"""
yfinance OHLCV ingestion → MongoDB time-series `prices` collection.

Every interval, downloads the latest 1-minute bars for the watchlist tickers
(top-N companies by market cap from the companies collection) and bulk-inserts
new bars into the `prices` time-series collection.

Idempotent: we track the last `ts` per ticker locally so a re-run only inserts
genuinely new bars.

Run:
    python -m workers.yfinance_ticks
    python -m workers.yfinance_ticks --once
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import pandas as pd
import yfinance as yf

from workers._common import get_db, jlog, sync_main

NAME = "yfinance_ticks"

# Top-N tickers by market cap to track. yfinance handles ~50 tickers per call
# comfortably; we batch-download all at once.
TOP_N = int(os.environ.get("YFINANCE_TOP_N", "50"))

# In-process memory of the last bar timestamp we've stored per ticker.
_last_ts: dict[str, datetime] = {}


async def _watchlist() -> list[str]:
    """Return the top-N tickers by market cap from the companies collection."""
    db = get_db()
    cursor = (
        db.companies.find({}, {"ticker": 1, "market_cap": 1})
        .sort("market_cap", -1)
        .limit(TOP_N)
    )
    return [doc["ticker"] async for doc in cursor]


def _download_bars(tickers: list[str]) -> pd.DataFrame:
    """
    Run yfinance.download in the threadpool so we don't block the loop.
    Returns a DataFrame indexed by (Datetime, Ticker) with OHLCV columns.
    """
    return yf.download(
        tickers=tickers,
        period="1d",
        interval="1m",
        auto_adjust=False,
        prepost=False,
        group_by="ticker",
        threads=True,
        progress=False,
    )


def _rows_for_ticker(df: pd.DataFrame, ticker: str) -> list[dict[str, Any]]:
    """Flatten a single-ticker slice of the yfinance multi-index df into docs."""
    if df is None or df.empty:
        return []

    # yfinance returns a multi-level column index when group_by="ticker" and
    # multiple tickers are requested. Slice down to just this ticker.
    if isinstance(df.columns, pd.MultiIndex):
        if ticker not in df.columns.get_level_values(0):
            return []
        sub = df[ticker].dropna(how="all")
    else:
        sub = df.dropna(how="all")

    out: list[dict[str, Any]] = []
    last_seen = _last_ts.get(ticker)
    for ts, row in sub.iterrows():
        # yfinance returns tz-aware (often US/Eastern). Normalize to UTC.
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        ts = ts.tz_convert("UTC").to_pydatetime()
        if last_seen and ts <= last_seen:
            continue
        out.append(
            {
                "ts": ts,
                "ticker": ticker,
                "open": float(row["Open"]) if pd.notna(row.get("Open")) else None,
                "high": float(row["High"]) if pd.notna(row.get("High")) else None,
                "low": float(row["Low"]) if pd.notna(row.get("Low")) else None,
                "close": float(row["Close"]) if pd.notna(row.get("Close")) else None,
                "volume": int(row["Volume"]) if pd.notna(row.get("Volume")) else 0,
                "source": "yfinance",
            }
        )
    if out:
        _last_ts[ticker] = out[-1]["ts"]
    return out


async def poll_once() -> None:
    tickers = await _watchlist()
    if not tickers:
        jlog("warn", "yfin.no_watchlist")
        return

    loop = asyncio.get_running_loop()
    df = await loop.run_in_executor(None, _download_bars, tickers)

    all_docs: list[dict[str, Any]] = []
    for t in tickers:
        all_docs.extend(_rows_for_ticker(df, t))

    if not all_docs:
        jlog("info", "yfin.poll.done", tickers=len(tickers), inserted=0, note="no_new_bars")
        return

    db = get_db()
    # Time-series collections only support insert (no update/upsert needed —
    # we filter duplicates via _last_ts in-process).
    result = await db.prices.insert_many(all_docs, ordered=False)
    jlog(
        "info",
        "yfin.poll.done",
        tickers=len(tickers),
        inserted=len(result.inserted_ids),
        first_ts=all_docs[0]["ts"].isoformat(),
        last_ts=all_docs[-1]["ts"].isoformat(),
    )


if __name__ == "__main__":
    sync_main(NAME, poll_once, default_interval=60.0)  # 1 min
