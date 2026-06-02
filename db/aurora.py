"""
Aurora PostgreSQL adapter — asyncpg pool + helpers.

Replaces the Mongo Motor singleton from Cascade. Every other module in Cascade
should reach Aurora through `get_pool()` / `acquire()` here, never by
constructing its own connection.

This file is a STUB for the Day 3–5 bootstrap. Real implementation lands in
Days 10–14 of the plan (`/Users/rajkamal/.claude/plans/now-i-want-you-binary-raven.md` §13.8):

    - get_pool() / acquire() / close_pool()
    - register pgvector type codec on every connection
    - hybrid_search(query, k, sector, impact, days_back)  ← replaces $vectorSearch + $search + RRF
    - recursive_cascade(root_tickers, max_hops, min_weight)  ← replaces $graphLookup
    - geo_companies_within(lat, lon, radius_km)  ← replaces 2dsphere $geoNear via PostGIS
    - listen_events(callback)  ← LISTEN/NOTIFY consumer for the SSE primary channel
    - upsert_event(draft) / upsert_company(...) / upsert_relationship(...)

Connection string is read from DATABASE_URL or POSTGRES_URL (whichever the
Vercel Marketplace integration populates).
"""

from __future__ import annotations

import os
from typing import Any

# Lazy import — keeps the cold Vercel function fast when only DynamoDB is used.
_pool: Any = None


def _dsn() -> str:
    """Resolve the Aurora connection string from any of the env var names
    Vercel/AWS might populate."""
    for var in ("DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL"):
        value = os.environ.get(var)
        if value:
            return value
    raise RuntimeError(
        "Aurora connection string missing — set DATABASE_URL or POSTGRES_URL"
    )


async def get_pool() -> Any:
    """Lazily initialise and return the shared asyncpg pool.

    NOT YET IMPLEMENTED. Tracked for Days 10–14.
    """
    raise NotImplementedError(
        "db.aurora.get_pool — implementation pending (plan §13.8 Days 10–14)"
    )


async def close_pool() -> None:
    """Close the shared asyncpg pool. Called on Vercel function shutdown
    (best-effort — Vercel may terminate without a clean signal)."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
