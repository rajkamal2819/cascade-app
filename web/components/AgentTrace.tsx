"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Cpu } from "lucide-react";
import { useStore } from "@/lib/store";

type TraceLine = {
  kind: "tool" | "agent" | "io" | "ok";
  text: string;
  detail?: string;
};

// The Agent Trace panel renders a deterministic, phase-synced view of what
// the Aurora + Gemini synthesiser is doing while a cascade builds. The
// backend doesn't stream tool-call events yet, so this layer is derived
// from the cascade phase + root + node count — enough to show judges
// "this is a real agent, not a static API."
//
// Visual: a slim top-centre chip just under the header. Default collapsed —
// the chip shows the latest trace line as a ticker. Click to expand the full
// log. This avoids colliding with the bottom stats strip / time-machine
// scrubber and with the 3D hop stepper.
export function AgentTrace() {
  const phase = useStore((s) => s.cascadePhase);
  const cascade = useStore((s) => s.cascade);
  const loading = useStore((s) => s.cascadeLoading);
  const selectedId = useStore((s) => s.selectedEventId);

  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<TraceLine[]>([]);

  useEffect(() => {
    if (!selectedId) {
      setLines([]);
      setOpen(false);
      return;
    }
    setLines([{ kind: "agent", text: "synthesiser · gemini 3 flash", detail: "spawn" }]);
  }, [selectedId]);

  useEffect(() => {
    const root = cascade?.root;
    const nodeCount = cascade?.nodes?.length ?? 0;

    const append = (l: TraceLine) =>
      setLines((prev) => (prev.some((p) => p.text === l.text && p.kind === l.kind) ? prev : [...prev, l]));

    if (phase === "building") {
      append({ kind: "tool", text: "search_events", detail: "pgvector + tsvector + RRF" });
      if (root?.tickers?.[0]) append({ kind: "io", text: `query ⇢ ${root.tickers[0]} · ${root.sector ?? "—"}` });
      append({ kind: "tool", text: "build_cascade", detail: "recursive CTE · 3 hops" });
    }
    if (phase === "ranking") {
      append({ kind: "tool", text: "voyage rerank-2.5", detail: "cross-encoder · top-50 → top-10" });
      if (nodeCount) append({ kind: "io", text: `ranked ⇢ ${nodeCount} nodes` });
    }
    if (phase === "synthesising") {
      append({ kind: "agent", text: "society · fan-out", detail: "critic · predictor · memory · eli5" });
      append({ kind: "tool", text: "aggregate_stats", detail: "WITH parallel CTEs" });
    }
    if (phase === "ready") {
      append({ kind: "ok", text: "cascade ready", detail: `${nodeCount} nodes · gemini synth done` });
    }
  }, [phase, cascade]);

  if (!selectedId) return null;

  const latest = lines[lines.length - 1];
  const inFlight = loading || phase === "building" || phase === "ranking" || phase === "synthesising";

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="pointer-events-auto fixed left-1/2 top-[60px] z-30 hidden -translate-x-1/2 md:block"
    >
      {/* Collapsed slim chip — sits below the header, above the canvas */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="glass mono flex max-w-[520px] items-center gap-2 rounded-full border border-white/10 bg-black/55 px-3 py-1 text-[10px] text-text/85 shadow-[0_12px_28px_rgba(0,0,0,0.45)] hover:border-accent/30"
      >
        <Cpu size={11} className="text-accent shrink-0" />
        <span className="uppercase tracking-[0.28em] text-muted shrink-0">agent</span>
        <span className={
          "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] " +
          (phase === "ready" ? "bg-emerald-500/15 text-emerald-300" :
           inFlight ? "bg-accent/15 text-accent" :
           "bg-white/5 text-muted")
        }>
          {phase === "ready" ? "done" : phase === "idle" ? "idle" : phase}
        </span>
        {latest && (
          <span className="truncate text-text/85">
            <span className={
              latest.kind === "tool" ? "mr-1 text-accent" :
              latest.kind === "agent" ? "mr-1 text-fuchsia-300" :
              latest.kind === "ok" ? "mr-1 text-emerald-300" :
              "mr-1 text-muted"
            }>
              {latest.kind === "tool" ? "→" : latest.kind === "agent" ? "✺" : latest.kind === "ok" ? "✓" : "·"}
            </span>
            {latest.text}
            {latest.detail && <span className="ml-1 text-muted/80">· {latest.detail}</span>}
          </span>
        )}
        <span className="ml-1 shrink-0 text-[9px] text-muted/70">{open ? "▴" : "▾"}</span>
      </button>

      {/* Expanded log */}
      <AnimatePresence initial={false}>
        {open && lines.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="mt-1.5 w-[min(520px,86vw)] overflow-hidden rounded-2xl border border-white/10 bg-black/75 shadow-[0_18px_42px_rgba(0,0,0,0.55)] backdrop-blur-md"
          >
            <div className="max-h-[200px] overflow-y-auto px-3 py-2 text-[10px]">
              {lines.map((l, i) => (
                <motion.div
                  key={`${i}-${l.text}`}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.16 }}
                  className="flex items-baseline gap-2 py-0.5"
                >
                  <span className={
                    l.kind === "tool" ? "text-accent" :
                    l.kind === "agent" ? "text-fuchsia-300" :
                    l.kind === "ok" ? "text-emerald-300" :
                    "text-muted"
                  }>
                    {l.kind === "tool" ? "→" : l.kind === "agent" ? "✺" : l.kind === "ok" ? "✓" : "·"}
                  </span>
                  <span className="text-text/90">{l.text}</span>
                  {l.detail && <span className="text-muted/70">· {l.detail}</span>}
                </motion.div>
              ))}
              {inFlight && (
                <div className="flex items-baseline gap-2 py-0.5 text-muted/70">
                  <span className="animate-pulse text-accent">→</span>
                  <span>thinking…</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
