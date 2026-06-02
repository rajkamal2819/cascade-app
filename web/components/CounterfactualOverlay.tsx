"use client";

import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, X } from "lucide-react";
import { useStore } from "@/lib/store";
import type { CascadeNode } from "@/lib/api";

// Counterfactual mode is a pure-client diff: "what if this root event had NOT
// happened?" Without re-running the agent, we can still tell the trader a
// useful story by:
//  - greying out nodes that lose their causal chain (everything with the
//    upstream/customer/supplier relationship to the root),
//  - flagging derivative / sector-peer nodes that would still move because
//    their reasoning isn't single-rooted,
//  - quantifying the "exposure delta" (nodes removed, % at risk).

type PolarityBucket = "removed" | "stays" | "flips";

function bucketize(node: CascadeNode): PolarityBucket {
  const t = (node.relationship_type ?? "").toLowerCase();
  // Direct dependencies on the root drop out entirely.
  if (t.includes("supplier") || t.includes("customer") || t.includes("upstream")) return "removed";
  // Derivatives / shorts / inverse plays would swing the OTHER direction.
  if (t.includes("derivative") || t.includes("inverse") || t.includes("short")) return "flips";
  // Sector peers / semantic neighbours still react to the broader regime.
  return "stays";
}

export function CounterfactualOverlay() {
  const active = useStore((s) => s.counterfactual);
  const cascade = useStore((s) => s.cascade);
  const toggle = useStore((s) => s.toggleCounterfactual);

  const summary = useMemo(() => {
    const nodes = cascade?.nodes ?? [];
    const removed: CascadeNode[] = [];
    const flips: CascadeNode[] = [];
    const stays: CascadeNode[] = [];
    for (const n of nodes) {
      const b = bucketize(n);
      if (b === "removed") removed.push(n);
      else if (b === "flips") flips.push(n);
      else stays.push(n);
    }
    const total = nodes.length || 1;
    return {
      removed,
      flips,
      stays,
      pctRemoved: Math.round((removed.length / total) * 100),
      pctStays: Math.round((stays.length / total) * 100),
      pctFlips: Math.round((flips.length / total) * 100),
    };
  }, [cascade]);

  if (!cascade) return null;

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.22 }}
          className="pointer-events-auto fixed bottom-20 right-4 z-40 w-[min(380px,92vw)] md:right-[calc(360px+24px)]"
        >
          <div className="glass mono rounded-2xl border border-fuchsia-400/25 bg-black/65 p-3 shadow-[0_22px_50px_rgba(0,0,0,0.55)]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles size={13} className="text-fuchsia-300" />
                <span className="text-[10px] uppercase tracking-[0.32em] text-fuchsia-300">counterfactual</span>
              </div>
              <button
                onClick={toggle}
                title="Exit counterfactual mode"
                className="rounded-full p-1 text-muted hover:text-text"
              >
                <X size={12} />
              </button>
            </div>

            <div className="mt-2 text-[12px] text-text">
              If <span className="text-fuchsia-300">{cascade.root?.tickers?.[0] ?? "this event"}</span> had NOT happened…
            </div>

            <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-white/5">
              <div className="h-full bg-rose-400/60"   style={{ width: `${summary.pctRemoved}%` }} />
              <div className="h-full bg-amber-300/60" style={{ width: `${summary.pctStays}%`   }} />
              <div className="h-full bg-emerald-300/60" style={{ width: `${summary.pctFlips}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-[9px] uppercase tracking-widest text-muted">
              <span>removed · {summary.pctRemoved}%</span>
              <span>still moves · {summary.pctStays}%</span>
              <span>flips · {summary.pctFlips}%</span>
            </div>

            <div className="mt-3 space-y-2">
              <Bucket title="Drops out of the cascade" tone="rose" items={summary.removed} hint="direct supply / customer link to root" />
              <Bucket title="Still moves regardless" tone="amber" items={summary.stays} hint="sector / regime exposure unchanged" />
              <Bucket title="Flips direction" tone="emerald" items={summary.flips} hint="derivative / inverse — benefits from absence" />
            </div>

            <div className="mt-2 text-[9px] uppercase tracking-widest text-muted/70">
              client-side projection · derived from cascade payload
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Bucket({
  title, tone, items, hint,
}: {
  title: string;
  tone: "rose" | "amber" | "emerald";
  items: CascadeNode[];
  hint: string;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-white/5 px-2.5 py-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-widest text-muted">{title}</span>
          <span className="text-[10px] text-muted/60">none</span>
        </div>
      </div>
    );
  }
  const ring =
    tone === "rose"   ? "border-rose-400/30 bg-rose-500/[0.06]" :
    tone === "amber"  ? "border-amber-300/25 bg-amber-300/[0.05]" :
                        "border-emerald-300/25 bg-emerald-300/[0.05]";
  const dot =
    tone === "rose"  ? "bg-rose-400" :
    tone === "amber" ? "bg-amber-300" :
                       "bg-emerald-300";
  return (
    <div className={"rounded-lg border px-2.5 py-1.5 " + ring}>
      <div className="flex items-baseline justify-between">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-text/90">
          <span className={"h-1.5 w-1.5 rounded-full " + dot} />
          {title}
        </span>
        <span className="text-[10px] text-muted/70">{items.length}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {items.slice(0, 8).map((n) => (
          <span key={n.ticker} className="rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-text/85">
            {n.ticker}
          </span>
        ))}
        {items.length > 8 && <span className="text-[10px] text-muted/70">+{items.length - 8}</span>}
      </div>
      <div className="mt-1 text-[9px] text-muted/60">{hint}</div>
    </div>
  );
}

// Header-level toggle button — placed in the top bar by the terminal page.
export function CounterfactualToggle() {
  const active = useStore((s) => s.counterfactual);
  const cascade = useStore((s) => s.cascade);
  const toggle = useStore((s) => s.toggleCounterfactual);
  if (!cascade) return null;
  return (
    <button
      onClick={toggle}
      title="Counterfactual · what if this event hadn't happened?"
      className={
        "glass mono inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider transition " +
        (active ? "border border-fuchsia-300/40 text-fuchsia-300" : "text-muted hover:text-text")
      }
    >
      <Sparkles size={12} className={active ? "text-fuchsia-300" : "text-muted"} />
      <span className="hidden sm:inline">{active ? "what-if · on" : "what-if"}</span>
    </button>
  );
}
