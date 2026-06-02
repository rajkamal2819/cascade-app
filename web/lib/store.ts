// Zustand store for the terminal — events, selection, cascade, time-machine.

import { create } from "zustand";
import type { CascadeResponse, Event } from "./api";
import type { NodeReasoningInfo } from "./cascade-layout";

type StreamStatus = "idle" | "connecting" | "live" | "reconnecting";

// Event augmented with the wall-clock time it landed in the browser. Used
// by the globe to render a 3-second "fresh arrival" shockwave and to size
// points by recency rather than impact alone.
export type LiveEvent = Event & { _arrivedAt?: number };

type State = {
  events: LiveEvent[];
  selectedEventId: string | null;
  cascade: CascadeResponse | null;
  cascadeLoading: boolean;
  cascadePhase: "idle" | "building" | "ranking" | "synthesising" | "ready";
  streamStatus: StreamStatus;
  // Wall-clock time (ms) when the last live event arrived. Drives the
  // "LIVE · last event Ns ago" chip on the globe.
  lastEventAt: number | null;
  // Last server heartbeat (ms, browser wall clock). Lets us detect a stalled
  // backend even when the stream is technically still open.
  lastHeartbeatAt: number | null;

  // Click-to-drill breadcrumb: last 5 events visited via cascade node clicks.
  breadcrumb: { id: string; label: string }[];

  // Compare mode: when set, terminal renders two cascade graphs side-by-side.
  compareIds: [string, string] | null;

  // Time-machine: 0 = now, 7 = 7 days ago. Drives a UI-side time filter.
  timeOffset: number;

  // ELI5 toggle on narrative card — re-renders with novice-friendly text.
  eli5: boolean;

  // Counterfactual mode: "what if this event had NOT happened?" — flips the
  // cascade rail / overlay to render the diff view derived from cascade nodes.
  counterfactual: boolean;

  // Source filter chips: when non-empty, only show events with this source_type.
  sourceFilter: string | null;

  // NodeReasoning popover state — set when a node in the cascade graph
  // (2D or 3D) is clicked. null means the popover is closed.
  reasoningNode: NodeReasoningInfo | null;

  // Geo-cascade arc density toggle — for tickerless events the globe can fan
  // arcs from every Gemini-inferred region to every affected company HQ
  // ("all"), only the primary region ("primary"), or hide the geo layer
  // entirely ("off"). Cycled from the GeoCascadePanel filter button.
  geoArcMode: "all" | "primary" | "off";

  // Manual /admin/refresh state. Drives the top progress bar so the user
  // can keep using the current cascade while workers run in the background.
  workerRunState: "idle" | "running" | "ok" | "error";
  workerRunMessage: string;

  setEvents: (events: Event[]) => void;
  pushEvent: (e: Event) => void;
  pushBackfill: (events: Event[]) => void;
  markHeartbeat: (ts?: number) => void;
  selectEvent: (id: string | null) => void;
  drillIntoEvent: (id: string, label: string) => void;
  popBreadcrumb: () => void;
  clearBreadcrumb: () => void;
  pinForCompare: (id: string) => void;
  clearCompare: () => void;
  setCascade: (c: CascadeResponse | null) => void;
  setCascadeLoading: (b: boolean) => void;
  setCascadePhase: (p: State["cascadePhase"]) => void;
  setStreamStatus: (s: StreamStatus) => void;
  setTimeOffset: (n: number) => void;
  toggleEli5: () => void;
  toggleCounterfactual: () => void;
  setSourceFilter: (s: string | null) => void;
  setReasoningNode: (n: NodeReasoningInfo | null) => void;
  setGeoArcMode: (m: State["geoArcMode"]) => void;
  cycleGeoArcMode: () => void;
  setWorkerRun: (state: State["workerRunState"], message?: string) => void;
};

const MAX_EVENTS = 500;

