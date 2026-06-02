"""
Multimodal (image / text-with-image) embeddings via Voyage.

Used for:
  - News article hero images (Marketaux → events.media[].embedding)
  - Earnings call slides / price chart screenshots
  - Future: SEC filing PDF excerpts as rendered images

Voyage's multimodal model produces embeddings in the *same vector space* as
voyage-3-large text embeddings, so queries written in plain English can match
relevant images directly.
"""

from __future__ import annotations

import asyncio
import base64
import io
import os
from typing import Any

import httpx
import voyageai
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

MODEL = os.environ.get("VOYAGE_MULTIMODAL_MODEL", "voyage-multimodal-3")
DIMS = 1024

_client: voyageai.AsyncClient | None = None


def _get_client() -> voyageai.AsyncClient:
    global _client
    if _client is None:
        key = os.environ.get("VOYAGE_API_KEY")
        if not key:
            raise RuntimeError("VOYAGE_API_KEY not set")
        _client = voyageai.AsyncClient(api_key=key)
    return _client


def _data_uri(image_bytes: bytes, mime: str = "image/jpeg") -> str:
    return f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"


@retry(
    retry=retry_if_exception_type((voyageai.error.RateLimitError, voyageai.error.APIError, httpx.HTTPError)),
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=2, min=2, max=60),
    reraise=True,
)
async def _multimodal_embed(inputs: list[list[Any]]) -> list[list[float]]:
    """
    Voyage's multimodal_embed expects each input as a list of "content" items:
    each item is either {"type": "text", "text": "..."} or
    {"type": "image_url", "image_url": "https://..."} /
    {"type": "image_base64", "image_base64": "data:image/jpeg;base64,..."}.

    The official SDK exposes this as client.multimodal_embed.
    """
    client = _get_client()
    result = await client.multimodal_embed(
        inputs=inputs,
        model=MODEL,
        input_type="document",
        truncation=True,
    )
    return result.embeddings


async def embed_image_url(url: str, caption: str | None = None) -> list[float]:
    """Embed a single remote image. Optional caption gives Voyage extra signal."""
    content: list[dict[str, Any]] = [{"type": "image_url", "image_url": url}]
    if caption:
        content.insert(0, {"type": "text", "text": caption})
    vectors = await _multimodal_embed([content])
    return vectors[0]


async def embed_image(image_bytes: bytes, mime: str = "image/jpeg", caption: str | None = None) -> list[float]:
    """Embed an in-memory image (after httpx fetch, screenshot capture, etc.)."""
    content: list[dict[str, Any]] = [{"type": "image_base64", "image_base64": _data_uri(image_bytes, mime)}]
    if caption:
        content.insert(0, {"type": "text", "text": caption})
    vectors = await _multimodal_embed([content])
    return vectors[0]


async def embed_text_with_images(text: str, image_urls: list[str]) -> list[float]:
    """Joint embedding of an article with N inline images."""
    content: list[dict[str, Any]] = [{"type": "text", "text": text}]
    for url in image_urls:
        content.append({"type": "image_url", "image_url": url})
    vectors = await _multimodal_embed([content])
    return vectors[0]


if __name__ == "__main__":
    # Smoke test: python -m embed.multimodal <image_url>
    import sys

    from workers._common import load_dotenv_once

    load_dotenv_once()
    url = sys.argv[1] if len(sys.argv) > 1 else "https://placehold.co/600x400/png?text=Cascade"

    async def main():
        v = await embed_image_url(url, caption="A finance dashboard")
        print(f"url: {url}")
        print(f"model: {MODEL}  dims: {len(v)}")
        print(f"first 4: {v[:4]}")

    asyncio.run(main())
