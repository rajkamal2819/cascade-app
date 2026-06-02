"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const STEPS = [
  { label: "Bootstrapping Cascade terminal", ms: 180 },
  { label: "Connecting MongoDB Atlas · M0", ms: 260 },
  { label: "Loading $graphLookup walker · 3 hops", ms: 200 },
  { label: "Initialising Voyage rerank-2.5", ms: 220 },
  { label: "Waking Gemini 3 Pro · synthesiser", ms: 280 },
  { label: "Spawning society · critic · predictor · memory · eli5", ms: 240 },
  { label: "Subscribing to change-stream · SSE online", ms: 200 },
  { label: "All systems nominal", ms: 180 },
];

const SESSION_KEY = "cascade-boot-shown";

export function BootSequence() {
  const [active, setActive] = useState(false);
  const [shown, setShown] = useState<number>(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (sessionStorage.getItem(SESSION_KEY) === "1") return;
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {}
    setActive(true);

    let i = 0;
    let cancelled = false;
    const advance = () => {
      if (cancelled) return;
      setShown(i + 1);
      i += 1;
      if (i >= STEPS.length) {
        setTimeout(() => !cancelled && setActive(false), 320);
        return;
      }
      setTimeout(advance, STEPS[i]?.ms ?? 200);
    };
    setTimeout(advance, STEPS[0]?.ms ?? 200);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key="boot"
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-black"
        >
          <div className="absolute inset-0 opacity-[0.07]" style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, rgba(0,255,180,0.6) 0px, rgba(0,255,180,0.6) 1px, transparent 1px, transparent 3px)",
          }} />
          <div className="relative w-[min(560px,92vw)] rounded-xl border border-accent/20 bg-black/80 p-6 font-mono text-[12px] text-accent shadow-[0_0_40px_rgba(34,197,94,0.15)]">
            <div className="mb-4 flex items-center justify-between text-[10px] uppercase tracking-[0.35em] text-accent/70">
              <span>cascade · planetary nervous system</span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                booting
              </span>
            </div>
            <div className="space-y-1.5">
              {STEPS.slice(0, shown).map((s, idx) => (
                <motion.div
                  key={s.label}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.18 }}
                  className="flex items-center gap-2"
                >
                  <span className="text-accent">{idx === STEPS.length - 1 ? "✓" : "▸"}</span>
                  <span className="text-accent/90">{s.label}</span>
                  <span className="ml-auto text-accent/40">ok</span>
                </motion.div>
              ))}
              {shown < STEPS.length && (
                <div className="flex items-center gap-2 text-accent/50">
                  <span className="animate-pulse">▸</span>
                  <span>{STEPS[shown]?.label}…</span>
                </div>
              )}
            </div>
            <div className="mt-5 h-[2px] w-full overflow-hidden rounded-full bg-accent/10">
              <motion.div
                className="h-full bg-accent"
                initial={{ width: 0 }}
                animate={{ width: `${(shown / STEPS.length) * 100}%` }}
                transition={{ duration: 0.25 }}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
