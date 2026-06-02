"""
USGS earthquake feed → events collection.

Polls the past-hour GeoJSON feed every 15 minutes. Quakes with magnitude
>= 4.5 become medium-impact events; >= 6.0 become critical. Geo coordinates
land in `event.geo` so the globe can render a 200km radius ring.

No API key required.

Run:
    python -m workers.usgs
    python -m workers.usgs --once
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from workers._common import EventDraft, jlog, sync_main, upsert_events

NAME = "usgs"
ENDPOINT = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson"
DEFAULT_INTERVAL_S = 900.0  # 15 min


def _impact(mag: float) -> str:
    if mag >= 6.0:
        return "critical"
    if mag >= 5.0:
        return "high"
    if mag >= 4.5:
        return "medium"
    return "low"


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
    wait=wait_exponential(multiplier=2, min=4, max=60),
    stop=stop_after_attempt(4),
)
async def _fetch() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": "Cascade research/contact@example.com"}) as client:
        r = await client.get(ENDPOINT)
        r.raise_for_status()
        return r.json()


async def work() -> None:
    payload = await _fetch()
    drafts: list[EventDraft] = []
    for feature in payload.get("features", []):
        props = feature.get("properties") or {}
        geom = feature.get("geometry") or {}
        mag = props.get("mag")
        if mag is None or mag < 4.5:
            continue
        place = props.get("place") or "unknown"
        ts_ms = props.get("time") or 0
        published_at = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        coords = geom.get("coordinates") or [0, 0, 0]
        lng, lat = coords[0], coords[1]
        ext_id = feature.get("id") or f"usgs-{ts_ms}-{lat}-{lng}"

        drafts.append(EventDraft(
            source="USGS",
            source_type="usgs_quake",
            external_id=str(ext_id),
            text=f"M{mag:.1f} earthquake near {place}",
            tickers=[],
            published_at=published_at,
            impact=_impact(float(mag)),
            sector="Geophysical",
            geo={"type": "Point", "coordinates": [lng, lat], "magnitude": mag, "place": place},
            url=props.get("url"),
        ))
    if drafts:
        ins, mod = await upsert_events(drafts)
        jlog("info", "usgs.upsert", inserted=ins, modified=mod, count=len(drafts))
    else:
        jlog("info", "usgs.empty", reason="no M>=4.5 in past hour")


if __name__ == "__main__":
    sync_main(NAME, work, DEFAULT_INTERVAL_S)
