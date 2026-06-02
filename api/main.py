"""
Cascade FastAPI application.

Routes:
    GET  /health             — liveness + dependency status
    GET  /events             — paginated event feed
    GET  /events/{id}        — single event by id
    POST /search             — hybrid vector + text search (rerank-2.5)
    POST /cascade            — build cascade via $graphLookup + rerank
    GET  /cascade/{id}       — fetch a persisted cascade
    GET  /stats              — $facet dashboard counts
    GET  /watchlist/{user}   — read watchlist
    POST /watchlist          — upsert watchlist
    GET  /stream             — Server-Sent Events backed by change streams
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from sse_starlette.sse import EventSourceResponse

from agent.tools import aggregate_stats
from api.cascade import router as cascade_router
from api.deps import DB_NAME, get_db
from api.models import (
    EventList,
    EventOut,
    HealthResponse,
    StatsResponse,
    WatchlistItem,
)
from api.multimodal import router as multimodal_router
from api.search import router as search_router
from api.sse import set_cascadable_tickers, sse_event_generator, start_watcher, stop_watcher

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format='{"ts":"%(asctime)s","level":"%(levelname)s","name":"%(name)s","msg":"%(message)s"}',
)
log = logging.getLogger("cascade.api")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Open Motor + start change-stream watcher; tear down on shutdown."""
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        raise RuntimeError("MONGODB_URI not set")

    client = AsyncIOMotorClient(
        uri,
        maxPoolSize=10,
        serverSelectionTimeoutMS=5000,
        appname="cascade-api",
    )
    await client.admin.command("ping")
    app.state.mongo = client
    app.state.db = client[DB_NAME]

    # Cache the set of tickers that have outgoing relationships — used to
    # tell the UI which events will produce a non-empty cascade.
    try:
        cursor = app.state.db.relationships.distinct("from_ticker")
        app.state.cascadable_tickers = set(await cursor)
        set_cascadable_tickers(app.state.cascadable_tickers)
        log.info("cascadable tickers cached: %d", len(app.state.cascadable_tickers))
    except Exception as e:
        log.warning("cascadable cache failed: %s", e)
        app.state.cascadable_tickers = set()

    # Cache ticker→sector so events with missing sector can be enriched at
    # serialise time. Workers don't all populate sector, but companies do.
    try:
        ticker_sector: dict[str, str] = {}
        async for co in app.state.db.companies.find({}, {"ticker": 1, "sector": 1}):
            t = co.get("ticker")
            s = co.get("sector")
            if t and s:
                ticker_sector[t] = s
        app.state.ticker_sector = ticker_sector
        log.info("ticker→sector cached: %d", len(ticker_sector))
    except Exception as e:
        log.warning("ticker→sector cache failed: %s", e)
        app.state.ticker_sector = {}

    # Best-effort: change streams require a replica set. Atlas M0 is one.
    try:
        await start_watcher(app.state.db)
    except Exception as e:
        log.warning("change-stream watcher failed to start: %s", e)

    try:
        yield
    finally:
        await stop_watcher()
        client.close()


