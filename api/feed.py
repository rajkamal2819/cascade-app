"""
Lean Aurora-backed routes powering the Cascade UI.

Implements the minimum surface the Next.js app calls so the live deployment
can show feed + cascade + search + stats + memory end-to-end. Full hybrid
search with Voyage rerank, Gemini synthesis, and DynamoDB-Streams-driven
SSE come online as their secrets / wiring land.

    GET    /api/events                              — feed
    GET    /api/events/{id}                         — single event
    GET    /api/stats                               — dashboard counts
    POST   /api/search                              — Postgres FTS for now
    POST   /api/cascade                             — recursive-CTE cascade build
    GET    /api/cascade/by-event/{id}               — alias for the POST shape
    GET    /api/cascade/by-event/{id}/society       — placeholder (no Gemini yet)
    GET    /api/cascade/by-event/{id}/narrative     — placeholder (no Gemini yet)
    GET    /api/stream                              — SSE heartbeat
    POST   /api/memory/cascade-view                 — DynamoDB single-table
    GET    /api/memory/recent                       — DynamoDB
    DELETE /api/memory/{device_id}                  — DynamoDB
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator

from boto3.dynamodb.conditions import Key
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from db import aurora, dynamo
from db.schema import CASCADE_WALK_SQL
from agent import society as society_agent
from agent import cascade_reasoning
from agent import geo_cascade as geo_agent

router = APIRouter(prefix="/api", tags=["feed"])


def _impact_bucket(score: float | None) -> str:
    if score is None:
        return "low"
    if score >= 0.75:
        return "critical"
    if score >= 0.5:
        return "high"
    if score >= 0.25:
        return "medium"
    return "low"


def _serialize_event(row: dict, cascadable: set[str] | None = None) -> dict[str, Any]:
    tickers = list(row.get("tickers") or [])
    sectors = list(row.get("sectors") or [])
    has_cascade = bool(cascadable and any(t in cascadable for t in tickers))
    return {
        "id": str(row["id"]),
        "headline": row.get("title") or "",
        "text": row.get("body") or "",
        "tickers": tickers,
        "entities": [],
        "sector": sectors[0] if sectors else "",
        "impact": _impact_bucket(row.get("impact")),
        "source_type": row.get("source_type") or "",
        "source_url": row.get("url") or "",
        "published_at": row["published_at"].isoformat() if row.get("published_at") else None,
        "ingested_at": row["ingested_at"].isoformat() if row.get("ingested_at") else None,
        "has_cascade": has_cascade,
        "replay": "",
    }


async def _cascadable_tickers(conn) -> set[str]:
    rows = await conn.fetch("SELECT DISTINCT from_ticker FROM relationships")
    return {r["from_ticker"] for r in rows}


# ---------------------------------------------------------------- events ----

@router.get("/events")
async def list_events(
    ticker: str | None = None,
    sector: str | None = None,
    impact: str | None = None,
    source_type: str | None = None,
    hours_back: int = Query(default=24, ge=1, le=24 * 90),
    limit: int = Query(default=100, ge=1, le=500),
    cascadable_only: bool = Query(default=False),
) -> dict[str, Any]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours_back)
    pool = await aurora.get_pool()
    clauses = ["published_at >= $1"]
    params: list[Any] = [cutoff]
    if ticker:
        params.append(ticker.upper())
        clauses.append(f"${len(params)} = ANY(tickers)")
    if sector:
        params.append(sector)
        clauses.append(f"${len(params)} = ANY(sectors)")
    if source_type:
        params.append(source_type)
        clauses.append(f"source_type = ${len(params)}")
    sql = (
        "SELECT id, title, body, url, source_type, published_at, ingested_at, "
        "       tickers, sectors, impact "
        f"FROM events WHERE {' AND '.join(clauses)} "
        f"ORDER BY published_at DESC LIMIT {limit}"
    )
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)
        cascadable = await _cascadable_tickers(conn)
    events = [_serialize_event(dict(r), cascadable) for r in rows]
    if impact:
        events = [e for e in events if e["impact"] == impact]
    if cascadable_only:
        events = [e for e in events if e["has_cascade"]]
    return {"events": events, "count": len(events)}


@router.get("/events/{event_id}")
async def get_event(event_id: str) -> dict[str, Any]:
    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, title, body, url, source_type, published_at, ingested_at, "
            "       tickers, sectors, impact "
            "FROM events WHERE id = $1",
            event_id,
        )
        if not row:
            raise HTTPException(404, "event not found")
        cascadable = await _cascadable_tickers(conn)
    return _serialize_event(dict(row), cascadable)


# ----------------------------------------------------------------- stats ----

@router.get("/stats")
async def stats(hours_back: int = Query(default=24, ge=1, le=24 * 90)) -> dict[str, Any]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours_back)
    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM events WHERE published_at >= $1", cutoff
        )
        cascade_count = await conn.fetchval(
            "SELECT COUNT(*) FROM cascades c JOIN events e ON e.id = c.event_id "
            "WHERE e.published_at >= $1",
            cutoff,
        )
        impact_rows = await conn.fetch(
            "SELECT impact FROM events WHERE published_at >= $1", cutoff
        )
        sector_rows = await conn.fetch(
            "SELECT UNNEST(sectors) AS sector FROM events WHERE published_at >= $1",
            cutoff,
        )
        ticker_rows = await conn.fetch(
            "SELECT UNNEST(tickers) AS ticker, COUNT(*) AS n "
            "FROM events WHERE published_at >= $1 "
            "GROUP BY ticker ORDER BY n DESC LIMIT 10",
            cutoff,
        )

    impact_counts: dict[str, int] = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for r in impact_rows:
        impact_counts[_impact_bucket(r["impact"])] += 1
    sector_counts: dict[str, int] = {}
    for r in sector_rows:
        if r["sector"]:
            sector_counts[r["sector"]] = sector_counts.get(r["sector"], 0) + 1
    top_tickers = [{"ticker": r["ticker"], "count": int(r["n"])} for r in ticker_rows]
    return {
        "impact_counts": impact_counts,
        "sector_counts": sector_counts,
        "top_tickers": top_tickers,
        "total_events": int(total or 0),
        "cascade_count": int(cascade_count or 0),
        "hours_back": hours_back,
    }


# ---------------------------------------------------------------- search ----

class SearchBody(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    sector: str = ""
    impact: str = ""
    days_back: int = Field(default=7, ge=1, le=90)
    limit: int = Field(default=10, ge=1, le=50)


@router.post("/search")
async def search(body: SearchBody) -> dict[str, Any]:
    """Hybrid retrieval: pgvector cosine + Postgres tsvector FTS, fused via
    Reciprocal Rank Fusion, then reranked with Voyage rerank-2.5. Falls back
    to FTS-only if Voyage / embedding is unavailable."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=body.days_back)
    pool = await aurora.get_pool()

    # ------------------------------------------------ embed query (best-effort)
    query_vec: list[float] | None = None
    try:
        from embed.text import embed_query
        query_vec = await embed_query(body.query)
    except Exception:
        query_vec = None

    # ------------------------------------------------------------ candidates --
    fts_params: list[Any] = [cutoff, body.query]
    fts_filters = ["published_at >= $1",
                   "to_tsvector('english', title || ' ' || COALESCE(body,'')) @@ websearch_to_tsquery('english', $2)"]
    if body.sector:
        fts_params.append(body.sector)
        fts_filters.append(f"${len(fts_params)} = ANY(sectors)")
    fts_sql = (
        "SELECT id, title, body, tickers, sectors, impact, source_type, published_at, "
        "       ts_rank(to_tsvector('english', title || ' ' || COALESCE(body,'')), "
        "               websearch_to_tsquery('english', $2)) AS score "
        f"FROM events WHERE {' AND '.join(fts_filters)} "
        f"ORDER BY score DESC, published_at DESC LIMIT 50"
    )

    async with pool.acquire() as conn:
        fts_rows = await conn.fetch(fts_sql, *fts_params)

        vec_rows: list[Any] = []
        if query_vec is not None:
            vec_params: list[Any] = [cutoff, "[" + ",".join(f"{x:.6f}" for x in query_vec) + "]"]
            vec_filters = ["published_at >= $1", "embedding IS NOT NULL"]
            if body.sector:
                vec_params.append(body.sector)
                vec_filters.append(f"${len(vec_params)} = ANY(sectors)")
            vec_sql = (
                "SELECT id, title, body, tickers, sectors, impact, source_type, published_at, "
                "       1 - (embedding <=> $2::vector) AS score "
                f"FROM events WHERE {' AND '.join(vec_filters)} "
                "ORDER BY embedding <=> $2::vector LIMIT 50"
            )
            try:
                vec_rows = await conn.fetch(vec_sql, *vec_params)
            except Exception:
                vec_rows = []

    # -------------------------------------------------- Reciprocal Rank Fusion
    K = 60
    fused: dict[str, dict[str, Any]] = {}
    for rank, r in enumerate(fts_rows):
        eid = str(r["id"])
        fused.setdefault(eid, {"row": dict(r), "score": 0.0})
        fused[eid]["score"] += 1.0 / (K + rank + 1)
    for rank, r in enumerate(vec_rows):
        eid = str(r["id"])
        fused.setdefault(eid, {"row": dict(r), "score": 0.0})
        fused[eid]["score"] += 1.0 / (K + rank + 1)
    candidates = sorted(fused.values(), key=lambda x: -x["score"])[: max(body.limit * 2, 20)]

    # ----------------------------------------------------- Voyage rerank-2.5 --
    try:
        from embed.rerank import rerank_dicts
        docs = [
            {
                "id": str(c["row"]["id"]),
                "text": (c["row"]["title"] or "") + ". " + (c["row"]["body"] or ""),
                "row": c["row"],
                "rrf": c["score"],
            }
            for c in candidates
        ]
        reranked = await rerank_dicts(body.query, docs, text_field="text", top_k=body.limit)
        ordered = [(d["row"], float(d.get("rerank_score") or 0.0)) for d in reranked]
    except Exception:
        ordered = [(c["row"], float(c["score"])) for c in candidates[: body.limit]]

    hits: list[dict[str, Any]] = []
    for row, score in ordered:
        hit = {
            "id": str(row["id"]),
            "headline": row.get("title") or "",
            "tickers": list(row.get("tickers") or []),
            "sector": (list(row.get("sectors") or []) or [""])[0],
            "impact": _impact_bucket(row.get("impact")),
            "source_type": row.get("source_type") or "",
            "published_at": row["published_at"].isoformat() if row.get("published_at") else "",
            "rerank_score": score,
        }
        if body.impact and hit["impact"] != body.impact:
            continue
        hits.append(hit)
    return {"query": body.query, "events": hits, "count": len(hits)}


