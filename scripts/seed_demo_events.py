"""
Seed demo events for the four landing-page scenario cards.

Each scenario inserts one root event tagged `replay=<slug>` so the terminal
can auto-select it when opened with `?replay=<slug>`. Idempotent: upserts
on (source_type, external_id).

Slugs (must match landing card hrefs):
  ship-stall    — Container ship stalls near Kaohsiung (AIS)
  taiwan-quake  — M6.4 hits Taiwan (USGS geo)
  aapl-8k       — Apple files an 8-K after hours (SEC)
  pattern-brush — Aug-2024 semis correction (multimodal pattern hook)

Usage:
    python scripts/seed_demo_events.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import UpdateOne

MONGODB_URI = os.environ.get("MONGODB_URI")
DB_NAME = os.environ.get("MONGODB_DB", "cascade")

NOW = datetime.now(timezone.utc)


def _hours_ago(h: int) -> datetime:
    return NOW - timedelta(hours=h)


SCENARIOS: list[dict] = [
    {
        "replay": "ship-stall",
        "source": "AISStream",
        "source_type": "ais_stall",
        "external_id": "replay-ship-stall-kaohsiung",
        "headline": "Container ship MAERSK SHANGHAI stalled 18nm off Kaohsiung — speed 0kn for 47 minutes",
        "text": "AIS telemetry shows a 14,000-TEU container vessel halted near Kaohsiung approaches. No reported mechanical advisory. Adjacent vessels rerouting. Port congestion risk rising for semiconductor and electronics outbound.",
        "tickers": ["TSM", "FDX", "ZIM", "MAERSK"],
        "entities": ["Maersk Shanghai", "Port of Kaohsiung", "TSMC"],
        "sector": "Shipping",
        "impact": "high",
        "published_at": _hours_ago(2),
        "geo": {"type": "Point", "coordinates": [120.3, 22.6], "place": "Kaohsiung approaches"},
        "url": "",
    },
    {
        "replay": "taiwan-quake",
        "source": "USGS",
        "source_type": "usgs_quake",
        "external_id": "replay-taiwan-quake",
        "headline": "M6.4 earthquake — 28km ESE of Hualien, Taiwan",
        "text": "M6.4 earthquake struck 28km ESE of Hualien, Taiwan at depth 12km. 200km radius covers TSMC fabs in Hsinchu, Foxconn assembly campuses, and multiple electronics OEMs. No tsunami warning issued.",
        "tickers": [],
        "entities": ["Hualien", "TSMC", "Foxconn"],
        "sector": "Geophysical",
        "impact": "critical",
        "published_at": _hours_ago(4),
        "geo": {"type": "Point", "coordinates": [121.7, 23.97], "magnitude": 6.4, "place": "28km ESE of Hualien"},
        "url": "https://earthquake.usgs.gov/",
    },
    {
        "replay": "aapl-8k",
        "source": "SEC EDGAR",
        "source_type": "sec_8k",
        "external_id": "replay-aapl-8k",
        "headline": "Apple Inc. · Item 2.02: Results of Operations and Financial Condition",
        "text": "8-K - Apple Inc (0000320193) (Filer) — Item 2.02: Results of Operations and Financial Condition. Item 9.01: Financial Statements and Exhibits. Filed after market hours.",
        "tickers": ["AAPL", "FOXCONN", "JBL", "QRVO", "SWKS", "AVGO"],
        "entities": ["Apple Inc.", "Foxconn", "Jabil"],
        "sector": "Technology",
        "impact": "high",
        "published_at": _hours_ago(6),
        "url": "https://www.sec.gov/",
    },
    {
        "replay": "pattern-brush",
        "source": "Cascade Memory",
        "source_type": "chart",
        "external_id": "replay-pattern-brush-semis-aug24",
        "headline": "Pattern brush · Semis correction archetype — Aug 2024 echo",
        "text": "Multimodal pattern match: current sector moves resemble the August 2024 semiconductor correction (TSM, NVDA, SMCI). Drawing a region on the globe re-runs voyage-multimodal-3 against events.media[].embedding to surface historical analogues.",
        "tickers": ["NVDA", "TSM", "SMCI", "AMD", "AVGO"],
        "entities": ["Semiconductors", "August 2024 correction"],
        "sector": "Technology",
        "impact": "medium",
        "published_at": _hours_ago(8),
        "url": "",
    },
]


def _draft_to_doc(d: dict) -> dict:
    doc = {
        "source": d["source"],
        "source_type": d["source_type"],
        "external_id": d["external_id"],
        "headline": d["headline"],
        "text": d["text"],
        "tickers": [t.upper() for t in d["tickers"]],
        "entities": d.get("entities", []),
        "sector": d.get("sector"),
        "impact": d.get("impact", "medium"),
        "published_at": d["published_at"],
        "ingested_at": NOW,
        "url": d.get("url", ""),
        "geo": d.get("geo"),
        "replay": d["replay"],
        "demo_seeded": True,
    }
    return doc


async def main() -> None:
    if not MONGODB_URI:
        print("ERROR: MONGODB_URI not set", file=sys.stderr)
        sys.exit(1)

    client = AsyncIOMotorClient(MONGODB_URI)
    db = client[DB_NAME]

    ops = [
        UpdateOne(
            {"source_type": d["source_type"], "external_id": d["external_id"]},
            {
                "$set": _draft_to_doc(d),
                "$setOnInsert": {"created_at": NOW},
            },
            upsert=True,
        )
        for d in SCENARIOS
    ]
    result = await db.events.bulk_write(ops, ordered=False)
    print(
        f"seeded {len(SCENARIOS)} replay scenarios — inserted={len(result.upserted_ids)} "
        f"modified={result.modified_count}"
    )
    for d in SCENARIOS:
        print(f"  · {d['replay']:<14}  {d['headline'][:70]}")

    client.close()


if __name__ == "__main__":
    asyncio.run(main())
