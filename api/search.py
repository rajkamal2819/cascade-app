"""
/search route — hybrid $vectorSearch + $search + Voyage rerank-2.5.

Thin HTTP wrapper around agent.tools.search_events so the same logic is
reachable both as an agent tool and as a public REST endpoint.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from agent.tools import search_events
from api.models import SearchHit, SearchRequest, SearchResponse

router = APIRouter()


@router.post("/search", response_model=SearchResponse)
async def post_search(req: SearchRequest) -> SearchResponse:
    try:
        result = await search_events(
            query=req.query,
            sector=req.sector,
            impact=req.impact,
            days_back=req.days_back,
            limit=req.limit,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"search failed: {e}")

    hits = []
    for h in result.get("events", []):
        # tool returns may contain None for missing fields; coerce to "".
        hits.append(SearchHit(
            id=h.get("id", ""),
            headline=h.get("headline") or "",
            tickers=h.get("tickers") or [],
            sector=h.get("sector") or "",
            impact=h.get("impact") or "",
            source_type=h.get("source_type") or "",
            published_at=h.get("published_at") or "",
            rerank_score=float(h.get("rerank_score") or 0.0),
        ))
    return SearchResponse(query=req.query, events=hits, count=result.get("count", 0))
