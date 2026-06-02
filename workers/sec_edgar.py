"""
SEC EDGAR 8-K ingestion worker.

Polls the SEC's current 8-K Atom feed every 10 minutes, extracts the filer's
CIK, looks up the ticker (one-time cached map), classifies impact from the
filing item codes in the title/summary, and upserts an event document.

SEC requires a User-Agent header on every request — set SEC_USER_AGENT in .env
or the requests will be rejected.

Run:
    python -m workers.sec_edgar              # loop forever
    python -m workers.sec_edgar --once       # single pass (for cron / smoke tests)
"""

from __future__ import annotations

import asyncio
import os
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import feedparser
import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from workers._common import EventDraft, get_db, jlog, sync_main, upsert_events

NAME = "sec_edgar"

FEED_URL = (
    "https://www.sec.gov/cgi-bin/browse-edgar"
    "?action=getcurrent&type=8-K&output=atom&count=100"
)
TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json"

# 8-K item code → impact level. Source: SEC Form 8-K instructions.
# https://www.sec.gov/files/form8-k.pdf
ITEM_IMPACT: dict[str, str] = {
    # Section 1 — Registrant's Business and Operations
    "1.01": "high",      # Entry into a Material Definitive Agreement
    "1.02": "high",      # Termination of a Material Definitive Agreement
    "1.03": "critical",  # Bankruptcy or Receivership
    # Section 2 — Financial Information
    "2.01": "high",      # Completion of Acquisition or Disposition
    "2.02": "high",      # Results of Operations and Financial Condition (earnings)
    "2.03": "medium",    # Material Direct Financial Obligation
    "2.04": "critical",  # Triggering Event Accelerating Direct Financial Obligation
    "2.05": "high",      # Costs Associated with Exit or Disposal Activities
    "2.06": "high",      # Material Impairments
    # Section 3 — Securities and Trading Markets
    "3.01": "critical",  # Notice of Delisting / Failure to Satisfy Listing Standards
    "3.02": "medium",    # Unregistered Sales of Equity Securities
    "3.03": "medium",    # Material Modification to Rights of Security Holders
    # Section 4 — Matters Related to Accountants and Financial Statements
    "4.01": "high",      # Changes in Registrant's Certifying Accountant
    "4.02": "critical",  # Non-Reliance on Previously Issued Financial Statements
    # Section 5 — Corporate Governance and Management
    "5.01": "medium",    # Changes in Control of Registrant
    "5.02": "high",      # Departure / Election of Directors or Officers
    "5.03": "low",       # Amendments to Articles
    "5.07": "medium",    # Submission of Matters to a Vote
    # Section 7 — Regulation FD
    "7.01": "medium",    # Regulation FD Disclosure
    # Section 8 — Other Events
    "8.01": "medium",    # Other Events
    # Section 9 — Financial Statements and Exhibits
    "9.01": "low",       # Financial Statements and Exhibits
}

ITEM_PATTERN = re.compile(r"\b(\d\.\d{2})\b")
# Title looks like "8-K - Apple Inc. (0000320193) (Filer)"
CIK_IN_TITLE = re.compile(r"\((\d{6,10})\)")
# Link looks like ".../edgar/data/320193/..."
CIK_IN_LINK = re.compile(r"/edgar/data/(\d+)/", re.IGNORECASE)


_ticker_by_cik: dict[str, dict[str, str]] | None = None
_ticker_map_loaded_at: datetime | None = None


def _sec_headers() -> dict[str, str]:
    ua = os.environ.get("SEC_USER_AGENT", "").strip()
    if not ua:
        # Fallback so we never send an empty UA; SEC will still rate-limit but won't 403.
        ua = "Cascade research/no-email-configured"
    return {
        "User-Agent": ua,
        "Accept-Encoding": "gzip, deflate",
        "Host": "www.sec.gov",
    }


@retry(
    retry=retry_if_exception_type(httpx.HTTPError),
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    reraise=True,
)
async def _fetch(client: httpx.AsyncClient, url: str) -> httpx.Response:
    resp = await client.get(url, headers=_sec_headers(), timeout=30.0)
    resp.raise_for_status()
    return resp


