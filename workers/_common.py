"""
Shared infra for ingestion workers.

Every worker should `from workers._common import ...` and use:
  - run_worker(name, interval, work_fn)  — main loop with --once support
  - get_db()                             — singleton AsyncIOMotorClient/db
  - jlog(level, event, **fields)         — structured JSON logging
  - normalize_event(...)                 — canonical event document builder
  - load_dotenv_once()                   — reads .env at import time
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable

import orjson
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

# --- env -------------------------------------------------------------------

_ENV_LOADED = False


def load_dotenv_once() -> None:
    """Load .env from repo root if present. Idempotent."""
    global _ENV_LOADED
    if _ENV_LOADED:
        return
    repo_root = Path(__file__).resolve().parent.parent
    env_path = repo_root / ".env"
    if env_path.is_file():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)
    _ENV_LOADED = True


load_dotenv_once()

# --- logging ---------------------------------------------------------------


def jlog(level: str, event: str, **fields: Any) -> None:
    """Emit one JSON log line to stdout. Cheap, structured, parseable."""
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "level": level,
        "event": event,
        **fields,
    }
    sys.stdout.write(orjson.dumps(payload).decode() + "\n")
    sys.stdout.flush()


# Quiet noisy third-party loggers; we use jlog.
for noisy in ("httpx", "httpcore", "yfinance", "peewee", "asyncio"):
    logging.getLogger(noisy).setLevel(logging.WARNING)


# --- db --------------------------------------------------------------------

_client: AsyncIOMotorClient | None = None


def get_db() -> AsyncIOMotorDatabase:
    """Singleton Motor client + db handle. M0 cluster has a 100-conn cap."""
    global _client
    if _client is None:
        uri = os.environ.get("MONGODB_URI")
        if not uri:
            raise RuntimeError("MONGODB_URI not set in env")
        _client = AsyncIOMotorClient(uri, maxPoolSize=10)
    return _client[os.environ.get("MONGODB_DB", "cascade")]


# --- event normalization ---------------------------------------------------

ImpactLevel = str  # "critical" | "high" | "medium" | "low"


@dataclass(slots=True)
class EventDraft:
    """Lightweight builder so workers don't hand-construct dicts."""

    source: str  # e.g. "SEC EDGAR", "Marketaux", "r/wallstreetbets"
    source_type: str  # "sec_8k" | "news" | "social" | "filing" | ...
    external_id: str  # stable dedup key (URL, post ID, article hash)
    text: str
    tickers: list[str]
    published_at: datetime
    impact: ImpactLevel = "medium"
    sector: str | None = None
    sentiment: float | None = None
    entities: list[str] | None = None
    geo: dict | None = None
    url: str | None = None
    media: list[dict] | None = None
    extra: dict | None = None

    def to_doc(self) -> dict:
        doc: dict[str, Any] = {
            "source": self.source,
            "source_type": self.source_type,
            "external_id": self.external_id,
            "text": self.text,
            "tickers": [t.upper() for t in self.tickers],
            "entities": self.entities or [],
            "impact": self.impact,
            "sector": self.sector,
            "sentiment": self.sentiment,
            "geo": self.geo,
            "url": self.url,
            "media": self.media or [],
            "published_at": self.published_at,
            "ingested_at": datetime.now(timezone.utc),
        }
        if self.extra:
            doc.update(self.extra)
        return doc


async def upsert_events(drafts: Iterable[EventDraft]) -> tuple[int, int]:
    """
    Bulk upsert events on (source_type, external_id). Returns (inserted, modified).

    Embeds each event's text via Voyage at insert time so the vector index
    is populated continuously. If VOYAGE_API_KEY isn't set we still insert
    the document (without embedding); scripts/backfill_embeddings.py can
    fill them in later.
    """
    from pymongo import UpdateOne

    docs = [d.to_doc() for d in drafts]
    if not docs:
        return (0, 0)

    # Best-effort embed. Failure here must not block ingestion — the
    # backfill script is the safety net.
    if os.environ.get("VOYAGE_API_KEY"):
        try:
            from embed.text import embed_documents

            vectors = await embed_documents([d["text"] for d in docs])
            for d, vec in zip(docs, vectors, strict=True):
                d["embedding"] = vec
                d["embedded_at"] = datetime.now(timezone.utc)
        except Exception as exc:  # noqa: BLE001
            jlog("warn", "events.embed.skip", error=type(exc).__name__, message=str(exc)[:200])

    ops = [
        UpdateOne(
            {"source_type": d["source_type"], "external_id": d["external_id"]},
            {"$set": d, "$setOnInsert": {"created_at": d["ingested_at"]}},
            upsert=True,
        )
        for d in docs
    ]

    db = get_db()
    result = await db.events.bulk_write(ops, ordered=False)
    return (len(result.upserted_ids), result.modified_count)


# --- main-loop helpers -----------------------------------------------------

WorkFn = Callable[[], Awaitable[None]]


def parse_cli(default_interval: float) -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--once", action="store_true", help="Run a single pass and exit.")
    p.add_argument(
        "--interval",
        type=float,
        default=default_interval,
        help=f"Seconds between passes (default {default_interval}).",
    )
    return p.parse_args()


async def run_worker(name: str, work: WorkFn, default_interval: float) -> None:
    """
    Standard worker loop: call work() forever every `interval` seconds,
    or once if --once is set. Catches and logs exceptions per-pass so a
    transient error never kills the whole worker.
    """
    args = parse_cli(default_interval)
    jlog("info", "worker.start", worker=name, once=args.once, interval=args.interval)

    while True:
        t0 = datetime.now(timezone.utc)
        try:
            await work()
            jlog(
                "info",
                "worker.pass.ok",
                worker=name,
                duration_ms=int((datetime.now(timezone.utc) - t0).total_seconds() * 1000),
            )
        except Exception as exc:  # noqa: BLE001
            jlog(
                "error",
                "worker.pass.fail",
                worker=name,
                error=type(exc).__name__,
                message=str(exc)[:500],
            )

        if args.once:
            return
        await asyncio.sleep(args.interval)


def sync_main(name: str, work: WorkFn, default_interval: float) -> None:
    """Convenience for `if __name__ == "__main__": sync_main(...)`."""
    try:
        asyncio.run(run_worker(name, work, default_interval))
    except KeyboardInterrupt:
        jlog("info", "worker.stop", worker=name, reason="keyboard_interrupt")
