"""
Ticker / entity extraction from event text.

Hybrid extraction:
  1. `$TICKER` cashtag regex (Twitter / Reddit convention)
  2. Bare uppercase tokens matched against the companies collection
     (handles SEC titles like "Apple Inc. (0000320193)")
  3. Company-name alias match (e.g. "Apple Inc." → AAPL)

This module is reused by:
  - Workers (already partially handled there; this is the canonical impl)
  - The agent's search_events tool — when a user query mentions a company
    name, we backfill the ticker filter automatically.
"""

from __future__ import annotations

import re
from typing import Iterable

from workers._common import get_db

CASHTAG_RE = re.compile(r"\$([A-Z]{1,5})\b")
BARE_TICKER_RE = re.compile(r"\b([A-Z]{2,5})\b")
PARENS_CIK_NAME_RE = re.compile(r"([A-Z][A-Za-z0-9& .,'\-]{2,80}?)\s*\(\d{6,10}\)")

# Common English words that look like tickers but almost never are. Keep small
# and grow with experience — we'd rather have a false positive than miss a
# legitimate hit, since downstream filtering on `companies` will catch most.
_STOPWORDS = {
    "THE", "AND", "FOR", "WITH", "FROM", "INTO", "OVER", "UNDER", "ABOUT",
    "WILL", "HAVE", "BEEN", "JUST", "MORE", "MOST", "MUST", "ONLY", "SOME",
    "SUCH", "THAN", "THAT", "THEN", "THEY", "THIS", "WHEN", "YOU", "YOUR",
    "CEO", "CFO", "COO", "CTO", "USD", "EUR", "GBP", "JPY", "USA", "UK",
    "NYSE", "NASDAQ", "SEC", "ETF", "IPO", "API", "SPV", "PLC", "INC", "LLC",
}


_ticker_set_cache: set[str] | None = None
_name_to_ticker_cache: dict[str, str] | None = None


async def _load_caches() -> tuple[set[str], dict[str, str]]:
    """One-shot load of the canonical ticker + alias maps from companies."""
    global _ticker_set_cache, _name_to_ticker_cache
    if _ticker_set_cache is not None and _name_to_ticker_cache is not None:
        return _ticker_set_cache, _name_to_ticker_cache

    db = get_db()
    tickers: set[str] = set()
    name_map: dict[str, str] = {}
    async for doc in db.companies.find({}, {"ticker": 1, "name": 1}):
        t = doc["ticker"].upper()
        tickers.add(t)
        name = doc.get("name") or ""
        if name:
            # Index the full name and a short form (drop common suffixes).
            short = re.sub(r"\s+(Inc|Corporation|Corp|Company|Co|Group|Holdings|Ltd|plc|LLC|N\.V\.)\.?$", "", name, flags=re.IGNORECASE).strip()
            for alias in {name, short}:
                if alias:
                    name_map[alias.lower()] = t

    _ticker_set_cache = tickers
    _name_to_ticker_cache = name_map
    return tickers, name_map


def reset_cache() -> None:
    """Clear caches (mostly for tests / long-running processes)."""
    global _ticker_set_cache, _name_to_ticker_cache
    _ticker_set_cache = None
    _name_to_ticker_cache = None


async def extract_tickers(text: str) -> list[str]:
    """
    Return a deduped, alphabetically sorted list of tickers in `text` that
    appear in the companies collection. Combines cashtags + bare tokens +
    name aliases.
    """
    if not text:
        return []
    known, names = await _load_caches()
    found: set[str] = set()

    # 1. Cashtags — $TICKER, the cleanest signal.
    for m in CASHTAG_RE.finditer(text):
        sym = m.group(1).upper()
        if sym in known:
            found.add(sym)

    # 2. Bare uppercase tokens — only count if they're in the known set
    #    and not a common stopword.
    for m in BARE_TICKER_RE.finditer(text):
        sym = m.group(1).upper()
        if sym in known and sym not in _STOPWORDS:
            found.add(sym)

    # 3. Company name aliases ("Apple Inc.", "Microsoft Corporation").
    lower = text.lower()
    for alias, ticker in names.items():
        if alias in lower:
            found.add(ticker)

    return sorted(found)


async def extract_entities(text: str) -> list[str]:
    """Pull out likely company / person names. Lightweight, regex-only."""
    out: list[str] = []
    for m in PARENS_CIK_NAME_RE.finditer(text):
        name = m.group(1).strip().rstrip(",.")
        if name:
            out.append(name)
    # Dedup, preserve order
    seen: set[str] = set()
    deduped: list[str] = []
    for n in out:
        k = n.lower()
        if k not in seen:
            seen.add(k)
            deduped.append(n)
    return deduped


async def enrich_doc(text: str, current_tickers: Iterable[str] | None = None) -> dict[str, list[str]]:
    """
    Convenience helper for workers that want to populate both fields at once.

    Returns: { "tickers": [...], "entities": [...] }

    `current_tickers` lets workers seed the result with anything they
    already extracted (e.g. SEC's CIK → ticker map); this function unions
    with text-derived hits.
    """
    seed: set[str] = {t.upper() for t in (current_tickers or [])}
    text_hits = set(await extract_tickers(text))
    entities = await extract_entities(text)
    return {
        "tickers": sorted(seed | text_hits),
        "entities": entities,
    }


if __name__ == "__main__":
    # Smoke test: python -m embed.ner "NVDA crushed earnings while Apple Inc. cut guidance"
    import asyncio
    import sys

    from workers._common import load_dotenv_once

    load_dotenv_once()
    q = " ".join(sys.argv[1:]) or "NVDA crushed earnings while Apple Inc. cut guidance and $TSLA rallied"

    async def main():
        out = await enrich_doc(q)
        print(f"text: {q}")
        print(f"  tickers : {out['tickers']}")
        print(f"  entities: {out['entities']}")

    asyncio.run(main())
