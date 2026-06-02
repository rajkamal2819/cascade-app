"""
One-shot backfill of events.embedding for documents that don't have one yet.

After Phase 2 the events collection has plenty of documents but no
embeddings — the vector index is empty. This script:

  1. Streams events without an `embedding` field
  2. Batches their text through voyage-3-large
  3. Bulk-updates the documents
  4. Optionally embeds any media[].image_url with voyage-multimodal-3

Idempotent — re-running skips events that already have embeddings.

Usage:
    python scripts/backfill_embeddings.py                # text only
    python scripts/backfill_embeddings.py --media        # also embed media URLs
    python scripts/backfill_embeddings.py --limit 50     # cap for testing
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone

from pymongo import UpdateOne

from embed.multimodal import embed_image_url
from embed.text import embed_documents
from workers._common import get_db, jlog, load_dotenv_once

BATCH = 64


async def backfill_text(limit: int | None) -> tuple[int, int]:
    db = get_db()
    query = {"embedding": {"$exists": False}, "text": {"$exists": True, "$ne": ""}}
    projection = {"_id": 1, "text": 1}

    cursor = db.events.find(query, projection)
    if limit:
        cursor = cursor.limit(limit)

    pending: list[tuple] = []  # (_id, text)
    total_scanned = 0
    total_updated = 0

    async for doc in cursor:
        pending.append((doc["_id"], doc["text"]))
        total_scanned += 1
        if len(pending) >= BATCH:
            total_updated += await _flush_text(pending)
            pending.clear()

    if pending:
        total_updated += await _flush_text(pending)

    return (total_scanned, total_updated)


async def _flush_text(pending: list[tuple]) -> int:
    ids = [p[0] for p in pending]
    texts = [p[1] for p in pending]
    jlog("info", "backfill.text.embed", batch=len(texts))
    vectors = await embed_documents(texts)

    ops = [
        UpdateOne({"_id": _id}, {"$set": {"embedding": vec, "embedded_at": datetime.now(timezone.utc)}})
        for _id, vec in zip(ids, vectors, strict=True)
    ]
    db = get_db()
    result = await db.events.bulk_write(ops, ordered=False)
    jlog("info", "backfill.text.flush", modified=result.modified_count)
    return result.modified_count


async def backfill_media(limit: int | None) -> tuple[int, int]:
    """Embed media[].image_url entries that have a url but no embedding."""
    db = get_db()
    query = {"media": {"$elemMatch": {"url": {"$exists": True}, "embedding": {"$exists": False}}}}
    cursor = db.events.find(query, {"_id": 1, "media": 1, "text": 1})
    if limit:
        cursor = cursor.limit(limit)

    scanned = 0
    updated = 0
    async for doc in cursor:
        scanned += 1
        new_media = []
        changed = False
        for m in doc.get("media", []):
            if m.get("embedding") or not m.get("url"):
                new_media.append(m)
                continue
            try:
                vec = await embed_image_url(m["url"], caption=doc.get("text", "")[:200] or None)
                new_media.append({**m, "embedding": vec})
                changed = True
                jlog("info", "backfill.media.embed", id=str(doc["_id"]), url=m["url"][:80])
            except Exception as exc:  # noqa: BLE001
                jlog("warn", "backfill.media.fail", id=str(doc["_id"]), url=m["url"][:80], error=str(exc)[:200])
                new_media.append(m)

        if changed:
            await db.events.update_one({"_id": doc["_id"]}, {"$set": {"media": new_media}})
            updated += 1

    return (scanned, updated)


async def main() -> None:
    load_dotenv_once()
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="Cap number of events for testing.")
    parser.add_argument("--media", action="store_true", help="Also backfill media image embeddings.")
    parser.add_argument("--skip-text", action="store_true", help="Skip text backfill (run --media only).")
    args = parser.parse_args()

    t0 = datetime.now(timezone.utc)
    if not args.skip_text:
        scanned, updated = await backfill_text(args.limit)
        jlog("info", "backfill.text.done", scanned=scanned, updated=updated)

    if args.media:
        scanned, updated = await backfill_media(args.limit)
        jlog("info", "backfill.media.done", scanned=scanned, updated=updated)

    elapsed = (datetime.now(timezone.utc) - t0).total_seconds()
    jlog("info", "backfill.complete", elapsed_s=round(elapsed, 2))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
