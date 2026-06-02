"""
MongoDB change streams → Server-Sent Events.

A single background task tails `events` change-stream and fans out new
critical/high-impact events to every connected SSE client. Browsers see live
updates without polling.

Usage from api/main.py:
    @app.get("/stream")
    async def stream(request: Request):
        return EventSourceResponse(sse_event_generator(request))
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from fastapi import Request
from motor.motor_asyncio import AsyncIOMotorDatabase

log = logging.getLogger(__name__)

# In-process broadcast — one queue per connected SSE client.
_subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
_subscribers_lock = asyncio.Lock()

# Background change-stream task handles.
_watcher_task: asyncio.Task | None = None
_geo_watcher_task: asyncio.Task | None = None

# Mongo handle stashed for the geo-trigger background callbacks.
_db_ref: AsyncIOMotorDatabase | None = None


_cascadable_tickers: set[str] = set()


def set_cascadable_tickers(tickers: set[str]) -> None:
    global _cascadable_tickers
    _cascadable_tickers = tickers


async def _watch_changes(db: AsyncIOMotorDatabase) -> None:
    """
    Tail the events collection change-stream and broadcast inserts to all
    SSE subscribers. Reconnects automatically on transient errors.
    """
    pipeline = [
        {
            "$match": {
                "operationType": "insert",
                "fullDocument.impact": {"$in": ["critical", "high"]},
            }
        }
    ]
    while True:
        try:
            log.info("change-stream watcher starting")
            async with db.events.watch(pipeline=pipeline, full_document="updateLookup") as stream:
                async for change in stream:
                    doc = change.get("fullDocument") or {}
                    payload = _serialize_event(doc)
                    await _broadcast(payload)
        except Exception as e:
            log.warning("change-stream watcher error (%s) — reconnecting in 5s", e)
            await asyncio.sleep(5)


_HTML_TAGS = re.compile(r"<[^>]+>")


def _derive_headline(doc: dict[str, Any]) -> str:
    h = (doc.get("headline") or "").strip()
    if h:
        return h
    text = (doc.get("text") or "").strip()
    if not text:
        return ""
    return _HTML_TAGS.sub("", text.split("\n", 1)[0]).strip()[:200]


def _serialize_event(doc: dict[str, Any]) -> dict[str, Any]:
    """Project an event doc to a JSON-safe SSE payload."""
    tickers = doc.get("tickers", []) or []
    return {
        "id": str(doc.get("_id", "")),
        "headline": _derive_headline(doc),
        "tickers": tickers,
        "sector": doc.get("sector") or "",
        "impact": doc.get("impact", ""),
        "source_type": doc.get("source_type", ""),
        "published_at": _iso(doc.get("published_at")),
        "has_cascade": bool(_cascadable_tickers and any(t in _cascadable_tickers for t in tickers)),
    }


def _iso(v: Any) -> str:
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v) if v else ""


async def _broadcast(payload: dict[str, Any]) -> None:
    """Drop the payload into every subscriber's queue (non-blocking)."""
    async with _subscribers_lock:
        dead: list[asyncio.Queue] = []
        for q in _subscribers:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            _subscribers.discard(q)


async def _watch_geo_triggers(db: AsyncIOMotorDatabase) -> None:
    """
    Tail events for M6.0+ quakes and Extreme NOAA alerts. Auto-fire a geo
    cascade for each and persist it under cascades.raw_event_id so the
    frontend can pull it. This is the "predictive cascade" demo flourish.
    """
    pipeline = [
        {
            "$match": {
                "operationType": "insert",
                "$or": [
                    {
                        "fullDocument.source_type": "usgs_quake",
                        "fullDocument.geo.magnitude": {"$gte": 6.0},
                    },
                    {
                        "fullDocument.source_type": "noaa_alert",
                        "fullDocument.impact": "critical",
                    },
                ],
            }
        }
    ]
    while True:
        try:
            log.info("geo-trigger watcher starting")
            async with db.events.watch(pipeline=pipeline, full_document="updateLookup") as stream:
                async for change in stream:
                    doc = change.get("fullDocument") or {}
                    asyncio.create_task(_handle_geo_event(doc, db))
        except Exception as e:
            log.warning("geo-trigger watcher error (%s) — reconnecting in 5s", e)
            await asyncio.sleep(5)


