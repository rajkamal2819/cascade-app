"""
Admin endpoints — schema bootstrap and seed loader.

All routes here are gated by `CRON_SECRET` (same secret the EventBridge
Scheduler uses for /api/cron/*). Pass it as `?key=<secret>` or in the
`X-Cron-Secret` header. Without it the endpoint returns 401.

    POST /api/admin/bootstrap  — apply DDL (idempotent)
    POST /api/admin/seed       — load data/companies.json + data/relationships.json
    GET  /api/admin/info       — counts per table
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query

from db import aurora
from db.schema import DDL

router = APIRouter(prefix="/api/admin", tags=["admin"])

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"


def _check_secret(key: str | None, header: str | None) -> None:
    expected = os.environ.get("CRON_SECRET")
    if not expected:
        raise HTTPException(503, "CRON_SECRET not configured on the deployment")
    provided = key or header
    if provided != expected:
        raise HTTPException(401, "invalid or missing CRON_SECRET")


@router.post("/bootstrap")
async def bootstrap(
    key: str | None = Query(default=None),
    x_cron_secret: str | None = Header(default=None),
) -> dict[str, Any]:
    """Apply the Aurora schema DDL. Idempotent — safe to call repeatedly."""
    _check_secret(key, x_cron_secret)
    pool = await aurora.get_pool()
    applied: list[str] = []
    async with pool.acquire() as conn:
        for stmt in DDL:
            await conn.execute(stmt)
            head = stmt.strip().splitlines()[0][:80]
            applied.append(head)
    return {"ok": True, "applied": applied}


@router.post("/seed")
async def seed(
    key: str | None = Query(default=None),
    x_cron_secret: str | None = Header(default=None),
) -> dict[str, Any]:
    """Load companies + relationships from data/ into Aurora."""
    _check_secret(key, x_cron_secret)
    companies = json.loads((DATA_DIR / "companies.json").read_text())
    relationships = json.loads((DATA_DIR / "relationships.json").read_text())

    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        # Upsert companies (with PostGIS POINT from [lon, lat]).
        for c in companies:
            lon, lat = c["hq_coords"]
            await conn.execute(
                """
                INSERT INTO companies (ticker, name, sector, industry, hq_country,
                                       hq_coords, market_cap, exchange, updated_at)
                VALUES ($1, $2, $3, $4, $5,
                        ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography,
                        $8, $9, NOW())
                ON CONFLICT (ticker) DO UPDATE SET
                    name = EXCLUDED.name,
                    sector = EXCLUDED.sector,
                    industry = EXCLUDED.industry,
                    hq_country = EXCLUDED.hq_country,
                    hq_coords = EXCLUDED.hq_coords,
                    market_cap = EXCLUDED.market_cap,
                    exchange = EXCLUDED.exchange,
                    updated_at = NOW()
                """,
                c["ticker"],
                c.get("name"),
                c.get("sector"),
                c.get("industry"),
                c.get("hq_country"),
                lon,
                lat,
                c.get("market_cap"),
                c.get("exchange"),
            )

        # Filter relationships whose endpoints exist as companies.
        known = {c["ticker"] for c in companies}
        valid_rels = [
            r for r in relationships
            if r["from_ticker"] in known and r["to_ticker"] in known
        ]

        for r in valid_rels:
            await conn.execute(
                """
                INSERT INTO relationships (from_ticker, to_ticker, type, weight, source)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (from_ticker, to_ticker, type) DO UPDATE SET
                    weight = EXCLUDED.weight,
                    source = EXCLUDED.source
                """,
                r["from_ticker"],
                r["to_ticker"],
                r["type"],
                float(r["weight"]),
                r.get("source"),
            )

    return {
        "ok": True,
        "companies_loaded": len(companies),
        "relationships_loaded": len(valid_rels),
        "relationships_skipped_unknown_ticker": len(relationships) - len(valid_rels),
    }


@router.post("/seed-demo-events")
async def seed_demo_events(
    key: str | None = Query(default=None),
    x_cron_secret: str | None = Header(default=None),
    count: int = Query(default=60, ge=1, le=500),
    days_back: int = Query(default=14, ge=1, le=90),
) -> dict[str, Any]:
    """Generate `count` synthetic events spread over the last `days_back`
    days so the UI feed has something to render until real workers ingest.

    Each event is tied to 1-2 random seeded tickers and gets a realistic
    headline template per source type. Idempotent on (source_type, source_id)
    via the table's UNIQUE constraint.
    """
    _check_secret(key, x_cron_secret)
    import random
    rng = random.Random(2026)

    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        co_rows = await conn.fetch(
            "SELECT ticker, name, sector FROM companies ORDER BY market_cap DESC NULLS LAST LIMIT 60"
        )
        if not co_rows:
            raise HTTPException(409, "no companies seeded yet — call /api/admin/seed first")
        companies = [dict(r) for r in co_rows]

    sources = [
        ("sec_edgar", "{T} files {form} disclosing {topic}",
         ["10-K", "10-Q", "8-K · Item 2.02", "8-K · Item 1.01"],
         ["guidance revision", "material agreement", "results of operations",
          "executive transition"]),
        ("marketaux", "{T} {action} as {driver} rattles {sector}",
         ["slides 3.2%", "jumps 4.1%", "drops 6.8%", "rallies 2.7%"],
         ["margin compression", "demand softness", "supply tightness",
          "analyst upgrade", "FX headwind"]),
        ("reddit", "r/wallstreetbets · {T} {flavor}",
         ["DD: thesis update", "earnings preview", "post-earnings reaction",
          "options unusual activity"],
         []),
        ("yfinance", "{T} hits {milestone}",
         ["fresh 52-week high", "52-week low", "1-year high on volume",
          "key technical breakout"],
         []),
    ]
    impacts = [0.15, 0.3, 0.5, 0.7, 0.85]

    inserted = 0
    now = datetime.now(timezone.utc)
    async with pool.acquire() as conn:
        for i in range(count):
            co = rng.choice(companies)
            src_type, tmpl, forms, drivers = rng.choice(sources)
            form = rng.choice(forms) if forms else ""
            driver = rng.choice(drivers) if drivers else ""
            title = (tmpl
                     .replace("{T}", co["ticker"])
                     .replace("{form}", form)
                     .replace("{topic}", driver)
                     .replace("{action}", form)
                     .replace("{driver}", driver)
                     .replace("{flavor}", form)
                     .replace("{milestone}", form)
                     .replace("{sector}", (co["sector"] or "tech").lower()))
            offset_minutes = rng.randint(0, days_back * 24 * 60)
            pub = now - timedelta(minutes=offset_minutes)
            impact = rng.choice(impacts)
            body_text = f"{co['name']} ({co['ticker']}) — {title.lower()}. Synthetic demo event."
            await conn.execute(
                """
                INSERT INTO events (source_type, source_id, title, body, url,
                                    published_at, ingested_at, tickers, sectors, impact)
                VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9)
                ON CONFLICT (source_type, source_id) DO NOTHING
                """,
                src_type,
                f"demo-{i:04d}",
                title,
                body_text,
                f"https://example.com/demo/{src_type}/{i}",
                pub,
                [co["ticker"]],
                [co["sector"] or ""],
                impact,
            )
            inserted += 1
    return {"ok": True, "events_inserted": inserted}


@router.get("/info")
async def info() -> dict[str, Any]:
    """Public — counts per table. No secret needed (just rowcounts)."""
    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        rows = {}
        for table in ("companies", "relationships", "events", "cascades"):
            count = await conn.fetchval(
                f"SELECT COUNT(*) FROM {table}"
            )
            rows[table] = count
    return {"ok": True, "counts": rows}
