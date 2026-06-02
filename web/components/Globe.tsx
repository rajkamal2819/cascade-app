"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useStore } from "@/lib/store";

const GlobeGL = dynamic(() => import("react-globe.gl"), { ssr: false });

// Subsolar point — where the sun is overhead right now. Drives the
// day/night marker so the globe feels tied to real wall-clock time.
function subsolarPoint(now: Date): { lat: number; lng: number } {
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const lng = -15 * (utcHours - 12);
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const day = Math.floor((now.getTime() - start) / 86_400_000);
  const lat = 23.44 * Math.sin(((day - 81) * 2 * Math.PI) / 365);
  return { lat, lng: ((lng + 540) % 360) - 180 };
}

// "Fresh arrival" window — points that landed within this many ms get the
// oversized halo + shockwave ring. Tuned so the eye registers them as new
// without the globe feeling jittery.
const FRESH_WINDOW_MS = 3_500;

// Cascade hop reveal delays (ms). Hop-1 arcs draw immediately, hop-2 lands
// 600ms later, hop-3 at 1200ms — the eye literally watches damage radiate
// out from the root instead of seeing one tangled snapshot.
// Keyed by hop number directly so HOP_REVEAL_DELAYS[1] === 0 (no off-by-one).
const HOP_REVEAL_DELAYS: Record<number, number> = { 1: 0, 2: 600, 3: 1200 };

// Per-hop dash speed (ms to traverse arc). Fast hop-1 = urgent primary
// blow; slow hop-3 = distant ripple. Asymmetry is the whole point.
const HOP_DASH_MS: Record<number, number> = { 1: 1100, 2: 1700, 3: 2400 };

// Per-hop stroke width. Hop-1 is bold (primary), hop-3 thinner (ripple).
// Tubes are rendered against a dark globe so anything under ~0.6 disappears.
const HOP_STROKE: Record<number, number> = { 1: 1.8, 2: 1.3, 3: 0.9 };

// Per-hop arc altitude — hop-1 hugs the globe (immediate), hop-3 arches
// high (distant ripple). Adds 3D depth to the cascade.
const HOP_ALT: Record<number, number> = { 1: 0.35, 2: 0.55, 3: 0.75 };

// Coarse geographic bin size for label clustering (degrees). 2° ≈ 220km
// at the equator, smaller toward the poles. Tight enough to keep distinct
// cities apart (NYC vs Boston), loose enough that all of Silicon Valley
// collapses into one label.
const LABEL_BIN_DEG = 2.0;

// HQ coordinates + city label for the most-referenced tickers.
// City names are shown when a cascade is active so judges can read
// "where" cascades originate / propagate to.
const HQ: Record<string, { lat: number; lng: number; name: string; city: string }> = {
  AAPL: { lat: 37.3349, lng: -122.0090, name: "Apple", city: "Cupertino" },
  MSFT: { lat: 47.6396, lng: -122.1281, name: "Microsoft", city: "Redmond" },
  GOOGL: { lat: 37.4220, lng: -122.0841, name: "Alphabet", city: "Mountain View" },
  AMZN: { lat: 47.6228, lng: -122.3375, name: "Amazon", city: "Seattle" },
  META: { lat: 37.4848, lng: -122.1484, name: "Meta", city: "Menlo Park" },
  NVDA: { lat: 37.3711, lng: -121.9619, name: "NVIDIA", city: "Santa Clara" },
  TSLA: { lat: 30.2225, lng: -97.7666, name: "Tesla", city: "Austin" },
  TSM: { lat: 24.7740, lng: 120.9982, name: "TSMC", city: "Hsinchu" },
  AMD: { lat: 37.3825, lng: -121.9627, name: "AMD", city: "Santa Clara" },
  INTC: { lat: 37.3879, lng: -121.9636, name: "Intel", city: "Santa Clara" },
  AVGO: { lat: 37.4419, lng: -122.1430, name: "Broadcom", city: "Palo Alto" },
  AMAT: { lat: 37.4053, lng: -121.9876, name: "Applied Materials", city: "Santa Clara" },
  MU: { lat: 43.6150, lng: -116.2023, name: "Micron", city: "Boise" },
  SMCI: { lat: 37.3865, lng: -121.9842, name: "Super Micro", city: "San Jose" },
  ORCL: { lat: 30.2240, lng: -97.7460, name: "Oracle", city: "Austin" },
  CRM: { lat: 37.7898, lng: -122.3942, name: "Salesforce", city: "San Francisco" },
  JPM: { lat: 40.7558, lng: -73.9787, name: "JPMorgan", city: "New York" },
  GS: { lat: 40.7141, lng: -74.0144, name: "Goldman Sachs", city: "New York" },
  MS: { lat: 40.7614, lng: -73.9776, name: "Morgan Stanley", city: "New York" },
  BAC: { lat: 35.2271, lng: -80.8431, name: "Bank of America", city: "Charlotte" },
  WFC: { lat: 37.7901, lng: -122.4019, name: "Wells Fargo", city: "San Francisco" },
  C: { lat: 40.7128, lng: -74.0060, name: "Citigroup", city: "New York" },
  XOM: { lat: 32.9667, lng: -96.8333, name: "Exxon", city: "Irving, TX" },
  CVX: { lat: 32.7833, lng: -96.8000, name: "Chevron", city: "Houston" },
  WMT: { lat: 36.3729, lng: -94.2088, name: "Walmart", city: "Bentonville" },
  HD: { lat: 33.8500, lng: -84.3625, name: "Home Depot", city: "Atlanta" },
  PG: { lat: 39.1031, lng: -84.5120, name: "P&G", city: "Cincinnati" },
  KO: { lat: 33.7660, lng: -84.3877, name: "Coca-Cola", city: "Atlanta" },
  PEP: { lat: 41.0700, lng: -73.7090, name: "PepsiCo", city: "Purchase, NY" },
  JNJ: { lat: 40.4969, lng: -74.4407, name: "J&J", city: "New Brunswick" },
  PFE: { lat: 40.7506, lng: -73.9756, name: "Pfizer", city: "New York" },
  UNH: { lat: 44.9637, lng: -93.4031, name: "UnitedHealth", city: "Minnetonka" },
  V: { lat: 37.7771, lng: -122.4196, name: "Visa", city: "San Francisco" },
  MA: { lat: 40.9710, lng: -73.7610, name: "Mastercard", city: "Purchase, NY" },
  DIS: { lat: 34.1561, lng: -118.3236, name: "Disney", city: "Burbank" },
  NFLX: { lat: 37.2580, lng: -121.9706, name: "Netflix", city: "Los Gatos" },
  BA: { lat: 41.8521, lng: -87.6314, name: "Boeing", city: "Arlington, VA" },
  CAT: { lat: 32.7767, lng: -96.7970, name: "Caterpillar", city: "Irving, TX" },
  GE: { lat: 42.3653, lng: -71.0856, name: "GE", city: "Boston" },
  F: { lat: 42.3223, lng: -83.2179, name: "Ford", city: "Dearborn" },
  GM: { lat: 42.3354, lng: -83.0398, name: "GM", city: "Detroit" },
  // Non-US anchors useful for geopolitical cascades
  ASML: { lat: 51.4108, lng: 5.4530, name: "ASML", city: "Veldhoven" },
  SSNLF: { lat: 37.2580, lng: 127.0470, name: "Samsung", city: "Suwon" },
  BABA: { lat: 30.2741, lng: 120.1551, name: "Alibaba", city: "Hangzhou" },
};

