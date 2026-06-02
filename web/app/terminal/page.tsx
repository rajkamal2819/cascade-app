"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Globe2, Network, Boxes } from "lucide-react";
import { AgentTrace } from "@/components/AgentTrace";
import { BootSequence } from "@/components/BootSequence";
import { Cascade } from "@/components/Cascade";
import { CascadeGraph } from "@/components/CascadeGraph";
import { CascadeGraph3D } from "@/components/CascadeGraph3D";
import { CompareView } from "@/components/CompareView";
import { CounterfactualOverlay, CounterfactualToggle } from "@/components/CounterfactualOverlay";
import { DemoTour } from "@/components/DemoTour";
import { NodeReasoning } from "@/components/NodeReasoning";
import { Feed } from "@/components/Feed";
import { Globe } from "@/components/Globe";
import { ReplayMenu } from "@/components/ReplayMenu";
import { RefreshButton } from "@/components/RefreshButton";
import { WorkerProgressBar } from "@/components/WorkerProgressBar";
import { ResizableRail } from "@/components/ResizableRail";
import { SearchBar } from "@/components/SearchBar";
import { LiveStatusPill } from "@/components/LiveStatusPill";
import { TimeMachine } from "@/components/TimeMachine";
import { WatchMode } from "@/components/WatchMode";
import { api, type StatsResponse } from "@/lib/api";
import { useLiveEvents } from "@/lib/sse";
import { useStore } from "@/lib/store";

type ViewMode = "globe" | "graph" | "graph3d";

const EXAMPLE_QUERIES = [
  { label: "Taiwan Strait tensions", query: "Taiwan Strait geopolitical risk semiconductor supply" },
  { label: "OPEC supply cut", query: "OPEC production cut oil price energy" },
  { label: "AI capex slowdown", query: "AI capex slowdown NVIDIA hyperscaler demand" },
  { label: "Fed rate decision", query: "Federal Reserve rate decision inflation markets" },
];

