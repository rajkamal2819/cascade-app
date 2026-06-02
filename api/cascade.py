"""
/cascade routes — build and fetch supply-chain cascade trees.

POST /cascade
    body: {event_id, max_hops, top_k}
    runs build_cascade ($graphLookup + rerank-2.5). The Gemini-synthesised
    narrative ("summary") is cached in the cascades collection keyed by
    raw_event_id; on cache hit (<24h old) we return it inline. On miss we
    return the cascade immediately and kick off synthesis in the background.

GET /cascade/{id}
    returns a previously-synthesised cascade by its Mongo ObjectId.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from agent.cascade_reasoning import synthesize_cascade
from agent.society import run_society
from agent.tools import build_cascade
from api.deps import get_db
from api.models import CascadeRequest, CascadeResponse

router = APIRouter()
log = logging.getLogger(__name__)

CACHE_TTL_HOURS = 24


async def _synth_and_persist(raw: dict, event_id: str, db: AsyncIOMotorDatabase) -> None:
    """Background task — synth + persist. Failure is non-fatal and logged."""
    try:
        synth = await synthesize_cascade(raw)
        await db.cascades.insert_one({
            **synth,
            "raw_event_id": event_id,
            "created_at": datetime.now(timezone.utc),
        })
    except Exception as e:
        log.warning("background cascade synthesis failed: %s", e)


async def _society_and_persist(
    raw: dict,
    event_id: str,
    db: AsyncIOMotorDatabase,
    device_id: str = "",
) -> None:
    """
    Background task — two-stage society persistence:
      1. Persist instant LOCAL fallbacks for all 4 agents (≤200ms) so the
         frontend renders content immediately instead of buffering.
      2. Fire Gemini calls in parallel; whichever land before the 15s
         per-agent timeout overwrite the local content with `_source=gemini`.
         If Gemini hangs/fails, the local content stays — user never sees a
         spinner stall.
    """
    from agent.society import (
        critique, predict, memory as memory_agent, eli5 as eli5_agent,
        _critic_local, _predict_local, _memory_local, _eli5_local,
    )

    async def _persist_field(key: str, value) -> None:
        try:
            await db.cascades.update_one(
                {"raw_event_id": event_id},
                {
                    "$set": {
                        f"society.{key}": value,
                        f"society_{key}_at": datetime.now(timezone.utc),
                    },
                    "$setOnInsert": {
                        "raw_event_id": event_id,
                        "created_at": datetime.now(timezone.utc),
                    },
                },
                upsert=True,
            )
        except Exception as e:
            log.warning("society persist %s failed: %s", key, e)

    # Pre-load this user's last 20 cascade views for the Memory agent.
    history: list = []
    if device_id:
        try:
            history = await db.user_memory.find(
                {"device_id": device_id, "event_id": {"$ne": event_id}},
                {"_id": 0, "root_ticker": 1, "sector": 1, "headline": 1, "viewed_at": 1},
            ).sort("viewed_at", -1).limit(20).to_list(length=20)
        except Exception:
            history = []

    # --- Stage 1: instant local fallbacks (always persist these first) ---
    await asyncio.gather(
        _persist_field("critic", _critic_local(raw)),
        _persist_field("predictor", _predict_local(raw)),
        _persist_field("memory", _memory_local(raw, hist_size=len(history))),
        _persist_field("eli5", _eli5_local(raw)),
    )

    # --- Stage 2: upgrade with Gemini where it lands within the timeout ---
    async def _upgrade(key: str, coro_factory) -> None:
        try:
            value = await coro_factory()
            # Only overwrite if the agent actually reached Gemini (not its own
            # internal fallback) — keeps the instant local copy otherwise.
            src = (value or {}).get("_source") if isinstance(value, dict) else None
            if src == "gemini":
                await _persist_field(key, value)
        except Exception as e:
            log.warning("society upgrade %s failed: %s", key, e)

    async def _upgrade_eli5() -> None:
        try:
            text = await eli5_agent(raw)
            local_text = _eli5_local(raw)
            if text and text.strip() and text.strip() != local_text.strip():
                await _persist_field("eli5", text)
        except Exception as e:
            log.warning("society upgrade eli5 failed: %s", e)

    await asyncio.gather(
        _upgrade("critic", lambda: critique(raw)),
        _upgrade("predictor", lambda: predict(raw)),
        _upgrade("memory", lambda: memory_agent(raw, history=history)),
        _upgrade_eli5(),
        return_exceptions=False,
    )


@router.post("/cascade", response_model=CascadeResponse)
async def post_cascade(
    req: CascadeRequest,
    background: BackgroundTasks,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> CascadeResponse:
    try:
        raw = await build_cascade(
            event_id=req.event_id,
            max_hops=req.max_hops,
            top_k=req.top_k,
        )
    except Exception as e:
        log.exception("build_cascade failed")
        raise HTTPException(status_code=500, detail=f"build_cascade failed: {e}")

    if "error" in raw:
        raise HTTPException(status_code=404, detail=raw["error"])

    # Cache check: any narrative synthesised in the last 24h for this event?
    since = datetime.now(timezone.utc) - timedelta(hours=CACHE_TTL_HOURS)
    cached = await db.cascades.find_one(
        {"raw_event_id": req.event_id, "created_at": {"$gte": since}},
        sort=[("created_at", -1)],
    )
    if cached and cached.get("summary"):
        raw["narrative"] = cached.get("summary", "")
        raw["severity"] = cached.get("severity", "")
    else:
        # Cache miss → fire-and-forget background synth. The next call within
        # 24h will pick up the cached narrative.
        background.add_task(_synth_and_persist, raw, req.event_id, db)

    # Always kick off society if it isn't cached yet — independent of narrative.
    if not (cached and cached.get("society")):
        background.add_task(_society_and_persist, raw, req.event_id, db, req.device_id)

    return CascadeResponse(**raw)


@router.get("/cascade/by-event/{event_id}/society")
async def get_society(
    event_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> dict:
    """
    Poll for the multi-agent Society. Returns whatever agents have completed
    so far; `ready` is true once at least one agent is done, and `done` is
    true once all four are. Frontend reveals each agent as its field appears.
    """
    since = datetime.now(timezone.utc) - timedelta(hours=CACHE_TTL_HOURS)
    doc = await db.cascades.find_one(
        {"raw_event_id": event_id, "created_at": {"$gte": since}},
        sort=[("created_at", -1)],
    )
    if not doc:
        return {"ready": False, "done": False}
    society = doc.get("society") or {}
    fields = {
        "critic": society.get("critic"),
        "predictor": society.get("predictor"),
        "memory": society.get("memory"),
        "eli5": society.get("eli5"),
    }
    have = {k: v for k, v in fields.items() if v}
    return {
        "ready": bool(have),
        "done": len(have) == 4,
        **{k: (v if v else {}) for k, v in fields.items() if k != "eli5"},
        "eli5": fields["eli5"] or "",
    }


@router.get("/memory/recent")
async def get_memory_recent(
    device_id: str,
    limit: int = 20,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> dict:
    """
    Return the calling device's recent cascade views — feeds the Memory
    agent's client-side timeline, sector-radar, and déjà-vu visualisations.
    No LLM hop required; this is direct collection state.
    """
    if not device_id:
        return {"items": [], "count": 0}
    cur = db.user_memory.find(
        {"device_id": device_id},
        {"_id": 0, "event_id": 1, "root_ticker": 1, "sector": 1, "headline": 1, "viewed_at": 1},
    ).sort("viewed_at", -1).limit(max(1, min(100, limit)))
    docs = await cur.to_list(length=limit)
    # ISO-format the timestamps for the client.
    for d in docs:
        v = d.get("viewed_at")
        if isinstance(v, datetime):
            d["viewed_at"] = v.isoformat()
    return {"items": docs, "count": len(docs)}


@router.delete("/memory/{device_id}")
async def delete_memory(
    device_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> dict:
    """Wipe this device's view history — the 'forget me' button."""
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id required")
    res = await db.user_memory.delete_many({"device_id": device_id})
    return {"ok": True, "deleted": res.deleted_count}