const REL_COLOR: Record<string, string> = {
  supplier: "#34d399",
  customer: "#38bdf8",
  peer: "#c084fc",
  sector: "#fbbf24",
  derivative: "#f472b6",
  semantic: "#64748b",
};

// Polarity model — how a NEGATIVE shock at the root propagates through this edge.
//   damage  — red    : supplier loses orders, sector cohort sells off
//   exposed — amber  : customer or peer with mixed exposure
//   benefit — green  : substitute / derivative play that *wins*
//   related — grey   : semantic, direction unknown
const POLARITY: Record<string, "damage" | "exposed" | "benefit" | "related"> = {
  supplier: "damage",
  sector: "damage",
  customer: "exposed",
  peer: "exposed",
  derivative: "benefit",
  semantic: "related",
};
// Polarity arc colours — chosen to read cleanly against the cyan/violet
// atmosphere and the dark earth-night base map. Rose for damage (cool red,
// less "Christmas" than #f43f5e), tangerine for exposure (distinct from
// the amber high-impact dot), emerald for benefit, slate for related.
const POLARITY_COLOR: Record<string, string> = {
  damage: "#f43f5e",
  exposed: "#fb923c",
  benefit: "#34d399",
  related: "#64748b",
};

// Impact dot colours — sit at fixed positions on the globe, so they need
// to be unambiguous against the night earth. Critical = rose to match
// damage arcs; high = amber; medium/low fade into slate.
const IMPACT_COLOR: Record<string, string> = {
  critical: "#f43f5e",
  high: "#fbbf24",
  medium: "#64748b",
  low: "#334155",
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Globe() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<any>(null);
  const eventsAll = useStore((s) => s.events);
  const timeOffset = useStore((s) => s.timeOffset);
  const events = useMemo(() => {
    if (timeOffset <= 0) return eventsAll;
    const cutoff = Date.now() - timeOffset * 24 * 3600 * 1000;
    return eventsAll.filter((e) => {
      const t = e.published_at ? new Date(e.published_at).getTime() : 0;
      return t > 0 && t <= cutoff;
    });
  }, [eventsAll, timeOffset]);
  const cascade = useStore((s) => s.cascade);
  const geoArcMode = useStore((s) => s.geoArcMode);
  const selectEvent = useStore((s) => s.selectEvent);
  const streamStatus = useStore((s) => s.streamStatus);
  const lastEventAt = useStore((s) => s.lastEventAt);
  const lastHeartbeatAt = useStore((s) => s.lastHeartbeatAt);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [shown, setShown] = useState(false);
  // Wall-clock tick — drives the "Ns ago" chip and the recency-decay sizing.
  // 1 Hz is enough; pulses use CSS animation, not React re-render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Cascade hop reveal state. Counts which hops are currently drawable.
  // Bumped 0→1→2→3 by staggered setTimeouts when a new cascade lands so
  // the eye sees the shockwave radiate out instead of all arcs at once.
  // cascadeStartedAt drives the root "fire" pulse for the first 1.2s.
  const [revealedHops, setRevealedHops] = useState(0);
  const [cascadeStartedAt, setCascadeStartedAt] = useState<number | null>(null);
  // Hops that "just landed" — drives the one-shot impact-flash ring on
  // destination nodes for ~1.5s. Map<hop, startedAtMs>.
  const [hopLandings, setHopLandings] = useState<Record<number, number>>({});

  useEffect(() => {
    if (!cascade) {
      setRevealedHops(0);
      setCascadeStartedAt(null);
      setHopLandings({});
      return;
    }
    const startedAt = Date.now();
    setCascadeStartedAt(startedAt);
    setRevealedHops(0);
    setHopLandings({});
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Schedule each hop's reveal + the impact-flash at that hop's
    // *destination* (synced with the arc-completion moment, not the
    // reveal moment, so the flash lands when the comet arrives).
    for (let hop = 1; hop <= 3; hop++) {
      const reveal = HOP_REVEAL_DELAYS[hop] ?? hop * 600;
      const arcDur = HOP_DASH_MS[hop] ?? 1800;
      timers.push(setTimeout(() => setRevealedHops((h) => Math.max(h, hop)), reveal));
      timers.push(
        setTimeout(() => {
          setHopLandings((m) => ({ ...m, [hop]: Date.now() }));
        }, reveal + arcDur),
      );
    }
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [cascade]);

  useEffect(() => {
    const t = setTimeout(() => setShown(true), 30);
    const measure = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setSize({ width: Math.max(300, rect.width), height: Math.max(300, rect.height) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Background event pulses. Two-axis sizing:
  //   • impact (critical > high > medium > low) sets the base radius
  //   • recency decays the radius — events older than ~3h fade into the floor
  // Plus: events that landed in the last FRESH_WINDOW_MS get an oversized
  // "fresh" multiplier so the eye catches new arrivals without needing the
  // user to read a feed entry.
  const points = useMemo(() => {
    const out: Array<{
      id: string; lat: number; lng: number; altitude: number; radius: number;
      color: string; ticker: string; impact: string; headline: string;
      fresh: boolean; arrivedAt: number | null;
    }> = [];
    for (const e of events.slice(0, 300)) {
      const t = e.tickers.find((tk) => HQ[tk]);
      if (!t) continue;
      const hq = HQ[t];
      const isCrit = e.impact === "critical";
      const isHigh = e.impact === "high";
      const baseR = isCrit ? 0.95 : isHigh ? 0.7 : 0.45;
      const baseA = isCrit ? 0.42 : isHigh ? 0.25 : 0.08;
      // Recency decay: 1.0 at arrival → 0.55 after ~3h half-life. Stays
      // visible long enough to read the globe as "alive over hours", not
      // "dead 30min after a news event". Uses _arrivedAt when available,
      // else falls back to published_at.
      const stamp = e._arrivedAt ?? (e.published_at ? Date.parse(e.published_at) : now);
      const ageMin = Math.max(0, (now - stamp) / 60_000);
      const decay = 0.55 + 0.45 * Math.exp(-ageMin / 180);
      const arrivedAt = e._arrivedAt ?? null;
      const fresh = arrivedAt !== null && now - arrivedAt < FRESH_WINDOW_MS;
      const freshMul = fresh ? 1.6 : 1.0;
      out.push({
        id: e.id,
        lat: hq.lat,
        lng: hq.lng,
        altitude: baseA * (fresh ? 1.5 : 1) * Math.max(0.6, decay),
        radius: baseR * decay * freshMul,
        color: IMPACT_COLOR[e.impact] ?? "#64748b",
        ticker: t,
        impact: e.impact,
        headline: e.headline || e.source_type,
        fresh,
        arrivedAt,
      });
      if (out.length >= 150) break;
    }
    return out;
  }, [events, now]);

  // Cascade arcs — polarity-coloured comets that radiate out by hop.
  //   • Hop-1 reveals immediately, hop-2 at +600ms, hop-3 at +1200ms.
  //   • Stroke + altitude shrink/grow by hop so the cascade looks like a
  //     real 3D shockwave dome (low+thick near root, high+thin at edges).
  //   • Color fades by hop (eye drawn to freshest ripple).
  // The `dashLength=0.05, dashGap=0.95` config below turns each arc into
  // a *comet head* travelling its path — far more "signal moving" than
  // the long ticker-tape dashes we had before.
  const arcs = useMemo(() => {
    if (!cascade) return [];
    type Arc = {
      startLat: number; startLng: number; endLat: number; endLng: number;
      color: [string, string]; stroke: number; hop: number; polarity: string;
      dashTime: number; dashLen: number; dashGap: number; altitude: number;
    };
    const out: Arc[] = [];
    const withAlpha = (hex: string, a: number): string => {
      const h = hex.replace("#", "");
      const r = parseInt(h.substring(0, 2), 16);
      const g = parseInt(h.substring(2, 4), 16);
      const b = parseInt(h.substring(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
    };
    for (const edge of cascade.edges.slice(0, 80)) {
      if (edge.hop > revealedHops) continue;
      const from = HQ[edge.from];
      const to = HQ[edge.to];
      if (!from || !to) continue;
      const polarity = POLARITY[edge.type] ?? "related";
      const destColor = POLARITY_COLOR[polarity];
      const alpha = edge.hop === 1 ? 1.0 : edge.hop === 2 ? 0.8 : 0.55;
      const startColor = edge.hop === 1 ? "#f43f5e" : destColor;
      const baseStroke = (HOP_STROKE[edge.hop] ?? 1.0) + edge.weight * 0.4;
      const altitude = HOP_ALT[edge.hop] ?? 0.35;
      // Layer 1 — base "wire" — thin, always-visible path so the eye sees
      // *where* the cascade connects (NVDA → TSM, SF → Hsinchu) even
      // between comet passes. Without this the arc was 95% invisible.
      out.push({
        startLat: from.lat, startLng: from.lng,
        endLat: to.lat, endLng: to.lng,
        color: [withAlpha(startColor, alpha * 0.55), withAlpha(destColor, alpha * 0.55)],
        stroke: Math.max(0.7, baseStroke * 0.6),
        hop: edge.hop,
        polarity,
        // No dash animation on the wire — full continuous line.
        dashTime: 0,
        dashLen: 1.0,
        dashGap: 0.0,
        altitude,
      });
      // Layer 2 — comet head — bright moving pulse along the path.
      out.push({
        startLat: from.lat, startLng: from.lng,
        endLat: to.lat, endLng: to.lng,
        color: [withAlpha(startColor, alpha), withAlpha(destColor, alpha)],
        stroke: baseStroke,
        hop: edge.hop,
        polarity,
        dashTime: HOP_DASH_MS[edge.hop] ?? 1800,
        dashLen: 0.18,
        dashGap: 0.82,
        altitude,
      });
    }
    return out;
  }, [cascade, revealedHops]);

  // Concentration ring — when ≥ 40% of cascade HQs cluster in one region,
  // draw a large slow-pulsing ring around the centroid. Tells the user
  // "this cascade is geographically concentrated" at a glance.
  const concentrationRing = useMemo(() => {
    if (!cascade || cascade.nodes.length < 3) return null;
    // Bucket by 30°×30° lat-lng cells (continental scale)
    const buckets = new Map<string, { lats: number[]; lngs: number[]; count: number }>();
    const allTickers = [...cascade.root.tickers, ...cascade.nodes.map((n) => n.ticker)];
    for (const t of allTickers) {
      const hq = HQ[t];
      if (!hq) continue;
      const key = `${Math.floor(hq.lat / 30)}_${Math.floor(hq.lng / 30)}`;
      const b = buckets.get(key) ?? { lats: [], lngs: [], count: 0 };
      b.lats.push(hq.lat);
      b.lngs.push(hq.lng);
      b.count += 1;
      buckets.set(key, b);
    }
    let best: { lats: number[]; lngs: number[]; count: number } | null = null;
    for (const b of buckets.values()) {
      if (!best || b.count > best.count) best = b;
    }
    if (!best) return null;
    const totalKnown = [...buckets.values()].reduce((s, b) => s + b.count, 0);
    const pct = best.count / totalKnown;
    if (pct < 0.4 || best.count < 3) return null;
    const cLat = best.lats.reduce((a, b) => a + b, 0) / best.lats.length;
    const cLng = best.lngs.reduce((a, b) => a + b, 0) / best.lngs.length;
    return { lat: cLat, lng: cLng, color: "#f43f5e", maxR: 18, period: 4200, pct };
  }, [cascade]);

  // Halos: root + cascade tickers (polarity colour) + concentration ring.
  // The root pulse "fires" rapidly (period 600ms) for the first 1.2s of a
  // cascade — visibly launches the propagation — then settles to 1300ms.
  const rings = useMemo(() => {
    if (!cascade) return [];
    const out: Array<{ lat: number; lng: number; color: string; maxR: number; period: number }> = [];
    const fireUntil = (cascadeStartedAt ?? 0) + 1200;
    const rootFiring = cascadeStartedAt !== null && now < fireUntil;
    for (const t of cascade.root.tickers) {
      const hq = HQ[t];
      if (!hq) continue;
      out.push({
        lat: hq.lat, lng: hq.lng, color: "#f43f5e",
        maxR: rootFiring ? 7 : 5,
        period: rootFiring ? 600 : 1300,
      });
    }
    for (const n of cascade.nodes) {
      const hq = HQ[n.ticker];
      if (!hq) continue;
      // Only show node halos for hops that have been revealed.
      if (n.hop > revealedHops) continue;
      const polarity = POLARITY[n.relationship_type] ?? "related";
      out.push({
        lat: hq.lat,
        lng: hq.lng,
        color: POLARITY_COLOR[polarity],
        maxR: 2.5 + n.cascade_score * 2,
        period: 1700 + n.hop * 200,
      });
    }
    if (concentrationRing) {
      out.push(concentrationRing);
    }
    return out;
  }, [cascade, concentrationRing, cascadeStartedAt, revealedHops, now]);

  // Impact flash rings — one-shot bright ring at each hop's destination
  // node, fired the moment the comet *lands* there. Lasts ~1.5s then
  // fades. This is the visual moment a judge sees the cascade hit.
  const flashRings = useMemo(() => {
    if (!cascade) return [];
    const out: Array<{ lat: number; lng: number; color: string; maxR: number; period: number }> = [];
    for (const [hopStr, startedAt] of Object.entries(hopLandings)) {
      if (now - startedAt > 1500) continue;
      const hop = Number(hopStr);
      for (const n of cascade.nodes) {
        if (n.hop !== hop) continue;
        const hq = HQ[n.ticker];
        if (!hq) continue;
        const polarity = POLARITY[n.relationship_type] ?? "related";
        out.push({
          lat: hq.lat, lng: hq.lng,
          color: POLARITY_COLOR[polarity],
          maxR: 6, period: 500,
        });
      }
    }
    return out;
  }, [cascade, hopLandings, now]);

  // Shockwave rings for events that arrived in the last FRESH_WINDOW_MS.
  // These overlay on the cascade rings so a live news drop is visible even
  // mid-cascade. Critical events get a brighter, larger wave.
  const freshRings = useMemo(() => {
    const out: Array<{ lat: number; lng: number; color: string; maxR: number; period: number }> = [];
    const seen = new Set<string>();
    for (const p of points) {
      if (!p.fresh || seen.has(p.ticker)) continue;
      seen.add(p.ticker);
      const isCrit = p.impact === "critical";
      out.push({
        lat: p.lat,
        lng: p.lng,
        color: p.color,
        maxR: isCrit ? 7 : 4.5,
        period: isCrit ? 900 : 1200,
      });
    }
    return out;
  }, [points]);

  // Ambient idle arcs — when no cascade is selected, sweep slow cyan arcs
  // between the most-recently-active mapped tickers. We bias toward
  // *long* arcs (intercontinental) over short ones because globe-spanning
  // motion reads as a planetary network; Bay-Area-to-Bay-Area reads as
  // a tangle. Arcs rotate which pair every 20s.
  const ambientArcs = useMemo(() => {
    if (cascade) return [];
    const recents: string[] = [];
    const seen = new Set<string>();
    for (const e of events) {
      const t = e.tickers.find((tk) => HQ[tk]);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      recents.push(t);
      if (recents.length >= 10) break;
    }
    if (recents.length < 2) return [];
    type Pair = { a: string; b: string; dist: number };
    const pairs: Pair[] = [];
    for (let i = 0; i < recents.length; i++) {
      for (let j = i + 1; j < recents.length; j++) {
        const A = HQ[recents[i]];
        const B = HQ[recents[j]];
        if (!A || !B) continue;
        const d = Math.hypot(A.lat - B.lat, A.lng - B.lng);
        pairs.push({ a: recents[i], b: recents[j], dist: d });
      }
    }
    pairs.sort((p, q) => q.dist - p.dist);
    const out: Array<{
      startLat: number; startLng: number; endLat: number; endLng: number;
      color: [string, string]; stroke: number;
      dashTime: number; dashLen: number; dashGap: number; altitude: number; hop: number;
    }> = [];
    const offset = Math.floor(now / 20_000) % Math.max(1, pairs.length);
    for (let i = 0; i < Math.min(4, pairs.length); i++) {
      const p = pairs[(i + offset) % pairs.length];
      const a = HQ[p.a];
      const b = HQ[p.b];
      if (!a || !b) continue;
      out.push({
        startLat: a.lat, startLng: a.lng, endLat: b.lat, endLng: b.lng,
        color: ["rgba(34,211,238,0.0)", "rgba(34,211,238,0.9)"],
        stroke: 0.9,
        dashTime: 4000,
        dashLen: 0.35,
        dashGap: 0.65,
        altitude: 0.4,
        hop: 0,
      });
    }
    return out;
  }, [cascade, events, now]);

  // Idle shimmer rings — slow low-opacity halos on the top-3 most-active
  // mapped tickers. Globe always has *something* breathing, even when
  // the news flow is quiet. Suppressed during cascade so they don't
  // clutter the propagation.
  const shimmerRings = useMemo(() => {
    if (cascade) return [];
    const out: Array<{ lat: number; lng: number; color: string; maxR: number; period: number }> = [];
    const seen = new Set<string>();
    for (const e of events) {
      const t = e.tickers.find((tk) => HQ[tk]);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      const hq = HQ[t];
      if (!hq) continue;
      const impactColor = IMPACT_COLOR[e.impact] ?? "#38bdf8";
      out.push({
        lat: hq.lat, lng: hq.lng,
        color: impactColor,
        maxR: 3.5, period: 3500,
      });
      if (out.length >= 3) break;
    }
    return out;
  }, [cascade, events]);

  // City labels — bin nearby HQs into ~220km cells so Silicon Valley
  // (AAPL/NVDA/GOOGL/META/AMD/INTC/AVGO/AMAT/SMCI all within 50km) doesn't
  // pile up into one unreadable smear. The "winning" ticker for a bin is
  // the highest-priority one (root > earlier-hop > higher cascade_score),
  // and the label shows `+N` when others share the bin.
  const labels = useMemo(() => {
    type Cand = { ticker: string; color: string; size: number; priority: number };
    const bins = new Map<string, Cand[]>();
    const push = (ticker: string, color: string, size: number, priority: number) => {
      const hq = HQ[ticker];
      if (!hq) return;
      const key = `${Math.floor(hq.lat / LABEL_BIN_DEG)}_${Math.floor(hq.lng / LABEL_BIN_DEG)}`;
      const arr = bins.get(key) ?? [];
      if (arr.some((c) => c.ticker === ticker)) return;
      arr.push({ ticker, color, size, priority });
      bins.set(key, arr);
    };
    if (cascade) {
      for (const t of cascade.root.tickers) push(t, "#f43f5e", 0.95, 100);
      for (const n of cascade.nodes.slice(0, 25)) {
        const c = REL_COLOR[n.relationship_type] ?? "#fff";
        // Earlier hops + higher score win the label slot in a crowded bin.
        push(n.ticker, c, 0.75, 50 - n.hop * 10 + n.cascade_score * 5);
      }
    } else {
      for (const e of events.slice(0, 80)) {
        const t = e.tickers[0];
        if (!t || !HQ[t]) continue;
        const color = IMPACT_COLOR[e.impact] ?? "#94a3b8";
        const p = e.impact === "critical" ? 30 : e.impact === "high" ? 20 : 5;
        push(t, color, 0.7, p);
      }
    }
    // For each bin, pick the highest-priority ticker and annotate with +N.
    const out: Array<{ lat: number; lng: number; text: string; size: number; color: string }> = [];
    const winners: Cand[] = [];
    for (const arr of bins.values()) {
      arr.sort((a, b) => b.priority - a.priority);
      const top = arr[0];
      const hq = HQ[top.ticker];
      if (!hq) continue;
      const extra = arr.length - 1;
      const text = extra > 0 ? `${top.ticker} +${extra}` : `${top.ticker} · ${hq.city}`;
      winners.push(top);
      out.push({ lat: hq.lat, lng: hq.lng, text, size: top.size, color: top.color });
    }
    // Sort by priority desc, cap to 12 so the globe stays legible.
    out.sort((a, b) => {
      const pa = winners.find((w) => a.text.startsWith(w.ticker))?.priority ?? 0;
      const pb = winners.find((w) => b.text.startsWith(w.ticker))?.priority ?? 0;
      return pb - pa;
    });
    return out.slice(0, 12);
  }, [cascade, events]);

  // Sun marker — subsolar point updated each render-tick. Renders as a
  // bright label so the globe is visibly anchored to real wall-clock UTC.
  const sunLabel = useMemo(() => {
    const sub = subsolarPoint(new Date(now));
    return [{ lat: sub.lat, lng: sub.lng, text: "☀ noon", size: 0.7, color: "#fde68a" }];
  }, [now]);

  // Geo-cascade layer — Gemini-inferred region centroids for tickerless
  // events (geopolitics, disasters, macro). The supply-chain $graphLookup
  // path can't seed these, so the globe renders the *region* as a pulsing
  // pin and fans arcs from each region to every affected company HQ. Mode
  // is user-cycled from the GeoCascadePanel ("all" / "primary" / "off") so
  // multi-region events don't get visually busy.
  const geoRegionsActive = useMemo(() => {
    if (!cascade?.geo_cascade?.regions || geoArcMode === "off") return [];
    const valid = cascade.geo_cascade.regions.filter(
      (r) => typeof r.lat === "number" && typeof r.lon === "number",
    );
    return geoArcMode === "primary" ? valid.slice(0, 1) : valid;
  }, [cascade, geoArcMode]);

  const geoArcs = useMemo(() => {
    if (!cascade || geoRegionsActive.length === 0) return [];
    type Arc = {
      startLat: number; startLng: number; endLat: number; endLng: number;
      color: [string, string]; stroke: number; hop: number; polarity: string;
      dashTime: number; dashLen: number; dashGap: number; altitude: number;
    };
    const out: Arc[] = [];
    // Origin colour = accent cyan (matches GeoCascadePanel header), dest
    // colour = polarity colour for the affected company. Distinct from
    // ticker→ticker arcs (rose/amber) so the geo layer reads as "regional
    // exposure" not "supply-chain hop".
    for (const region of geoRegionsActive) {
      const rLat = region.lat as number;
      const rLng = region.lon as number;
      for (const n of cascade.nodes.slice(0, 12)) {
        if (n.hop > revealedHops + 1) continue;
        const hq = HQ[n.ticker];
        if (!hq) continue;
        const polarity = n.direction === -1 ? "damage" : n.direction === 1 ? "benefit" : "exposed";
        const destColor = POLARITY_COLOR[polarity];
        out.push({
          startLat: rLat, startLng: rLng,
          endLat: hq.lat, endLng: hq.lng,
          color: ["rgba(34,211,238,0.85)", destColor],
          stroke: 1.2 + n.cascade_score * 0.4,
          hop: Math.max(1, n.hop),
          polarity,
          dashTime: 1800,
          dashLen: 0.16,
          dashGap: 0.84,
          altitude: 0.45,
        });
      }
    }
    return out.slice(0, 40);
  }, [cascade, geoRegionsActive, revealedHops]);

  const geoRegionRings = useMemo(() => {
    return geoRegionsActive.map((r) => ({
      lat: r.lat as number,
      lng: r.lon as number,
      color: "#22d3ee",
      maxR: 8,
      period: 1500,
    }));
  }, [geoRegionsActive]);

  const geoRegionLabels = useMemo(() => {
    return geoRegionsActive.map((r) => ({
      lat: r.lat as number,
      lng: r.lon as number,
      text: r.name,
      size: 0.6,
      color: "#67e8f9",
    }));
  }, [geoRegionsActive]);

  // Merge cascade arcs with ambient idle arcs so we don't pass two layers.
  const allArcs = useMemo(() => [...arcs, ...geoArcs, ...ambientArcs], [arcs, geoArcs, ambientArcs]);
  // Merge cascade rings with fresh-arrival shockwaves, hop-landing impact
  // flashes, and idle shimmer rings.
  const allRings = useMemo(
    () => [...rings, ...freshRings, ...flashRings, ...shimmerRings, ...geoRegionRings],
    [rings, freshRings, flashRings, shimmerRings, geoRegionRings],
  );
  // Merge labels with the sun marker and any active geo-cascade region pins.
  const allLabels = useMemo(
    () => [...labels, ...sunLabel, ...geoRegionLabels],
    [labels, sunLabel, geoRegionLabels],
  );

  // Idle auto-rotate. Constrain zoom so users can dive in without pixelation.
  useEffect(() => {
    const g = globeRef.current;
    if (!g?.controls) return;
    const c = g.controls();
    c.autoRotate = !cascade;
    c.autoRotateSpeed = cascade ? 0 : 0.35;
    c.enableZoom = true;
    c.minDistance = 180;
    c.maxDistance = 480;
    c.zoomSpeed = 0.6;
    c.rotateSpeed = 0.7;
  }, [cascade, shown]);

  // When a cascade lands, fly toward the first ticker we know coords for.
  // If none of the root or node tickers are in the HQ map, stay where we are
  // rather than snapping the camera to a default location.
  useEffect(() => {
    const g = globeRef.current;
    if (!g?.pointOfView || !cascade) return;
    const candidates = [...cascade.root.tickers, ...cascade.nodes.map((n) => n.ticker)];
    const t = candidates.find((tk) => HQ[tk]);
    if (t) {
      const hq = HQ[t];
      g.pointOfView({ lat: hq.lat, lng: hq.lng, altitude: 1.7 }, 1400);
      return;
    }
    // Tickerless geo-cascade — fly to the primary inferred region instead.
    const region = cascade.geo_cascade?.regions?.find(
      (r) => typeof r.lat === "number" && typeof r.lon === "number",
    );
    if (region) {
      g.pointOfView({ lat: region.lat as number, lng: region.lon as number, altitude: 1.7 }, 1400);
    }
  }, [cascade]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {!shown && <GlobeSkeleton />}
      {shown && (
        <GlobeGL
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor="rgba(0,0,0,0)"
          globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
          bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
          showAtmosphere
          atmosphereColor={cascade ? "#a855f7" : "#22d3ee"}
          atmosphereAltitude={cascade ? 0.20 : 0.24}
          pointsData={points}
          pointAltitude={(d: any) => d.altitude}
          pointColor={(d: any) => d.color}
          pointRadius={(d: any) => d.radius}
          pointResolution={8}
          pointLabel={(d: any) =>
            `<div style="font-family:ui-monospace;font-size:11px;padding:6px 8px;background:rgba(8,12,20,0.92);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#e6edf3;max-width:280px;">
              <div style="font-weight:600;color:${d.color}">${d.ticker} · ${(d.impact || "").toUpperCase()}</div>
              <div style="margin-top:2px;color:#64748b;font-family:system-ui">${(d.headline || "").slice(0, 120)}</div>
            </div>`
          }
          onPointClick={(p: any) => p?.id && selectEvent(p.id)}
          arcsData={allArcs}
          arcColor={(d: any) => d.color}
          arcStroke={(d: any) => d.stroke}
          arcDashLength={(d: any) => d.dashLen ?? 0.18}
          arcDashGap={(d: any) => d.dashGap ?? 0.82}
          arcDashAnimateTime={(d: any) => d.dashTime ?? 1700}
          arcAltitude={(d: any) => d.altitude ?? 0.3}
          ringsData={allRings}
          ringColor={(d: any) => () => d.color}
          ringMaxRadius={(d: any) => d.maxR}
          ringPropagationSpeed={2.6}
          ringRepeatPeriod={(d: any) => d.period}
          labelsData={allLabels}
          labelLat={(d: any) => d.lat}
          labelLng={(d: any) => d.lng}
          labelText={(d: any) => d.text}
          labelSize={(d: any) => d.size}
          labelDotRadius={0.035}
          labelColor={(d: any) => d.color}
          labelResolution={2}
          labelAltitude={0.02}
        />
      )}

      {/* LIVE chip — top-left overlay. Colour and label react to actual
          stream state so judges see at a glance that the data is moving.
          Green = event in last 60s. Amber = stale (60s–5min). Red = stalled. */}
      <LiveChip
        status={streamStatus}
        lastEventAt={lastEventAt}
        lastHeartbeatAt={lastHeartbeatAt}
        now={now}
        eventCount={points.length}
      />

      {/* Vignette */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 70% at 50% 50%, transparent 60%, rgba(4,6,10,0.55) 100%)",
        }}
      />

      {/* Concentration callout — only when a regional cluster is detected */}
      {concentrationRing && cascade && (
        <div className="pointer-events-none absolute left-1/2 bottom-20 -translate-x-1/2">
          <div className="glass-strong inline-flex items-center gap-2 rounded-full px-3 py-1 text-[10px] uppercase tracking-widest">
            <span className="h-1.5 w-1.5 rounded-full pulse-soft" style={{ background: "#f43f5e", boxShadow: "0 0 8px #f43f5e" }} />
            <span className="text-critical">geographic concentration</span>
            <span className="text-muted tabular-nums">{Math.round(concentrationRing.pct * 100)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

function formatAgo(ms: number): string {
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function LiveChip({
  status,
  lastEventAt,
  lastHeartbeatAt,
  now,
  eventCount,
}: {
  status: "idle" | "connecting" | "live" | "reconnecting";
  lastEventAt: number | null;
  lastHeartbeatAt: number | null;
  now: number;
  eventCount: number;
}) {
  let dotColor = "#94a3b8";
  let label = "OFFLINE";
  let detail = "";

  if (status === "connecting") {
    dotColor = "#60a5fa";
    label = "CONNECTING";
  } else if (status === "reconnecting") {
    dotColor = "#fbbf24";
    label = "RECONNECTING";
  } else if (status === "live") {
    const eventAge = lastEventAt ? now - lastEventAt : null;
    const beatAge = lastHeartbeatAt ? now - lastHeartbeatAt : null;
    // Treat the channel as healthy if either a real event or a heartbeat
    // landed in the last 30s. After 60s with no event we degrade to amber
    // (still connected, but the news flow is quiet). After 5min — red.
    if (beatAge !== null && beatAge > 45_000) {
      dotColor = "#ef4444";
      label = "STALLED";
    } else if (eventAge !== null && eventAge > 300_000) {
      dotColor = "#ef4444";
      label = "QUIET";
    } else if (eventAge !== null && eventAge > 60_000) {
      dotColor = "#fbbf24";
      label = "LIVE";
    } else {
      dotColor = "#4ade80";
      label = "LIVE";
    }
    detail = eventAge !== null ? `last event ${formatAgo(eventAge)}` : "warming up…";
  }

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20">
      <div
        className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[10px] uppercase tracking-widest backdrop-blur-md"
        style={{
          background: "rgba(8,12,20,0.78)",
          border: "1px solid rgba(255,255,255,0.14)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
          color: "#e6edf3",
        }}
      >
        <span
          className="h-2 w-2 rounded-full pulse-soft"
          style={{ background: dotColor, boxShadow: `0 0 10px ${dotColor}` }}
        />
        <span style={{ color: dotColor, fontWeight: 600 }}>{label}</span>
        {detail && (
          <span style={{ color: "#94a3b8", textTransform: "none", letterSpacing: 0 }}>
            · {detail}
          </span>
        )}
        <span style={{ color: "#94a3b8", textTransform: "none", letterSpacing: 0 }}>
          · {eventCount} on globe
        </span>
      </div>
    </div>
  );
}

function GlobeSkeleton() {
  return (
    <div className="absolute inset-0 grid place-items-center">
      <div className="relative h-72 w-72 rounded-full opacity-50">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 35% 35%, rgba(34,211,238,0.28) 0%, transparent 60%), radial-gradient(circle at 70% 70%, rgba(168,85,247,0.20) 0%, transparent 60%)",
          }}
        />
        <div className="pulse-ring absolute inset-0 rounded-full border border-white/10" />
      </div>
    </div>
  );
}
