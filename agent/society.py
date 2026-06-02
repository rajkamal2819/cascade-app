"""
Multi-agent cascade society — Critic, Predictor, Memory, ELI5.

Each is a Gemini call (gemini-3-flash-preview, JSON mode) over the raw
build_cascade output. Designed to fire in parallel after the cascade
lands. Results are cached in the `cascades` collection alongside the
existing narrative.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
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
    return os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")


def _fast_config(max_tokens: int, json_mode: bool, temperature: float):
    """Speed-tuned Gemini config: zero thinking budget + capped tokens.
    Skips the ~1-2s Flash "thinking" preroll we don't need for short outputs."""
    import google.genai as genai
    cfg: dict[str, Any] = {
        "temperature": temperature,
        "max_output_tokens": max_tokens,
    }
    if json_mode:
        cfg["response_mime_type"] = "application/json"
    # thinking_budget=0 → no thinking step; available on gemini-3-flash-preview.
    try:
        cfg["thinking_config"] = genai.types.ThinkingConfig(thinking_budget=0)
    except Exception:
        pass
    return genai.types.GenerateContentConfig(**cfg)


# Hard timeout so a hung / rate-limited Gemini call never blocks the UI forever.
# Empirically the call should land in 2-4s; 15s leaves margin for transient slowness.
GEMINI_TIMEOUT_S = 15.0


async def _gen_json(prompt: str, max_tokens: int = 240) -> dict[str, Any]:
    client = _get_genai()
    resp = await asyncio.wait_for(
        client.aio.models.generate_content(
            model=_model(),
            contents=prompt,
            config=_fast_config(max_tokens, json_mode=True, temperature=0.2),
        ),
        timeout=GEMINI_TIMEOUT_S,
    )
    return json.loads(resp.text.strip())


async def _gen_text(prompt: str, max_tokens: int = 180) -> str:
    client = _get_genai()
    resp = await asyncio.wait_for(
        client.aio.models.generate_content(
            model=_model(),
            contents=prompt,
            config=_fast_config(max_tokens, json_mode=False, temperature=0.4),
        ),
        timeout=GEMINI_TIMEOUT_S,
    )
    return resp.text.strip()


def _slim(cascade: dict[str, Any]) -> dict[str, Any]:
    """Strip cascade to what each agent actually needs (token budget)."""
    return {
        "root": {
            "headline": (cascade.get("root") or {}).get("headline", ""),
            "tickers": (cascade.get("root") or {}).get("tickers", []),
            "sector": (cascade.get("root") or {}).get("sector", ""),
            "impact": (cascade.get("root") or {}).get("impact", ""),
        },
        "severity": cascade.get("severity", ""),
        "nodes": [
            {
                "ticker": n.get("ticker"),
                "company": n.get("company"),
                "level": n.get("level"),
                "relationship_type": n.get("relationship_type"),
                "cascade_score": round(n.get("cascade_score", 0), 3),
                "why": n.get("why", "")[:160],
            }
            for n in (cascade.get("nodes") or [])[:14]
        ],
        "fallback": cascade.get("fallback", ""),
    }


CRITIC_PROMPT = """You are the Critic in a cascade-analysis agent society.
Read this cascade and flag the WEAKEST 1-2 edges by rerank score that may be
noise, not signal. Be specific (cite tickers and the reason). If everything
looks solid, say so. Return ONLY JSON:

{{"message": "<one paragraph, <=60 words>", "weak_tickers": ["<TICKER>", ...]}}

Cascade:
{cascade}
"""

PREDICTOR_PROMPT = """You are the Predictor in a cascade-analysis agent society.
Given this cascade, project a 24-hour outlook for the top-3 cascade nodes by
rerank score. Include direction (UP/DOWN/NEUTRAL), confidence (0-1), and a
brief rationale. If you know a comparable historical cascade (e.g. CrowdStrike
2024, TSMC quakes, Suez Ever Given), cite it. Return ONLY JSON:

{{
  "message": "<one paragraph summarising the projection, <=70 words>",
  "projections": [
    {{"ticker": "<T>", "direction": "UP|DOWN|NEUTRAL", "confidence": 0.0, "rationale": "<short>"}}
  ],
  "analogue": "<historical comparable or empty>"
}}

Cascade:
{cascade}
"""

