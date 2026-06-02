"""
OpenSky Network — corporate-jet tracking → events collection.

Polls OpenSky's free /states/all endpoint and filters down to a curated set
of corporate-jet ICAO24 hex codes. Unusual clusters (3+ corporate jets
within 50 nautical miles) become medium-impact events. No API key required.

Run:
    python -m workers.opensky
    python -m workers.opensky --once
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from workers._common import EventDraft, jlog, sync_main, upsert_events

NAME = "opensky"
ENDPOINT = "https://opensky-network.org/api/states/all"
DEFAULT_INTERVAL_S = 600.0  # 10 min (OpenSky free tier — be polite)

# Curated corporate-jet hex codes (ICAO24, lowercase) → operator label.
# Tiny seed list — expand from public spotters' databases as needed.
CORPORATE_JETS: dict[str, str] = {
    "a8a0b1": "Berkshire NetJets",
    "a8a002": "Tesla SpaceX (Musk)",
    "a39d1f": "Amazon corporate",
    "a4d57c": "Bezos NetJets",
    "ab1644": "Apple corporate",
}


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
    wait=wait_exponential(multiplier=3, min=5, max=120),
    stop=stop_after_attempt(3),
)
async def _fetch() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=25.0, headers={"User-Agent": "Cascade research/contact@example.com"}) as client:
        r = await client.get(ENDPOINT)
        r.raise_for_status()
        return r.json()


def _haversine_nm(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance in nautical miles between two lat/lng points."""
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * 3440.065 * math.asin(math.sqrt(h))


async def work() -> None:
    payload = await _fetch()
    now = datetime.now(timezone.utc)
    matched: list[tuple[str, str, float, float]] = []
    for state in payload.get("states", []) or []:
        try:
            icao24 = (state[0] or "").lower()
            callsign = (state[1] or "").strip()
            lng = state[5]
            lat = state[6]
            if lat is None or lng is None:
                continue
            if icao24 not in CORPORATE_JETS:
                continue
            matched.append((icao24, callsign, lat, lng))
        except (IndexError, TypeError):
            continue

    if not matched:
        jlog("info", "opensky.empty", reason="no curated jets airborne")
        return

    # Cluster detection: 3+ jets within 50 nm.
    drafts: list[EventDraft] = []
    used: set[int] = set()
    for i, a in enumerate(matched):
        if i in used:
            continue
        cluster = [a]
        for j, b in enumerate(matched):
            if i == j or j in used:
                continue
            if _haversine_nm((a[2], a[3]), (b[2], b[3])) <= 50:
                cluster.append(b)
        if len(cluster) >= 3:
            used.update({matched.index(c) for c in cluster})
            ops = sorted({CORPORATE_JETS[c[0]] for c in cluster})
            lat = sum(c[2] for c in cluster) / len(cluster)
            lng = sum(c[3] for c in cluster) / len(cluster)
            drafts.append(EventDraft(
                source="OpenSky",
                source_type="opensky_cluster",
                external_id=f"opensky-cluster-{int(now.timestamp())}-{round(lat, 2)}-{round(lng, 2)}",
                text=f"Unusual cluster: {len(cluster)} corporate jets ({', '.join(ops)}) converging within 50nm",
                tickers=[],
                published_at=now,
                impact="medium",
                sector="Corporate Aviation",
                geo={"type": "Point", "coordinates": [lng, lat], "cluster_size": len(cluster)},
            ))

    # Also emit one event per jet for the globe overlay (lower impact).
    for icao24, callsign, lat, lng in matched:
        drafts.append(EventDraft(
            source="OpenSky",
            source_type="opensky_jet",
            external_id=f"opensky-{icao24}-{int(now.timestamp() // DEFAULT_INTERVAL_S)}",
            text=f"{CORPORATE_JETS[icao24]} aloft ({callsign or icao24.upper()})",
            tickers=[],
            published_at=now,
            impact="low",
            sector="Corporate Aviation",
            geo={"type": "Point", "coordinates": [lng, lat], "callsign": callsign, "icao24": icao24},
        ))

    ins, mod = await upsert_events(drafts)
    jlog("info", "opensky.upsert", inserted=ins, modified=mod, count=len(drafts))


if __name__ == "__main__":
    sync_main(NAME, work, DEFAULT_INTERVAL_S)