async def _handle_geo_event(doc: dict[str, Any], db: AsyncIOMotorDatabase) -> None:
    """Build a geo cascade for a quake/alert event and persist it."""
    geo = doc.get("geo") or {}
    coords = geo.get("coordinates") if isinstance(geo, dict) else None
    if not coords or len(coords) < 2:
        return
    lng, lat = coords[0], coords[1]
    radius_km = 250.0 if doc.get("source_type") == "usgs_quake" else 150.0
    event_id = str(doc.get("_id", ""))

    try:
        pipeline = [
            {
                "$geoNear": {
                    "near": {"type": "Point", "coordinates": [lng, lat]},
                    "distanceField": "dist_m",
                    "maxDistance": radius_km * 1000,
                    "spherical": True,
                    "key": "loc",
                }
            },
            {"$limit": 20},
        ]
        nearby = await db.companies.aggregate(pipeline).to_list(length=20)
    except Exception as e:
        log.warning("geo aggregate failed (%s)", e)
        return

    if not nearby:
        return

    nodes = []
    for d in nearby:
        nodes.append({
            "ticker": d.get("ticker", ""),
            "company": d.get("name", ""),
            "sector": d.get("sector", ""),
            "level": "L1",
            "hop": 1,
            "relationship_type": "geo_exposure",
            "cascade_score": max(0.1, 1.0 - (d.get("dist_m", 0) / (radius_km * 1000))),
            "why": f"HQ within {radius_km:.0f}km of {doc.get('source_type', 'event')}",
            "event_id": event_id,
        })

    cascade_doc = {
        "raw_event_id": event_id,
        "root": {
            "id": event_id,
            "headline": doc.get("text", "")[:200],
            "tickers": [],
            "impact": doc.get("impact", "high"),
            "sector": doc.get("sector", "Geographic"),
            "published_at": _iso(doc.get("published_at")),
            "source_type": doc.get("source_type", "geo"),
        },
        "nodes": nodes,
        "edges": [],
        "hop_counts": {"L1": len(nodes)},
        "summary": f"Auto-cascade: {len(nodes)} companies HQ'd within {radius_km:.0f}km",
        "severity": "high",
        "auto_triggered": True,
        "created_at": datetime.now(timezone.utc),
    }
    try:
        await db.cascades.update_one(
            {"raw_event_id": event_id},
            {"$setOnInsert": cascade_doc},
            upsert=True,
        )
        log.info("auto geo-cascade persisted: event=%s nodes=%d", event_id, len(nodes))
    except Exception as e:
        log.warning("geo cascade persist failed (%s)", e)


async def start_watcher(db: AsyncIOMotorDatabase) -> None:
    """Kick off the singleton change-stream watchers on app startup."""
    global _watcher_task, _geo_watcher_task, _db_ref
    _db_ref = db
    if _watcher_task is None or _watcher_task.done():
        _watcher_task = asyncio.create_task(_watch_changes(db), name="events-watcher")
    if _geo_watcher_task is None or _geo_watcher_task.done():
        _geo_watcher_task = asyncio.create_task(_watch_geo_triggers(db), name="geo-watcher")


async def stop_watcher() -> None:
    global _watcher_task, _geo_watcher_task
    for task in (_watcher_task, _geo_watcher_task):
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
    _watcher_task = None
    _geo_watcher_task = None


async def _backfill_recent(limit: int = 50) -> list[dict[str, Any]]:
    """Pull the most recent high/critical events so the globe is never empty
    on first connect — judges should see life immediately, not wait for the
    next inbound change-stream event."""
    if _db_ref is None:
        return []
    try:
        cursor = (
            _db_ref.events.find(
                {"impact": {"$in": ["critical", "high", "medium"]}},
                {
                    "_id": 1, "headline": 1, "text": 1, "tickers": 1, "sector": 1,
                    "impact": 1, "source_type": 1, "published_at": 1,
                },
            )
            .sort("published_at", -1)
            .limit(limit)
        )
        docs = await cursor.to_list(length=limit)
        return [_serialize_event(d) for d in docs]
    except Exception as e:
        log.warning("backfill query failed (%s)", e)
        return []


async def sse_event_generator(request: Request) -> AsyncIterator[dict[str, Any]]:
    """
    Per-client async generator. Yields sse-starlette events for every
    broadcasted change. Sends a heartbeat every 15s so proxies don't close
    the connection.
    """
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
    async with _subscribers_lock:
        _subscribers.add(queue)

    # Send an initial ready event so the client knows the channel is live.
    yield {"event": "ready", "data": json.dumps({"ok": True})}

    # Backfill: flush the most-recent events as one payload so the globe
    # has signal before the next change-stream tick.
    backfill = await _backfill_recent(limit=50)
    if backfill:
        yield {"event": "backfill", "data": json.dumps({"events": backfill})}

    try:
        while True:
            if await request.is_disconnected():
                break
            try:
                payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                yield {"event": "event", "data": json.dumps(payload)}
            except asyncio.TimeoutError:
                # Heartbeat with server time so the client can show
                # "last event Xs ago" grounded in server clock, not browser idle.
                yield {
                    "event": "heartbeat",
                    "data": json.dumps({"ts": datetime.now(timezone.utc).isoformat()}),
                }
    finally:
        async with _subscribers_lock:
            _subscribers.discard(queue)
