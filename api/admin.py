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