# --------------------------------------------------------------- cascade ----

class CascadeBody(BaseModel):
    event_id: str
    max_hops: int = Field(default=3, ge=1, le=5)
    top_k: int = Field(default=15, ge=1, le=50)
    device_id: str = ""


async def _ticker_universe(conn) -> dict[str, dict[str, Any]]:
    """Return ticker→{name,sector} map for Gemini ticker validation."""
    rows = await conn.fetch("SELECT ticker, name, sector FROM companies ORDER BY market_cap DESC NULLS LAST LIMIT 200")
    return {r["ticker"]: {"name": r["name"] or "", "sector": r["sector"] or ""} for r in rows}


async def _build_geo_cascade(conn, event_row: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    """Tickerless event path: ask Gemini to infer affected tickers, then walk
    those through the same recursive CTE so the result shape stays consistent."""
    empty = {
        "root": root,
        "nodes": [],
        "edges": [],
        "hop_counts": {},
        "message": "no tickers on root event",
        "fallback": "semantic_no_tickers",
        "narrative": "",
        "severity": "",
        "geo_cascade": None,
    }
    by_ticker = await _ticker_universe(conn)
    if not by_ticker:
        return empty
    gemini_event = {
        "headline": event_row.get("title") or "",
        "text": event_row.get("body") or "",
        "sector": (list(event_row.get("sectors") or []) or [""])[0],
        "impact": _impact_bucket(event_row.get("impact")),
        "published_at": event_row.get("published_at"),
    }
    hypothesis = await geo_agent.gemini_geo_hypothesis_from_universe(gemini_event, by_ticker)
    affected = hypothesis.get("affected_companies") or []
    if not affected:
        empty["geo_cascade"] = {
            "event_type": hypothesis.get("event_type", "other"),
            "regions": hypothesis.get("regions", []),
            "sectors": hypothesis.get("sectors", []),
            "transmission_mechanism": hypothesis.get("transmission_mechanism", ""),
            "time_horizon": hypothesis.get("time_horizon", ""),
            "historical_analog": hypothesis.get("historical_analog", ""),
            "model": hypothesis.get("_model", ""),
        }
        return empty

    # Gemini-inferred L1 nodes become the cascade seed.
    l1_tickers = [c["ticker"] for c in affected if c.get("level", 1) == 1] or [c["ticker"] for c in affected]
    nodes: list[dict[str, Any]] = []
    for c in affected:
        dir_sign = {"negative": -1, "positive": 1, "mixed": 0}.get(c.get("direction", "mixed"), 0)
        nodes.append({
            "ticker": c["ticker"],
            "company": c.get("company", ""),
            "sector": c.get("sector", ""),
            "level": "downstream",
            "hop": int(c.get("level", 1)),
            "relationship_type": f"gemini_{hypothesis.get('event_type', 'other')}",
            "cascade_score": float(c.get("confidence", 0.5)),
            "why": c.get("mechanism", ""),
            "event_id": "",
            "direction": dir_sign,
        })

    # Walk one more hop through the relationships graph from the L1 seeds.
    edges: list[dict[str, Any]] = []
    if l1_tickers:
        walk = await conn.fetch(CASCADE_WALK_SQL, l1_tickers, 2, 0.4)
        seen = {n["ticker"] for n in nodes}
        co_rows = await conn.fetch(
            "SELECT ticker, name, sector FROM companies WHERE ticker = ANY($1::TEXT[])",
            list({r["ticker"] for r in walk}),
        )
        co = {r["ticker"]: dict(r) for r in co_rows}
        for r in walk:
            edges.append({
                "from": r["path_from"],
                "to": r["ticker"],
                "type": r["type"],
                "weight": float(r["edge_weight"]),
                "hop": int(r["hop"]) + 1,
            })
            if r["ticker"] in seen:
                continue
            seen.add(r["ticker"])
            c = co.get(r["ticker"], {})
            nodes.append({
                "ticker": r["ticker"],
                "company": c.get("name") or "",
                "sector": c.get("sector") or "",
                "level": "downstream",
                "hop": int(r["hop"]) + 1,
                "relationship_type": r["type"],
                "cascade_score": float(r["cumulative_weight"]),
                "why": f"{r['type']} of {r['path_from']} (weight {r['edge_weight']:.2f})",
                "event_id": "",
                "direction": 0,
            })

    hop_counts: dict[str, int] = {}
    for n in nodes:
        hop_counts[f"L{n['hop']}"] = hop_counts.get(f"L{n['hop']}", 0) + 1

    return {
        "root": root,
        "nodes": nodes,
        "edges": edges,
        "hop_counts": hop_counts,
        "message": hypothesis.get("transmission_mechanism", "") or "Gemini-inferred regional & sector exposure.",
        "fallback": "gemini_geo",
        "narrative": "",
        "severity": "",
        "geo_cascade": {
            "event_type": hypothesis.get("event_type", "other"),
            "regions": hypothesis.get("regions", []),
            "sectors": hypothesis.get("sectors", []),
            "transmission_mechanism": hypothesis.get("transmission_mechanism", ""),
            "time_horizon": hypothesis.get("time_horizon", ""),
            "historical_analog": hypothesis.get("historical_analog", ""),
            "model": hypothesis.get("_model", ""),
        },
    }


async def _build_cascade(conn, event_id: str, max_hops: int, top_k: int) -> dict[str, Any]:
    event = await conn.fetchrow(
        "SELECT id, title, tickers, sectors, impact, source_type, published_at "
        "FROM events WHERE id = $1",
        event_id,
    )
    if not event:
        raise HTTPException(404, "event not found")
    tickers = list(event["tickers"] or [])
    root = {
        "id": str(event["id"]),
        "headline": event["title"] or "",
        "tickers": tickers,
        "impact": _impact_bucket(event["impact"]),
        "sector": (list(event["sectors"]) or [""])[0],
        "published_at": event["published_at"].isoformat() if event["published_at"] else "",
        "source_type": event["source_type"] or "",
    }
    if not tickers:
        return await _build_geo_cascade(conn, dict(event), root)

    walk = await conn.fetch(CASCADE_WALK_SQL, tickers, max_hops, 0.3)

    # Pull company display info for all referenced tickers in one query.
    referenced = {r["ticker"] for r in walk} | set(tickers)
    if referenced:
        co_rows = await conn.fetch(
            "SELECT ticker, name, sector FROM companies WHERE ticker = ANY($1::TEXT[])",
            list(referenced),
        )
        co = {r["ticker"]: dict(r) for r in co_rows}
    else:
        co = {}

    # Root nodes (hop 0).
    nodes: list[dict[str, Any]] = []
    for t in tickers:
        c = co.get(t, {})
        nodes.append({
            "ticker": t,
            "company": c.get("name") or "",
            "sector": c.get("sector") or "",
            "level": "root",
            "hop": 0,
            "relationship_type": "root",
            "cascade_score": 1.0,
            "why": "root of cascade",
            "event_id": str(event["id"]),
            "direction": -1 if _impact_bucket(event["impact"]) in ("critical", "high") else 0,
        })

    # Deduplicate downstream nodes by ticker, keep best cumulative_weight.
    seen: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    for r in walk:
        edges.append({
            "from": r["path_from"],
            "to": r["ticker"],
            "type": r["type"],
            "weight": float(r["edge_weight"]),
            "hop": int(r["hop"]),
        })
        score = float(r["cumulative_weight"])
        existing = seen.get(r["ticker"])
        if not existing or score > existing["cascade_score"]:
            c = co.get(r["ticker"], {})
            seen[r["ticker"]] = {
                "ticker": r["ticker"],
                "company": c.get("name") or "",
                "sector": c.get("sector") or "",
                "level": "downstream",
                "hop": int(r["hop"]),
                "relationship_type": r["type"],
                "cascade_score": score,
                "why": f"{r['type']} of {r['path_from']} (weight {r['edge_weight']:.2f})",
                "event_id": "",
                "direction": -1 if _impact_bucket(event["impact"]) in ("critical", "high") else 0,
            }

    # Sort and clip downstream.
    downstream = sorted(seen.values(), key=lambda n: (n["hop"], -n["cascade_score"]))[: top_k]
    nodes.extend(downstream)

    hop_counts: dict[str, int] = {}
    for n in nodes:
        key = f"L{n['hop']}"
        hop_counts[key] = hop_counts.get(key, 0) + 1

    return {
        "root": root,
        "nodes": nodes,
        "edges": edges,
        "hop_counts": hop_counts,
        "message": "",
        "fallback": "",
        "narrative": "",
        "severity": "",
        "geo_cascade": None,
    }


@router.post("/cascade")
async def post_cascade(body: CascadeBody) -> dict[str, Any]:
    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        return await _build_cascade(conn, body.event_id, body.max_hops, body.top_k)


@router.get("/cascade/by-event/{event_id}")
async def get_cascade_by_event(event_id: str) -> dict[str, Any]:
    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        return await _build_cascade(conn, event_id, 3, 15)


@router.get("/cascade/by-event/{event_id}/narrative")
async def cascade_narrative(event_id: str) -> dict[str, Any]:
    """Gemini cascade synthesis. Cached in the `cascades` table for instant
    second-clicks; first call takes 2-4s on Flash."""
    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        cached_narrative = await conn.fetchval(
            "SELECT narrative FROM cascades WHERE event_id = $1", event_id
        )
        if cached_narrative:
            try:
                payload = json.loads(cached_narrative)
                payload["ready"] = True
                payload["cached"] = True
                return payload
            except Exception:
                pass

        cascade = await _build_cascade(conn, event_id, 3, 15)
        result = await cascade_reasoning.synthesize_cascade(cascade)
        payload = {
            "ready": True,
            "narrative": result.get("summary", ""),
            "severity": result.get("severity", ""),
            "risk_factors": result.get("risk_factors", []),
            "confidence": float(result.get("confidence", 0.5)),
            "source": result.get("_source", "passthrough"),
        }
        # Cache only successful Gemini results.
        if result.get("_source") == "gemini":
            try:
                await conn.execute(
                    """
                    INSERT INTO cascades (event_id, root_tickers, walk, narrative)
                    VALUES ($1, $2::TEXT[], $3::jsonb, $4)
                    ON CONFLICT (event_id) DO UPDATE SET
                        narrative = EXCLUDED.narrative,
                        built_at = NOW()
                    """,
                    event_id,
                    list((cascade.get("root") or {}).get("tickers") or []),
                    json.dumps(cascade, default=str),
                    json.dumps(payload),
                )
            except Exception:
                pass
        return payload


@router.get("/cascade/by-event/{event_id}/society")
async def cascade_society(
    event_id: str,
    device_id: str | None = Query(default=None),
) -> dict[str, Any]:
    """Gemini agent society — Critic, Predictor, Memory, ELI5 in parallel.
    Memory pulls the device's last 20 cascade views from DynamoDB."""
    pool = await aurora.get_pool()
    async with pool.acquire() as conn:
        cached_society = await conn.fetchval(
            "SELECT society FROM cascades WHERE event_id = $1", event_id
        )
        if cached_society:
            payload = cached_society if isinstance(cached_society, dict) else json.loads(cached_society)
            payload["ready"] = True
            payload["done"] = True
            payload["cached"] = True
            return payload

        cascade = await _build_cascade(conn, event_id, 3, 15)

    history: list[dict[str, Any]] = []
    if device_id:
        try:
            async with dynamo.get_table() as table:
                resp = await table.query(
                    KeyConditionExpression=Key("PK").eq(dynamo.user_pk(device_id)),
                    ScanIndexForward=False,
                    Limit=20,
                )
            history = [
                {
                    "root_ticker": i.get("root_ticker", ""),
                    "sector": i.get("sector", ""),
                    "viewed_at": i.get("SK", ""),
                }
                for i in resp.get("Items", [])
            ]
        except Exception:
            history = []

    society = await society_agent.run_society(cascade, history=history)
    payload = {
        "ready": True,
        "done": True,
        "critic": society.get("critic"),
        "predictor": society.get("predictor"),
        "memory": society.get("memory"),
        "eli5": society.get("eli5"),
    }

    sources = {(society.get(k) or {}).get("_source") if isinstance(society.get(k), dict) else None
               for k in ("critic", "predictor", "memory")}
    if "gemini" in sources:
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO cascades (event_id, root_tickers, walk, society)
                    VALUES ($1, $2::TEXT[], $3::jsonb, $4::jsonb)
                    ON CONFLICT (event_id) DO UPDATE SET
                        society = EXCLUDED.society,
                        built_at = NOW()
                    """,
                    event_id,
                    list((cascade.get("root") or {}).get("tickers") or []),
                    json.dumps(cascade, default=str),
                    json.dumps(payload, default=str),
                )
        except Exception:
            pass
    return payload


# ----------------------------------------------------------------- stream ----

@router.get("/stream")
async def stream(request: Request) -> EventSourceResponse:
    """SSE channel. Handshake → backfill → Aurora LISTEN/NOTIFY live push.

    Holds one asyncpg connection open with LISTEN events_new for the duration
    of the request. Every INSERT into the events table fires the trigger that
    calls pg_notify, which lands on this connection, which yields an SSE event.
    Vercel Hobby caps function duration at 60s — the browser EventSource
    auto-reconnects on close, so the SSE stays effectively continuous."""

    async def gen() -> AsyncIterator[dict[str, Any]]:
        yield {"event": "ready", "data": json.dumps({"ok": True})}
        pool = await aurora.get_pool()

        # Backfill recent events first so the UI populates immediately.
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT id, title, body, url, source_type, published_at, ingested_at, "
                "       tickers, sectors, impact "
                "FROM events ORDER BY published_at DESC LIMIT 50"
            )
            cascadable = await _cascadable_tickers(conn)
        events = [_serialize_event(dict(r), cascadable) for r in rows]
        yield {"event": "backfill", "data": json.dumps({"events": events})}

        # Now hold a dedicated connection open for LISTEN.
        queue: asyncio.Queue[str] = asyncio.Queue()

        def _on_notify(conn, pid, channel, payload):
            try:
                queue.put_nowait(payload)
            except Exception:
                pass

        try:
            conn = await pool.acquire()
        except Exception:
            conn = None

        if conn is None:
            # Fall back to heartbeat-only loop.
            while True:
                if await request.is_disconnected():
                    return
                await asyncio.sleep(15)
                yield {"event": "heartbeat",
                       "data": json.dumps({"ts": datetime.now(timezone.utc).isoformat()})}

        try:
            await conn.add_listener("events_new", _on_notify)
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event_id = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield {"event": "heartbeat",
                           "data": json.dumps({"ts": datetime.now(timezone.utc).isoformat()})}
                    continue
                # Fetch full row for the freshly-inserted event.
                try:
                    row = await conn.fetchrow(
                        "SELECT id, title, body, url, source_type, published_at, ingested_at, "
                        "       tickers, sectors, impact FROM events WHERE id = $1",
                        event_id,
                    )
                except Exception:
                    row = None
                if row:
                    yield {"event": "event",
                           "data": json.dumps(_serialize_event(dict(row), cascadable))}
        finally:
            try:
                await conn.remove_listener("events_new", _on_notify)
            except Exception:
                pass
            try:
                await pool.release(conn)
            except Exception:
                pass

    return EventSourceResponse(gen())


# ----------------------------------------------------------------- memory ----

class MemoryViewBody(BaseModel):
    device_id: str
    event_id: str
    root_ticker: str = ""
    sector: str = ""
    headline: str = ""


@router.post("/memory/cascade-view")
async def log_cascade_view(body: MemoryViewBody) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    async with dynamo.get_table() as table:
        await table.put_item(Item={
            "PK": dynamo.user_pk(body.device_id),
            "SK": now,
            "event_id": body.event_id,
            "root_ticker": body.root_ticker,
            "sector": body.sector,
            "headline": body.headline,
            "ttl": int((datetime.now(timezone.utc) + timedelta(days=30)).timestamp()),
        })
    return {"ok": True}


@router.get("/memory/recent")
async def recent_memory(
    device_id: str,
    limit: int = Query(default=20, ge=1, le=100),
) -> dict[str, Any]:
    async with dynamo.get_table() as table:
        resp = await table.query(
            KeyConditionExpression=Key("PK").eq(dynamo.user_pk(device_id)),
            ScanIndexForward=False,
            Limit=limit,
        )
    items = [
        {
            "event_id": i.get("event_id", ""),
            "root_ticker": i.get("root_ticker", ""),
            "sector": i.get("sector", ""),
            "headline": i.get("headline", ""),
            "viewed_at": i.get("SK", ""),
        }
        for i in resp.get("Items", [])
    ]
    return {"items": items, "count": len(items)}


@router.delete("/memory/{device_id}")
async def forget_memory(device_id: str) -> dict[str, Any]:
    deleted = 0
    async with dynamo.get_table() as table:
        resp = await table.query(
            KeyConditionExpression=Key("PK").eq(dynamo.user_pk(device_id)),
        )
        for item in resp.get("Items", []):
            await table.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
            deleted += 1
    return {"ok": True, "deleted": deleted}