export default function TerminalPage() {
  useLiveEvents();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("globe");
  const [isWatchMode, setIsWatchMode] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsWatchMode(new URLSearchParams(window.location.search).get("watch") === "1");
  }, []);
  const events = useStore((s) => s.events);
  const selectEvent = useStore((s) => s.selectEvent);
  const selectedId = useStore((s) => s.selectedEventId);
  const cascade = useStore((s) => s.cascade);
  const compareIds = useStore((s) => s.compareIds);

  // Track resizable rail widths so the hero/nudge centre between them
  // instead of being anchored to the viewport (which makes them visually
  // offset by the panels' combined width).
  const [leftW, setLeftW] = useState(340);
  const [rightW, setRightW] = useState(360);
  useEffect(() => {
    const read = () => {
      try {
        const l = parseInt(localStorage.getItem("cascade-rail-left") || "340", 10);
        const r = parseInt(localStorage.getItem("cascade-rail-right") || "360", 10);
        if (Number.isFinite(l)) setLeftW(l);
        if (Number.isFinite(r)) setRightW(r);
      } catch {}
    };
    read();
    const id = setInterval(read, 600);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .stats(72)
        .then((s) => alive && setStats(s))
        .catch(() => {});
    tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Auto-switch to graph view when cascade loads with real nodes
  useEffect(() => {
    if (cascade && cascade.nodes.length > 0) setViewMode("graph");
  }, [cascade]);

  // DemoTour drives view-mode via this custom event.
  useEffect(() => {
    const onView = (e: Event) => {
      const v = (e as CustomEvent<ViewMode>).detail;
      if (v === "globe" || v === "graph" || v === "graph3d") setViewMode(v);
    };
    window.addEventListener("cascade:view", onView);
    return () => window.removeEventListener("cascade:view", onView);
  }, []);

  // ?replay=<slug> → fetch the seeded scenario event and auto-select it.
  // Same handler is also fired by the ReplayMenu via the `cascade:replay`
  // CustomEvent so judges can pick a scenario without reloading.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const runReplay = async (slug: string) => {
      try {
        const r = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"}/events?hours_back=72&limit=200`,
          { cache: "no-store" },
        );
        const data = await r.json();
        const match = (data.events ?? []).find(
          (e: { id: string; headline?: string }) =>
            (e as { replay?: string }).replay === slug ||
            (e.headline ?? "").toLowerCase().includes(slug.replace(/-/g, " ")),
        );
        if (match?.id) selectEvent(match.id);
      } catch {}
    };

    const slug = new URLSearchParams(window.location.search).get("replay");
    if (slug) runReplay(slug);

    const onReplay = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) runReplay(detail);
    };
    window.addEventListener("cascade:replay", onReplay);
    return () => window.removeEventListener("cascade:replay", onReplay);
  }, [selectEvent]);

  // ⌘K / "/" → focus search · Esc → exit compare mode
  const clearCompare = useStore((s) => s.clearCompare);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") || (!inField && ev.key === "/")) {
        ev.preventDefault();
        (document.getElementById("cascade-search") as HTMLInputElement | null)?.focus();
      }
      // G = globe, C = graph, V = graph3d (volume)
      if (!inField && ev.key.toLowerCase() === "g") setViewMode("globe");
      if (!inField && ev.key.toLowerCase() === "c") setViewMode("graph");
      if (!inField && ev.key.toLowerCase() === "v") setViewMode("graph3d");
      // Esc → exit compare mode
      if (!inField && ev.key === "Escape") clearCompare();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearCompare]);

  const showHero = events.length === 0;

  if (isWatchMode) {
    return <WatchMode />;
  }

  return (
    <main className="terminal-bg relative h-screen overflow-hidden text-text">

      {/* ── Center canvas: Globe, single CascadeGraph, or split CompareView ── */}
      <div className="absolute inset-0">
        <AnimatePresence mode="wait">
          {compareIds && compareIds[0] && compareIds[1] ? (
            <motion.div
              key="compare"
              className="absolute inset-0"
              style={{ left: leftW + 16, right: rightW + 16, top: 64, bottom: 48 }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35 }}
            >
              <CompareView leftId={compareIds[0]} rightId={compareIds[1]} />
            </motion.div>
          ) : viewMode === "globe" ? (
            <motion.div
              key="globe"
              className="absolute inset-0"
              initial={{ opacity: 0, scale: 1.04 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.45, ease: "easeInOut" }}
            >
              <Globe />
            </motion.div>
          ) : viewMode === "graph3d" ? (
            <motion.div
              key="graph3d"
              className="absolute"
              style={{ left: leftW + 16, right: rightW + 16, top: 72, bottom: 48 }}
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.04 }}
              transition={{ duration: 0.45, ease: "easeInOut" }}
            >
              <CascadeGraph3D />
            </motion.div>
          ) : (
            <motion.div
              key="graph"
              className="absolute flex items-center justify-center"
              style={{ left: leftW + 16, right: rightW + 16, top: 72, bottom: 48 }}
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.04 }}
              transition={{ duration: 0.45, ease: "easeInOut" }}
            >
              <CascadeGraph />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Top bar ── 3-column grid so SearchBar is geometrically centred
              regardless of how wide the side cells get. */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 grid grid-cols-[1fr_minmax(360px,560px)_1fr] items-center gap-4 px-4 py-3">
        <div className="pointer-events-auto flex items-center gap-3 justify-self-start">
          <Link
            href="/"
            className="glass mono inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-[0.25em] text-text"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent pulse-soft" style={{ boxShadow: "0 0 10px var(--accent-glow)" }} />
            CASCADE
          </Link>
          <LiveStatusPill stats={stats} />
        </div>

        <div className="pointer-events-auto justify-self-center w-full max-w-[560px]">
          <SearchBar onResults={(hits) => { if (hits[0]) selectEvent(hits[0].id); }} />
        </div>

        <div className="pointer-events-auto flex items-center gap-2 justify-self-end">
          <RefreshButton />
          <CounterfactualToggle />
          <ReplayMenu />
          {/* View-mode toggle */}
          <div className="glass flex items-center gap-0.5 rounded-full p-0.5">
            <button
              onClick={() => setViewMode("globe")}
              title="Globe view (G)"
              className={
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider transition " +
                (viewMode === "globe" ? "bg-accent/20 text-accent" : "text-muted hover:text-text")
              }
            >
              <Globe2 size={12} />
              <span className="hidden sm:inline">Globe</span>
            </button>
            <button
              onClick={() => setViewMode("graph")}
              title="Graph view (C)"
              className={
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider transition " +
                (viewMode === "graph" ? "bg-accent/20 text-accent" : "text-muted hover:text-text")
              }
            >
              <Network size={12} />
              <span className="hidden sm:inline">Graph</span>
            </button>
            <button
              onClick={() => setViewMode("graph3d")}
              title="3D cascade · hop reveal (V)"
              className={
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider transition " +
                (viewMode === "graph3d" ? "bg-accent/20 text-accent" : "text-muted hover:text-text")
              }
            >
              <Boxes size={12} />
              <span className="hidden sm:inline">3D</span>
            </button>
          </div>
        </div>
      </header>

      {/* ── Left Feed rail — always open ── */}
      <motion.aside
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.35, delay: 0.05 }}
        className="pointer-events-auto absolute bottom-12 left-3 top-[72px] z-10 hidden md:block"
      >
        <ResizableRail side="left" defaultWidth={340} className="h-full">
          <Feed />
        </ResizableRail>
      </motion.aside>

      {/* ── Right Cascade rail — always open ── */}
      <motion.aside
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.35, delay: 0.1 }}
        className="pointer-events-auto absolute bottom-12 right-3 top-[72px] z-10 hidden md:block"
      >
        <ResizableRail side="right" defaultWidth={360} className="h-full">
          <Cascade />
        </ResizableRail>
      </motion.aside>

      {/* ── Centred middle column (lives between the rails so the hero
              and nudge are visually centred in the visible canvas) ── */}
      <div
        className="pointer-events-none absolute top-[72px] bottom-12 z-10 hidden md:flex flex-col items-center justify-center"
        style={{ left: leftW + 16, right: rightW + 16 }}
      >
        <AnimatePresence>
          {showHero && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.4, delay: 0.3 }}
              className="w-full max-w-sm text-center"
            >
              <div className="glass pointer-events-auto rounded-2xl px-6 py-5">
                <div className="mono text-[10px] uppercase tracking-[0.4em] text-muted">planetary nervous system</div>
                <div className="mt-1 text-[14px] text-text">Watch news, ships, quakes &amp; filings cascade in real time</div>
                <div className="mt-1 text-[11px] text-muted">$graphLookup · voyage rerank-2.5 · gemini</div>
                <div className="mt-4 mono text-[9px] uppercase tracking-widest text-muted/70">try a query</div>
                <div className="mt-1.5 flex flex-wrap justify-center gap-1.5">
                  {EXAMPLE_QUERIES.map((q) => (
                    <button
                      key={q.label}
                      onClick={() => window.dispatchEvent(new CustomEvent("cascade:search", { detail: q.query }))}
                      className="rounded-full bg-white/[0.04] px-3 py-1 text-[11px] text-text/85 hover:bg-accent/15 hover:text-accent transition"
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Nudge — sits at the bottom of the middle column */}
        {!showHero && !selectedId && (
          <div className="absolute bottom-4 text-center">
            <div className="mono text-[10px] uppercase tracking-[0.35em] text-muted/60">
              click an event to walk its cascade
            </div>
            <div className="mt-1 flex items-center justify-center gap-2 text-[9px] text-muted/40">
              <span><span className="kbd">j</span><span className="kbd ml-0.5">k</span> navigate</span>
              <span>·</span>
              <span><span className="kbd">/</span> search</span>
              <span>·</span>
              <span><span className="kbd">G</span> globe <span className="kbd ml-0.5">C</span> graph</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom stats strip ── */}
      <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pb-3">
        <div className="glass mono mx-auto flex max-w-5xl items-center justify-between gap-5 rounded-full px-4 py-1.5 text-[10px] uppercase tracking-wider text-muted">
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <Stat label="events 72h" value={stats?.total_events} />
            <Stat label="cascades" value={stats?.cascade_count} />
            <Stat label="critical" value={stats?.impact_counts?.critical ?? 0} color="var(--critical)" />
            <Stat label="high" value={stats?.impact_counts?.high ?? 0} color="var(--high)" />
          </div>
          <TimeMachine />
        </div>
      </footer>

      {/* ── Eye-candy overlays ── */}
      <BootSequence />
      <AgentTrace />
      <CounterfactualOverlay />
      <DemoTour />
      <NodeReasoning />
      <WorkerProgressBar />

      {/* ── Mobile: stack ── */}
      <div className="absolute inset-x-2 bottom-12 top-[72px] z-10 md:hidden">
        <div className="grid h-full grid-rows-2 gap-2">
          <div className="min-h-0"><Feed /></div>
          <div className="min-h-0"><Cascade /></div>
        </div>
      </div>
    </main>
  );
}

function Stat({ label, value, color }: { label: string; value: number | undefined; color?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span>{label}</span>
      <span className="tabular-nums text-text" style={color ? { color } : undefined}>{value ?? "—"}</span>
    </span>
  );
}
