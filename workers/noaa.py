"""
NOAA active weather alerts → events collection.

Polls the National Weather Service GeoJSON alerts feed every 10 minutes.
Severe / extreme alerts (hurricanes, tornadoes, blizzards) become high or
critical impact events with geo coordinates for globe overlays.

NWS requires a User-Agent header (any string) and does not require a key.

Run:
    python -m workers.noaa
    python -m workers.noaa --once
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from workers._common import EventDraft, jlog, sync_main, upsert_events

NAME = "noaa"
ENDPOINT = "https://api.weather.gov/alerts/active"
DEFAULT_INTERVAL_S = 600.0  # 10 min
USER_AGENT = os.environ.get("SEC_USER_AGENT", "Cascade research/contact@example.com")


_SEVERITY_IMPACT = {
    "Extreme": "critical",
    "Severe": "high",
    "Moderate": "medium",
    "Minor": "low",
}


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
    wait=wait_exponential(multiplier=2, min=4, max=60),
    stop=stop_after_attempt(4),
)
async def _fetch() -> dict:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/geo+json"}
    async with httpx.AsyncClient(timeout=20.0, headers=headers) as client:
        r = await client.get(ENDPOINT)
        r.raise_for_status()
        return r.json()


def _centroid(geometry: dict | None) -> tuple[float, float] | None:
    if not geometry:
        return None
    t = geometry.get("type")
    coords = geometry.get("coordinates")
    if not coords:
        return None
    try:
        if t == "Point":
            return float(coords[0]), float(coords[1])
        if t in ("Polygon", "MultiPolygon"):
            ring = coords[0] if t == "Polygon" else coords[0][0]
            lats = [p[1] for p in ring]
            lngs = [p[0] for p in ring]
            return sum(lngs) / len(lngs), sum(lats) / len(lats)
    except Exception:
        return None
    return None


async def work() -> None:
    payload = await _fetch()
    drafts: list[EventDraft] = []
    # Per-poll guards so weather doesn't flood the events collection and crowd
    # out tech/industrial signal. We keep only Severe+ alerts, dedupe by
    # (event_name, area) within a poll, and cap total per poll.
    MAX_PER_POLL = 15
    seen: set[tuple[str, str]] = set()
    for feat in payload.get("features", []):
        if len(drafts) >= MAX_PER_POLL:
            break
        props = feat.get("properties") or {}
        severity = props.get("severity") or "Moderate"
        impact = _SEVERITY_IMPACT.get(severity, "medium")
        # Tighten threshold: drop low + medium. Severe Thunderstorm Warnings
        # are "Severe" → "high" and still pass; everyday advisories don't.
        if impact in ("low", "medium"):
            continue
        ext_id = props.get("id") or feat.get("id") or props.get("@id")
        if not ext_id:
            continue
        event_name = props.get("event") or "Weather alert"
        headline = props.get("headline") or event_name
        area = props.get("areaDesc") or ""
        # Dedupe identical alert types in the same area within this poll.
        key = (event_name, area[:40])
        if key in seen:
            continue
        seen.add(key)
        sent = props.get("sent")
        try:
            published_at = datetime.fromisoformat(sent.replace("Z", "+00:00")) if sent else datetime.now(timezone.utc)
        except Exception:
            published_at = datetime.now(timezone.utc)

        centroid = _centroid(feat.get("geometry"))
        geo = None
        if centroid:
            lng, lat = centroid
            geo = {"type": "Point", "coordinates": [lng, lat], "area": area, "event": event_name}

        drafts.append(EventDraft(
            source="NOAA NWS",
            source_type="noaa_alert",
            external_id=str(ext_id),
            text=f"{event_name} — {headline}",
            tickers=[],
            published_at=published_at,
            impact=impact,
            sector="Weather",
            geo=geo,
            url=props.get("@id") or f"https://api.weather.gov/alerts/{ext_id}",
        ))

    if drafts:
        ins, mod = await upsert_events(drafts)
        jlog("info", "noaa.upsert", inserted=ins, modified=mod, count=len(drafts))
    else:
        jlog("info", "noaa.empty")


if __name__ == "__main__":
    sync_main(NAME, work, DEFAULT_INTERVAL_S)
