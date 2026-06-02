"""
Finnhub WebSocket → MongoDB `prices` time-series collection.

Long-running connection. Subscribes to the top-N watchlist tickers, accumulates
trade ticks, and flushes to MongoDB every 2 seconds (or 200 ticks) to keep
write pressure off the M0 cluster.

Reconnects automatically on disconnect with exponential backoff.

Set FINNHUB_API_KEY in .env.

Run:
    python -m workers.finnhub_ws          # long-running stream
    python -m workers.finnhub_ws --once   # connect, drain 60s of ticks, exit
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import datetime, timezone

import websockets
from websockets.exceptions import ConnectionClosed

from workers._common import get_db, jlog, load_dotenv_once

NAME = "finnhub_ws"
WSS_URL = "wss://ws.finnhub.io"

API_KEY = os.environ.get("FINNHUB_API_KEY", "").strip()
TOP_N = int(os.environ.get("FINNHUB_TOP_N", "50"))
FLUSH_INTERVAL_S = 2.0
FLUSH_BATCH_SIZE = 200


async def _watchlist() -> list[str]:
    db = get_db()
    cursor = (
        db.companies.find({}, {"ticker": 1, "market_cap": 1})
        .sort("market_cap", -1)
        .limit(TOP_N)
    )
    return [doc["ticker"] async for doc in cursor]


async def _flusher(queue: asyncio.Queue) -> None:
    """Drain queue into MongoDB in small batches."""
    db = get_db()
    buf: list[dict] = []
    last_flush = asyncio.get_event_loop().time()

    while True:
        try:
            doc = await asyncio.wait_for(queue.get(), timeout=FLUSH_INTERVAL_S)
            buf.append(doc)
        except asyncio.TimeoutError:
            pass

        now = asyncio.get_event_loop().time()
        if buf and (len(buf) >= FLUSH_BATCH_SIZE or now - last_flush >= FLUSH_INTERVAL_S):
            chunk, buf = buf, []
            last_flush = now
            try:
                result = await db.prices.insert_many(chunk, ordered=False)
                jlog("info", "finnhub.flush", inserted=len(result.inserted_ids))
            except Exception as exc:  # noqa: BLE001
                jlog("error", "finnhub.flush.fail", error=str(exc)[:200])


async def _stream(tickers: list[str], queue: asyncio.Queue, run_seconds: float | None) -> None:
    url = f"{WSS_URL}?token={API_KEY}"
    deadline = (
        asyncio.get_event_loop().time() + run_seconds if run_seconds else None
    )
    backoff = 2.0

    while True:
        if deadline and asyncio.get_event_loop().time() >= deadline:
            jlog("info", "finnhub.run_once.expired")
            return
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
                jlog("info", "finnhub.connected", tickers=len(tickers))
                backoff = 2.0
                # Subscribe to every ticker.
                for t in tickers:
                    await ws.send(json.dumps({"type": "subscribe", "symbol": t}))

                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("type") != "trade":
                        continue
                    for tick in msg.get("data", []) or []:
                        # tick = {"s": ticker, "p": price, "v": volume, "t": ms_epoch, "c": [...]}
                        ts = datetime.fromtimestamp(tick["t"] / 1000.0, tz=timezone.utc)
                        await queue.put(
                            {
                                "ts": ts,
                                "ticker": tick["s"].upper(),
                                "close": float(tick["p"]),
                                "volume": int(tick.get("v") or 0),
                                "source": "finnhub_ws",
                            }
                        )
                    if deadline and asyncio.get_event_loop().time() >= deadline:
                        return
        except ConnectionClosed as exc:
            jlog("warn", "finnhub.disconnected", code=exc.code, reason=str(exc.reason)[:120])
        except Exception as exc:  # noqa: BLE001
            jlog("error", "finnhub.stream.fail", error=type(exc).__name__, message=str(exc)[:200])

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60.0)


async def main_async(once: bool) -> None:
    load_dotenv_once()
    if not API_KEY:
        jlog("warn", "finnhub.no_key", message="FINNHUB_API_KEY not set; exiting")
        return

    tickers = await _watchlist()
    if not tickers:
        jlog("warn", "finnhub.no_watchlist")
        return

    queue: asyncio.Queue = asyncio.Queue(maxsize=10_000)
    flusher = asyncio.create_task(_flusher(queue))
    streamer = asyncio.create_task(_stream(tickers, queue, run_seconds=60.0 if once else None))

    if once:
        await streamer
        await asyncio.sleep(FLUSH_INTERVAL_S * 2)  # let flusher drain
        flusher.cancel()
        try:
            await flusher
        except asyncio.CancelledError:
            pass
    else:
        await asyncio.gather(streamer, flusher)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="Run for ~60s then exit (smoke test).")
    args = parser.parse_args()
    try:
        asyncio.run(main_async(args.once))
    except KeyboardInterrupt:
        jlog("info", "finnhub.stop", reason="keyboard_interrupt")
