"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Pause, Play, SkipForward, X } from "lucide-react";
import { useStore } from "@/lib/store";

// DemoTour is a fully autonomous guided walkthrough that auto-plays when
// /terminal?demo=1 is loaded. It picks scripted scenarios in sequence,
// auto-selects them (triggering real cascade builds), and renders
// caption + caption-pill narration on top so judges have something to
// watch even if live ingestion is quiet.

type Beat = {
  ms: number;                       // dwell time for this beat
  caption: string;                  // big centred sentence
  pill?: string;                    // small mono uppercase chip above caption
  action?: "select-replay" | "switch-globe" | "switch-graph" | "switch-graph3d" | "toggle-whatif" | "clear";
  replay?: string;                  // for action = "select-replay"
};

const SCRIPT: Beat[] = [
  { ms: 2200, pill: "live · planetary nervous system", caption: "Cascade is watching news, ships, quakes and filings — globally, in real time." },
  { ms: 2200, pill: "scenario 1 of 3", caption: "A magnitude-6.4 earthquake just struck near Hualien, Taiwan.", action: "select-replay", replay: "taiwan-quake" },
  { ms: 2400, pill: "recursive CTE · 3 hops", caption: "We walk the supplier graph from the epicentre — TSMC, then everyone downstream of TSMC." },
  { ms: 2200, pill: "voyage rerank-2.5", caption: "A cross-encoder reranks the 50 closest nodes to keep only the most relevant exposures." },
  { ms: 2300, pill: "gemini 3 pro · synthesis", caption: "Gemini summarises the cascade and the society of agents debates it." },
  { ms: 2200, pill: "what-if", caption: "What if this quake had NOT happened? Counterfactual mode shows which nodes drop out.", action: "toggle-whatif" },
  { ms: 2200, pill: "graph view", caption: "Same cascade, force-directed — see the bottleneck in one frame.", action: "switch-graph" },
  { ms: 2600, pill: "3d cascade · hop reveal", caption: "Lift the graph into 3D. Each shell is a hop — watch the cascade unfold L0 → L3.", action: "switch-graph3d" },
  { ms: 1600, pill: "back to the globe", caption: "Cascade keeps painting the planet.", action: "switch-globe" },
  { ms: 2200, pill: "scenario 2 of 3", caption: "A container ship stalls 18 nautical miles off Kaohsiung.", action: "select-replay", replay: "ship-stall" },
  { ms: 2600, pill: "AIS · shipping", caption: "We pull every customer routed through that lane, then peers who reroute first." },
  { ms: 2200, pill: "scenario 3 of 3", caption: "Apple files an 8-K · Item 2.02 results of operations.", action: "select-replay", replay: "aapl-8k" },
  { ms: 2600, pill: "SEC EDGAR · 8-K", caption: "Cascade reads the filing, finds Apple's suppliers, and ranks who reacts first." },
  { ms: 2600, pill: "ready", caption: "Open the terminal — every event in your feed will do this in one click." },
];

function isActive() {
  if (typeof window === "undefined") return false;
  const p = new URLSearchParams(window.location.search);
  return p.get("demo") === "1";
}

