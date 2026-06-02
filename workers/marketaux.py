"""
Marketaux news ingestion → events collection.

Free tier: 100 requests / day. We default to a 15-minute interval which lands
at ~96 requests/day, comfortably inside the cap. Each call pulls the most
recent ~3 US-equity news articles with sentiment attached.

Set MARKETAUX_API_KEY in .env.

Run:
    python -m workers.marketaux
    python -m workers.marketaux --once
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from workers._common import EventDraft, get_db, jlog, sync_main, upsert_events

# Voyage multimodal — best-effort hero-image embedding for the logo/chart feed.
EMBED_IMAGES = os.environ.get("MARKETAUX_EMBED_IMAGES", "1") != "0"

NAME = "marketaux"
ENDPOINT = "https://api.marketaux.com/v1/news/all"

API_KEY = os.environ.get("MARKETAUX_API_KEY", "").strip()


def _impact_from_sentiment(score: float | None) -> str:
    if score is None:
        return "medium"
    s = abs(score)
    if s >= 0.7:
        return "high"
    if s >= 0.4:
        return "medium"
    return "low"


@retry(
    retry=retry_if_exception_type(httpx.HTTPError),
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=2, min=4, max=60),
    reraise=True,
)
async def _fetch_news(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    params = {
        "api_token": API_KEY,
        "filter_entities": "true",
        "language": "en",
        "countries": "us",
        "limit": 3,  # free tier returns at most 3 articles per request
    }
    resp = await client.get(ENDPOINT, params=params, timeout=30.0)
    if resp.status_code == 402:
        jlog("warn", "marketaux.quota_exhausted", body=resp.text[:200])
        return []
    resp.raise_for_status()
    body = resp.json()
    return body.get("data", []) or []


def _parse_dt(s: str | None) -> datetime:
    if not s:
        return datetime.now(timezone.utc)
    # Marketaux returns "2024-08-20T13:45:00.000000Z" style.
    s2 = s.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s2)
    except ValueError:
        return datetime.now(timezone.utc)


async def _sector_for(ticker: str) -> str | None:
    db = get_db()
    doc = await db.companies.find_one({"ticker": ticker}, {"sector": 1})
    return doc.get("sector") if doc else None


async def _embed_hero(image_url: str, caption: str) -> list[float] | None:
    """Embed a Marketaux hero image via voyage-multimodal-3. Best-effort."""
    if not EMBED_IMAGES or not image_url or not os.environ.get("VOYAGE_API_KEY"):
        return None
    try:
        from embed.multimodal import embed_image_url
        return await embed_image_url(image_url, caption=caption[:200])
    except Exception as e:
        jlog("warn", "marketaux.image_embed.skip", error=type(e).__name__, message=str(e)[:160])
        return None


async def poll_once() -> None:
    if not API_KEY:
        jlog("warn", "marketaux.no_key", message="MARKETAUX_API_KEY not set; skipping")
        return

    async with httpx.AsyncClient() as client:
        articles = await _fetch_news(client)

    drafts: list[EventDraft] = []
    for art in articles:
        ents = art.get("entities") or []
        tickers = sorted({e["symbol"].upper() for e in ents if e.get("symbol")})
        if not tickers:
            continue

        # Average per-entity sentiment.
        sents = [e.get("sentiment_score") for e in ents if e.get("sentiment_score") is not None]
        sentiment = sum(sents) / len(sents) if sents else None

        primary = tickers[0]
        sector = await _sector_for(primary)

        text = f"{art.get('title','')}\n\n{art.get('description','') or art.get('snippet','')}".strip()

        image_url = art.get("image_url") or ""
        media: list[dict[str, Any]] = []
        if image_url:
            vec = await _embed_hero(image_url, caption=art.get("title", ""))
            media.append({
                "url": image_url,
                "type": "hero_image",
                **({"embedding": vec, "embedded_model": "voyage-multimodal-3"} if vec else {}),
            })

        drafts.append(
            EventDraft(
                source="Marketaux",
                source_type="news",
                external_id=art.get("uuid") or art.get("url") or text[:120],
                text=text,
                tickers=tickers,
                published_at=_parse_dt(art.get("published_at")),
                impact=_impact_from_sentiment(sentiment),
                sector=sector,
                sentiment=sentiment,
                entities=[e.get("name") for e in ents if e.get("name")],
                url=art.get("url"),
                media=media,
                extra={"image_url": image_url} if image_url else None,
            )
        )

    inserted, modified = await upsert_events(drafts)
    jlog(
        "info",
        "marketaux.poll.done",
        articles=len(articles),
        drafted=len(drafts),
        inserted=inserted,
        modified=modified,
    )


if __name__ == "__main__":
    sync_main(NAME, poll_once, default_interval=900.0)  # 15 min