async def _load_ticker_map(client: httpx.AsyncClient) -> dict[str, dict[str, str]]:
    """Fetch SEC's authoritative CIK→ticker map. Cache for 24h."""
    global _ticker_by_cik, _ticker_map_loaded_at
    now = datetime.now(timezone.utc)
    if (
        _ticker_by_cik is not None
        and _ticker_map_loaded_at is not None
        and (now - _ticker_map_loaded_at).total_seconds() < 86400
    ):
        return _ticker_by_cik

    resp = await _fetch(client, TICKER_MAP_URL)
    raw = resp.json()
    # Format: { "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}, ... }
    out: dict[str, dict[str, str]] = {}
    for row in raw.values():
        cik = str(row["cik_str"]).zfill(10)
        out[cik] = {"ticker": row["ticker"].upper(), "name": row["title"]}
    _ticker_by_cik = out
    _ticker_map_loaded_at = now
    jlog("info", "sec.ticker_map.loaded", count=len(out))
    return out


def _extract_cik(entry: Any) -> str | None:
    title = getattr(entry, "title", "") or ""
    link = getattr(entry, "link", "") or ""
    m = CIK_IN_TITLE.search(title)
    if m:
        return m.group(1).zfill(10)
    m = CIK_IN_LINK.search(link)
    if m:
        return m.group(1).zfill(10)
    return None


def _classify_impact(text: str) -> tuple[str, list[str]]:
    """Find 8-K item codes in the text, pick the highest-impact one."""
    items = sorted(set(ITEM_PATTERN.findall(text)))
    if not items:
        return ("medium", [])
    order = {"critical": 3, "high": 2, "medium": 1, "low": 0}
    best = "medium"
    for code in items:
        level = ITEM_IMPACT.get(code, "medium")
        if order[level] > order[best]:
            best = level
    return (best, items)


def _published_at(entry: Any) -> datetime:
    # feedparser parses `updated` and `published` into struct_time.
    for attr in ("updated_parsed", "published_parsed"):
        st = getattr(entry, attr, None)
        if st:
            return datetime(*st[:6], tzinfo=timezone.utc)
    # Fallback to string parse
    for attr in ("updated", "published"):
        s = getattr(entry, attr, None)
        if s:
            try:
                dt = parsedate_to_datetime(s)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except (TypeError, ValueError):
                pass
    return datetime.now(timezone.utc)


async def _sector_for(ticker: str) -> str | None:
    """Look up sector from companies collection. Cheap, 1 round trip per call."""
    db = get_db()
    doc = await db.companies.find_one({"ticker": ticker}, {"sector": 1})
    return doc.get("sector") if doc else None


async def _allowed_tickers() -> set[str]:
    """Restrict SEC ingestion to the curated large-cap universe (the
    `companies` collection). Without this filter the worker ingests every
    8-K from SEC's full ~13k-filer map and the feed drowns in small-cap
    noise like SATA / NXPLW that aren't in any cascade graph anyway."""
    db = get_db()
    cur = db.companies.find({}, {"ticker": 1, "_id": 0})
    return {d["ticker"].upper() async for d in cur if d.get("ticker")}


async def poll_once() -> None:
    async with httpx.AsyncClient() as client:
        ticker_map = await _load_ticker_map(client)
        resp = await _fetch(client, FEED_URL)
        feed = feedparser.parse(resp.text)

    if feed.bozo:
        jlog("warn", "sec.feed.bozo", reason=str(feed.bozo_exception)[:200])

    allowed = await _allowed_tickers()
    drafts: list[EventDraft] = []
    seen_tickers: set[str] = set()
    skipped_unmapped = 0
    skipped_smallcap = 0

    for entry in feed.entries:
        cik = _extract_cik(entry)
        info = ticker_map.get(cik) if cik else None
        if not info:
            skipped_unmapped += 1
            continue

        ticker = info["ticker"]
        if ticker not in allowed:
            skipped_smallcap += 1
            continue
        seen_tickers.add(ticker)
        title = getattr(entry, "title", "") or ""
        summary = getattr(entry, "summary", "") or ""
        text = f"{title}\n\n{summary}".strip()
        impact, items = _classify_impact(text)
        sector = await _sector_for(ticker)
        url = getattr(entry, "link", "") or ""

        drafts.append(
            EventDraft(
                source="SEC EDGAR",
                source_type="sec_8k",
                external_id=url or getattr(entry, "id", f"{cik}:{title}"),
                text=text,
                tickers=[ticker],
                published_at=_published_at(entry),
                impact=impact,
                sector=sector,
                entities=[info["name"]],
                url=url,
                extra={"items": items, "cik": cik},
            )
        )

    inserted, modified = await upsert_events(drafts)
    jlog(
        "info",
        "sec.poll.done",
        entries=len(feed.entries),
        drafted=len(drafts),
        inserted=inserted,
        modified=modified,
        tickers=len(seen_tickers),
        skipped_unmapped=skipped_unmapped,
        skipped_smallcap=skipped_smallcap,
    )


if __name__ == "__main__":
    sync_main(NAME, poll_once, default_interval=600.0)  # 10 min
