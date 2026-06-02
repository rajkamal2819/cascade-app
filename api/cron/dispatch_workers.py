"""
Vercel Cron Job dispatcher — replaces the `workers/_common.py:run_worker`
infinite loop pattern that Cascade used on Cloud Run Jobs.

Vercel Hobby tier allows **2 cron schedules per project**. Cascade has 11
polling-style workers, so we group them into two buckets and dispatch by
the wall-clock minute:

    bucket=hi   → every 5 min (`*/5 * * * *`)
                  high-cadence sources: sec_edgar, marketaux, alpha_vantage,
                  yfinance_ticks, rss_news
    bucket=lo   → every hour (`0 * * * *`)
                  lower-cadence sources: gdelt, usgs, noaa, opensky,
                  reddit (gated), aisstream (snapshot)

The actual per-worker `poll_once()` / `work()` functions are unchanged —
this handler is a thin dispatcher.

Triggered by Vercel Cron via the GET endpoints registered in `vercel.json`:
    /api/cron/dispatch_workers?bucket=hi
    /api/cron/dispatch_workers?bucket=lo

Returns a JSON summary of which workers ran and which succeeded.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Awaitable, Callable
from urllib.parse import parse_qs

log = logging.getLogger(__name__)

WorkFn = Callable[[], Awaitable[None]]


# -----------------------------------------------------------------------------
# Bucket → worker entrypoint registry
#
# The keys are stable identifiers; the values are lazy importers so the cold
# Vercel function doesn't pay startup cost for workers the current bucket
# won't touch.
# -----------------------------------------------------------------------------

def _lazy(module_name: str, attr: str) -> WorkFn:
    """Return a coroutine-returning callable that imports lazily on first call."""
    async def runner() -> None:
        mod = __import__(f"workers.{module_name}", fromlist=[attr])
        fn = getattr(mod, attr)
        await fn()
    runner.__name__ = f"{module_name}.{attr}"
    return runner


BUCKETS: dict[str, dict[str, WorkFn]] = {
    "hi": {
        "sec_edgar":     _lazy("sec_edgar", "poll_once"),
        "marketaux":     _lazy("marketaux", "poll_once"),
        "alpha_vantage": _lazy("alpha_vantage", "poll_once"),
        "yfinance":      _lazy("yfinance_ticks", "poll_once"),
        "rss_news":      _lazy("rss_news", "poll_once"),
    },
    "lo": {
        "gdelt":     _lazy("gdelt", "work"),
        "usgs":      _lazy("usgs", "work"),
        "noaa":      _lazy("noaa", "work"),
        "opensky":   _lazy("opensky", "work"),
        "reddit":    _lazy("reddit", "poll_once"),
        "aisstream": _lazy("aisstream", "work"),
    },
}


# -----------------------------------------------------------------------------
# Dispatcher
# -----------------------------------------------------------------------------

async def _run_one(name: str, fn: WorkFn) -> dict:
    try:
        await fn()
        return {"worker": name, "ok": True}
    except Exception as e:  # noqa: BLE001 — surface to logs + response
        log.warning("worker %s failed: %s", name, e)
        return {"worker": name, "ok": False, "error": str(e)[:200]}


async def dispatch(bucket: str) -> dict:
    """Fan out every worker in the named bucket concurrently."""
    workers = BUCKETS.get(bucket)
    if not workers:
        return {"error": f"unknown bucket: {bucket}", "valid": list(BUCKETS.keys())}

    results = await asyncio.gather(*(_run_one(n, f) for n, f in workers.items()))
    return {
        "bucket": bucket,
        "ran": len(results),
        "succeeded": sum(1 for r in results if r["ok"]),
        "failed":    sum(1 for r in results if not r["ok"]),
        "workers": results,
    }


# -----------------------------------------------------------------------------
# Vercel Python runtime — module-level `handler` callable.
#
# Vercel passes the raw HTTP request as a `Request`-like object; for the
# Python runtime the simplest interface is to expose `handler(request)` and
# return a dict (auto-JSON-serialized) or a `Response`.
#
# The runtime varies slightly between Vercel Python "BaseHTTPRequestHandler"
# style and the newer ASGI style. We support both.
# -----------------------------------------------------------------------------

def _read_bucket(url: str) -> str:
    """Extract `?bucket=...` from a request URL or path. Defaults to 'hi'."""
    qs = url.split("?", 1)[1] if "?" in url else ""
    parsed = parse_qs(qs)
    bucket = (parsed.get("bucket") or ["hi"])[0]
    return bucket.lower().strip()


def _verify_cron_auth(headers: dict) -> bool:
    """Vercel Cron Jobs send a bearer token equal to CRON_SECRET when set.
    If CRON_SECRET isn't configured (local dev), allow all callers."""
    expected = os.environ.get("CRON_SECRET", "")
    if not expected:
        return True
    auth = headers.get("authorization") or headers.get("Authorization") or ""
    return auth == f"Bearer {expected}"


# Vercel "Web" Python runtime — async handler signature.
async def handler(request):  # type: ignore[no-untyped-def]
    headers = dict(getattr(request, "headers", {}) or {})
    if not _verify_cron_auth(headers):
        return {"status": 401, "body": {"error": "unauthorized"}}

    url = getattr(request, "url", "") or getattr(request, "path", "")
    bucket = _read_bucket(url)

    summary = await dispatch(bucket)
    body = json.dumps(summary)
    return {
        "status": 200,
        "headers": {"content-type": "application/json"},
        "body": body,
    }


# CLI smoke test — `python -m api.cron.dispatch_workers hi`
if __name__ == "__main__":
    import sys
    bucket_arg = sys.argv[1] if len(sys.argv) > 1 else "hi"
    print(json.dumps(asyncio.run(dispatch(bucket_arg)), indent=2))
