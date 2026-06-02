// Typed fetch wrappers for the Cascade FastAPI backend.
// In dev, NEXT_PUBLIC_API_URL points at http://localhost:8080.
// In prod, it points at the Cloud Run URL.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export type Event = {
  id: string;
  headline: string;
  text?: string;
  tickers: string[];
  entities?: string[];
  sector: string;
  impact: "critical" | "high" | "medium" | "low" | string;
  source_type: string;
  source_url?: string;
  published_at?: string | null;
  has_cascade?: boolean;
  replay?: string;
};

export type EventList = {
  events: Event[];
  count: number;
};

export type SearchHit = {
  id: string;
  headline: string;
  tickers: string[];
  sector: string;
  impact: string;
  source_type: string;
  published_at: string;
  rerank_score: number;
};

export type SearchResponse = {
  query: string;
  events: SearchHit[];
  count: number;
};

export type CascadeNode = {
  ticker: string;
  company: string;
  sector: string;
  level: string;
  hop: number;
  relationship_type: string;
  cascade_score: number;
  why: string;
  event_id?: string;
  direction?: number;  // -1 neg, 0 neutral, +1 pos (geo-cascade only)
};

export type CascadeEdge = {
  from: string;
  to: string;
  type: string;
  weight: number;
  hop: number;
};

export type CascadeRoot = {
  id: string;
  headline: string;
  tickers: string[];
  impact: string;
  sector: string;
  published_at: string;
  source_type: string;
};

export type GeoRegion = {
  name: string;
  iso?: string | null;
  role?: string;
  lat?: number | null;
  lon?: number | null;
};
export type GeoSectorExposure = { name: string; exposure?: string; confidence?: number };
export type GeoCascadeMeta = {
  event_type: string;
  regions: GeoRegion[];
  sectors: GeoSectorExposure[];
  transmission_mechanism: string;
  time_horizon?: string;
  historical_analog?: string;
  model?: string;
};

export type CascadeResponse = {
  root: CascadeRoot;
  nodes: CascadeNode[];
  edges: CascadeEdge[];
  hop_counts: Record<string, number>;
  message?: string;
  fallback?: string;
  narrative?: string;
  severity?: string;
  geo_cascade?: GeoCascadeMeta | null;
};

export type NarrativeResponse = {
  ready: boolean;
  narrative?: string;
  severity?: string;
  risk_factors?: string[];
  confidence?: number;
};

export type StatsResponse = {
  impact_counts: Record<string, number>;
  sector_counts: Record<string, number>;
  top_tickers: { ticker: string; count: number }[];
  total_events: number;
  cascade_count: number;
  hours_back: number;
};

export type Health = {
  ok: boolean;
  mongo: string;
  voyage: string;
  gemini_model: string;
  events_24h: number;
};

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => http<Health>("/health"),

  listEvents: (params: { ticker?: string; sector?: string; impact?: string; source_type?: string; hours_back?: number; limit?: number; cascadable_only?: boolean } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v !== undefined && v !== "" && q.set(k, String(v)));
    return http<EventList>(`/events${q.toString() ? `?${q}` : ""}`);
  },

  getEvent: (id: string) => http<Event>(`/events/${id}`),

  stats: (hours_back = 24) => http<StatsResponse>(`/stats?hours_back=${hours_back}`),

  search: (body: { query: string; sector?: string; impact?: string; days_back?: number; limit?: number }) =>
    http<SearchResponse>("/search", { method: "POST", body: JSON.stringify(body) }),

  buildCascade: (body: { event_id: string; max_hops?: number; top_k?: number; device_id?: string }) =>
    http<CascadeResponse>("/cascade", { method: "POST", body: JSON.stringify(body) }),

  refreshAll: () =>
    http<{
      ran: number;
      succeeded: number;
      failed: number;
      workers: { worker: string; ok: boolean; error?: string }[];
    }>("/admin/refresh", { method: "POST" }),

  logCascadeView: (body: { device_id: string; event_id: string; root_ticker?: string; sector?: string; headline?: string }) =>
    http<{ ok: boolean }>("/memory/cascade-view", { method: "POST", body: JSON.stringify(body) }),

  recentMemory: (device_id: string, limit = 20) =>
    http<MemoryRecentResponse>(`/memory/recent?device_id=${encodeURIComponent(device_id)}&limit=${limit}`),

  forgetMemory: (device_id: string) =>
    http<{ ok: boolean; deleted: number }>(`/memory/${encodeURIComponent(device_id)}`, { method: "DELETE" }),

  narrative: (event_id: string) =>
    http<NarrativeResponse>(`/cascade/by-event/${event_id}/narrative`),

  chartSearch: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API_URL}/multimodal/search`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json() as Promise<{
      matches: Array<{ id: string; headline: string; tickers: string[]; score: number }>;
      count: number;
      note?: string;
    }>;
  },

  pdfSearch: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API_URL}/multimodal/pdf`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json() as Promise<{
      matches: Array<{ id: string; headline: string; tickers: string[]; score: number }>;
      count: number;
      note?: string;
    }>;
  },

  society: (event_id: string) =>
    http<SocietyResponse>(`/cascade/by-event/${event_id}/society`),
};

export type MemoryRecentItem = {
  event_id: string;
  root_ticker?: string;
  sector?: string;
  headline?: string;
  viewed_at?: string;
};

export type MemoryRecentResponse = {
  items: MemoryRecentItem[];
  count: number;
};

export type SocietyResponse = {
  ready: boolean;
  done: boolean;
  critic?: { message: string; weak_tickers?: string[]; _source?: "gemini" | "local" | "timeout" };
  predictor?: {
    message: string;
    projections?: Array<{ ticker: string; direction: string; confidence: number; rationale: string }>;
    analogue?: string;
    _source?: "gemini" | "local" | "timeout";
  };
  memory?: { message: string; tags?: string[]; _history_size?: number; _source?: "gemini" | "local" | "fallback" };
  eli5?: string;
};

export const SSE_URL = process.env.NEXT_PUBLIC_SSE_URL ?? `${API_URL}/stream`;