app = FastAPI(
    title="Cascade API",
    description="Real-time market cascade intelligence.",
    version="0.5.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tightened to https://*.vercel.app + localhost in Phase 7
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(search_router, tags=["search"])
app.include_router(cascade_router, tags=["cascade"])
app.include_router(multimodal_router)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
async def health(db: AsyncIOMotorDatabase = Depends(get_db)) -> HealthResponse:
    mongo_ok = "ok"
    events_24h = 0
    try:
        since = datetime.now(timezone.utc) - timedelta(hours=24)
        events_24h = await db.events.count_documents({"published_at": {"$gte": since}})
    except Exception as e:
        mongo_ok = f"error: {e}"

    voyage_ok = "configured" if os.environ.get("VOYAGE_API_KEY") else "missing"
    gemini_model = os.environ.get("GEMINI_MODEL", "unset")

    return HealthResponse(
        ok=(mongo_ok == "ok"),
        mongo=mongo_ok,
        voyage=voyage_ok,
        gemini_model=gemini_model,
        events_24h=events_24h,
    )


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

_HTML_TAGS = re.compile(r"<[^>]+>")
_SEC_COMPANY = re.compile(r"^8-K\s*-\s*([^()]+?)\s*\(\d", re.IGNORECASE)
_SEC_ITEM = re.compile(r"Item\s+(\d+\.\d+)\s*:\s*([^\n<]+)", re.IGNORECASE)


def derive_headline(doc: dict) -> str:
    """
    Workers don't all populate `headline` — derive a readable one from
    `text` and `items` when missing. SEC 8-K entries get a friendly
    "COMPANY · Item X.XX: Description" form instead of the raw feed line.
    """
    h = (doc.get("headline") or "").strip()
    if h:
        return h
    text = (doc.get("text") or "").strip()
    if not text:
        return ""

    # SEC 8-K — extract company and Item code description.
    if doc.get("source_type") == "sec_8k":
        cleaned = _HTML_TAGS.sub(" ", text)
        company = ""
        m = _SEC_COMPANY.search(cleaned)
        if m:
            company = m.group(1).strip().rstrip(",").title()
        item = ""
        mi = _SEC_ITEM.search(cleaned)
        if mi:
            item = f"Item {mi.group(1)}: {mi.group(2).strip()}"
        if company and item:
            return f"{company} · {item}"[:200]
        if company:
            return f"{company} · 8-K filing"[:200]

    # Fallback: first non-empty line of text, HTML stripped.
    first = text.split("\n", 1)[0]
    return _HTML_TAGS.sub("", first).strip()[:200]


def _serialize_event(
    doc: dict,
    cascadable: set[str] | None = None,
    ticker_sector: dict[str, str] | None = None,
) -> EventOut:
    tickers = doc.get("tickers", []) or []
    has_cascade = bool(cascadable and any(t in cascadable for t in tickers))

    # Enrich sector when worker didn't set it: look up the first known ticker.
    sector = (doc.get("sector") or "").strip()
    if not sector and ticker_sector:
        for t in tickers:
            if t in ticker_sector:
                sector = ticker_sector[t]
                break

    return EventOut(
        id=str(doc.get("_id", "")),
        headline=derive_headline(doc),
        text=doc.get("text", "") or "",
        tickers=tickers,
        entities=doc.get("entities", []) or [],
        sector=sector,
        impact=doc.get("impact", "") or "",
        source_type=doc.get("source_type", "") or "",
        source_url=doc.get("source_url") or doc.get("url") or "",
        published_at=doc.get("published_at"),
        ingested_at=doc.get("ingested_at"),
        has_cascade=has_cascade,
        replay=(doc.get("replay") or ""),
    )


@app.get("/events", response_model=EventList)
async def list_events(
    request: Request,
    ticker: str = "",
    sector: str = "",
    impact: str = "",
    source_type: str = "",
    hours_back: int = Query(default=24, ge=1, le=720),
    limit: int = Query(default=80, ge=1, le=200),
    cascadable_only: bool = False,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> EventList:
    since = datetime.now(timezone.utc) - timedelta(hours=hours_back)
    q: dict = {"published_at": {"$gte": since}}
    if ticker:
        q["tickers"] = ticker.upper()
    if impact:
        q["impact"] = impact
    if source_type:
        q["source_type"] = source_type

    cascadable: set[str] = getattr(request.app.state, "cascadable_tickers", set())
    ticker_sector: dict[str, str] = getattr(request.app.state, "ticker_sector", {})

    if cascadable_only and cascadable:
        q["tickers"] = {"$in": list(cascadable)}

    # Sector filter applies after enrichment (since stored sector is often empty).
    # We over-fetch a bit to allow filtering server-side.
    fetch_limit = limit * 3 if sector else limit
    cursor = db.events.find(q).sort("published_at", -1).limit(fetch_limit)
    docs = await cursor.to_list(length=fetch_limit)
    events = [_serialize_event(d, cascadable, ticker_sector) for d in docs]
    if sector:
        events = [e for e in events if e.sector == sector]
    events = events[:limit]
    # Stable sort: cascadable first (within the existing time order).
    events.sort(key=lambda e: 0 if e.has_cascade else 1)
    return EventList(events=events, count=len(events))


@app.get("/events/{event_id}", response_model=EventOut)
async def get_event(event_id: str, request: Request, db: AsyncIOMotorDatabase = Depends(get_db)) -> EventOut:
    try:
        oid = ObjectId(event_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="invalid event id")

    doc = await db.events.find_one({"_id": oid})
    if not doc:
        raise HTTPException(status_code=404, detail="event not found")
    cascadable: set[str] = getattr(request.app.state, "cascadable_tickers", set())
    ticker_sector: dict[str, str] = getattr(request.app.state, "ticker_sector", {})
    return _serialize_event(doc, cascadable, ticker_sector)


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

@app.get("/stats", response_model=StatsResponse)
async def stats(
    sector: str = "",
    hours_back: int = Query(default=24, ge=1, le=168),
) -> StatsResponse:
    result = await aggregate_stats(sector=sector, hours_back=hours_back)
    return StatsResponse(**result)


# ---------------------------------------------------------------------------
# Watchlist
# ---------------------------------------------------------------------------

@app.get("/watchlist/{user_id}", response_model=WatchlistItem)
async def get_watchlist(
    user_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> WatchlistItem:
    doc = await db.watchlists.find_one({"user_id": user_id})
    if not doc:
        return WatchlistItem(user_id=user_id, tickers=[])
    return WatchlistItem(user_id=user_id, tickers=doc.get("tickers", []))


@app.post("/watchlist", response_model=WatchlistItem)
async def upsert_watchlist(
    item: WatchlistItem,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> WatchlistItem:
    tickers = [t.upper() for t in item.tickers if t]
    await db.watchlists.update_one(
        {"user_id": item.user_id},
        {
            "$set": {"tickers": tickers, "updated_at": datetime.now(timezone.utc)},
            "$setOnInsert": {"created_at": datetime.now(timezone.utc)},
        },
        upsert=True,
    )
    return WatchlistItem(user_id=item.user_id, tickers=tickers)


# ---------------------------------------------------------------------------
# Admin: manual worker fan-out
#
# Runs every poll-style worker once concurrently so judges can refresh the
# feed on demand without waiting for the cron tick. WebSocket workers
# (finnhub_ws, aisstream) are skipped — they connect persistently and don't
# have a one-shot semantic. Cooldown guard prevents rate-limit bursts (Voyage
# free tier is 3 RPM).
# ---------------------------------------------------------------------------

_REFRESH_COOLDOWN_S = 30
_last_refresh_at = 0.0
_refresh_lock = asyncio.Lock()


async def _run_one(name: str, fn):  # type: ignore[no-untyped-def]
    try:
        await fn()
        return {"worker": name, "ok": True}
    except Exception as e:  # noqa: BLE001 — surface to UI
        log.warning("refresh worker %s failed: %s", name, e)
        return {"worker": name, "ok": False, "error": str(e)[:200]}


@app.post("/admin/refresh")
async def admin_refresh(request: Request) -> dict:
    """Fan out a one-shot run across all poll-style workers."""
    global _last_refresh_at
    now = asyncio.get_event_loop().time()
    if now - _last_refresh_at < _REFRESH_COOLDOWN_S:
        wait = int(_REFRESH_COOLDOWN_S - (now - _last_refresh_at))
        raise HTTPException(
            status_code=429,
            detail=f"Refresh on cooldown — try again in {wait}s.",
        )
    if _refresh_lock.locked():
        raise HTTPException(status_code=409, detail="A refresh is already running.")

    async with _refresh_lock:
        _last_refresh_at = asyncio.get_event_loop().time()

        # Lazy imports so the api container doesn't pay startup cost for
        # worker modules unless a refresh is actually requested.
        from workers import gdelt, noaa, opensky, usgs  # work() entrypoints
        from workers import (  # poll_once()
            alpha_vantage,
            marketaux,
            reddit,
            rss_news,
            sec_edgar,
            yfinance_ticks,
        )

        jobs = [
            ("rss_news", rss_news.poll_once),   # tech / industrial / energy via RSS
            ("gdelt", gdelt.work),
            ("noaa", noaa.work),
            ("usgs", usgs.work),
            ("opensky", opensky.work),
            ("marketaux", marketaux.poll_once),
            ("sec_edgar", sec_edgar.poll_once),
            ("reddit", reddit.poll_once),
            ("alpha_vantage", alpha_vantage.poll_once),
            ("yfinance_ticks", yfinance_ticks.poll_once),
        ]
        results = await asyncio.gather(*(_run_one(n, f) for n, f in jobs))

    ok = sum(1 for r in results if r["ok"])

    # Pre-warm Gemini Geo-Cascade for the freshest tickerless impactful
    # events — judges click those first and we don't want them watching a
    # 5–8s Pro call. Bounded (top 5, 4-concurrent) so we don't blow the
    # 100/day Pro free-tier cap on a single refresh.
    prewarmed = 0
    try:
        prewarmed = await _prewarm_geo_cascade(request.app.state.db, limit=5)
    except Exception as e:
        log.warning("geo prewarm failed: %s", e)

    return {
        "ran": len(results),
        "succeeded": ok,
        "failed": len(results) - ok,
        "workers": results,
        "geo_prewarmed": prewarmed,
    }


async def _prewarm_geo_cascade(db, limit: int = 5) -> int:
    """Fire Gemini geo-cascade on top-N recent tickerless impactful events
    and cache the hypothesis on the event doc. Concurrency-bounded; per-call
    failures are swallowed so one bad event can't break the whole sweep."""
    from agent.geo_cascade import build_geo_cascade, is_geo_candidate, TICKERLESS_SECTORS

    cur = db.events.find(
        {
            "tickers": {"$in": [None, []]},
            "impact": {"$in": ["medium", "high", "critical"]},
            "sector": {"$in": list(TICKERLESS_SECTORS)},
            "geo_cascade": {"$exists": False},
        },
        {"_id": 1, "headline": 1, "text": 1, "sector": 1, "impact": 1,
         "published_at": 1, "source_type": 1, "tickers": 1},
    ).sort("published_at", -1).limit(limit)
    candidates = await cur.to_list(length=limit)

    sem = asyncio.Semaphore(2)

    async def _one(doc: dict) -> bool:
        if not is_geo_candidate(doc):
            return False
        async with sem:
            try:
                resp = await build_geo_cascade(doc, str(doc["_id"]), db)
                return bool(resp and resp.get("nodes"))
            except Exception as e:
                log.warning("geo prewarm one failed: %s", e)
                return False

    flags = await asyncio.gather(*(_one(d) for d in candidates))
    return sum(1 for f in flags if f)


# ---------------------------------------------------------------------------
# Server-Sent Events — backed by MongoDB change streams
# ---------------------------------------------------------------------------

@app.get("/stream")
async def stream(request: Request) -> EventSourceResponse:
    return EventSourceResponse(sse_event_generator(request))