export function DemoTour() {
  const [active, setActive] = useState(false);
  const [beat, setBeat] = useState(0);
  const [paused, setPaused] = useState(false);
  const beatRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectEvent = useStore((s) => s.selectEvent);
  const toggleCounterfactual = useStore((s) => s.toggleCounterfactual);

  useEffect(() => { setActive(isActive()); }, []);

  // Drive one beat, schedule the next.
  useEffect(() => {
    if (!active || paused) return;
    if (beat >= SCRIPT.length) {
      // Loop back to the top so the kiosk plays forever during a demo.
      const t = setTimeout(() => setBeat(0), 4500);
      timerRef.current = t;
      return () => clearTimeout(t);
    }

    const b = SCRIPT[beat];
    beatRef.current = beat;

    // Side-effects fire at the START of the beat.
    (async () => {
      try {
        if (b.action === "select-replay" && b.replay) {
          const r = await fetch(
            `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"}/events?hours_back=72&limit=200`,
            { cache: "no-store" },
          );
          const data = await r.json();
          const match = (data.events ?? []).find(
            (e: { id: string; headline?: string; replay?: string }) =>
              e.replay === b.replay ||
              (e.headline ?? "").toLowerCase().includes((b.replay ?? "").replace(/-/g, " ")),
          );
          if (match?.id) selectEvent(match.id);
          // Fallback — if no seeded replay match, grab the most recent event so
          // the cascade rail still has something to render.
          else if ((data.events ?? [])[0]?.id) selectEvent(data.events[0].id);
        }
        if (b.action === "switch-globe") {
          window.dispatchEvent(new CustomEvent("cascade:view", { detail: "globe" }));
        }
        if (b.action === "switch-graph") {
          window.dispatchEvent(new CustomEvent("cascade:view", { detail: "graph" }));
        }
        if (b.action === "switch-graph3d") {
          window.dispatchEvent(new CustomEvent("cascade:view", { detail: "graph3d" }));
        }
        if (b.action === "toggle-whatif") {
          // Toggle ON for this beat. We don't auto-toggle off — the next replay
          // selection rebuilds the cascade and the panel adapts.
          toggleCounterfactual();
          setTimeout(() => toggleCounterfactual(), b.ms + 600);
        }
        if (b.action === "clear") {
          selectEvent(null);
        }
      } catch {}
    })();

    const t = setTimeout(() => setBeat((i) => i + 1), b.ms);
    timerRef.current = t;
    return () => clearTimeout(t);
  }, [active, beat, paused, selectEvent, toggleCounterfactual]);

  // Use a single, deterministic stats source for the progress bar.
  const totalMs = SCRIPT.reduce((a, b) => a + b.ms, 0);
  const elapsedMs = SCRIPT.slice(0, beat).reduce((a, b) => a + b.ms, 0);
  const pct = Math.min(100, Math.round((elapsedMs / totalMs) * 100));

  if (!active) return null;

  const exitDemo = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const url = new URL(window.location.href);
    url.searchParams.delete("demo");
    window.history.replaceState({}, "", url.toString());
    setActive(false);
  };

  const skip = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setBeat((i) => Math.min(i + 1, SCRIPT.length));
  };

  const current = SCRIPT[Math.min(beat, SCRIPT.length - 1)];

  return (
    <>
      {/* Vignette so captions read clean against the globe */}
      <div className="pointer-events-none fixed inset-0 z-[55] bg-[radial-gradient(120%_80%_at_50%_120%,rgba(0,0,0,0.78),transparent_60%),radial-gradient(120%_80%_at_50%_-20%,rgba(0,0,0,0.55),transparent_60%)]" />

      {/* Caption block — bottom-centre, large readable type */}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex justify-center px-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={beat}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.45, ease: "easeOut" }}
            className="max-w-3xl text-center"
          >
            {current.pill && (
              <div className="mono mb-3 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-black/55 px-3 py-1 text-[10px] uppercase tracking-[0.32em] text-accent">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                {current.pill}
              </div>
            )}
            <div className="text-[clamp(20px,3.4vw,34px)] font-medium leading-tight text-text drop-shadow-[0_4px_24px_rgba(0,0,0,0.85)]">
              {current.caption}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Bottom progress + transport bar */}
      <div className="pointer-events-auto fixed inset-x-0 bottom-3 z-[60] flex justify-center px-4">
        <div className="glass mono flex w-[min(720px,94vw)] items-center gap-3 rounded-full border border-white/10 bg-black/60 px-4 py-2 text-[10px] uppercase tracking-widest text-muted">
          <span className="text-accent">demo</span>
          <span className="text-text/70">beat {Math.min(beat + 1, SCRIPT.length)}/{SCRIPT.length}</span>
          <div className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-white/10">
            <div className="absolute inset-y-0 left-0 bg-accent transition-[width] duration-300" style={{ width: pct + "%" }} />
          </div>
          <button onClick={() => setPaused((p) => !p)} title={paused ? "Play" : "Pause"} className="rounded-full p-1.5 text-text/85 hover:bg-white/10">
            {paused ? <Play size={12} /> : <Pause size={12} />}
          </button>
          <button onClick={skip} title="Skip" className="rounded-full p-1.5 text-text/85 hover:bg-white/10">
            <SkipForward size={12} />
          </button>
          <button onClick={exitDemo} title="Exit demo" className="rounded-full p-1.5 text-text/85 hover:bg-white/10">
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Top-centre badge so the viewer always knows this is a scripted tour */}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center">
        <div className="glass mono inline-flex items-center gap-2 rounded-full border border-accent/20 bg-black/60 px-3 py-1 text-[10px] uppercase tracking-[0.3em] text-accent">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          watch demo · 60-second tour
        </div>
      </div>
    </>
  );
}
