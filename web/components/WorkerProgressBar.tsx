"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "@/lib/store";

// Thin top-of-viewport progress strip that reflects /admin/refresh state.
// Indeterminate while running (a shuttle gradient slides L↔R), then a
// brief solid bar in accent / rose for the success or error tail.
//
// The user keeps using the cascade / feed while this runs — no modal,
// no overlay, just a one-pixel-tall heartbeat at the top of the page.
export function WorkerProgressBar() {
  const state = useStore((s) => s.workerRunState);
  const message = useStore((s) => s.workerRunMessage);

  const visible = state !== "idle";
  const color =
    state === "ok"
      ? "var(--accent)"
      : state === "error"
      ? "#f87171"
      : "var(--accent)";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="worker-progress"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
          className="pointer-events-none fixed inset-x-0 top-0 z-[60]"
        >
          {/* Bar */}
          <div className="relative h-[3px] w-full overflow-hidden bg-white/[0.04]">
            {state === "running" ? (
              <motion.div
                className="absolute inset-y-0 w-1/3 rounded-full"
                style={{
                  background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
                  boxShadow: `0 0 12px ${color}`,
                }}
                initial={{ x: "-40%" }}
                animate={{ x: "120%" }}
                transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity }}
              />
            ) : (
              <motion.div
                className="absolute inset-0"
                initial={{ scaleX: 0, transformOrigin: "left" }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.4 }}
                style={{ background: color, boxShadow: `0 0 10px ${color}` }}
              />
            )}
          </div>

          {/* Message chip — centred under the bar */}
          <div className="flex justify-center pt-1.5">
            <div
              className="glass mono rounded-full border border-white/10 bg-black/65 px-2.5 py-0.5 text-[10px] uppercase tracking-widest"
              style={{ color }}
            >
              {state === "running" && (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="h-1 w-1 rounded-full"
                    style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                  />
                  {message || "running worker agents…"}
                </span>
              )}
              {state === "ok" && <span>✓ {message || "done"}</span>}
              {state === "error" && <span>✗ {message || "failed"}</span>}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