MEMORY_PROMPT = """You are Memory in a cascade-analysis agent society.
You have access to the current cascade AND this user's recent viewing history
(anonymous device id, last 20 cascade opens). Use history WHEN PRESENT to
ground specific observations like "You've looked at TSM 4× this week, all
during Taiwan-related events." If history is empty, fall back to general
observations about the cascade (sector concentration, recurring tickers).

Return ONLY JSON:
{{"message": "<one paragraph, <=55 words>", "tags": ["<short tag>", ...]}}

User history (most recent first):
{history}

Cascade:
{cascade}
"""

ELI5_PROMPT = """Rewrite this cascade analysis for a curious 12-year-old.
No financial jargon. Use one concrete analogy (dominos, a sneeze, traffic).
2-3 sentences. Plain text only, no JSON, no quotes.

Cascade:
{cascade}
"""


def _critic_local(cascade: dict[str, Any]) -> dict[str, Any]:
    """Deterministic Critic fallback derived from cascade payload."""
    nodes = cascade.get("nodes") or []
    weak = sorted(
        [n for n in nodes if (n.get("cascade_score") or 0) < 0.30],
        key=lambda n: n.get("cascade_score") or 0,
    )[:2]
    weak_tickers = [n["ticker"] for n in weak if n.get("ticker")]
    if weak_tickers:
        msg = (
            f"Weakest edges: {', '.join(weak_tickers)} score under 0.30 — most likely "
            f"semantic noise, not direct supply-chain risk. Treat as watchlist, not signal."
        )
    else:
        msg = "All cascade edges score above the noise floor. Confidence high on the graph walk."
    return {"message": msg, "weak_tickers": weak_tickers, "_source": "local"}


def _predict_local(cascade: dict[str, Any]) -> dict[str, Any]:
    """Deterministic Predictor fallback — directional bias from relationship_type."""
    nodes = cascade.get("nodes") or []
    top = sorted(nodes, key=lambda n: -(n.get("cascade_score") or 0))[:3]
    projections = []
    for n in top:
        rel = n.get("relationship_type") or ""
        if rel == "derivative":
            direction = "UP"
        elif rel in ("supplier", "customer", "sector", "peer", "geo_exposure"):
            direction = "DOWN"
        else:
            direction = "NEUTRAL"
        projections.append({
            "ticker": n.get("ticker", ""),
            "direction": direction,
            "confidence": round(min(0.95, (n.get("cascade_score") or 0) * 0.9 + 0.05), 2),
            "rationale": (n.get("why") or f"{rel} exposure to root").strip()[:120],
        })
    if projections:
        msg = (
            f"Top watch: {', '.join(p['ticker'] for p in projections)}. "
            f"Direction inferred from relationship type to root."
        )
    else:
        msg = "Insufficient cascade for a 24h projection."
    return {"message": msg, "projections": projections, "analogue": "", "_source": "local"}


async def critique(cascade: dict[str, Any]) -> dict[str, Any]:
    try:
        out = await _gen_json(
            CRITIC_PROMPT.format(cascade=json.dumps(_slim(cascade), default=str)),
            max_tokens=200,
        )
        out["_source"] = "gemini"
        return out
    except asyncio.TimeoutError:
        log.warning("critic timed out after %ss — using local fallback", GEMINI_TIMEOUT_S)
        out = _critic_local(cascade)
        out["_source"] = "timeout"
        return out
    except Exception as e:
        log.warning("critic failed (%s) — using local fallback", e)
        return _critic_local(cascade)


