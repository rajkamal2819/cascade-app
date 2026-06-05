"""
Gemini Geo-Cascade — turn tickerless events (geopolitics, disasters, macro)
into real company / region cascades.

The semantic-similarity fallback in build_cascade just matches other events
("special weather statement" → other weather statements), which is useless
for impact reasoning. This module calls Gemini 2.5 Pro in JSON mode to
extract a structured impact hypothesis (regions, sectors, affected tickers
with transmission mechanism), then validates the tickers against our seed
companies collection so hallucinated symbols never escape.

Output schema is the contract the frontend renders. Cached on the event doc
as `geo_cascade` so the second click is instant and we don't burn quota.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger(__name__)

_genai_client = None


def _get_genai():
    global _genai_client
    if _genai_client is None:
        import google.genai as genai
        key = os.environ.get("GEMINI_API_KEY")
        _genai_client = genai.Client(api_key=key) if key else genai.Client()
    return _genai_client


def _model() -> str:
    # Dedicated knob, defaults to the same Flash model the rest of the agent
    # stack uses — gemini-2.5-pro is paid-only on AI Studio so Flash is the
    # free-tier choice. Override with GEMINI_GEO_MODEL when a paid project
    # (Vertex) is wired up.
    return os.environ.get("GEMINI_GEO_MODEL", "gemini-3-flash-preview")


# Pro is slower than Flash — give it room. Cached on the event doc anyway,
# so latency only hits the very first click per event.
GEMINI_TIMEOUT_S = 25.0

# Sectors where ticker-graphLookup is structurally unable to seed a cascade —
# these are the events worth spending a Pro call on. Everything else flows
# through the existing $graphLookup / vectorSearch paths.
TICKERLESS_SECTORS = {
    "Geopolitics", "Weather", "Geophysical", "Macro",
    "Natural Disaster", "Regulatory", "Climate",
}


GEO_PROMPT = """You are a financial cascade analyst. Given a news event with no
explicit ticker references, infer the structured market impact.

Event:
  headline: {headline}
  sector: {sector}
  impact: {impact}
  published_at: {published_at}
  text: {text}

Known investable universe (use ONLY these tickers; never invent symbols):
{ticker_universe}

Return ONLY valid JSON matching this exact schema — no markdown, no prose:
{{
  "event_type": "geopolitics|natural_disaster|macro|regulatory|climate|other",
  "regions": [
    {{"name": "<region>", "iso": "<2-letter ISO or null>", "role": "manufacturing_hub|logistics_chokepoint|exporter|consumer|other", "lat": <decimal degrees -90..90>, "lon": <decimal degrees -180..180>}}
  ],
  "sectors": [
    {{"name": "<sector>", "exposure": "supply_disruption|demand_shock|price_spike|regulatory|currency|other", "confidence": <0-1>}}
  ],
  "affected_companies": [
    {{"ticker": "<TICKER>", "level": 1, "mechanism": "<one-sentence reason>", "direction": "negative|positive|mixed", "confidence": <0-1>}}
  ],
  "transmission_mechanism": "<1-2 sentence narrative of how the event propagates from region/sector to companies>",
  "time_horizon": "days|weeks|quarters",
  "historical_analog": "<short reference to a comparable past event, or empty string>"
}}

Rules:
- Pick at most 8 affected_companies, ranked by exposure × confidence.
- `level` is 1 for direct exposure, 2 for second-order (e.g. customer of an affected supplier).
- If you don't know the ticker, omit the company. Never invent.
- Be specific in `mechanism` — name the actual transmission ("fabs in Hsinchu", "Hormuz transit risk → crude spike").
- Keep `historical_analog` concrete (year + name) or empty.
- For `lat`/`lon`: use the geographic centroid of the named region (country, province, city, or chokepoint).
  Pick a point that visually anchors the event — for a chokepoint use the strait itself, for a country use its capital
  or industrial heartland (e.g. "Taiwan" → Hsinchu ~24.77,120.99 not Taipei). Round to 2 decimals. Never omit.
