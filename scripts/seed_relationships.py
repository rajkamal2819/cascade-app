"""
Seed the `relationships` collection from data/relationships.json.

Each document encodes a directed edge: from_ticker depends on / is influenced
by to_ticker, with a type and weight. Used by $graphLookup in cascade.py to
walk supply chains up to 3 hops.

Idempotent — upserts on the (from_ticker, to_ticker, type) tuple.

Usage:
    python scripts/seed_relationships.py
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
DATA_FILE = ROOT / "data" / "relationships.json"

MONGODB_URI = os.environ.get("MONGODB_URI")
DB_NAME = os.environ.get("MONGODB_DB", "cascade")

VALID_TYPES = {"supplier", "customer", "peer", "sector", "derivative"}


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

    edges = _load()
    print(f"Loaded {len(edges)} edges from {DATA_FILE.relative_to(ROOT)}")

    client = AsyncIOMotorClient(MONGODB_URI)
    db = client[DB_NAME]
    now = datetime.now(timezone.utc)

    # Validate against known tickers and types — fail fast on bad data.
    known_tickers = {c["ticker"] async for c in db.companies.find({}, {"ticker": 1})}
    if not known_tickers:
        print(
            "WARNING: companies collection is empty. "
            "Run `python scripts/seed_companies.py` first.",
            file=sys.stderr,
        )

    ops: list[UpdateOne] = []
    skipped = 0
    for e in edges:
        a = e["from_ticker"].upper()
        b = e["to_ticker"].upper()
        t = e["type"]

        if t not in VALID_TYPES:
            print(f"  skip: invalid type {t!r} for {a}->{b}", file=sys.stderr)
            skipped += 1
            continue
        if known_tickers and (a not in known_tickers or b not in known_tickers):
            print(f"  skip: unknown ticker in {a}->{b}", file=sys.stderr)
            skipped += 1
            continue
        if a == b:
            skipped += 1
            continue

        doc = {
            "from_ticker": a,
            "to_ticker": b,
            "type": t,
            "weight": float(e.get("weight", 0.5)),
            "source": e.get("source", "seed"),
            "updated_at": now,
        }
        ops.append(
            UpdateOne(
                {"from_ticker": a, "to_ticker": b, "type": t},
                {"$set": doc, "$setOnInsert": {"created_at": now}},
                upsert=True,
            )
        )

    try:
        if ops:
            result = await db.relationships.bulk_write(ops, ordered=False)
            print(
                f"upserted: matched={result.matched_count} "
                f"modified={result.modified_count} upserted={len(result.upserted_ids)} "
                f"skipped={skipped}"
            )
        else:
            print("nothing to write")

        total = await db.relationships.count_documents({})
        by_type = await db.relationships.aggregate(
            [{"$group": {"_id": "$type", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}]
        ).to_list(length=None)

        print(f"relationships collection now has {total} documents")
        for row in by_type:
            print(f"  {row['_id']}: {row['n']}")
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