async def predict(cascade: dict[str, Any]) -> dict[str, Any]:
    try:
        out = await _gen_json(
            PREDICTOR_PROMPT.format(cascade=json.dumps(_slim(cascade), default=str)),
            max_tokens=400,
        )
        out["_source"] = "gemini"
        return out
    except asyncio.TimeoutError:
        log.warning("predictor timed out after %ss — using local fallback", GEMINI_TIMEOUT_S)
        out = _predict_local(cascade)
        out["_source"] = "timeout"
        return out
    except Exception as e:
        log.warning("predictor failed (%s) — using local fallback", e)
        return _predict_local(cascade)


def _memory_local(cascade: dict[str, Any], hist_size: int) -> dict[str, Any]:
    """Deterministic Memory fallback — instant, no LLM round-trip.
    Used when device history is empty/trivial, or when Gemini fails."""
    root = cascade.get("root") or {}
    sector = root.get("sector") or "Mixed"
    severity = (cascade.get("severity") or "").upper() or "UNKNOWN"
    nodes = cascade.get("nodes") or []
    l1 = sum(1 for n in nodes if n.get("hop") == 1)
    tickers = [n.get("ticker") for n in nodes[:3] if n.get("ticker")]
    if hist_size == 0:
        msg = (
            f"First cascade on this device. Root sector: {sector}. "
            f"Severity {severity}. {l1} direct (L1) exposures — "
            f"{', '.join(tickers) if tickers else 'none'}."
        )
    else:
        msg = (
            f"{hist_size} prior cascade{'s' if hist_size != 1 else ''} viewed on this device. "
            f"Current root: {sector} · severity {severity}. Pin to track sequels."
        )
    return {
        "message": msg,
        "tags": [sector, severity.title()] + ([t for t in tickers if t][:2]),
        "_source": "local",
        "_history_size": hist_size,
    }


async def memory(
    cascade: dict[str, Any],
    history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    hist = history or []
    # Short-circuit: with no/trivial history, skip Gemini entirely.
    if len(hist) < 3:
        return _memory_local(cascade, hist_size=len(hist))

    hist_repr = json.dumps(
        [
            {
                "ticker": h.get("root_ticker", ""),
                "sector": h.get("sector", ""),
                "viewed_at": str(h.get("viewed_at", "")),
            }
            for h in hist[:20]
        ],
        default=str,
    ) if hist else "[]  // no prior history yet"
    try:
        out = await _gen_json(
            MEMORY_PROMPT.format(
                cascade=json.dumps(_slim(cascade), default=str),
                history=hist_repr,
            )
        )
        out["_source"] = "gemini"
        out["_history_size"] = len(hist)
        return out
    except Exception as e:
        log.warning("memory failed: %s", e)
        return _memory_local(cascade, hist_size=len(hist))


def _eli5_local(cascade: dict[str, Any]) -> str:
    root = (cascade.get("root") or {})
    sector = (root.get("sector") or "this industry").lower()
    n = len(cascade.get("nodes") or [])
    return (
        f"Imagine one company in {sector} trips. Because {n} other companies "
        "rely on or compete with it, they wobble too. The cascade shows which "
        "ones wobble most."
    )


async def eli5(cascade: dict[str, Any]) -> str:
    try:
        return await _gen_text(ELI5_PROMPT.format(cascade=json.dumps(_slim(cascade), default=str)))
    except asyncio.TimeoutError:
        log.warning("eli5 timed out after %ss — using local fallback", GEMINI_TIMEOUT_S)
        return _eli5_local(cascade)
    except Exception as e:
        log.warning("eli5 failed (%s) — using local fallback", e)
        return _eli5_local(cascade)


async def run_society(
    cascade: dict[str, Any],
    history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run Critic + Predictor + Memory + ELI5 in parallel."""
    c, p, m, e = await asyncio.gather(
        critique(cascade),
        predict(cascade),
        memory(cascade, history=history),
        eli5(cascade),
        return_exceptions=False,
    )
    return {"critic": c, "predictor": p, "memory": m, "eli5": e}
