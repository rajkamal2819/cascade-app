"""
GDELT 2.0 DOC API → events collection.

Polls GDELT's Article Search every 15 minutes for high-tone (positive or
negative) global news, mapped to events.

GDELT requires no API key. Free, rate-limited politely.

Run:
    python -m workers.gdelt
    python -m workers.gdelt --once
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from workers._common import EventDraft, jlog, sync_main, upsert_events

NAME = "gdelt"
ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc"
DEFAULT_INTERVAL_S = 900.0  # 15 min

# Query targets cascadable, market-moving geopolitics + macro events. We
# bias toward terms that imply equity impact (sanctions, export ban,
# tariff, chip ban, refinery, port strike) so the feed doesn't fill with
# generic "geopolitics" coverage.
QUERY = (
    '("export ban" OR "chip ban" OR sanctions OR tariff OR "port strike" '
    'OR "supply chain" OR semiconductor OR "earnings miss" OR refinery '
    'OR "oil spike" OR Taiwan OR Houthi OR OPEC) sourcelang:eng'
)
MAX_PER_POLL = 12


def _impact_from_tone(tone: float | None) -> str:
    if tone is None:
        return "medium"
    a = abs(tone)
    if a >= 8:
        return "high"
    if a >= 4:
        return "medium"
    return "low"


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
    wait=wait_exponential(multiplier=2, min=4, max=60),
    stop=stop_after_attempt(4),
)
async def _fetch() -> dict[str, Any]:
    params = {
        "query": QUERY,
        "mode": "ArtList",
        "format": "json",
        "maxrecords": 50,
        "sort": "DateDesc",
        "timespan": "1h",
    }
    async with httpx.AsyncClient(timeout=20.0, headers={"User-Agent": "Cascade research/contact@example.com"}) as client:
        r = await client.get(ENDPOINT, params=params)
        r.raise_for_status()
        if not r.text.strip().startswith("{"):
            return {"articles": []}
        return r.json()


def _parse_gdelt_date(s: str | None) -> datetime:
    if not s:
        return datetime.now(timezone.utc)
    try:
        return datetime.strptime(s, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)


async def work() -> None:
    payload = await _fetch()
    drafts: list[EventDraft] = []
    seen_titles: set[str] = set()
    for art in payload.get("articles", []):
        if len(drafts) >= MAX_PER_POLL:
            break
        url = art.get("url") or ""
        if not url:
            continue
        title = (art.get("title") or "").strip()
        if not title:
            continue
        # Dedupe near-identical headlines within a poll (wire syndication).
        title_key = title.lower()[:80]
        if title_key in seen_titles:
            continue
        seen_titles.add(title_key)
        tone = art.get("tone")
        try:
            tone_val = float(tone) if tone is not None else None
        except (TypeError, ValueError):
            tone_val = None
        # Drop low-impact (weak tone) — they're rarely market-moving.
        if _impact_from_tone(tone_val) == "low":
            continue

        # Best-effort country / theme hints in extra
        country = art.get("sourcecountry") or ""
        socialimg = art.get("socialimage") or ""
        media = [{"url": socialimg, "kind": "image"}] if socialimg else None

        drafts.append(EventDraft(
            source="GDELT",
            source_type="gdelt_news",
            external_id=url,
            text=title,
            tickers=[],
            published_at=_parse_gdelt_date(art.get("seendate")),
            impact=_impact_from_tone(tone_val),
            sector="Geopolitics",
            sentiment=tone_val / 10.0 if tone_val is not None else None,
            entities=[country] if country else [],
            url=url,
            media=media,
            extra={"gdelt_domain": art.get("domain"), "gdelt_language": art.get("language")},
        ))
    if drafts:
        ins, mod = await upsert_events(drafts)
        jlog("info", "gdelt.upsert", inserted=ins, modified=mod, count=len(drafts))
    else:
        jlog("info", "gdelt.empty")


if __name__ == "__main__":
    sync_main(NAME, work, DEFAULT_INTERVAL_S)
