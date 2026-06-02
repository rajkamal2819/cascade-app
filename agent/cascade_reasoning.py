"""
Cascade synthesis: takes raw build_cascade output and produces a structured
CascadeResult using Gemini JSON-mode.

The result is stored in the `cascades` collection for SSE push and the
frontend cascade panel.
"""

from __future__ import annotations

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
        if key:
            _genai_client = genai.Client(api_key=key)
        else:
            # Vertex AI ADC path (Phase 7 swap)
            _genai_client = genai.Client()
    return _genai_client


SYNTHESIS_PROMPT = """You are a financial cascade analyst. Given a supply-chain cascade
tree from a financial event, produce a structured JSON analysis.

Return ONLY valid JSON matching this exact schema — no markdown, no prose:
{{
  "summary": "<1-2 sentence plain-English summary of the cascade>",
  "severity": "LOW|MEDIUM|HIGH|CRITICAL",
  "root": {{
    "ticker": "<ticker>",
    "event_id": "<id>",
    "headline": "<headline>",
    "impact": "<low|medium|high|critical>",
    "published_at": "<ISO datetime>"
  }},
  "nodes": [
    {{
      "ticker": "<ticker>",
      "company": "<company name>",
      "level": "L1|L2|L3",
      "relationship_type": "<supplier|customer|peer|sector|derivative>",
      "cascade_score": <float 0-1>,
      "expected_direction": "UP|DOWN|NEUTRAL|UNKNOWN",
      "why": "<one sentence reasoning>"
    }}
  ],
  "edges": [
    {{"from": "<ticker>", "to": "<ticker>", "type": "<relationship_type>", "weight": <float>}}
  ],
  "risk_factors": ["<factor1>", "<factor2>"],
  "confidence": <float 0-1>
}}

Cascade data:
{cascade_json}

Classify severity as:
- CRITICAL: direct suppliers/customers likely to have >5% price move
- HIGH: multiple L1 nodes affected, meaningful supply-chain exposure
- MEDIUM: L1-L2 effects, sector-wide but diffuse
- LOW: L3+ hops only, indirect effects
"""


async def synthesize_cascade(
    cascade_data: dict[str, Any],
    model: str | None = None,
) -> dict[str, Any]:
    """
    Use Gemini JSON-mode to synthesize a structured CascadeResult from
    raw build_cascade output.

    Falls back to a passthrough structure if Gemini fails.
    """
    if not cascade_data.get("nodes"):
        return _passthrough(cascade_data)

    model_name = model or os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")
    prompt = SYNTHESIS_PROMPT.format(
        cascade_json=json.dumps(cascade_data, default=str, indent=2)
    )

    try:
        import google.genai as genai
        client = _get_genai()
        response = await client.aio.models.generate_content(
            model=model_name,
            contents=prompt,
            config=genai.types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.1,
                max_output_tokens=2048,
            ),
        )
        raw = response.text.strip()
        result = json.loads(raw)
        result["_source"] = "gemini"
        result["_model"] = model_name
        return result
    except Exception as e:
        log.warning("Gemini cascade synthesis failed (%s), using passthrough", e)
        return _passthrough(cascade_data)


def _passthrough(cascade_data: dict[str, Any]) -> dict[str, Any]:
    """Build a minimal CascadeResult without calling Gemini."""
    root = cascade_data.get("root", {})
    nodes = cascade_data.get("nodes", [])
    edges = cascade_data.get("edges", [])

    max_score = max((n.get("cascade_score", 0) for n in nodes), default=0)
    if max_score > 0.8:
        severity = "CRITICAL"
    elif max_score > 0.6:
        severity = "HIGH"
    elif max_score > 0.4:
        severity = "MEDIUM"
    else:
        severity = "LOW"

    return {
        "summary": f"Cascade from {root.get('headline', 'unknown event')} affecting {len(nodes)} companies.",
        "severity": severity,
        "root": {
            "ticker": root.get("tickers", ["?"])[0] if root.get("tickers") else "?",
            "event_id": root.get("id", ""),
            "headline": root.get("headline", ""),
            "impact": root.get("impact", ""),
            "published_at": root.get("published_at", ""),
        },
        "nodes": [
            {
                "ticker": n.get("ticker", ""),
                "company": n.get("company", ""),
                "level": n.get("level", "L1"),
                "relationship_type": n.get("relationship_type", ""),
                "cascade_score": n.get("cascade_score", 0),
                "expected_direction": "UNKNOWN",
                "why": n.get("why", ""),
            }
            for n in nodes
        ],
        "edges": [
            {"from": e.get("from", ""), "to": e.get("to", ""), "type": e.get("type", ""), "weight": e.get("weight", 0.5)}
            for e in edges[:30]
        ],
        "risk_factors": [],
        "confidence": 0.5,
        "_source": "passthrough",
    }


async def save_cascade(
    cascade_result: dict[str, Any],
    db,
) -> str:
    """
    Persist a synthesized CascadeResult to the `cascades` collection.
    Returns the inserted document ID.
    """
    doc = {
        **cascade_result,
        "created_at": datetime.now(timezone.utc),
    }
    result = await db.cascades.insert_one(doc)
    return str(result.inserted_id)