"""


def _passthrough(reason: str = "no_call") -> dict[str, Any]:
    return {
        "event_type": "other",
        "regions": [],
        "sectors": [],
        "affected_companies": [],
        "transmission_mechanism": "",
        "time_horizon": "",
        "historical_analog": "",
        "_source": reason,
    }


async def _ticker_universe(db) -> tuple[list[str], dict[str, dict]]:
    """Return (sorted ticker list, ticker→company doc map) from seed companies."""
    cur = db.companies.find({}, {"ticker": 1, "name": 1, "sector": 1})
    docs = await cur.to_list(length=500)
    by_ticker = {(d.get("ticker") or "").upper(): d for d in docs if d.get("ticker")}
    return sorted(by_ticker.keys()), by_ticker


async def gemini_geo_hypothesis_from_universe(
    event: dict[str, Any],
    by_ticker: dict[str, dict],
) -> dict[str, Any]:
    """Aurora-flavored variant: caller supplies the ticker universe directly
    (no DB object). Validates Gemini's affected_companies against by_ticker."""
    headline = (event.get("headline") or event.get("title") or "").strip()
    text = (event.get("text") or event.get("body") or "").strip()[:1200]
    sector = event.get("sector") or ""
    impact = event.get("impact") or ""
    published_at = str(event.get("published_at") or "")

    if not (headline or text) or not by_ticker:
        return _passthrough("empty")

    prompt = GEO_PROMPT.format(
        headline=headline[:240],
        sector=sector,
        impact=impact,
        published_at=published_at,
        text=text,
        ticker_universe=_format_universe(by_ticker),
    )

    try:
        import google.genai as genai
        client = _get_genai()
        cfg = genai.types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.2,
            max_output_tokens=3000,
        )
        resp = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_model(),
                contents=prompt,
                config=cfg,
            ),
            timeout=GEMINI_TIMEOUT_S,
        )
        data = json.loads((resp.text or "").strip())
    except asyncio.TimeoutError:
        log.warning("geo_cascade gemini timeout")
        return _passthrough("timeout")
    except Exception as e:
        log.warning("geo_cascade gemini failed: %s", e)
        return _passthrough("error")

    valid_companies = []
    seen = set()
    for c in (data.get("affected_companies") or [])[:12]:
        t = (c.get("ticker") or "").upper().strip()
        if not t or t in seen or t not in by_ticker:
            continue
        seen.add(t)
        co = by_ticker[t]
        valid_companies.append({
            "ticker": t,
            "company": co.get("name", ""),
            "sector": co.get("sector", ""),
            "level": int(c.get("level") or 1),
            "mechanism": (c.get("mechanism") or "")[:240],
            "direction": (c.get("direction") or "mixed").lower(),
            "confidence": float(c.get("confidence") or 0.5),
        })

    return {
        "event_type": (data.get("event_type") or "other"),
        "regions": [
            r for r in (
                _clean_region(raw) for raw in (data.get("regions") or [])[:6]
            ) if r is not None
        ],
        "sectors": [
            {
                "name": (s.get("name") or "")[:48],
                "exposure": (s.get("exposure") or "other")[:32],
                "confidence": float(s.get("confidence") or 0.5),
            }
            for s in (data.get("sectors") or [])[:6]
            if s.get("name")
        ],
        "affected_companies": valid_companies,
        "transmission_mechanism": (data.get("transmission_mechanism") or "")[:600],
        "time_horizon": (data.get("time_horizon") or "")[:24],
        "historical_analog": (data.get("historical_analog") or "")[:160],
        "_source": "gemini",
        "_model": _model(),
        "_generated_at": datetime.now(timezone.utc).isoformat(),
    }


