"use client";

import { Cpu } from "lucide-react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";

// Fires every poll-style worker on the backend. The request is intentionally
// fire-and-forget from the user's perspective — we set a global "running"
// flag on the Zustand store so the top progress bar renders, and the rest
// of the UI stays interactive. When the fan-out completes, we re-pull the
// feed and clear the flag.
export function RefreshButton() {
  const state = useStore((s) => s.workerRunState);
  const setWorkerRun = useStore((s) => s.setWorkerRun);
  const setEvents = useStore((s) => s.setEvents);

  const running = state === "running";

  const onClick = () => {
    if (running) return;
    setWorkerRun("running", "Workers dispatched · ingesting…");
    // Async — does not block the click handler.
    (async () => {
      try {
        const r = await api.refreshAll();
        setWorkerRun("ok", `${r.succeeded}/${r.ran} workers ok`);
        try {
          const ev = await api.listEvents({ hours_back: 720, limit: 200 });
          setEvents(ev.events);
        } catch { /* feed re-pull is best effort */ }
        setTimeout(() => setWorkerRun("idle"), 4000);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const short = msg.split(":").slice(-1)[0].trim().slice(0, 80);
        setWorkerRun("error", short || "refresh failed");
        setTimeout(() => setWorkerRun("idle"), 5000);
      }
    })();
  };

  return (
    <button
      onClick={onClick}
      disabled={running}
      title="Run every poll-style ingest worker once · feed updates asynchronously"
      className={
        "glass mono inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider transition " +
        (running
          ? "text-accent ring-1 ring-accent/30"
          : "text-muted hover:text-text")
      }
    >
      <Cpu size={12} className={running ? "animate-pulse" : ""} />
      <span className="hidden sm:inline">
        {running ? "running…" : "Run worker agents"}
      </span>
    </button>
  );
}
