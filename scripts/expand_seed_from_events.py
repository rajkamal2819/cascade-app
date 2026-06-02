"""
Expand the supply-chain seed graph data-driven from the events collection.

Problem: the seed graph covers ~100 large-cap US tickers, but the live event
feed regularly mentions tickers outside that set (HY, BHM, FREVS, BIIB, …).
Cascades for those events fall through to semantic-only fallback.

Fix: mine the events collection for the most-frequent un-seeded tickers, look
up basic profile data from yfinance, append them to companies.json, then
generate sector + industry peer edges so $graphLookup has somewhere to walk.

Run:   python scripts/expand_seed_from_events.py --limit 250 --apply
Dry:   python scripts/expand_seed_from_events.py --limit 250
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections import Counter
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent
COMPANIES_PATH = ROOT / "data" / "companies.json"
RELATIONSHIPS_PATH = ROOT / "data" / "relationships.json"


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

async def top_unmapped_tickers(limit: int) -> list[tuple[str, int]]:
    uri = os.environ["MONGODB_URI"]
    db_name = os.environ.get("MONGODB_DB", "cascade")
    client = AsyncIOMotorClient(uri)
    db = client[db_name]

    # All currently-seeded tickers
    seeded = {c["ticker"] async for c in db.companies.find({}, {"ticker": 1})}
    print(f"Seeded tickers: {len(seeded)}")

    # Frequency of every ticker mentioned in the events collection
    pipeline = [
        {"$unwind": "$tickers"},
        {"$group": {"_id": "$tickers", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 1500},
    ]
    counts: list[tuple[str, int]] = []
    async for row in db.events.aggregate(pipeline):
        t = row["_id"]
        if not isinstance(t, str) or not t.isupper() or len(t) > 6:
            continue
        if t in seeded:
            continue
        counts.append((t, row["count"]))
        if len(counts) >= limit:
            break

    client.close()
    return counts


# ---------------------------------------------------------------------------
# Profile lookup — yfinance optional; degrade gracefully
# ---------------------------------------------------------------------------

def lookup_profile(ticker: str) -> dict | None:
    try:
        import yfinance as yf  # type: ignore
    except ImportError:
        return None
    try:
        info = yf.Ticker(ticker).info
    except Exception:
        return None
    name = info.get("longName") or info.get("shortName") or ticker
    sector = info.get("sector") or "Unknown"
    industry = info.get("industry") or "Unknown"
    # Many small-caps lack coords; default to NYC.
    return {
        "ticker": ticker,
        "name": name,
        "sector": sector,
        "industry": industry,
        "hq_country": info.get("country") or "US",
        "hq_coords": [-74.0060, 40.7128],
        "market_cap": round((info.get("marketCap") or 0) / 1e9, 1),
        "exchange": info.get("exchange") or "NYSE",
    }


def fallback_profile(ticker: str) -> dict:
    """Used when yfinance is unavailable — keep a placeholder so $graphLookup still works."""
    return {
        "ticker": ticker,
        "name": ticker,
        "sector": "Unknown",
        "industry": "Unknown",
        "hq_country": "US",
        "hq_coords": [-74.0060, 40.7128],
        "market_cap": 0,
        "exchange": "NYSE",
    }


# ---------------------------------------------------------------------------
# Densify relationships — add peer edges within each industry, sector edges across
# ---------------------------------------------------------------------------

def densify(companies: list[dict], existing: list[dict]) -> list[dict]:
    seen = {(r["from_ticker"], r["to_ticker"]) for r in existing}
    new: list[dict] = []

    by_industry: dict[str, list[str]] = {}
    by_sector: dict[str, list[str]] = {}
    for c in companies:
        by_industry.setdefault(c["industry"], []).append(c["ticker"])
        by_sector.setdefault(c["sector"], []).append(c["ticker"])

    # Peer edges within the same industry (bi-directional, weight 0.55)
    for industry, tickers in by_industry.items():
        if industry == "Unknown":
            continue
        for a in tickers:
            for b in tickers:
                if a == b or (a, b) in seen:
                    continue
                seen.add((a, b))
                new.append({
                    "from_ticker": a,
                    "to_ticker": b,
                    "type": "peer",
                    "weight": 0.55,
                    "source": f"same-industry: {industry}",
                })

    # Sector edges (one direction, lower weight 0.35) — only fill gaps where no
    # stronger edge exists; cap fan-out per ticker to avoid noise.
    SECTOR_FANOUT = 6
    for sector, tickers in by_sector.items():
        if sector == "Unknown" or len(tickers) <= 1:
            continue
        for a in tickers:
            out = 0
            for b in tickers:
                if out >= SECTOR_FANOUT:
                    break
                if a == b or (a, b) in seen:
                    continue
                seen.add((a, b))
                new.append({
                    "from_ticker": a,
                    "to_ticker": b,
                    "type": "sector",
                    "weight": 0.35,
                    "source": f"same-sector: {sector}",
                })
                out += 1

    return new


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=250, help="max new tickers to add")
    ap.add_argument("--apply", action="store_true", help="write changes to JSON files")
    ap.add_argument("--no-yfinance", action="store_true", help="skip yfinance lookup (use placeholders)")
    args = ap.parse_args()

    companies = json.loads(COMPANIES_PATH.read_text())
    relationships = json.loads(RELATIONSHIPS_PATH.read_text())
    print(f"Current: {len(companies)} companies, {len(relationships)} relationships")

    print(f"\nMining events collection for top {args.limit} unmapped tickers…")
    unmapped = await top_unmapped_tickers(args.limit)
    print(f"Found {len(unmapped)} unmapped tickers (showing top 20):")
    for t, c in unmapped[:20]:
        print(f"  {t:8s} {c} events")

    print(f"\nResolving profiles…")
    additions: list[dict] = []
    for i, (t, _c) in enumerate(unmapped):
        if i % 25 == 0:
            print(f"  …{i}/{len(unmapped)}")
        prof = None if args.no_yfinance else lookup_profile(t)
        additions.append(prof or fallback_profile(t))

    merged = companies + additions
    print(f"\nDensifying relationships (peer + sector edges)…")
    new_edges = densify(merged, relationships)
    merged_rels = relationships + new_edges
    print(f"Added {len(additions)} companies, {len(new_edges)} new relationships")
    print(f"New totals: {len(merged)} companies, {len(merged_rels)} relationships")

    if not args.apply:
        print("\n(dry run — pass --apply to write)")
        return 0

    COMPANIES_PATH.write_text(json.dumps(merged, indent=2))
    RELATIONSHIPS_PATH.write_text(json.dumps(merged_rels, indent=2))
    print(f"\nWrote {COMPANIES_PATH} and {RELATIONSHIPS_PATH}.")
    print("Next: re-run scripts/seed_companies.py and scripts/seed_relationships.py to push to Atlas.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
