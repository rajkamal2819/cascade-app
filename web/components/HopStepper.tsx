"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Pause, Play, RotateCcw } from "lucide-react";

export type HopStepperProps = {
  maxHop: number;
  current: number;
  setCurrent: (n: number) => void;
  playing: boolean;
  setPlaying: (b: boolean) => void;
  onReplay: () => void;
};

const HOP_LABEL = ["L0 · root", "L1 · direct", "L2 · second order", "L3 · tail"];

export function HopStepper({ maxHop, current, setCurrent, playing, setPlaying, onReplay }: HopStepperProps) {
  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-advance one hop every 1.2s while playing; stop at maxHop.
  useEffect(() => {
    if (!playing) return;
    if (current >= maxHop) {
      setPlaying(false);
      return;
    }
    tRef.current = setTimeout(() => setCurrent(current + 1), 1200);
    return () => { if (tRef.current) clearTimeout(tRef.current); };
  }, [playing, current, maxHop, setCurrent, setPlaying]);

  // ← / → keyboard scrub
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (ev.key === "ArrowRight") setCurrent(Math.min(current + 1, maxHop));
      if (ev.key === "ArrowLeft")  setCurrent(Math.max(current - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, maxHop, setCurrent]);

  const total = Math.max(1, maxHop) + 1; // 0..maxHop inclusive

  return (
    <div className="glass mono pointer-events-auto flex w-[min(540px,92vw)] items-center gap-3 rounded-full border border-white/10 bg-black/65 px-4 py-2 text-[10px] uppercase tracking-widest text-muted">
      <button
        onClick={onReplay}
        title="Replay reveal"
        className="rounded-full p-1.5 text-text/80 hover:bg-white/10"
      >
        <RotateCcw size={12} />
      </button>
      <button
        onClick={() => setPlaying(!playing)}
        title={playing ? "Pause" : "Play"}
        className="rounded-full p-1.5 text-text/85 hover:bg-white/10"
      >
        {playing ? <Pause size={12} /> : <Play size={12} />}
      </button>

      <div className="flex flex-1 items-center justify-between gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <button
            key={i}
            onClick={() => setCurrent(i)}
            className="group relative flex flex-col items-center gap-1 outline-none"
            title={HOP_LABEL[i] ?? `L${i}`}
          >
            <motion.span
              animate={{
                scale: i === current ? 1.3 : 1,
                backgroundColor: i <= current ? "rgb(34,211,238)" : "rgba(255,255,255,0.15)",
                boxShadow: i === current ? "0 0 14px rgba(34,211,238,0.7)" : "none",
              }}
              transition={{ duration: 0.25 }}
              className="block h-2 w-2 rounded-full"
            />
            <span className={"text-[8.5px] tracking-wider " + (i === current ? "text-cyan-300" : "text-muted/60")}>
              {`L${i}`}
            </span>
          </button>
        ))}
      </div>

      <span className="text-[9px] text-muted/70">
        hop <span className="text-text">{current}</span>/<span className="text-text">{maxHop}</span>
      </span>
    </div>
  );
}