export const useStore = create<State>((set) => ({
  events: [],
  selectedEventId: null,
  cascade: null,
  cascadeLoading: false,
  cascadePhase: "idle",
  streamStatus: "idle",
  breadcrumb: [],
  compareIds: null,
  timeOffset: 0,
  eli5: false,
  counterfactual: false,
  sourceFilter: null,
  reasoningNode: null,
  geoArcMode: "all",
  workerRunState: "idle",
  workerRunMessage: "",
  lastEventAt: null,
  lastHeartbeatAt: null,

  setEvents: (events) => set({ events }),

  pushEvent: (e) =>
    set((s) => {
      const without = s.events.filter((x) => x.id !== e.id);
      const stamped: LiveEvent = { ...e, _arrivedAt: Date.now() };
      return {
        events: [stamped, ...without].slice(0, MAX_EVENTS),
        lastEventAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      };
    }),

  pushBackfill: (events) =>
    set((s) => {
      // On a cold connect the change-stream may stay quiet for minutes,
      // so we stagger arrival timestamps on the first few backfill events.
      // The globe then plays a ripple-in shockwave for ~700ms instead of
      // sitting dead. Only the top-5 most-recent get stamped; the rest
      // land silently so we don't carpet-bomb the globe with halos.
      const known = new Set(s.events.map((e) => e.id));
      const fresh = events.filter((e) => !known.has(e.id));
      const t0 = Date.now();
      const stamped: LiveEvent[] = fresh.map((e, i) =>
        i < 5 ? { ...e, _arrivedAt: t0 + i * 120 } : e,
      );
      const merged: LiveEvent[] = [...s.events, ...stamped].slice(0, MAX_EVENTS);
      merged.sort((a, b) => {
        const ta = a.published_at ? Date.parse(a.published_at) : 0;
        const tb = b.published_at ? Date.parse(b.published_at) : 0;
        return tb - ta;
      });
      return {
        events: merged,
        lastEventAt: stamped.length ? t0 : s.lastEventAt,
        lastHeartbeatAt: t0,
      };
    }),

  markHeartbeat: (ts) => set({ lastHeartbeatAt: ts ?? Date.now() }),

  selectEvent: (id) =>
    set((s) => (id === null ? { selectedEventId: null, breadcrumb: [] } : { selectedEventId: id })),

  drillIntoEvent: (id, label) =>
    set((s) => {
      if (!id || id === s.selectedEventId) return s;
      const trail = [...s.breadcrumb];
      if (s.selectedEventId && !trail.some((b) => b.id === s.selectedEventId)) {
        const cur = s.events.find((e) => e.id === s.selectedEventId);
        trail.push({ id: s.selectedEventId, label: cur?.tickers?.[0] ?? "ROOT" });
      }
      return { selectedEventId: id, breadcrumb: trail.slice(-5), cascade: null };
    }),

  popBreadcrumb: () =>
    set((s) => {
      const trail = [...s.breadcrumb];
      const prev = trail.pop();
      if (!prev) return s;
      return { selectedEventId: prev.id, breadcrumb: trail, cascade: null };
    }),

  clearBreadcrumb: () => set({ breadcrumb: [] }),

  pinForCompare: (id) =>
    set((s) => {
      if (!id) return s;
      if (!s.compareIds) {
        return { compareIds: [id, ""] as [string, string] };
      }
      if (s.compareIds[1] === "") {
        if (s.compareIds[0] === id) return s;
        return { compareIds: [s.compareIds[0], id] };
      }
      return { compareIds: [s.compareIds[0], id] };
    }),

  clearCompare: () => set({ compareIds: null }),

  setCascade: (cascade) => set({ cascade }),
  setCascadeLoading: (b) => set({ cascadeLoading: b }),
  setCascadePhase: (cascadePhase) => set({ cascadePhase }),
  setStreamStatus: (streamStatus) => set({ streamStatus }),
  setTimeOffset: (timeOffset) => set({ timeOffset }),
  toggleEli5: () => set((s) => ({ eli5: !s.eli5 })),
  toggleCounterfactual: () => set((s) => ({ counterfactual: !s.counterfactual })),
  setSourceFilter: (sourceFilter) => set({ sourceFilter }),
  setReasoningNode: (reasoningNode) => set({ reasoningNode }),
  setGeoArcMode: (geoArcMode) => set({ geoArcMode }),
  cycleGeoArcMode: () =>
    set((s) => ({
      geoArcMode:
        s.geoArcMode === "all" ? "primary" : s.geoArcMode === "primary" ? "off" : "all",
    })),
  setWorkerRun: (workerRunState, workerRunMessage = "") =>
    set({ workerRunState, workerRunMessage }),
}));
