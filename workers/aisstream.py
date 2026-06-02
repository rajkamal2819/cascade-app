"""
AISStream.io live vessel tracking → events collection.

Subscribes to the free AISStream WebSocket. Vessels stalled near major
container ports (speed < 1 kn for >30 min) become high-impact "port
congestion" events. Set AISSTREAM_API_KEY in .env to enable.

Free tier: unlimited messages, requires a free API key from aisstream.io.

Run:
    python -m workers.aisstream
    python -m workers.aisstream --once   # connect, drain 2 min of messages, exit
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import websockets

from workers._common import EventDraft, jlog, load_dotenv_once, upsert_events

load_dotenv_once()

NAME = "aisstream"
WSS_URL = "wss://stream.aisstream.io/v0/stream"
API_KEY = os.environ.get("AISSTREAM_API_KEY", "").strip()
STALL_SPEED_KT = 1.0
STALL_DURATION_S = 1800  # 30 min

# Bounding boxes for major container ports (sw lat/lng, ne lat/lng).
PORT_BBOXES: dict[str, list[list[float]]] = {
    "Kaohsiung": [[22.55, 120.20], [22.70, 120.40]],
    "Shanghai":  [[30.50, 121.50], [31.60, 122.20]],
    "Singapore": [[1.18, 103.60], [1.42, 104.10]],
    "LosAngeles":[[33.70, -118.30], [33.78, -118.20]],
    "Rotterdam": [[51.85, 3.90], [52.10, 4.50]],
}

# Track per-vessel stall start time (mmsi → first_seen_stalled_utc).
_stall_start: dict[int, datetime] = {}


def _subscribe_msg() -> str:
    bboxes: list[list[list[float]]] = list(PORT_BBOXES.values())
    return json.dumps({
        "APIKey": API_KEY,
        "BoundingBoxes": bboxes,
        "FilterMessageTypes": ["PositionReport"],
    })


def _port_for(lat: float, lng: float) -> str | None:
    for name, ((sw_lat, sw_lng), (ne_lat, ne_lng)) in (
        (n, b) for n, b in PORT_BBOXES.items()
    ):
        if sw_lat <= lat <= ne_lat and sw_lng <= lng <= ne_lng:
            return name
    return None


async def _drain(duration_s: float | None = None) -> None:
    if not API_KEY:
        jlog("warn", "aisstream.no_key", message="AISSTREAM_API_KEY not set — worker is a no-op")
        return
    end = datetime.now(timezone.utc) + timedelta(seconds=duration_s) if duration_s else None
    async with websockets.connect(WSS_URL, ping_interval=20, ping_timeout=20) as ws:
        await ws.send(_subscribe_msg())
        jlog("info", "aisstream.subscribed", ports=list(PORT_BBOXES.keys()))
        drafts_buffer: list[EventDraft] = []
        last_flush = datetime.now(timezone.utc)
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("MessageType") != "PositionReport":
                continue
            pr = (msg.get("Message", {}) or {}).get("PositionReport", {}) or {}
            meta = msg.get("MetaData", {}) or {}
            try:
                lat = float(pr.get("Latitude") or 0)
                lng = float(pr.get("Longitude") or 0)
                speed = float(pr.get("Sog") or 0)
                mmsi = int(meta.get("MMSI") or 0)
            except (TypeError, ValueError):
                continue
            port = _port_for(lat, lng)
            if not port:
                continue
            now = datetime.now(timezone.utc)
            if speed < STALL_SPEED_KT:
                started = _stall_start.setdefault(mmsi, now)
                if (now - started).total_seconds() >= STALL_DURATION_S:
                    drafts_buffer.append(EventDraft(
                        source="AISStream",
                        source_type="ais_stall",
                        external_id=f"ais-stall-{mmsi}-{int(started.timestamp())}",
                        text=f"Vessel MMSI {mmsi} stalled at {port} port for {int((now - started).total_seconds()/60)} min",
                        tickers=[],
                        published_at=now,
                        impact="high",
                        sector="Shipping",
                        geo={"type": "Point", "coordinates": [lng, lat], "port": port, "mmsi": mmsi},
                    ))
            else:
                _stall_start.pop(mmsi, None)

            if drafts_buffer and (datetime.now(timezone.utc) - last_flush).total_seconds() > 30:
                ins, mod = await upsert_events(drafts_buffer)
                jlog("info", "aisstream.upsert", inserted=ins, modified=mod, count=len(drafts_buffer))
                drafts_buffer.clear()
                last_flush = datetime.now(timezone.utc)

            if end and datetime.now(timezone.utc) >= end:
                if drafts_buffer:
                    await upsert_events(drafts_buffer)
                return


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()
    jlog("info", "worker.start", worker=NAME, once=args.once)
    if args.once:
        await _drain(duration_s=120)
        return
    while True:
        try:
            await _drain()
        except Exception as exc:  # noqa: BLE001
            jlog("warn", "aisstream.reconnect", error=type(exc).__name__, message=str(exc)[:200])
            await asyncio.sleep(10)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
