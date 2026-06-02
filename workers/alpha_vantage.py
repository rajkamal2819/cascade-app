"""
Alpha Vantage technicals → companies enrichment.

Free tier reality (2026): only TIME_SERIES_DAILY and RSI are free. MACD,
SMA, EMA, etc. are now premium-only. The free quota is 25 calls / day
and Alpha Vantage requires ~12s between requests.

We rotate through the top tickers by market cap, refreshing RSI(14) on
each pass. With a 12s spacing and 1-hour interval, we touch the oldest
ticker on each tick and stay well inside both rate limits.

Set ALPHA_VANTAGE_API_KEY in .env.

Run:
    python -m workers.alpha_vantage
    python -m workers.alpha_vantage --once
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from workers._common import get_db, jlog, sync_main

NAME = "alpha_vantage"
ENDPOINT = "https://www.alphavantage.co/query"

API_KEY = os.environ.get("ALPHA_VANTAGE_API_KEY", "").strip()
DAILY_CALL_BUDGET = int(os.environ.get("ALPHA_VANTAGE_DAILY_BUDGET", "20"))
SECONDS_BETWEEN_CALLS = float(os.environ.get("ALPHA_VANTAGE_CALL_SPACING", "13"))

# Only RSI is free on Alpha Vantage's current free tier. Add more here
# (with a paid key, or if AV unlocks them again).
INDICATORS: list[tuple[str, dict[str, str], str, str]] = [
    # (function, extra_params, response_key, value_field)
    ("RSI", {"interval": "daily", "time_period": "14", "series_type": "close"}, "Technical Analysis: RSI", "RSI"),
]
INDICATOR_KEYS = ["rsi_14"]


@retry(
    retry=retry_if_exception_type(httpx.HTTPError),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=2, min=2, max=30),
    reraise=True,
)
async def _call(client: httpx.AsyncClient, params: dict[str, str]) -> dict[str, Any]:
    resp = await client.get(ENDPOINT, params=params, timeout=30.0)
    resp.raise_for_status()
    return resp.json()


def _latest_value(body: dict[str, Any], series_key: str, value_field: str) -> tuple[str, float] | None:
    series = body.get(series_key) or {}
    if not series:
        return None
    # Date keys are ISO strings; take the most recent.
    latest = max(series.keys())
    point = series[latest]
    try:
        return (latest, float(point[value_field]))
    except (KeyError, ValueError, TypeError):
        return None


async def _rotation_tickers(budget: int) -> list[str]:
    """
    Pick the next batch of tickers to refresh.

    Strategy: order by `technicals.updated_at` ascending, missing first, capped
    so we never exceed the daily call budget (budget / 4 indicators).
    """
    per_ticker_calls = len(INDICATORS)
    max_tickers = max(1, budget // per_ticker_calls)
    db = get_db()
    cursor = (
        db.companies.find(
            {},
            {"ticker": 1, "technicals.updated_at": 1, "market_cap": 1},
        )
        .sort([("technicals.updated_at", 1), ("market_cap", -1)])
        .limit(max_tickers)
    )
    return [doc["ticker"] async for doc in cursor]


async def poll_once() -> None:
    if not API_KEY:
        jlog("warn", "alphav.no_key", message="ALPHA_VANTAGE_API_KEY not set; skipping")
        return

    tickers = await _rotation_tickers(DAILY_CALL_BUDGET)
    if not tickers:
        jlog("info", "alphav.no_tickers")
        return

    db = get_db()
    now = datetime.now(timezone.utc)
    refreshed = 0

    async with httpx.AsyncClient() as client:
        for i, ticker in enumerate(tickers):
            tech: dict[str, Any] = {}
            for (function, extra, series_key, value_field), storage_key in zip(
                INDICATORS, INDICATOR_KEYS, strict=True
            ):
                if i > 0:
                    await asyncio.sleep(SECONDS_BETWEEN_CALLS)  # AV free tier rate limit

                params = {
                    "function": function,
                    "symbol": ticker,
                    "apikey": API_KEY,
                    **extra,
                }
                try:
                    body = await _call(client, params)
                except httpx.HTTPError as exc:
                    jlog("error", "alphav.call.fail", ticker=ticker, function=function, error=str(exc)[:200])
                    continue

                # AV puts rate-limit / premium-gate notices in "Note" / "Information".
                if "Note" in body or "Information" in body:
                    jlog("warn", "alphav.rate_limited", function=function, note=str(body)[:200])
                    return  # stop the whole pass; next interval will retry

                pair = _latest_value(body, series_key, value_field)
                if pair:
                    date, value = pair
                    tech[storage_key] = {"value": value, "as_of": date}

            if tech:
                tech["updated_at"] = now
                await db.companies.update_one({"ticker": ticker}, {"$set": {"technicals": tech}})
                refreshed += 1
                jlog("info", "alphav.refresh", ticker=ticker, indicators=list(tech.keys()))

    jlog("info", "alphav.poll.done", tickers=len(tickers), refreshed=refreshed)


if __name__ == "__main__":
    sync_main(NAME, poll_once, default_interval=3600.0)  # 1 hour
