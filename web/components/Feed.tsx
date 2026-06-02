"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList, type FixedSizeList as FixedSizeListType } from "react-window";
import { motion } from "framer-motion";
import { ChevronDown, Network, Pin, SlidersHorizontal, X } from "lucide-react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";

const ROW_HEIGHT = 60;

const IMPACT_DOT: Record<string, string> = {
  critical: "var(--critical)",
  high: "var(--high)",
  medium: "var(--text-muted)",
  low: "var(--text-muted)",
};

const IMPACT_GLOW: Record<string, string> = {
  critical: "var(--critical-glow)",
  high: "var(--high-glow)",
  medium: "transparent",
  low: "transparent",
};

// Source → short display label
const SOURCE_LABEL: Record<string, string> = {
  sec_8k: "SEC",
  news: "News",
  marketaux: "News",
  finnhub_ws: "Ticks",
  alpha_vantage: "TA",
  reddit: "Social",
  gdelt_news: "GDELT",
  usgs_quake: "USGS",
  noaa_alert: "NOAA",
  opensky_jet: "Flight",
  opensky_cluster: "Cluster",
  ais_stall: "Ship",
  test: "Seed",
  chart: "Chart",
};

// Sector palette — each sector gets a subtle hue so the chip rail reads at a glance.
const SECTOR_COLOR: Record<string, string> = {
  Technology: "#60a5fa",
  Financials: "#4ade80",
  Healthcare: "#f472b6",
  Energy: "#fbbf24",
  Industrials: "#fb923c",
  "Consumer Discretionary": "#c084fc",
  "Consumer Staples": "#22d3ee",
  "Communication Services": "#a78bfa",
  Materials: "#84cc16",
  Utilities: "#facc15",
  "Real Estate": "#f87171",
  Geopolitics: "#ef4444",
  Geophysical: "#fb7185",
  Weather: "#38bdf8",
  Shipping: "#22d3ee",
  "Corporate Aviation": "#a3a3a3",
  Macro: "#94a3b8",
  Crypto: "#a855f7",
};

type Impact = "all" | "critical" | "high";
type Sort = "newest" | "impact";

// Always pull the widest reasonable window — "latest" means latest across
// everything we have. UX-wise the user no longer thinks in time, they think
// in categories + impact.
const DEFAULT_HOURS = 720;

// Per-sector cap applied client-side when no explicit sector filter is set,
// so noisy ingestors (NOAA weather, GDELT geopolitics) don't crowd out the
// market-relevant feed. When a user clicks a sector chip the cap drops away
// so they see everything in that sector.
const NOISY_SECTOR_CAP: Record<string, number> = {
  Weather: 12,
  Geopolitics: 15,
  Geophysical: 12,
  "Corporate Aviation": 8,
  Shipping: 8,
};

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!t) return "";
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  // Absolute date past a week
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function dayBucket(iso: string | null | undefined): string {
  if (!iso) return "Earlier";
  const t = new Date(iso).getTime();
  if (!t) return "Earlier";
  const now = new Date();
  const eventDay = new Date(iso);
  const sameDay = now.toDateString() === eventDay.toDateString();
  if (sameDay) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (yesterday.toDateString() === eventDay.toDateString()) return "Yesterday";
  const diffDays = Math.floor((now.getTime() - t) / (1000 * 60 * 60 * 24));
  if (diffDays < 7) return "This week";
  if (diffDays < 30) return "This month";
  return "Earlier";
}