def _coerce_coord(v: Any, lo: float, hi: float) -> float | None:
    """Coerce Gemini's lat/lon to a float in range, else None. Defensive — model
    occasionally emits strings, nulls, or out-of-range hallucinations."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f < lo or f > hi:  # NaN or out of range
        return None
    return round(f, 4)


def _clean_region(raw: dict[str, Any]) -> dict[str, Any] | None:
    name = (raw.get("name") or "").strip()[:80]
    if not name:
        return None
    return {
        "name": name,
        "iso": (raw.get("iso") or "") or None,
        "role": (raw.get("role") or "other")[:32],
        "lat": _coerce_coord(raw.get("lat"), -90.0, 90.0),
        "lon": _coerce_coord(raw.get("lon"), -180.0, 180.0),
    }


def _format_universe(by_ticker: dict[str, dict], limit: int = 120) -> str:
    """Compact `TICKER (Name, Sector)` listing — keeps the prompt under a few KB."""
    lines = []
    for t, d in list(by_ticker.items())[:limit]:
        lines.append(f"  {t} ({d.get('name','')[:40]}, {d.get('sector','')})")
    return "\n".join(lines)


async def gemini_geo_hypothesis(
    event: dict[str, Any],
    db,
) -> dict[str, Any]:
    """
    Call Gemini for a structured impact hypothesis. Validates returned tickers
    against the seed companies collection — anything not in our universe is
    dropped. Returns the raw structured hypothesis; the caller composes it
    into a cascade response.
    """
    headline = (event.get("headline") or "").strip()
    text = (event.get("text") or "").strip()[:1200]
    sector = event.get("sector") or ""
    impact = event.get("impact") or ""
    published_at = str(event.get("published_at") or "")

    if not (headline or text):
        return _passthrough("empty_event")

    tickers, by_ticker = await _ticker_universe(db)
    if not by_ticker:
        return _passthrough("empty_universe")

    prompt = GEO_PROMPT.format(
        headline=headline[:240],
        sector=sector,
        impact=impact,
        published_at=published_at,
        text=text,
        ticker_universe=_format_universe(by_ticker),
    )

    try:
        import google.genai as genai
        client = _get_genai()
        cfg = genai.types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.2,
            max_output_tokens=3000,
        )
        resp = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=_model(),
                contents=prompt,
                config=cfg,
            ),
            timeout=GEMINI_TIMEOUT_S,
        )
        data = json.loads((resp.text or "").strip())
    except asyncio.TimeoutError:
        log.warning("geo_cascade gemini timeout")
        return _passthrough("timeout")
    except Exception as e:
        log.warning("geo_cascade gemini failed: %s", e)
        return _passthrough("error")

    # Validate + clean.
    valid_companies = []
    seen = set()
    for c in (data.get("affected_companies") or [])[:12]:
        t = (c.get("ticker") or "").upper().strip()
        if not t or t in seen:
            continue
        if t not in by_ticker:
            continue  # drop hallucinated tickers
        seen.add(t)
        co = by_ticker[t]
        valid_companies.append({
            "ticker": t,
            "company": co.get("name", ""),
            "sector": co.get("sector", ""),
            "level": int(c.get("level") or 1),
            "mechanism": (c.get("mechanism") or "")[:240],
            "direction": (c.get("direction") or "mixed").lower(),
            "confidence": float(c.get("confidence") or 0.5),
        })

    return {
        "event_type": (data.get("event_type") or "other"),
        "regions": [
            r for r in (
                _clean_region(raw) for raw in (data.get("regions") or [])[:6]
            ) if r is not None
        ],
        "sectors": [
            {
                "name": (s.get("name") or "")[:48],
                "exposure": (s.get("exposure") or "other")[:32],
                "confidence": float(s.get("confidence") or 0.5),
            }
            for s in (data.get("sectors") or [])[:6]
            if s.get("name")
        ],
        "affected_companies": valid_companies,
        "transmission_mechanism": (data.get("transmission_mechanism") or "")[:600],
        "time_horizon": (data.get("time_horizon") or "")[:24],
        "historical_analog": (data.get("historical_analog") or "")[:160],
        "_source": "gemini",
        "_model": _model(),
        "_generated_at": datetime.now(timezone.utc).isoformat(),
    }


async def graph_extend(
    hypothesis: dict[str, Any],
    db,
    max_hops: int = 2,
) -> tuple[list[dict], list[dict]]:
    """
    Take Gemini's L1 affected tickers and walk the supply-chain relationships
    graph one more hop to surface L2 exposure. Returns (extra_nodes, edges).
    """
    seed_tickers = [c["ticker"] for c in hypothesis.get("affected_companies", []) if c.get("level", 1) == 1]
    if not seed_tickers:
        return [], []

    try:
        pipeline = [
            {"$match": {"ticker": {"$in": seed_tickers}}},
            {
                "$graphLookup": {
                    "from": "relationships",
                    "startWith": "$ticker",
                    "connectFromField": "to_ticker",
                    "connectToField": "from_ticker",
                    "as": "cascade_path",
                    "maxDepth": max(0, max_hops - 1),
                    "depthField": "hop",
                    "restrictSearchWithMatch": {"weight": {"$gte": 0.4}},
                }
            },
            {"$project": {"ticker": 1, "cascade_path": 1}},
        ]
        rows = await db.companies.aggregate(pipeline).to_list(length=80)
    except Exception as e:
        log.warning("geo graph_extend failed: %s", e)
        return [], []

    seen = {t for t in seed_tickers}
    extras: dict[str, dict] = {}
    edges: list[dict] = []
    for row in rows:
        src = row.get("ticker")
        for hop_doc in row.get("cascade_path", []):
            to_t = hop_doc.get("to_ticker")
            if not to_t or to_t in seen:
                continue
            hop = int(hop_doc.get("hop", 0)) + 2  # L2 onwards
            rel = hop_doc.get("type", "supply")
            w = float(hop_doc.get("weight", 0.5))
            if to_t not in extras or extras[to_t]["hop"] > hop:
                extras[to_t] = {"ticker": to_t, "hop": hop, "rel": rel, "weight": w, "src": src}
            edges.append({
                "from": hop_doc.get("from_ticker", src),
                "to": to_t,
                "type": rel,
                "weight": w,
                "hop": hop,
            })

    if not extras:
        return [], edges

    docs = await db.companies.find(
        {"ticker": {"$in": list(extras.keys())}},
        {"ticker": 1, "name": 1, "sector": 1},
    ).to_list(length=80)
    co_map = {d["ticker"]: d for d in docs}

    extra_nodes = []
    for t, info in extras.items():
        co = co_map.get(t, {})
        extra_nodes.append({
            "ticker": t,
            "company": co.get("name", ""),
            "sector": co.get("sector", ""),
            "level": "L2" if info["hop"] == 2 else "L3",
            "hop": info["hop"],
            "relationship_type": f"graph_{info['rel']}",
            "cascade_score": max(0.2, info["weight"] * 0.7),
            "why": f"{info['rel']} of {info['src']} (graph extension)",
            "event_id": "",
        })
    return extra_nodes, edges


def compose_cascade(
    event: dict[str, Any],
    event_id: str,
    hypothesis: dict[str, Any],
    extra_nodes: list[dict],
    extra_edges: list[dict],
) -> dict[str, Any]:
    """Merge Gemini L1 + graph L2 into a CascadeResponse-shaped dict."""
    l1_nodes = []
    for c in hypothesis.get("affected_companies", []):
        dir_sign = {"negative": -1, "positive": 1, "mixed": 0}.get(c.get("direction", "mixed"), 0)
        l1_nodes.append({
            "ticker": c["ticker"],
            "company": c.get("company", ""),
            "sector": c.get("sector", ""),
            "level": f"L{c.get('level', 1)}",
            "hop": int(c.get("level", 1)),
            "relationship_type": f"gemini_{hypothesis.get('event_type','other')}",
            "cascade_score": float(c.get("confidence", 0.5)),
            "why": c.get("mechanism", ""),
            "event_id": "",
            "direction": dir_sign,
        })

    all_nodes = l1_nodes + extra_nodes
    hop_counts: dict[str, int] = {}
    for n in all_nodes:
        hop_counts[n["level"]] = hop_counts.get(n["level"], 0) + 1

    return {
        "root": {
            "id": event_id,
            "headline": event.get("headline") or "",
            "tickers": [],
            "impact": event.get("impact", ""),
            "sector": event.get("sector", "") or "",
            "published_at": str(event.get("published_at", "")),
            "source_type": event.get("source_type", ""),
        },
        "nodes": all_nodes,
        "edges": extra_edges,
        "hop_counts": hop_counts,
        "fallback": "gemini_geo",
        "message": hypothesis.get("transmission_mechanism", "") or "Gemini-inferred regional & sector exposure.",
        "geo_cascade": {
            "event_type": hypothesis.get("event_type"),
            "regions": hypothesis.get("regions", []),
            "sectors": hypothesis.get("sectors", []),
            "transmission_mechanism": hypothesis.get("transmission_mechanism", ""),
            "time_horizon": hypothesis.get("time_horizon", ""),
            "historical_analog": hypothesis.get("historical_analog", ""),
            "model": hypothesis.get("_model", ""),
        },
    }


async def build_geo_cascade(
    event: dict[str, Any],
    event_id: str,
    db,
) -> dict[str, Any] | None:
    """
    Full Gemini Geo-Cascade pipeline with caching.

    1. Check event.geo_cascade cache → reuse if present.
    2. Call Gemini for structured hypothesis (validated against companies).
    3. $graphLookup extend L1 → L2.
    4. Compose response shape.
    5. Persist back onto the event doc (and cascades collection for SSE).

    Returns None on hard failure so caller can fall back to existing path.
    """
    cached = event.get("geo_cascade")
    if cached and cached.get("affected_companies"):
        # Re-compose from cache so we never re-hit Gemini.
        # Cached doc was the hypothesis; rebuild graph extension fresh since
        # the relationships graph may have changed.
        extra_nodes, extra_edges = await graph_extend(cached, db)
        return compose_cascade(event, event_id, cached, extra_nodes, extra_edges)

    hypothesis = await gemini_geo_hypothesis(event, db)
    if hypothesis.get("_source") != "gemini" or not hypothesis.get("affected_companies"):
        return None

    extra_nodes, extra_edges = await graph_extend(hypothesis, db)
    composed = compose_cascade(event, event_id, hypothesis, extra_nodes, extra_edges)

    # Persist hypothesis on the event doc — cache key is the event itself.
    try:
        from bson import ObjectId
        await db.events.update_one(
            {"_id": ObjectId(event_id)},
            {"$set": {"geo_cascade": hypothesis}},
        )
    except Exception as e:
        log.warning("geo_cascade cache persist failed: %s", e)

    return composed


def is_geo_candidate(event: dict[str, Any]) -> bool:
    """
    Does this tickerless event deserve a Pro call? Yes if:
    - no tickers AND
    - impact ≥ medium AND
    - sector is one of our infer-able buckets
    """
    if event.get("tickers"):
        return False
    impact = (event.get("impact") or "").lower()
    if impact not in ("medium", "high", "critical"):
        return False
    sector = (event.get("sector") or "").strip()
    if sector in TICKERLESS_SECTORS:
        return True
    # Source-type backup — GDELT / NOAA / USGS feeds even when sector misassigned.
    src = (event.get("source_type") or "").lower()
    if src in ("gdelt_news", "noaa", "usgs", "opensky"):
        return True
    return False
