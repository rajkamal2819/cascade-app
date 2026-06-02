"""
Voyage rerank-2.5 wrapper.

Used by build_cascade and search_events to re-order candidate documents
after hybrid $vectorSearch + $search retrieval.
"""

from __future__ import annotations

import os
from typing import Any

import voyageai
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

MODEL = os.environ.get("VOYAGE_RERANK_MODEL", "rerank-2.5")
TOP_K_DEFAULT = 10

_client: voyageai.AsyncClient | None = None


def _get_client() -> voyageai.AsyncClient:
    global _client
    if _client is None:
        key = os.environ.get("VOYAGE_API_KEY")
        if not key:
            raise RuntimeError("VOYAGE_API_KEY not set")
        _client = voyageai.AsyncClient(api_key=key)
    return _client


@retry(
    retry=retry_if_exception_type((voyageai.error.RateLimitError, voyageai.error.APIError)),
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=2, min=2, max=60),
    reraise=True,
)
async def rerank(
    query: str,
    documents: list[str],
    top_k: int = TOP_K_DEFAULT,
) -> list[tuple[int, float]]:
    """
    Rerank documents against a query using Voyage rerank-2.5.

    Returns list of (original_index, relevance_score) sorted by score desc,
    truncated to top_k.
    """
    if not documents:
        return []

    client = _get_client()
    result = await client.rerank(
        query=query,
        documents=documents,
        model=MODEL,
        top_k=min(top_k, len(documents)),
    )
    return [(r.index, r.relevance_score) for r in result.results]


async def rerank_dicts(
    query: str,
    items: list[dict[str, Any]],
    text_field: str = "text",
    top_k: int = TOP_K_DEFAULT,
) -> list[dict[str, Any]]:
    """
    Convenience wrapper: rerank a list of dicts using the text_field,
    return the dicts reordered by relevance (highest first).

    Adds `rerank_score` field to each returned dict.
    """
    texts = [str(item.get(text_field, "")) for item in items]
    ranked = await rerank(query, texts, top_k=top_k)
    out = []
    for orig_idx, score in ranked:
        d = dict(items[orig_idx])
        d["rerank_score"] = score
        out.append(d)
    return out
