"""
Seed the `companies` collection from data/companies.json.

Idempotent — upserts on ticker so re-running just refreshes existing docs.

Usage:
    python scripts/seed_companies.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import UpdateOne

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "companies.json"

MONGODB_URI = os.environ.get("MONGODB_URI")
DB_NAME = os.environ.get("MONGODB_DB", "cascade")


def _load() -> list[dict]:
    with DATA_FILE.open() as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{DATA_FILE} must contain a JSON array")
    return data


async def main() -> None:
    if not MONGODB_URI:
        print("ERROR: MONGODB_URI not set", file=sys.stderr)
        sys.exit(1)

    companies = _load()
    print(f"Loaded {len(companies)} companies from {DATA_FILE.relative_to(ROOT)}")

    client = AsyncIOMotorClient(MONGODB_URI)
    db = client[DB_NAME]
    now = datetime.now(timezone.utc)

    ops: list[UpdateOne] = []
    for c in companies:
        ticker = c["ticker"].upper()
        doc = {
            "ticker": ticker,
            "name": c["name"],
            "sector": c["sector"],
            "industry": c.get("industry"),
            "hq_country": c.get("hq_country"),
            "hq_coords": c.get("hq_coords"),  # [lng, lat]
            "market_cap": c.get("market_cap"),
            "exchange": c.get("exchange"),
            "updated_at": now,
        }
        ops.append(
            UpdateOne(
                {"ticker": ticker},
                {"$set": doc, "$setOnInsert": {"created_at": now}},
                upsert=True,
            )
        )

    try:
        result = await db.companies.bulk_write(ops, ordered=False)
        print(
            f"upserted: matched={result.matched_count} "
            f"modified={result.modified_count} upserted={len(result.upserted_ids)}"
        )

        total = await db.companies.count_documents({})
        print(f"companies collection now has {total} documents")
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
