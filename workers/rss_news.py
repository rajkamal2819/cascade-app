"""
RSS-based market news ingestion → events collection.

Pulls from a curated set of free, key-less RSS feeds (TechCrunch, The Verge,
Ars Technica, Hacker News, MarketWatch, CNBC sector feeds) so we have
sustained tech / industrial / energy signal even when Marketaux burns its
100-req/day cap. Each feed carries a default sector; per-article NER
overrides the sector when a known ticker is detected.

No API key required.

Run:
    python -m workers.rss_news
    python -m workers.rss_news --once
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta
from typing import Any

import feedparser
import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from embed.ner import extract_tickers
from workers._common import EventDraft, get_db, jlog, sync_main, upsert_events

NAME = "rss_news"

# (feed_url, default_sector, source_label, default_impact, per_poll_cap)
# Sector here is what the article gets *if NER doesn't override it*. We pick
# the most likely industry per feed so generic tech/biz articles still land
# under a meaningful chip instead of "Uncategorized".
FEEDS: list[tuple[str, str, str, str, int]] = [
    ("https://techcrunch.com/feed/",                                 "Technology",            "TechCrunch",     "medium", 6),
    ("https://www.theverge.com/rss/index.xml",                       "Technology",            "The Verge",      "medium", 6),
    ("https://feeds.arstechnica.com/arstechnica/index/",             "Technology",            "Ars Technica",   "medium", 4),
    ("https://news.ycombinator.com/rss",                             "Technology",            "Hacker News",    "low",    6),
    ("https://www.cnbc.com/id/10000664/device/rss/rss.html",         "Macro",                 "CNBC Markets",   "medium", 6),
    ("https://www.cnbc.com/id/19854910/device/rss/rss.html",         "Technology",            "CNBC Tech",      "medium", 6),
    ("https://www.cnbc.com/id/19836768/device/rss/rss.html",         "Industrials",           "CNBC Industrials","medium", 5),
    ("https://www.cnbc.com/id/19837104/device/rss/rss.html",         "Energy",                "CNBC Energy",    "medium", 5),
    ("https://www.cnbc.com/id/19854563/device/rss/rss.html",         "Financials",            "CNBC Finance",   "medium", 5),
    ("https://www.marketwatch.com/feeds/topstories",                 "Macro",                 "MarketWatch",    "medium", 6),
]

# Don't ingest items older than this — the feed may have a long history but
# our M0 collection is on a 14d TTL anyway, and stale articles muddle the
# "live feed" impression.
MAX_AGE = timedelta(days=2)
DEFAULT_INTERVAL_S = 1800.0  # 30 min


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
    wait=wait_exponential(multiplier=2, min=4, max=30),
    stop=stop_after_attempt(3),
)
async def _fetch_text(client: httpx.AsyncClient, url: str) -> str:
    r = await client.get(url, timeout=15.0, follow_redirects=True)
    r.raise_for_status()
    return r.text


def _parse_entry_dt(entry: Any) -> datetime:
    # feedparser surfaces parsed time tuples under published_parsed / updated_parsed.
    for key in ("published_parsed", "updated_parsed"):
        t = getattr(entry, key, None) or entry.get(key) if isinstance(entry, dict) else getattr(entry, key, None)
        if t:
            try:
                return datetime(*t[:6], tzinfo=timezone.utc)
            except Exception:
                pass
    return datetime.now(timezone.utc)


async def _sector_for_ticker(ticker: str) -> str | None:
    db = get_db()
    doc = await db.companies.find_one({"ticker": ticker}, {"sector": 1})
    return doc.get("sector") if doc else None


async def _process_feed(
    client: httpx.AsyncClient,
    url: str,
    default_sector: str,
    source_label: str,
    default_impact: str,
    cap: int,
) -> list[EventDraft]:
    try:
        body = await _fetch_text(client, url)
    except Exception as e:
        jlog("warn", "rss_news.fetch_fail", source=source_label, error=str(e)[:160])
        return []

    # feedparser is sync — run in a thread so we don't stall the loop.
    parsed = await asyncio.to_thread(feedparser.parse, body)
    now = datetime.now(timezone.utc)
    cutoff = now - MAX_AGE

    drafts: list[EventDraft] = []
    seen_titles: set[str] = set()
    for entry in parsed.entries[: cap * 2]:
        if len(drafts) >= cap:
            break
        title = (getattr(entry, "title", "") or "").strip()
        if not title:
            continue
        # Dedupe near-identical titles within a poll.
        key = title.lower()[:80]
        if key in seen_titles:
            continue
        seen_titles.add(key)

        link = getattr(entry, "link", "") or ""
        if not link:
            continue
        summary = (getattr(entry, "summary", "") or "").strip()
        # Strip HTML tags from summary cheaply (feedparser already cleans most).
        if summary and "<" in summary:
            import re
            summary = re.sub(r"<[^>]+>", " ", summary).strip()

        published_at = _parse_entry_dt(entry)
        if published_at < cutoff:
            continue

        text = f"{title}\n\n{summary[:600]}".strip()
        try:
            tickers = await extract_tickers(text)
        except Exception:
            tickers = []

        # Sector resolution: if NER found a known ticker, prefer that ticker's
        # sector (e.g. NVDA → Technology, BA → Industrials). Otherwise stick
        # with the feed default. This keeps articles correctly bucketed even
        # when one source talks about another sector's company.
        sector = default_sector
        if tickers:
            for t in tickers:
                s = await _sector_for_ticker(t)
                if s:
                    sector = s
                    break

        drafts.append(EventDraft(
            source=source_label,
            source_type="news",
            external_id=link,
            text=text,
            tickers=tickers,
            published_at=published_at,
            impact=default_impact,
            sector=sector,
            entities=[],
            url=link,
        ))
    return drafts


async def poll_once() -> None:
    async with httpx.AsyncClient(headers={"User-Agent": "Cascade research/contact@example.com"}) as client:
        results = await asyncio.gather(*(
            _process_feed(client, url, sec, src, imp, cap)
            for url, sec, src, imp, cap in FEEDS
        ), return_exceptions=False)

    drafts: list[EventDraft] = [d for batch in results for d in batch]
    if not drafts:
        jlog("info", "rss_news.empty")
        return

    inserted, modified = await upsert_events(drafts)
    jlog(
        "info",
        "rss_news.poll.done",
        feeds=len(FEEDS),
        drafted=len(drafts),
        inserted=inserted,
        modified=modified,
    )


if __name__ == "__main__":
    sync_main(NAME, poll_once, DEFAULT_INTERVAL_S)
