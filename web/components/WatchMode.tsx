"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Globe } from "@/components/Globe";
import { useLiveEvents } from "@/lib/sse";
import { useStore } from "@/lib/store";
import type { Event } from "@/lib/api";

// Watch mode (?watch=1) — minimal kiosk view: globe + ticker tape + toasts.
// Designed for the big screen behind a trading desk and for the demo loop.
export function WatchMode() {
  useLiveEvents();
  const events = useStore((s) => s.events);
  const [toasts, setToasts] = useState<Event[]>([]);
  const [lastSeen, setLastSeen] = useState<string | null>(null);

  // Show a toast for new critical/high events as they arrive.
  useEffect(() => {
    if (events.length === 0) return;
    const head = events[0];
    if (head.id === lastSeen) return;
    setLastSeen(head.id);
    if (head.impact === "critical" || head.impact === "high") {
      setToasts((t) => [head, ...t].slice(0, 4));
      const id = setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== head.id));
      }, 10_000);
      return () => clearTimeout(id);
    }
  }, [events, lastSeen]);

  // Ticker-tape source list: top tickers from the live feed.
  const tape = events
    .flatMap((e) => e.tickers.map((t) => ({ ticker: t, impact: e.impact })))
    .slice(0, 50);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-black text-text">
      <Globe />

      {/* Top-centre status pill */}
      <div className="pointer-events-none absolute inset-x-0 top-5 flex justify-center">
        <div className="glass mono inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-[10px] uppercase tracking-[0.3em]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          watch mode · live
        </div>
      </div>

      {/* Toasts */}
      <div className="pointer-events-none absolute right-6 top-20 flex flex-col gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 30 }}
              transition={{ duration: 0.35 }}
              className="glass-strong w-80 rounded-lg p-3 shadow-2xl"
            >
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    background: t.impact === "critical" ? "var(--critical)" : "var(--high)",
                    boxShadow:
                      t.impact === "critical"
                        ? "0 0 10px var(--critical-glow)"
                        : "0 0 10px var(--high-glow)",
                  }}
                />
                <span className="text-text">{t.impact}</span>
                <span className="text-muted/60">·</span>
                <span className="text-muted">{t.tickers.slice(0, 3).join(" · ")}</span>
              </div>
              <div className="mt-1.5 text-[12px] leading-snug text-text">
                {t.headline.slice(0, 140)}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Bottom ticker tape */}
      <div className="absolute inset-x-0 bottom-0 overflow-hidden border-t border-white/5 bg-black/70 py-2 backdrop-blur-md">
        <div className="ticker-tape flex gap-6 whitespace-nowrap text-[11px]">
          {tape.concat(tape).map((t, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              <span
                className="h-1 w-1 rounded-full"
                style={{
                  background:
                    t.impact === "critical"
                      ? "var(--critical)"
                      : t.impact === "high"
                      ? "var(--high)"
                      : "var(--text-muted)",
                }}
              />
              <span className="mono text-text">{t.ticker}</span>
            </span>
          ))}
        </div>
      </div>
    </main>
  );
}
