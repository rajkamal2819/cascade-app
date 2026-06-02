"""
Text embeddings via Voyage AI.

We use `voyage-3-large` (1024 dim) to match the cluster's `events_vector_index`.
The same model is used for both document embedding (worker insert path) and
query embedding (search bar, agent tools).

Voyage distinguishes input_type=document vs input_type=query for slightly
better retrieval quality. We expose both.
"""

from __future__ import annotations

import asyncio
import os
from typing import Literal

import voyageai
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

MODEL = os.environ.get("VOYAGE_TEXT_MODEL", "voyage-3-large")
DIMS = 1024
MAX_BATCH = 128  # Voyage limit per request

InputType = Literal["query", "document"]

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
async def _embed(texts: list[str], input_type: InputType) -> list[list[float]]:
    client = _get_client()
    result = await client.embed(
        texts,
        model=MODEL,
        input_type=input_type,
        truncation=True,
    )
    return result.embeddings


async def embed_query(text: str) -> list[float]:
    """Embed a single search query. ~1024-dim vector."""
    vectors = await _embed([text], "query")
    return vectors[0]


async def embed_documents(texts: list[str]) -> list[list[float]]:
    """
    Embed N documents. Auto-batches in chunks of MAX_BATCH.
    Empty strings are passed through as zero vectors (Voyage rejects empty input).
    """
    out: list[list[float]] = []
    # Replace empty strings to satisfy Voyage; index won't match zero vectors anyway.
    safe = [t if t and t.strip() else "(empty)" for t in texts]
    for i in range(0, len(safe), MAX_BATCH):
        chunk = safe[i : i + MAX_BATCH]
        vectors = await _embed(chunk, "document")
        out.extend(vectors)
    return out


async def embed_document(text: str) -> list[float]:
    """Embed a single document (event text) for insert path."""
    return (await embed_documents([text]))[0]


if __name__ == "__main__":
    # Smoke test: python -m embed.text "AI capex slowdown"
    import sys

    from workers._common import load_dotenv_once

    load_dotenv_once()
    q = " ".join(sys.argv[1:]) or "Apple iPhone sales decline"

    async def main():
        v = await embed_query(q)
        print(f"query: {q!r}")
        print(f"model: {MODEL}  dims: {len(v)}")
        print(f"first 4: {v[:4]}")

    asyncio.run(main())
