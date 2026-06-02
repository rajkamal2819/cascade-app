"""
Graph endpoints — companies, relationships, and the recursive-CTE cascade walk.

The cascade walk is the H0 Technical Implementation centerpiece: it replaces
MongoDB's `$graphLookup` with a Postgres `WITH RECURSIVE` CTE that traverses
the supply-chain / peer / sector graph up to `max_hops` deep, multiplying edge
weights along the path so downstream nodes can be ranked by aggregate impact.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from db import aurora
from db.schema import CASCADE_WALK_SQL

router = APIRouter(prefix="/api", tags=["graph"])


@router.get("/companies")
async def list_companies(
    limit: int = Query(default=50, ge=1, le=500),
    sector: str | None = Query(default=None),
) -> dict[str, Any]:
    """Paginated company list. Optionally filter by sector."""
    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        if sector:
            rows = await conn.fetch(
                """
                SELECT ticker, name, sector, industry, hq_country,
                       ST_X(hq_coords::geometry) AS lon,
                       ST_Y(hq_coords::geometry) AS lat,
                       market_cap, exchange
                FROM companies WHERE sector = $1
                ORDER BY market_cap DESC NULLS LAST
                LIMIT $2
                """,
                sector, limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT ticker, name, sector, industry, hq_country,
                       ST_X(hq_coords::geometry) AS lon,
                       ST_Y(hq_coords::geometry) AS lat,
                       market_cap, exchange
                FROM companies
                ORDER BY market_cap DESC NULLS LAST
                LIMIT $1
                """,
                limit,
            )
    return {"ok": True, "count": len(rows), "items": [dict(r) for r in rows]}


@router.get("/companies/{ticker}")
async def get_company(ticker: str) -> dict[str, Any]:
    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT ticker, name, sector, industry, hq_country,
                   ST_X(hq_coords::geometry) AS lon,
                   ST_Y(hq_coords::geometry) AS lat,
                   market_cap, exchange, updated_at
            FROM companies WHERE ticker = $1
            """,
            ticker.upper(),
        )
    if not row:
        raise HTTPException(404, f"company {ticker!r} not found")
    return dict(row)


@router.get("/relationships/{ticker}")
async def relationships_for(
    ticker: str,
    direction: str = Query(default="out", pattern="^(out|in|both)$"),
) -> dict[str, Any]:
    """Direct (1-hop) edges for a ticker. `out` = it supplies others;
    `in` = others supply it; `both` = union."""
    pool = await aurora.get_pool()
    sym = ticker.upper()
    async with pool.acquire() as conn:
        outgoing = await conn.fetch(
            "SELECT from_ticker, to_ticker, type, weight, source "
            "FROM relationships WHERE from_ticker = $1 ORDER BY weight DESC",
            sym,
        ) if direction in ("out", "both") else []
        incoming = await conn.fetch(
            "SELECT from_ticker, to_ticker, type, weight, source "
            "FROM relationships WHERE to_ticker = $1 ORDER BY weight DESC",
            sym,
        ) if direction in ("in", "both") else []
    return {
        "ok": True,
        "ticker": sym,
        "out": [dict(r) for r in outgoing],
        "in": [dict(r) for r in incoming],
    }


@router.get("/cascade/walk")
async def cascade_walk(
    tickers: str = Query(description="Comma-separated root tickers, e.g. NVDA,TSM"),
    max_hops: int = Query(default=3, ge=1, le=5),
    min_weight: float = Query(default=0.3, ge=0.0, le=1.0),
) -> dict[str, Any]:
    """Recursive-CTE cascade walk — the H0 centerpiece.

    Traverses the relationships graph from the root tickers up to `max_hops`
    deep, filtering by `min_weight` per edge and multiplying weights along the
    path. Replaces MongoDB `$graphLookup` from the original Cascade.
    """
    roots = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    if not roots:
        raise HTTPException(400, "tickers parameter required")
    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(CASCADE_WALK_SQL, roots, max_hops, min_weight)
    return {
        "ok": True,
        "roots": roots,
        "max_hops": max_hops,
        "min_weight": min_weight,
        "count": len(rows),
        "walk": [dict(r) for r in rows],
    }


@router.get("/geo/nearby")
async def geo_nearby(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_km: float = Query(default=500, gt=0, le=20000),
    limit: int = Query(default=20, ge=1, le=200),
) -> dict[str, Any]:
    """Companies whose HQ is within `radius_km` of (lat, lon). PostGIS-backed."""
    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT ticker, name, sector, hq_country,
                   ST_X(hq_coords::geometry) AS lon,
                   ST_Y(hq_coords::geometry) AS lat,
                   ST_Distance(hq_coords,
                               ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
                              ) / 1000 AS distance_km
            FROM companies
            WHERE ST_DWithin(hq_coords,
                             ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
                             $3 * 1000)
            ORDER BY distance_km
            LIMIT $4
            """,
            lat, lon, radius_km, limit,
        )
    return {
        "ok": True,
        "center": {"lat": lat, "lon": lon},
        "radius_km": radius_km,
        "count": len(rows),
        "items": [dict(r) for r in rows],
    }
