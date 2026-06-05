"use client";

import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, X, ExternalLink } from "lucide-react";
import { useStore } from "@/lib/store";
import { POLARITY_COLOR, type Graph3DNode, type NodeReasoningInfo as _NodeReasoningInfo } from "@/lib/cascade-layout";

export type NodeReasoningInfo = _NodeReasoningInfo;

// Reasoning popover — opens when a node is clicked in the 3D (or 2D) graph.
// Renders a human-readable explanation of WHY this node is in the cascade
// and HOW it connects to the root, derived entirely from the cascade payload
// fields we already have (relationship_type, hop, cascade_score, why, sector).

function rationaleFor(rel: string, root: string, target: string, hop: number): {
  headline: string;
  chain: string;
} {
  const t = (rel ?? "").toLowerCase();
  const hopLabel = hop === 1 ? "directly" : hop === 2 ? "through one intermediary" : `${hop} hops downstream`;

  if (t.includes("customer")) {
    return {
      headline: `${target} is a customer of ${root}.`,
      chain: `${root} sells into ${target}. If ${root} can't deliver — or prices spike — ${target}'s margins compress ${hopLabel}.`,
    };
  }
  if (t.includes("supplier")) {
    return {
      headline: `${target} supplies ${root}.`,
      chain: `${root} buys from ${target}. A demand shock or order pull from ${root} ripples back to ${target}'s top line ${hopLabel}.`,
    };
  }
  if (t.includes("peer") || t.includes("sector")) {
    return {
      headline: `${target} is a sector peer of ${root}.`,
      chain: `${target} doesn't transact with ${root}, but capital rotates by sector. A re-rating of ${root}'s industry hits ${target}'s multiple ${hopLabel}.`,
    };
  }
  if (t.includes("derivative") || t.includes("inverse") || t.includes("short")) {
    return {
      headline: `${target} is an inverse / derivative play vs ${root}.`,
      chain: `${target}'s thesis benefits when ${root} weakens. The same headline that hurts ${root} typically lifts ${target} ${hopLabel}.`,
    };
  }
  if (t === "semantic" || t.includes("semantic")) {
    return {
      headline: `${target} is semantically related to this event.`,
      chain: `No graph edge — we matched via pgvector cosine search on Aurora. The text of ${target}'s recent coverage embeds close to this event in Voyage space.`,
    };
  }
  if (t === "root") {
    return {
      headline: `${target} is the root of the cascade.`,
      chain: `Every other node in this cascade was selected because of its relationship to ${target}.`,
    };
  }
  return {
    headline: `${target} is linked to ${root} via "${rel}".`,
    chain: `Relationship type "${rel}" ${hopLabel}. Re-rank score reflects how strongly this link survives Voyage cross-encoder scoring.`,
  };
}

function confidenceBand(score: number): { label: string; color: string } {
  if (score >= 0.7)  return { label: "high",     color: "#34d399" };
  if (score >= 0.45) return { label: "moderate", color: "#fbbf24" };
  if (score >= 0.25) return { label: "low",      color: "#fb923c" };
  return                   { label: "noise floor", color: "#94a3b8" };
}

export function NodeReasoning() {
  const node = useStore((s) => s.reasoningNode);
  const setNode = useStore((s) => s.setReasoningNode);
  const cascade = useStore((s) => s.cascade);
  const drillIntoEvent = useStore((s) => s.drillIntoEvent);

  if (!node) return null;

  const rootTicker = cascade?.root?.tickers?.[0] ?? "ROOT";
  const isRoot = node.hop === 0 || node.relationship_type === "root";
  const rat = rationaleFor(node.relationship_type, rootTicker, node.ticker, Math.max(1, node.hop));
  const conf = confidenceBand(node.cascade_score ?? 0);
  const polColor = node.polarity ? POLARITY_COLOR[node.polarity] : "#94a3b8";

  return (
    <AnimatePresence>
      <motion.div
        key={node.ticker}
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.22 }}
        className="pointer-events-auto fixed left-1/2 top-1/2 z-[80] w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2"
      >
        <div className="glass mono rounded-2xl border border-white/10 bg-black/85 p-4 shadow-[0_22px_56px_rgba(0,0,0,0.7)] backdrop-blur-md">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="block h-2.5 w-2.5 rounded-full" style={{ background: polColor, boxShadow: `0 0 10px ${polColor}` }} />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-text">{node.ticker}</span>
                  <span className="rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-muted">
                    L{node.hop}
                  </span>
                </div>
                <div className="text-[11px] text-muted">{node.company}{node.sector ? ` · ${node.sector}` : ""}</div>
              </div>
            </div>
            <button
              onClick={() => setNode(null)}
              className="rounded-full p-1.5 text-muted hover:bg-white/10 hover:text-text"
              title="Close"
            >
              <X size={14} />
            </button>
          </div>

          {/* Connection chain */}
          {!isRoot && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-2 text-[11px]">
              <span className="rounded-md bg-cyan-400/15 px-1.5 py-0.5 font-semibold text-cyan-300">{rootTicker}</span>
              <ArrowRight size={12} className="text-muted" />
              <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-text/90">{node.relationship_type}</span>
              <ArrowRight size={12} className="text-muted" />
              <span className="rounded-md bg-fuchsia-400/15 px-1.5 py-0.5 font-semibold text-fuchsia-300">{node.ticker}</span>
            </div>
          )}

          {/* Rationale */}
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-[0.3em] text-muted">why it's in the cascade</div>
            <div className="mt-1 text-[13px] text-text">{rat.headline}</div>
            <div className="mt-1 text-[11.5px] leading-snug text-text/80">{rat.chain}</div>
          </div>

          {/* Backend "why" string if available and distinct */}
          {node.why && !rat.chain.includes(node.why.slice(0, 30)) && (
            <div className="mt-3 rounded-lg border border-accent/15 bg-accent/[0.05] px-2.5 py-2">
              <div className="text-[9px] uppercase tracking-widest text-accent/85">agent · why</div>
              <div className="mt-1 text-[11px] leading-snug text-text/85">{node.why}</div>
            </div>
          )}

          {/* Confidence bar */}
          <div className="mt-3">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-muted">
              <span>voyage rerank-2.5</span>
              <span style={{ color: conf.color }}>{conf.label} · {(node.cascade_score ?? 0).toFixed(2)}</span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${Math.min(100, (node.cascade_score ?? 0) * 100)}%`, background: conf.color }}
              />
            </div>
            <div className="mt-1 text-[10px] text-muted/70">
              Cross-encoder score after Voyage rerank-2.5 over the top-50 graph candidates. Decays by hop: `score × 0.8^(hop-1)`.
            </div>
          </div>

          {/* Drill-in CTA */}
          {node.event_id && (
            <button
              onClick={() => {
                drillIntoEvent(node.event_id!, node.ticker);
                setNode(null);
              }}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-2 text-[11px] uppercase tracking-widest text-accent hover:bg-accent/20"
            >
              <ExternalLink size={12} />
              drill into {node.ticker}'s most recent event
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

// Helper: convert a Graph3DNode → NodeReasoningInfo (drops layout fields).
export function toReasoningInfo(n: Graph3DNode): NodeReasoningInfo {
  return {
    ticker: n.ticker,
    company: n.company,
    sector: n.sector,
    hop: n.hop,
    relationship_type: n.relationship_type,
    cascade_score: n.cascade_score,
    why: n.why,
    event_id: n.event_id,
    polarity: n.polarity,
  };
}
