"""
Backfill the `companies` collection with sector data for any ticker that
appears in events but isn't seeded yet. Uses yfinance for the lookup.

Runs idempotently — re-running only fetches the new tickers.

Usage:
    python -m scripts.backfill_company_sectors
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import yfinance as yf

from workers._common import get_db, load_dotenv_once

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")
log = logging.getLogger("backfill")


async def collect_event_tickers(db) -> set[str]:
    """Distinct tickers that appear on events."""
    raw = await db.events.distinct("tickers")
    return {t.upper() for t in raw if t}


async def existing_company_tickers(db) -> set[str]:
    raw = await db.companies.distinct("ticker")
    return {t.upper() for t in raw if t}


def fetch_sector(ticker: str) -> dict | None:
    """Hit yfinance for sector/industry/HQ. Returns dict or None on failure."""
    try:
        t = yf.Ticker(ticker)
        info = t.info or {}
        sector = info.get("sector") or ""
        if not sector:
            return None
        return {
            "ticker": ticker,
            "name": info.get("longName") or info.get("shortName") or ticker,
            "sector": sector,
            "industry": info.get("industry") or "",
            "hq_city": info.get("city") or "",
            "hq_country": info.get("country") or "",
            "market_cap": info.get("marketCap") or 0,
            "description": (info.get("longBusinessSummary") or "")[:600],
        }
    except Exception as e:
        log.warning("yfinance failed for %s: %s", ticker, e)
        return None


async def main():
    load_dotenv_once()
    db = get_db()

    event_tickers = await collect_event_tickers(db)
    existing = await existing_company_tickers(db)
    missing = sorted(event_tickers - existing)

    log.info("event tickers: %d  existing companies: %d  missing: %d",
             len(event_tickers), len(existing), len(missing))

    if not missing:
        log.info("nothing to backfill")
        return

    added = 0
    skipped = 0
    for i, ticker in enumerate(missing, start=1):
        doc = fetch_sector(ticker)
        if not doc:
            skipped += 1
            continue
        doc["created_at"] = datetime.now(timezone.utc)
        doc["backfilled"] = True
        await db.companies.update_one(
            {"ticker": ticker},
            {"$set": doc},
            upsert=True,
        )
        added += 1
        log.info("[%3d/%3d] %-6s %-32s %s", i, len(missing), ticker, doc["sector"], doc["name"][:40])

    log.info("done — added %d  skipped %d", added, skipped)


if __name__ == "__main__":
    asyncio.run(main())
