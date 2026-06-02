"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Play, ChevronDown } from "lucide-react";

export type ReplayScenario = {
  slug: string;
  icon: string;
  label: string;
  blurb: string;
};

const SCENARIOS: ReplayScenario[] = [
  { slug: "ship-stall",     icon: "🚢", label: "Container ship stalls · Kaohsiung", blurb: "AIS · MAERSK SHANGHAI · 18nm off Taiwan" },
  { slug: "taiwan-quake",   icon: "🌋", label: "M6.4 quake · Hualien",               blurb: "USGS · semis + auto supply-chain shock" },
  { slug: "aapl-8k",        icon: "📜", label: "Apple 8-K · earnings miss",          blurb: "SEC EDGAR · Item 2.02 · 3-hop cascade" },
  { slug: "pattern-brush",  icon: "🛰️", label: "Pattern brush · semis correction",   blurb: "Aug-2024 archetype · multimodal recall" },
];

export function ReplayMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const trigger = (slug: string) => {
    setOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.set("replay", slug);
    window.history.replaceState({}, "", url.toString());
    // Reload-free trigger: dispatch the same event the terminal page listens for.
    window.dispatchEvent(new CustomEvent("cascade:replay", { detail: slug }));
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Replay a scripted cascade"
        className="glass mono inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider text-text/90 hover:text-accent transition"
      >
        <Play size={12} className="text-accent" />
        <span className="hidden sm:inline">Replay</span>
        <ChevronDown size={11} className={"transition " + (open ? "rotate-180" : "")} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="absolute right-0 top-[120%] z-50 w-[300px] rounded-xl border border-white/10 bg-black/85 p-1.5 shadow-[0_18px_42px_rgba(0,0,0,0.55)] backdrop-blur-md"
          >
            <div className="mono px-2 pb-1.5 pt-1 text-[9px] uppercase tracking-[0.32em] text-muted">
              scripted cascades
            </div>
            <div className="flex flex-col gap-0.5">
              {SCENARIOS.map((s) => (
                <button
                  key={s.slug}
                  onClick={() => trigger(s.slug)}
                  className="group flex items-start gap-3 rounded-lg px-2.5 py-2 text-left transition hover:bg-accent/10"
                >
                  <span className="text-[16px] leading-none">{s.icon}</span>
                  <span className="flex-1">
                    <span className="block text-[12px] text-text group-hover:text-accent">{s.label}</span>
                    <span className="block text-[10px] text-muted">{s.blurb}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="mono mt-1 border-t border-white/5 px-2 pt-1.5 pb-0.5 text-[9px] uppercase tracking-widest text-muted/60">
              deterministic · seeded events
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
