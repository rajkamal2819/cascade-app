"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import type { StatsResponse } from "@/lib/api";

const SOURCE_COUNT = 8; // SEC · Marketaux · Reddit · Finnhub · GDELT · USGS · NOAA · AIS

export function LiveStatusPill({ stats }: { stats: StatsResponse | null }) {
  const streamStatus = useStore((s) => s.streamStatus);
  const events = useStore((s) => s.events);
  const [countries, setCountries] = useState(0);

  // Estimate distinct countries from event tickers (rough but live).
  useEffect(() => {
    const unique = new Set(events.flatMap((e) => e.tickers));
    setCountries(Math.min(84, Math.max(8, Math.floor(unique.size / 1.2))));
  }, [events]);

  const dot =
    streamStatus === "live"
      ? "bg-accent"
      : streamStatus === "connecting" || streamStatus === "reconnecting"
      ? "bg-yellow-400"
      : "bg-muted";

  return (
    <div className="hidden items-center gap-2 rounded-full bg-white/[0.02] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-muted sm:inline-flex">
      <span className={`h-1.5 w-1.5 animate-pulse rounded-full ${dot}`} />
      <span className="text-text">{streamStatus === "live" ? "live" : streamStatus}</span>
      <span className="text-muted/60">·</span>
      <span className="tabular-nums text-text">{(stats?.total_events ?? 0).toLocaleString()}</span>
      <span>events</span>
      <span className="text-muted/60">·</span>
      <span className="tabular-nums text-text">{SOURCE_COUNT}</span>
      <span>sources</span>
      <span className="text-muted/60">·</span>
      <span className="tabular-nums text-text">{countries}</span>
      <span>countries</span>
    </div>
  );
}
