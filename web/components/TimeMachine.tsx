"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";
import { useStore } from "@/lib/store";

// Time-machine scrubber: rewind the globe and feed view through the last 7 days.
// The UI-side `timeOffset` (days) is read by Feed.tsx and Globe.tsx; the SSE
// stream remains live underneath. Play animates from 7d → 0 over ~40s.
const PLAY_DURATION_MS = 40_000;

export function TimeMachine() {
  const [playing, setPlaying] = useState(false);
  const offset = useStore((s) => s.timeOffset);
  const setTimeOffset = useStore((s) => s.setTimeOffset);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const startOffsetRef = useRef<number>(0);

  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    startRef.current = performance.now();
    // If user pressed play at offset=0, start the replay from 7d ago.
    startOffsetRef.current = offset <= 0 ? 7 : offset;
    if (offset <= 0) setTimeOffset(7);

    const tick = (t: number) => {
      const elapsed = t - startRef.current;
      const progress = Math.min(1, elapsed / PLAY_DURATION_MS);
      const next = startOffsetRef.current * (1 - progress);
      setTimeOffset(Number(next.toFixed(2)));
      if (progress >= 1) {
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const onChange = (v: number) => {
    setPlaying(false);
    setTimeOffset(v);
  };

  const reset = () => {
    setPlaying(false);
    setTimeOffset(0);
  };

  return (
    <div className="hidden items-center gap-2 text-[9px] sm:flex">
      <button
        onClick={() => setPlaying((p) => !p)}
        className={
          "rounded-full p-1 transition " +
          (playing ? "text-accent" : "text-muted hover:text-text")
        }
        title={playing ? "Pause replay" : "Play 7-day replay"}
      >
        {playing ? <Pause size={11} /> : <Play size={11} />}
      </button>
      <span className="tabular-nums text-muted/60 w-10 text-right">
        {offset === 0 ? "NOW" : `-${offset.toFixed(offset < 1 ? 1 : 0)}d`}
      </span>
      <input
        type="range"
        min={0}
        max={7}
        step={0.25}
        value={offset}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="time-machine h-1 w-32 cursor-pointer appearance-none rounded-full bg-white/10"
        title="Drag to scrub through the last 7 days"
      />
      <button
        onClick={reset}
        className="rounded-full p-1 text-muted transition hover:text-text"
        title="Reset to now"
      >
        <RotateCcw size={11} />
      </button>
    </div>
  );
}
