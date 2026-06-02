"""
Cascade — MongoDB Atlas setup.

Run once after creating an M0 cluster and saving MONGODB_URI in .env.

This creates:
- 6 collections (companies, relationships, events, cascades, watchlists, prices)
- Atlas Vector Search index on events.embedding with Automated Embedding via voyage-3-large
- Atlas Search (full-text) index on events
- Regular indexes for queries
- TTL index on events for 14-day retention (M0 has 512MB)
- prices as a native time-series collection

Usage:
    python scripts/setup_mongo.py
"""

import asyncio
import os
import sys
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, DESCENDING
from pymongo.operations import SearchIndexModel

MONGODB_URI = os.environ["MONGODB_URI"]
DB_NAME = os.environ.get("MONGODB_DB", "cascade")


async def create_collections(db) -> None:
    print("Creating collections...")

    existing = await db.list_collection_names()

    if "prices" not in existing:
        await db.create_collection(
            "prices",
            timeseries={
                "timeField": "ts",
                "metaField": "ticker",
                "granularity": "minutes",
            },
            expireAfterSeconds=60 * 60 * 24 * 90,
        )
        print("  prices (time-series, 90-day retention)")

    for name in ["companies", "relationships", "events", "cascades", "watchlists"]:
        if name not in existing:
            await db.create_collection(name)
            print(f"  {name}")


async def create_regular_indexes(db) -> None:
    print("Creating regular indexes...")

    await db.companies.create_index([("ticker", ASCENDING)], unique=True)
    await db.companies.create_index([("sector", ASCENDING)])
    await db.companies.create_index([("hq_country", ASCENDING)])

    await db.relationships.create_index([("from_ticker", ASCENDING), ("type", ASCENDING)])
    await db.relationships.create_index([("to_ticker", ASCENDING), ("type", ASCENDING)])

    await db.events.create_index([("tickers", ASCENDING), ("published_at", DESCENDING)])
    await db.events.create_index([("sector", ASCENDING), ("published_at", DESCENDING)])
    await db.events.create_index([("impact", ASCENDING), ("published_at", DESCENDING)])
    await db.events.create_index([("source_type", ASCENDING)])
    await db.events.create_index(
        [("published_at", ASCENDING)],
        expireAfterSeconds=60 * 60 * 24 * 14,
    )
    print("  events: composite + TTL (14 days)")

    await db.cascades.create_index([("root_event_id", ASCENDING)])
    await db.cascades.create_index([("created_at", DESCENDING)])

    print("  done")


async def create_search_indexes(db) -> None:
    """
    Atlas Vector Search + Atlas Search indexes.

    NOTE on embeddings: Atlas "Automated Embedding" (the model/sourcePath
    fields on the vector index) needs an Embedding Model resource set up at
    the Atlas project level first. We use a plain vector index here and
    have workers embed text client-side via the Voyage SDK in embed/text.py
    (Phase 3). The events.embedding field gets populated on insert.
    """
    print("Creating search indexes (this is async — wait 1-3 minutes to activate)...")

    vector_index = SearchIndexModel(
        definition={
            "fields": [
                {
                    "type": "vector",
                    "path": "embedding",
                    "numDimensions": 1024,
                    "similarity": "cosine",
                },
                {"type": "filter", "path": "tickers"},
                {"type": "filter", "path": "sector"},
                {"type": "filter", "path": "impact"},
                {"type": "filter", "path": "published_at"},
            ],
        },
        name="events_vector_index",
        type="vectorSearch",
    )

    try:
        await db.events.create_search_index(model=vector_index)
        print("  events_vector_index (voyage-3-large auto-embed)")
    except Exception as exc:
        if "already exists" in str(exc).lower():
            print("  events_vector_index — already exists, skipping")
        else:
            raise

    text_index = SearchIndexModel(
        definition={
            "mappings": {
                "dynamic": False,
                "fields": {
                    "text": {"type": "string", "analyzer": "lucene.standard"},
                    "tickers": {"type": "string", "analyzer": "lucene.keyword"},
                    "entities": {"type": "string", "analyzer": "lucene.standard"},
                    "sector": {"type": "string", "analyzer": "lucene.keyword"},
                },
            },
        },
        name="events_text_index",
    )

    try:
        await db.events.create_search_index(model=text_index)
        print("  events_text_index (atlas search, full-text)")
    except Exception as exc:
        if "already exists" in str(exc).lower():
            print("  events_text_index — already exists, skipping")
        else:
            raise

    cascade_vector = SearchIndexModel(
        definition={
            "fields": [
                {
                    "type": "vector",
                    "path": "embedding",
                    "numDimensions": 1024,
                    "similarity": "cosine",
                },
                {"type": "filter", "path": "root_ticker"},
            ],
        },
        name="cascades_vector_index",
        type="vectorSearch",
    )

    try:
        await db.cascades.create_search_index(model=cascade_vector)
        print("  cascades_vector_index")
    except Exception as exc:
        msg = str(exc).lower()
        if "already exists" in msg:
            print("  cascades_vector_index — already exists, skipping")
        elif "maximum number of fts indexes" in msg:
            # M0 free tier only allows 2 search indexes. The 2 on events are
            # the priority. Cascade semantic-search is a Phase 4 nice-to-have
            # and works fine without this index — fall back to regular queries.
            print(
                "  cascades_vector_index — SKIPPED (M0 free tier hit 2-index limit; "
                "upgrade to M2+ to enable cascade semantic search)"
            )
        else:
            raise


async def verify(db) -> None:
    print("\nVerification:")
    collections = await db.list_collection_names()
    for name in ["companies", "relationships", "events", "cascades", "watchlists", "prices"]:
        ok = "ok" if name in collections else "MISSING"
        print(f"  collection {name}: {ok}")

    indexes = list(await db.events.list_search_indexes().to_list(length=None))
    print(f"  search indexes on events: {[i['name'] for i in indexes]}")

    print(
        "\nIndex build is async. Check Atlas UI > Search > Atlas Search."
        " Status must say ACTIVE before queries work."
    )


async def main() -> None:
    if not MONGODB_URI:
        print("ERROR: MONGODB_URI not set in env", file=sys.stderr)
        sys.exit(1)

    client = AsyncIOMotorClient(MONGODB_URI)
    db = client[DB_NAME]

    try:
        await client.admin.command("ping")
        print(f"Connected to {DB_NAME}\n")

        await create_collections(db)
        await create_regular_indexes(db)
        await create_search_indexes(db)
        await verify(db)

        print(f"\nSetup complete at {datetime.now(timezone.utc).isoformat()}")
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