export function Feed() {
  const events = useStore((s) => s.events);
  const setEvents = useStore((s) => s.setEvents);
  const selectedId = useStore((s) => s.selectedEventId);
  const selectEvent = useStore((s) => s.selectEvent);
  const pinForCompare = useStore((s) => s.pinForCompare);
  const compareIds = useStore((s) => s.compareIds);
  const status = useStore((s) => s.streamStatus);
  const timeOffset = useStore((s) => s.timeOffset);

  const [impact, setImpact] = useState<Impact>("all");
  const [cascadableOnly, setCascadableOnly] = useState(false);
  const [sectorFilter, setSectorFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [sort, setSort] = useState<Sort>("newest");
  const [showFilters, setShowFilters] = useState(false);
  const [height, setHeight] = useState(600);
  const listRef = useRef<FixedSizeListType<unknown> | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  // Fetch whenever any server-driven filter changes.
  useEffect(() => {
    api
      .listEvents({
        hours_back: DEFAULT_HOURS,
        limit: 200,
        sector: sectorFilter || undefined,
        source_type: sourceFilter || undefined,
      })
      .then((res) => setEvents(res.events))
      .catch(() => {});
  }, [setEvents, sectorFilter, sourceFilter]);

  useEffect(() => {
    const measure = () => {
      const headerH = headerRef.current?.getBoundingClientRect().height ?? 0;
      const aside = headerRef.current?.parentElement;
      const containerH = aside?.getBoundingClientRect().height ?? window.innerHeight - 120;
      setHeight(Math.max(220, containerH - headerH - 8));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (headerRef.current?.parentElement) ro.observe(headerRef.current.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Client-side filters (cheap, no roundtrip)
  const filtered = useMemo(() => {
    let xs = events;
    // Time-machine: hide events newer than (now − timeOffset days).
    if (timeOffset > 0) {
      const cutoff = Date.now() - timeOffset * 24 * 3600 * 1000;
      xs = xs.filter((e) => {
        const t = e.published_at ? new Date(e.published_at).getTime() : 0;
        return t > 0 && t <= cutoff;
      });
    }
    if (impact !== "all") xs = xs.filter((e) => e.impact === impact);
    if (cascadableOnly) xs = xs.filter((e) => e.has_cascade);

    // Sector rebalance — cap noisy ingestors when no sector filter is set,
    // keeping only the most-recent N per sector so market signal isn't
    // buried under hundreds of NOAA alerts or GDELT geopolitics scrapes.
    if (!sectorFilter) {
      const sortedByRecency = [...xs].sort((a, b) => {
        const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
        const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
        return tb - ta;
      });
      const counts = new Map<string, number>();
      const kept = new Set<string>();
      for (const e of sortedByRecency) {
        const sec = e.sector || "";
        const cap = NOISY_SECTOR_CAP[sec];
        if (cap !== undefined) {
          const c = counts.get(sec) ?? 0;
          if (c >= cap) continue;
          counts.set(sec, c + 1);
        }
        kept.add(e.id);
      }
      xs = xs.filter((e) => kept.has(e.id));
    }

    if (sort === "impact") {
      const w: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
      xs = [...xs].sort((a, b) => (w[b.impact] ?? 0) - (w[a.impact] ?? 0));
    }
    return xs;
  }, [events, impact, cascadableOnly, sort, timeOffset, sectorFilter]);

  // Interleave day-group headers into the list (only when sorted by newest)
  type ListItem =
    | { kind: "header"; label: string; key: string }
    | { kind: "event"; event: typeof filtered[0]; key: string };

  const listItems: ListItem[] = useMemo(() => {
    if (sort !== "newest") {
      return filtered.map((e) => ({ kind: "event" as const, event: e, key: e.id }));
    }
    const out: ListItem[] = [];
    let lastBucket = "";
    for (const e of filtered) {
      const b = dayBucket(e.published_at);
      if (b !== lastBucket) {
        out.push({ kind: "header", label: b, key: `h_${b}` });
        lastBucket = b;
      }
      out.push({ kind: "event", event: e, key: e.id });
    }
    return out;
  }, [filtered, sort]);

  // Sector chip counts — reflect the *displayed* count (after the noisy-sector
  // cap), not raw ingest. Otherwise the badge says "138" while the feed shows
  // 12 rows and the user thinks the filter is broken.
  const sectorCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of events) {
      const s = e.sector || "Uncategorized";
      map.set(s, (map.get(s) ?? 0) + 1);
    }
    return [...map.entries()]
      .filter(([s]) => s !== "Uncategorized" || sectorFilter === "Uncategorized")
      .map(([s, raw]) => {
        const cap = NOISY_SECTOR_CAP[s];
        const shown = cap !== undefined ? Math.min(cap, raw) : raw;
        return [s, shown] as [string, number];
      })
      .sort((a, b) => b[1] - a[1]);
  }, [events, sectorFilter]);

  const sourceCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of events) {
      const s = e.source_type;
      if (!s) continue;
      map.set(s, (map.get(s) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [events]);

  const activeFilters: { key: string; label: string; clear: () => void }[] = [];
  if (impact !== "all") activeFilters.push({ key: "impact", label: impact, clear: () => setImpact("all") });
  if (cascadableOnly) activeFilters.push({ key: "graph", label: "graph", clear: () => setCascadableOnly(false) });
  if (sectorFilter) activeFilters.push({ key: "sector", label: sectorFilter, clear: () => setSectorFilter("") });
  if (sourceFilter)
    activeFilters.push({ key: "source", label: SOURCE_LABEL[sourceFilter] ?? sourceFilter, clear: () => setSourceFilter("") });

  const clearAll = useCallback(() => {
    setImpact("all");
    setCascadableOnly(false);
    setSectorFilter("");
    setSourceFilter("");
  }, []);

  // ---------- Keyboard navigation: j/k traverse, Enter selects, Esc clears, 1-4 windows ----------
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

      if (ev.key === "j" || ev.key === "k") {
        ev.preventDefault();
        const idx = filtered.findIndex((e) => e.id === selectedId);
        const nextIdx =
          ev.key === "j"
            ? Math.min(filtered.length - 1, idx < 0 ? 0 : idx + 1)
            : Math.max(0, idx < 0 ? 0 : idx - 1);
        const next = filtered[nextIdx];
        if (next) {
          selectEvent(next.id);
          // Find position in listItems (which has interleaved headers)
          const listIdx = listItems.findIndex((it) => it.kind === "event" && it.event.id === next.id);
          if (listIdx >= 0) listRef.current?.scrollToItem(listIdx, "smart");
        }
      } else if (ev.key === "Escape") {
        selectEvent(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, listItems, selectedId, selectEvent]);

  const emptyFiltered = filtered.length === 0;

  return (
    <aside className="glass flex h-full min-h-0 flex-col overflow-hidden rounded-2xl">
      {/* Header */}
      <div ref={headerRef} className="border-b border-white/5 px-3 pt-3 pb-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="mono uppercase tracking-[0.18em] text-muted">Live feed</span>
          <StreamBadge status={status} />
        </div>

        {/* Primary row: impact + graph */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {(["all", "critical", "high"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setImpact(f)}
              className={
                "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider transition " +
                (impact === f
                  ? "bg-accent text-black"
                  : "bg-white/[0.04] text-muted hover:bg-white/[0.08] hover:text-text")
              }
            >
              {f}
            </button>
          ))}
          <button
            onClick={() => setCascadableOnly((v) => !v)}
            title="Only events whose tickers are in the supply-chain graph"
            className={
              "ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider transition " +
              (cascadableOnly
                ? "bg-accent/15 text-accent ring-1 ring-accent/30"
                : "bg-white/[0.04] text-muted hover:text-text")
            }
          >
            <Network size={10} />
            graph
          </button>
        </div>

        {/* Category quick-pick — top 5 categories from current feed */}
        {sectorCounts.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="mono text-[9px] uppercase tracking-widest text-muted">category</span>
            {sectorCounts.slice(0, 5).map(([s, n]) => {
              const active = sectorFilter === s;
              const color = SECTOR_COLOR[s] ?? "var(--text-muted)";
              return (
                <button
                  key={s}
                  onClick={() => setSectorFilter(active ? "" : s)}
                  className={
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition " +
                    (active ? "bg-white/10 text-text ring-1 ring-white/15" : "bg-white/[0.03] text-muted hover:bg-white/[0.07]")
                  }
                  style={active ? { boxShadow: `inset 0 0 0 1px ${color}`, color } : undefined}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                  <span>{shortSector(s)}</span>
                  <span className="tabular-nums opacity-60">{n}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Sort toggle */}
        <div className="mt-2 flex items-center gap-1.5">
          <span className="mono text-[9px] uppercase tracking-widest text-muted">sort</span>
          <div className="flex flex-1 gap-1">
            {(["newest", "impact"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={
                  "flex-1 rounded-md py-0.5 text-[10px] uppercase tracking-wider transition " +
                  (sort === s
                    ? "bg-white/10 text-text ring-1 ring-white/15"
                    : "bg-white/[0.03] text-muted hover:text-text")
                }
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* More filters expander */}
        <button
          onClick={() => setShowFilters((v) => !v)}
          className="mt-2 flex w-full items-center justify-between rounded-md px-1.5 py-1 text-[10px] uppercase tracking-wider text-muted hover:text-text"
        >
          <span className="inline-flex items-center gap-1.5">
            <SlidersHorizontal size={11} />
            categories · sources
          </span>
          <ChevronDown size={12} className={"transition " + (showFilters ? "rotate-180" : "")} />
        </button>

        {showFilters && (
          <div className="mt-1.5 space-y-2">
            <FilterGroup label="sector / category">
              {sectorCounts.length === 0 ? (
                <span className="text-[10px] text-muted">no data</span>
              ) : (
                sectorCounts.slice(0, 10).map(([s, n]) => {
                  const active = sectorFilter === s;
                  const color = SECTOR_COLOR[s] ?? "var(--text-muted)";
                  return (
                    <button
                      key={s}
                      onClick={() => setSectorFilter(active ? "" : s)}
                      className={
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition " +
                        (active ? "bg-white/10 text-text" : "bg-white/[0.03] text-muted hover:bg-white/[0.07]")
                      }
                      style={active ? { boxShadow: `inset 0 0 0 1px ${color}`, color } : undefined}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                      <span className="truncate">{shortSector(s)}</span>
                      <span className="tabular-nums opacity-60">{n}</span>
                    </button>
                  );
                })
              )}
            </FilterGroup>

            <FilterGroup label="source">
              {sourceCounts.length === 0 ? (
                <span className="text-[10px] text-muted">no data</span>
              ) : (
                sourceCounts.map(([s, n]) => {
                  const active = sourceFilter === s;
                  return (
                    <button
                      key={s}
                      onClick={() => setSourceFilter(active ? "" : s)}
                      className={
                        "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider transition " +
                        (active
                          ? "bg-accent/15 text-accent ring-1 ring-accent/30"
                          : "bg-white/[0.03] text-muted hover:bg-white/[0.07]")
                      }
                    >
                      {SOURCE_LABEL[s] ?? s}
                      <span className="ml-1 tabular-nums opacity-60">{n}</span>
                    </button>
                  );
                })
              )}
            </FilterGroup>
          </div>
        )}

        {activeFilters.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-2">
            <span className="mono text-[9px] uppercase tracking-widest text-muted">active</span>
            {activeFilters.map((f) => (
              <button
                key={f.key}
                onClick={f.clear}
                className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-accent hover:bg-accent/15"
              >
                {f.label}
                <X size={10} />
              </button>
            ))}
            <button onClick={clearAll} className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-muted hover:text-text">
              clear
            </button>
          </div>
        )}
      </div>

      {emptyFiltered ? (
        events.length === 0 && activeFilters.length === 0 ? (
          // Skeleton state — no events loaded yet
          <div className="flex-1 space-y-0">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <div
                key={i}
                className="border-b border-white/[0.03] px-3 py-2.5"
                style={{ opacity: 1 - i * 0.08 }}
              >
                <div className="flex items-center gap-2">
                  <div className="shimmer h-1.5 w-1.5 rounded-full" />
                  <div className="shimmer h-3 w-10 rounded" />
                  <div className="shimmer h-2.5 w-14 rounded" />
                  <div className="shimmer ml-auto h-2.5 w-6 rounded" />
                </div>
                <div className="shimmer mt-2 h-3 w-3/4 rounded" />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-[11px] text-muted">
            No events match these filters.
            {activeFilters.length > 0 && (
              <button onClick={clearAll} className="ml-1 underline hover:text-text">
                clear
              </button>
            )}
          </div>
        )
      ) : (
        <FixedSizeList
          ref={listRef as never}
          className="thin-scroll"
          height={height}
          width={"100%"}
          itemCount={listItems.length}
          itemSize={ROW_HEIGHT}
          overscanCount={6}
        >
          {({ index, style }) => {
            const item = listItems[index];
            if (item.kind === "header") {
              return (
                <div
                  style={style}
                  className="mono flex items-center gap-2 border-b border-white/[0.04] bg-white/[0.02] px-3 text-[9px] uppercase tracking-[0.2em] text-muted"
                >
                  <span className="h-px flex-1 bg-white/10" />
                  <span>{item.label}</span>
                  <span className="h-px flex-1 bg-white/10" />
                </div>
              );
            }
            const e = item.event;
            const selected = e.id === selectedId;
            const sectorColor = e.sector ? SECTOR_COLOR[e.sector] : undefined;
            const isCritical = e.impact === "critical";
            const isHigh = e.impact === "high";
            return (
              <motion.div
                key={e.id}
                style={style}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.18 }}
                onClick={() => selectEvent(e.id)}
                className={
                  "group cursor-pointer border-b border-white/[0.04] px-3 py-2 text-xs transition " +
                  (selected
                    ? "bg-accent/10 ring-1 ring-inset ring-accent/40"
                    : "hover:bg-white/[0.03]") +
                  " " +
                  (isCritical ? "accent-bar-critical" : isHigh ? "accent-bar-high" : "")
                }
              >
                <div className="flex items-center gap-2">
                  <span className="relative inline-flex h-2 w-2 shrink-0">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{
                        background: IMPACT_DOT[e.impact] ?? "var(--text-muted)",
                        boxShadow: `0 0 10px ${IMPACT_GLOW[e.impact] ?? "transparent"}`,
                      }}
                    />
                    {(isCritical || isHigh) && (
                      <span
                        className="pulse-ring absolute inset-0 rounded-full"
                        style={{ border: `1px solid ${IMPACT_DOT[e.impact]}` }}
                      />
                    )}
                  </span>
                  <span
                    className={
                      "mono shrink-0 tracking-wider text-text " +
                      (isCritical ? "text-[12px] font-bold" : "text-[11px] font-semibold")
                    }
                  >
                    {e.tickers.slice(0, 2).join(" · ") || e.source_type.toUpperCase()}
                  </span>
                  {e.sector && (
                    <span
                      className="shrink-0 rounded px-1 py-px text-[8.5px] uppercase tracking-wider"
                      style={{
                        background: sectorColor ? `${sectorColor}1a` : "rgba(255,255,255,0.04)",
                        color: sectorColor ?? "var(--text-muted)",
                      }}
                    >
                      {shortSector(e.sector)}
                    </span>
                  )}
                  {e.source_type && (
                    <span className="shrink-0 text-[9px] uppercase tracking-wider text-muted/70">
                      {SOURCE_LABEL[e.source_type] ?? e.source_type}
                    </span>
                  )}
                  {e.has_cascade && (
                    <Network
                      size={10}
                      className="shrink-0 text-accent"
                      style={{ filter: "drop-shadow(0 0 6px var(--accent-glow))" }}
                    />
                  )}
                  <span className="mono ml-auto shrink-0 text-[10px] tabular-nums text-muted">
                    {relativeTime(e.published_at)}
                  </span>
                  <button
                    onClick={(ev) => { ev.stopPropagation(); pinForCompare(e.id); }}
                    title={compareIds?.[0] === e.id ? "Pinned · pin another event to compare" : "Pin to compare"}
                    className={
                      "shrink-0 rounded p-0.5 transition " +
                      (compareIds?.[0] === e.id || compareIds?.[1] === e.id
                        ? "text-yellow-400"
                        : "text-muted/40 opacity-0 group-hover:opacity-100 hover:text-accent")
                    }
                  >
                    <Pin size={11} />
                  </button>
                </div>
                <div
                  className={
                    "mt-1 line-clamp-2 leading-snug text-muted group-hover:text-text/80 " +
                    (isCritical ? "text-[12px] text-text/90" : "text-[11px]")
                  }
                >
                  {e.headline || e.source_type}
                </div>
              </motion.div>
            );
          }}
        </FixedSizeList>
      )}

      {/* Footer hint */}
      <div className="mono flex items-center justify-between border-t border-white/5 px-3 py-1.5 text-[9px] uppercase tracking-widest text-muted/70">
        <span className="flex items-center gap-1">
          <span className="kbd">j</span>
          <span className="kbd">k</span>
          <span className="ml-1">navigate</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="kbd">/</span>
          <span>search</span>
        </span>
      </div>
    </aside>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mono mb-1 text-[9px] uppercase tracking-widest text-muted/70">{label}</div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function shortSector(s: string): string {
  const map: Record<string, string> = {
    "Communication Services": "Comm",
    "Consumer Discretionary": "Cons Disc",
    "Consumer Staples": "Staples",
    "Real Estate": "RealEst",
    Uncategorized: "Other",
  };
  return map[s] ?? s;
}

function StreamBadge({ status }: { status: string }) {
  const isLive = status === "live";
  const isReconn = status === "reconnecting";
  const color = isLive ? "var(--accent)" : isReconn ? "var(--high)" : "var(--text-muted)";
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider" style={{ color }}>
      <span
        className={"h-1.5 w-1.5 rounded-full " + (isLive ? "pulse-soft" : "")}
        style={{ background: color, boxShadow: isLive ? `0 0 8px ${color}` : "none" }}
      />
      {status}
    </span>
  );
}
