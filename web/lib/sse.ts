// Browser EventSource client that talks to /stream and routes payloads
// into the Zustand store. The backend tags messages with:
//   event: ready     — handshake on connect
//   event: backfill  — recent events flushed on connect
//   event: event     — live insert from change-stream
//   event: heartbeat — server-time ping every 15s
//   event: ping      — legacy heartbeat name (kept for backwards compat)

import { useEffect } from "react";
import { SSE_URL } from "./api";
import { useStore } from "./store";
import type { Event } from "./api";

function parseEvent(raw: unknown): Event | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || !p.id) return null;
  return {
    id: p.id,
    headline: typeof p.headline === "string" ? p.headline : "",
    tickers: Array.isArray(p.tickers) ? (p.tickers as string[]) : [],
    sector: typeof p.sector === "string" ? p.sector : "",
    impact: typeof p.impact === "string" ? p.impact : "",
    source_type: typeof p.source_type === "string" ? p.source_type : "",
    published_at: (p.published_at as string | null) ?? null,
    has_cascade: Boolean(p.has_cascade),
  };
}

export function useLiveEvents() {
  useEffect(() => {
    const es = new EventSource(SSE_URL);
    useStore.getState().setStreamStatus("connecting");

    es.addEventListener("ready", () => {
      useStore.getState().setStreamStatus("live");
      useStore.getState().markHeartbeat();
    });

    es.addEventListener("backfill", (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data) as { events?: unknown[] };
        const events = (payload.events ?? [])
          .map(parseEvent)
          .filter((x): x is Event => x !== null);
        if (events.length) useStore.getState().pushBackfill(events);
      } catch {
        // ignore malformed backfill
      }
    });

    es.addEventListener("event", (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data);
        const event = parseEvent(payload);
        if (event) useStore.getState().pushEvent(event);
      } catch {
        // ignore malformed payloads
      }
    });

    es.addEventListener("heartbeat", () => {
      useStore.getState().markHeartbeat();
    });

    es.addEventListener("ping", () => {
      useStore.getState().markHeartbeat();
    });

    es.onerror = () => useStore.getState().setStreamStatus("reconnecting");

    return () => {
      es.close();
      useStore.getState().setStreamStatus("idle");
    };
  }, []);
}