@router.post("/memory/cascade-view")
async def log_cascade_view(payload: dict, db: AsyncIOMotorDatabase = Depends(get_db)) -> dict:
    """
    Record an anonymous device-id-keyed view so the Memory agent has actual
    history to reason about. No PII — caller passes a random device_id
    persisted in localStorage on the client.
    """
    device_id = (payload.get("device_id") or "").strip()
    event_id = (payload.get("event_id") or "").strip()
    if not device_id or not event_id:
        raise HTTPException(status_code=400, detail="device_id and event_id required")
    doc = {
        "device_id": device_id[:64],
        "event_id": event_id[:64],
        "root_ticker": (payload.get("root_ticker") or "")[:16],
        "sector": (payload.get("sector") or "")[:64],
        "headline": (payload.get("headline") or "")[:200],
        "viewed_at": datetime.now(timezone.utc),
    }
    try:
        await db.user_memory.insert_one(doc)
    except Exception as e:
        log.warning("user_memory insert failed: %s", e)
    return {"ok": True}


@router.get("/cascade/{cascade_id}")
async def get_cascade(
    cascade_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> dict:
    try:
        oid = ObjectId(cascade_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="invalid cascade id")

    doc = await db.cascades.find_one({"_id": oid})
    if not doc:
        raise HTTPException(status_code=404, detail="cascade not found")
    doc["id"] = str(doc.pop("_id"))
    if isinstance(doc.get("created_at"), datetime):
        doc["created_at"] = doc["created_at"].isoformat()
    return doc


@router.post("/cascade/geo")
async def post_cascade_geo(
    payload: dict,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> dict:
    """
    Geo-cascade — find companies HQ'd within `radius_km` of (lat, lng) and
    return them as a cascade structure. Used by USGS quake + NOAA weather
    auto-cascades. Requires a 2dsphere index on companies.hq_coords (loc).

    Body: {lat: float, lng: float, radius_km: float, root_text?: str}
    """
    try:
        lat = float(payload["lat"])
        lng = float(payload["lng"])
        radius_km = float(payload.get("radius_km", 200))
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="lat/lng required")
    root_text = (payload.get("root_text") or "Geographic event").strip()[:200]

    # $geoNear requires a 2dsphere index. Fall back to client-side filter if absent.
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
        docs = await db.companies.aggregate(pipeline).to_list(length=20)
    except Exception:
        docs = []

    nodes = []
    for d in docs:
        nodes.append({
            "ticker": d.get("ticker", ""),
            "company": d.get("name", ""),
            "sector": d.get("sector", ""),
            "level": "L1",
            "hop": 1,
            "relationship_type": "geo_exposure",
            "cascade_score": max(0.1, 1.0 - (d.get("dist_m", 0) / (radius_km * 1000))),
            "why": f"HQ within {radius_km:.0f}km of event",
            "event_id": "",
        })

    return {
        "root": {
            "id": "",
            "headline": root_text,
            "tickers": [],
            "impact": "high",
            "sector": "Geographic",
            "published_at": "",
            "source_type": "geo",
        },
        "nodes": nodes,
        "edges": [],
        "hop_counts": {"L1": len(nodes)},
        "message": f"{len(nodes)} companies HQ'd within {radius_km:.0f}km",
        "fallback": "" if nodes else "no_geo_matches",
        "narrative": "",
        "severity": "high" if nodes else "",
    }


@router.get("/cascade/by-event/{event_id}/narrative")
async def get_narrative(
    event_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> dict:
    """Poll for the Gemini narrative — frontend can refetch shortly after
    the initial /cascade call to pick up the synthesised summary."""
    since = datetime.now(timezone.utc) - timedelta(hours=CACHE_TTL_HOURS)
    doc = await db.cascades.find_one(
        {"raw_event_id": event_id, "created_at": {"$gte": since}},
        sort=[("created_at", -1)],
    )
    if not doc:
        return {"ready": False}
    return {
        "ready": True,
        "narrative": doc.get("summary", ""),
        "severity": doc.get("severity", ""),
        "risk_factors": doc.get("risk_factors", []),
        "confidence": doc.get("confidence", 0),
    }
