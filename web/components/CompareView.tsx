"use client";

import { useEffect, useMemo, useState } from "react";
import { X, ArrowLeftRight } from "lucide-react";
import { CascadeGraph } from "@/components/CascadeGraph";
import { api, type CascadeResponse } from "@/lib/api";
import { useStore } from "@/lib/store";

interface CompareViewProps {
  leftId: string;
  rightId: string;
}

export function CompareView({ leftId, rightId }: CompareViewProps) {
  const clearCompare = useStore((s) => s.clearCompare);
  const [left, setLeft] = useState<CascadeResponse | null>(null);
  const [right, setRight] = useState<CascadeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLeft(null);
    setRight(null);
    setError(null);
    Promise.all([
      api.buildCascade({ event_id: leftId, max_hops: 3, top_k: 14 }),
      api.buildCascade({ event_id: rightId, max_hops: 3, top_k: 14 }),
    ])
      .then(([l, r]) => {
        if (cancelled) return;
        setLeft(l);
        setRight(r);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [leftId, rightId]);

  // Compute shared tickers (intersection of cascade node tickers).
  const sharedTickers = useMemo(() => {
    if (!left || !right) return new Set<string>();
    const a = new Set(left.nodes.map((n) => n.ticker));
    const shared = new Set<string>();
    for (const n of right.nodes) {
      if (a.has(n.ticker)) shared.add(n.ticker);
    }
    return shared;
  }, [left, right]);

  const sharedList = useMemo(() => Array.from(sharedTickers), [sharedTickers]);

  // Pre-compute the shared-bottleneck banner content.
  const leftRoot = left?.root.tickers[0];
  const rightRoot = right?.root.tickers[0];

  return (
    <div className="relative h-full w-full">
      {/* Header banner */}
      <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-3 px-3 py-2">
        <div className="glass-strong flex items-center gap-2.5 rounded-xl px-3 py-1.5">
          <ArrowLeftRight size={13} className="text-accent" />
          <span className="mono text-[10px] uppercase tracking-[0.2em] text-muted">compare</span>
          {leftRoot && (
            <span className="mono rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-text">
              {leftRoot}
            </span>
          )}
          <span className="text-muted/50">vs</span>
          {rightRoot && (
            <span className="mono rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-text">
              {rightRoot}
            </span>
          )}
          {sharedList.length > 0 && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-yellow-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-yellow-300">
              <span className="h-1.5 w-1.5 rounded-full bg-yellow-400 pulse-soft" />
              {sharedList.length} shared · {sharedList.slice(0, 3).join(", ")}
              {sharedList.length > 3 ? "…" : ""}
            </span>
          )}
        </div>
        <button
          onClick={clearCompare}
          className="glass inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-muted hover:text-text transition"
          title="Exit compare mode (Esc)"
        >
          <X size={11} /> exit
        </button>
      </div>

      {/* Two-pane split */}
      <div className="absolute inset-0 grid grid-cols-2 gap-2 px-2 pb-2 pt-12">
        <div className="relative overflow-hidden rounded-xl border border-white/[0.04]">
          {error ? (
            <Empty msg={error} />
          ) : (
            <CascadeGraph cascade={left} compact sharedTickers={sharedTickers} />
          )}
        </div>
        <div className="relative overflow-hidden rounded-xl border border-white/[0.04]">
          {error ? (
            <Empty msg={error} />
          ) : (
            <CascadeGraph cascade={right} compact sharedTickers={sharedTickers} />
          )}
        </div>
      </div>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-muted">
      {msg}
    </div>
  );
}
