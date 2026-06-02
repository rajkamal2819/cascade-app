"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { GitBranch, Maximize2, Minus, Network, Pause, Play, Plus, Radio, RotateCcw } from "lucide-react";
import { useStore } from "@/lib/store";
import type { CascadeNode, CascadeEdge, CascadeResponse } from "@/lib/api";

// ============================================================================
// Colour + polarity model
// ============================================================================

const REL_COLOR: Record<string, string> = {
  supplier: "#4ade80",
  customer: "#60a5fa",
  peer: "#c084fc",
  sector: "#fbbf24",
  derivative: "#f472b6",
  semantic: "#94a3b8",
  root: "#ff4d6d",
};

// Polarity: how a *negative shock* on the root propagates.
//   "damage"   → red, shock hurts this node (supplier loses orders, sector cohort sells off)
//   "exposed"  → amber, mixed exposure (customer, peer)
//   "benefit"  → green, substitute / derivative play that *wins* from the shock
//   "related"  → grey, semantic only — direction unknown
const POLARITY: Record<string, "damage" | "exposed" | "benefit" | "related"> = {
  supplier: "damage",
  sector: "damage",
  customer: "exposed",
  peer: "exposed",
  derivative: "benefit",
  semantic: "related",
};

const POLARITY_COLOR: Record<"damage" | "exposed" | "benefit" | "related" | "root", string> = {
  damage: "#ff4d6d",
  exposed: "#fbbf24",
  benefit: "#4ade80",
  related: "#94a3b8",
  root: "#ff4d6d",
};

// ============================================================================
// Geometry
// ============================================================================

const RING_R: Record<number, number> = { 0: 0, 1: 150, 2: 265, 3: 345 };
const ROOT_R = 22;
const NODE_R = 12;

interface Vec { x: number; y: number }

interface PlacedNode extends Vec {
  ticker: string;
  company: string;
  color: string;
  polarity: "damage" | "exposed" | "benefit" | "related" | "root";
  level: string;
  hop: number;
  score: number;
  weight: number;
  relType: string;
  isRoot: boolean;
  isBottleneck: boolean;
  eventId?: string;  // drill-in target (latest event for this ticker)
}

interface PlacedEdge {
  from: Vec;
  to: Vec;
  cx: number;
  cy: number;
  color: string;
  pathId: string;
  weight: number;     // 0..1 — drives stroke width in Sankey
  fromHop: number;
  toHop: number;
}

type Layout = "radial" | "sankey";

// ============================================================================
// Layout builders
// ============================================================================

// Extract the real company name from the node — company field is often the
// ticker itself for semantic fallback nodes; the real name hides in "why".
function resolveCompany(ticker: string, company: string | null | undefined, why: string | null | undefined): string {
  const c = (company ?? "").trim();
  if (c && c.toUpperCase() !== ticker.toUpperCase() && c.length > 2 && !/^\$?[A-Z]{1,6}$/.test(c)) {
    return c;
  }
  const w = (why ?? "").trim();
  // "8-K - Company Name (0001234567) (Filer)"
  let m = w.match(/^8-K\s*[-·]\s*(.+?)\s*\(\d{10}\)/i);
  if (m) return m[1].trim();
  // "Company Name (CIK) (Filer)"
  m = w.match(/^(.+?)\s*\(\d{10}\)/);
  if (m && m[1].trim().toUpperCase() !== ticker.toUpperCase()) return m[1].trim();
  // "Company Name · Item X.XX: Description"
  m = w.match(/^(.+?)\s*[·\-]\s*Item\s+\d/i);
  if (m && m[1].trim().toUpperCase() !== ticker.toUpperCase()) return m[1].trim();
  return c || ticker;
}

function detectBottleneck(cascade: CascadeResponse): string | null {
  // The L1 ticker that the most L2+ nodes route through.
  const inDegree = new Map<string, number>();
  for (const e of cascade.edges) {
    if (e.hop >= 2) inDegree.set(e.from, (inDegree.get(e.from) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const [k, v] of inDegree) {
    if (!best || v > best[1]) best = [k, v];
  }
  // Only call it a bottleneck if it dominates (>= 40% of L2 routing)
  const totalL2 = cascade.edges.filter((e) => e.hop >= 2).length || 1;
  if (best && best[1] / totalL2 >= 0.4 && best[1] >= 2) return best[0];
  return null;
}

function classifyNode(relType: string, isRoot: boolean): PlacedNode["polarity"] {
  if (isRoot) return "root";
  return POLARITY[relType] ?? "related";
}

function buildRadial(cascade: CascadeResponse, W: number, H: number, bottleneck: string | null) {
  const ox = W / 2;
  const oy = H / 2;
  const nodes: PlacedNode[] = [];
  const edges: PlacedEdge[] = [];

  nodes.push({
    ticker: cascade.root.tickers[0] ?? "—",
    company: (cascade.root.headline ?? "").slice(0, 30),
    x: ox, y: oy,
    color: "#ff4d6d",
    polarity: "root",
    level: "ROOT", hop: 0, score: 1, weight: 1, relType: "root",
    isRoot: true, isBottleneck: false,
  });

  const byHop = new Map<number, CascadeNode[]>();
  for (const n of cascade.nodes) {
    const h = Math.max(1, n.hop ?? 1);
    if (!byHop.has(h)) byHop.set(h, []);
    byHop.get(h)!.push(n);
  }

  const posMap = new Map<string, Vec>();
  posMap.set(cascade.root.tickers[0] ?? "ROOT", { x: ox, y: oy });

  for (const [hop, group] of [...byHop.entries()].sort((a, b) => a[0] - b[0])) {
    const r = RING_R[hop] ?? 345;
    const count = group.length;
    const offsetAngle = (hop * Math.PI) / 6 - Math.PI / 2;
    group.forEach((n, i) => {
      const angle = offsetAngle + (2 * Math.PI / count) * i;
      const x = ox + r * Math.cos(angle);
      const y = oy + r * Math.sin(angle);
      const polarity = classifyNode(n.relationship_type, false);
      nodes.push({
        ticker: n.ticker, company: resolveCompany(n.ticker, n.company, n.why).slice(0, 22),
        x, y,
        color: POLARITY_COLOR[polarity],
        polarity,
        level: n.level, hop, score: n.cascade_score,
        weight: n.cascade_score,
        relType: n.relationship_type, isRoot: false,
        isBottleneck: n.ticker === bottleneck,
        eventId: n.event_id || undefined,
      });
      posMap.set(n.ticker, { x, y });
    });
  }

  const seen = new Set<string>();
  const allEdges: CascadeEdge[] = cascade.edges.length > 0
    ? cascade.edges
    : cascade.nodes.map((n: CascadeNode) => ({ from: cascade.root.tickers[0] ?? "", to: n.ticker, type: n.relationship_type, weight: n.cascade_score, hop: 1 }));

  for (const e of allEdges.slice(0, 60)) {
    const key = `${e.from}_${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = posMap.get(e.from) ?? { x: ox, y: oy };
    const t = posMap.get(e.to);
    if (!t) continue;
    const mx = (f.x + t.x) / 2;
    const my = (f.y + t.y) / 2;
    const dx = ox - mx;
    const dy = oy - my;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const cx = mx + (dx / d) * d * 0.25;
    const cy = my + (dy / d) * d * 0.25;
    const polarity = POLARITY[e.type] ?? "related";
    edges.push({
      from: f, to: t, cx, cy,
      color: POLARITY_COLOR[polarity],
      pathId: key.replace(/[^a-zA-Z0-9]/g, "_"),
      weight: e.weight,
      fromHop: 0, toHop: e.hop,
    });
  }

  return { nodes, edges };
}

function buildSankey(cascade: CascadeResponse, W: number, H: number, bottleneck: string | null) {
  // Three columns: Root | L1 | L2 (L3 folded into L2 column for readability)
  const colX = [W * 0.12, W * 0.5, W * 0.85];
  const nodes: PlacedNode[] = [];
  const edges: PlacedEdge[] = [];

  // Root
  nodes.push({
    ticker: cascade.root.tickers[0] ?? "—",
    company: (cascade.root.headline ?? "").slice(0, 26),
    x: colX[0], y: H / 2,
    color: "#ff4d6d",
    polarity: "root",
    level: "ROOT", hop: 0, score: 1, weight: 1, relType: "root",
    isRoot: true, isBottleneck: false,
  });

  // Partition by column
  const l1: CascadeNode[] = [];
  const l2: CascadeNode[] = [];
  for (const n of cascade.nodes) {
    const h = Math.max(1, n.hop ?? 1);
    if (h === 1) l1.push(n);
    else l2.push(n);
  }
  // Sort within column by score desc (heaviest at top, eye reads down)
  l1.sort((a, b) => b.cascade_score - a.cascade_score);
  l2.sort((a, b) => b.cascade_score - a.cascade_score);

  const posMap = new Map<string, Vec>();
  posMap.set(cascade.root.tickers[0] ?? "ROOT", { x: colX[0], y: H / 2 });

  const placeColumn = (group: CascadeNode[], xc: number, hop: number) => {
    if (group.length === 0) return;
    const padding = 40;
    const usable = H - padding * 2;
    const step = group.length === 1 ? 0 : usable / (group.length - 1);
    group.forEach((n, i) => {
      const y = padding + (group.length === 1 ? usable / 2 : step * i);
      const polarity = classifyNode(n.relationship_type, false);
      nodes.push({
        ticker: n.ticker, company: resolveCompany(n.ticker, n.company, n.why).slice(0, 22),
        x: xc, y,
        color: POLARITY_COLOR[polarity],
        polarity,
        level: n.level, hop, score: n.cascade_score,
        weight: n.cascade_score,
        relType: n.relationship_type, isRoot: false,
        isBottleneck: n.ticker === bottleneck,
        eventId: n.event_id || undefined,
      });
      posMap.set(n.ticker, { x: xc, y });
    });
  };

  placeColumn(l1, colX[1], 1);
  placeColumn(l2, colX[2], 2);

  // Edges — cubic bezier with horizontal tangents (Sankey style)
  const seen = new Set<string>();
  const allEdges: CascadeEdge[] = cascade.edges.length > 0
    ? cascade.edges
    : cascade.nodes.map((n: CascadeNode) => ({ from: cascade.root.tickers[0] ?? "", to: n.ticker, type: n.relationship_type, weight: n.cascade_score, hop: 1 }));

  for (const e of allEdges.slice(0, 80)) {
    const key = `${e.from}_${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = posMap.get(e.from);
    const t = posMap.get(e.to);
    if (!f || !t) continue;
    const polarity = POLARITY[e.type] ?? "related";
    // For Sankey: cubic bezier with horizontal control points
    const cxMid = (f.x + t.x) / 2;
    edges.push({
      from: f, to: t,
      cx: cxMid, cy: (f.y + t.y) / 2,
      color: POLARITY_COLOR[polarity],
      pathId: `s_${key.replace(/[^a-zA-Z0-9]/g, "_")}`,
      weight: e.weight,
      fromHop: e.hop - 1, toHop: e.hop,
    });
  }

  return { nodes, edges };
}

// ============================================================================
// Verdict — single-sentence summary of the cascade
// ============================================================================

function computeVerdict(cascade: CascadeResponse, bottleneck: string | null): {
  riskScore: number;
  text: string;
  tone: "damage" | "exposed" | "benefit" | "related";
} {
  const isFallback = cascade.fallback === "related_events" || cascade.fallback === "semantic_no_tickers";
  // Risk score: weighted sum of node scores with hop decay
  let total = 0;
  for (const n of cascade.nodes) {
    total += (n.cascade_score ?? 0) * Math.pow(0.7, Math.max(0, (n.hop ?? 1) - 1));
  }
  const riskScore = Math.min(100, Math.round(total * 12));

  if (isFallback) {
    return {
      riskScore: 0,
      tone: "related",
      text: `${cascade.nodes.length} semantically related events. No direct supply-chain links — root ticker is outside the seed graph.`,
    };
  }

  // Polarity breakdown
  const buckets: Record<string, number> = { damage: 0, exposed: 0, benefit: 0, related: 0 };
  for (const n of cascade.nodes) {
    const p = POLARITY[n.relationship_type] ?? "related";
    buckets[p] += 1;
  }
  const dominant = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0][0] as "damage" | "exposed" | "benefit" | "related";
  const total_nodes = cascade.nodes.length;
  const dominantPct = Math.round((buckets[dominant] / total_nodes) * 100);

  let text: string;
  if (bottleneck) {
    text = `${dominantPct}% of cascade exposure routes through ${bottleneck} — single-point-of-failure detected.`;
  } else if (dominant === "damage") {
    text = `Negative cascade: ${buckets.damage} downstream tickers absorb the shock (suppliers + sector cohort).`;
  } else if (dominant === "benefit") {
    text = `Mixed cascade with ${buckets.benefit} substitutes positioned to benefit.`;
  } else {
    text = `${total_nodes}-node cascade across ${Object.values(buckets).filter((v) => v > 0).length} relationship types.`;
  }

  return { riskScore, text, tone: dominant };
}

// ============================================================================
// Flow particle (radial only — bezier path travel)
// ============================================================================

function FlowParticle({ edge, delay }: { edge: PlacedEdge; delay: number }) {
  const ref = useRef<SVGCircleElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const path = document.getElementById(`path_${edge.pathId}`) as SVGPathElement | null;
    if (!path) return;
    const len = path.getTotalLength();
    let frame = 0;
    let start = 0;
    const duration = 3600 + delay * 220;
    const animate = (ts: number) => {
      if (!start) start = ts + delay * 180;
      const t = ((ts - start) % duration) / duration;
      if (t >= 0 && t <= 1) {
        try {
          const pt = path.getPointAtLength(t * len);
          el.setAttribute("cx", String(pt.x));
          el.setAttribute("cy", String(pt.y));
          el.style.opacity = String(Math.sin(t * Math.PI) * 0.9);
        } catch {}
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [edge, delay]);

  return (
    <circle
      ref={ref}
      r={2.5}
      fill={edge.color}
      style={{ filter: `drop-shadow(0 0 4px ${edge.color})`, opacity: 0 }}
    />
  );
}

// ============================================================================
// Main component
// ============================================================================

interface CascadeGraphProps {
  /** Optional override — when provided, the graph renders this cascade
   * instead of pulling from the global store (used by compare mode). */
  cascade?: CascadeResponse | null;
  /** Hide the layout switcher + replay scrubber for compact (compare) view. */
  compact?: boolean;
  /** Highlight tickers shared with another cascade (compare mode). */
  sharedTickers?: Set<string>;
}

export function CascadeGraph({ cascade: cascadeProp, compact = false, sharedTickers }: CascadeGraphProps = {}) {
  const storeCascade = useStore((s) => s.cascade);
  const cascade = cascadeProp !== undefined ? cascadeProp : storeCascade;
  const loading = useStore((s) => s.cascadeLoading);
  const selectedId = useStore((s) => s.selectedEventId);
  const drillIntoEvent = useStore((s) => s.drillIntoEvent);
  const setReasoningNode = useStore((s) => s.setReasoningNode);

  // Click handler: open the reasoning popover for the clicked node. The
  // popover itself offers a "drill into this event" button, so we no longer
  // jump straight to drill on click — judges get the WHY first.
  const openReasoning = (n: PlacedNode) => {
    if (n.isRoot) return; // root has no parent edge to explain
    // Look up the matching CascadeNode for `why` and `cascade_score`.
    const orig = cascade?.nodes?.find((cn) => cn.ticker === n.ticker);
    setReasoningNode({
      ticker: n.ticker,
      company: n.company,
      sector: undefined,
      hop: n.hop,
      relationship_type: n.relType,
      cascade_score: orig?.cascade_score ?? n.score,
      why: orig?.why ?? "",
      event_id: n.eventId,
      polarity: n.polarity === "related" ? "semantic"
              : n.polarity === "root"    ? "damage"
              : (n.polarity as "damage" | "exposed" | "benefit"),
    });
  };
  const breadcrumb = useStore((s) => s.breadcrumb);
  const popBreadcrumb = useStore((s) => s.popBreadcrumb);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 760, h: 560 });
  const [layout, setLayout] = useState<Layout>("radial");
  const [replayT, setReplayT] = useState(1);   // 0..1 — fraction of cascade revealed
  const [playing, setPlaying] = useState(false);

  // ── Zoom + pan state ───────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const clampZoom = (z: number) => Math.max(0.5, Math.min(3, z));

  const handleWheel = useCallback((ev: React.WheelEvent) => {
    ev.preventDefault();
    setZoom((z) => clampZoom(z + (ev.deltaY < 0 ? 0.08 : -0.08)));
  }, []);

  const handlePointerDown = useCallback((ev: React.PointerEvent) => {
    // Only left-button drag and not on a clickable element
    if (ev.button !== 0) return;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    dragRef.current = { x: ev.clientX, y: ev.clientY, px: pan.x, py: pan.y };
  }, [pan]);

  const handlePointerMove = useCallback((ev: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = ev.clientX - dragRef.current.x;
    const dy = ev.clientY - dragRef.current.y;
    setPan({ x: dragRef.current.px + dx, y: dragRef.current.py + dy });
  }, []);

  const handlePointerUp = useCallback((ev: React.PointerEvent) => {
    (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
    dragRef.current = null;
  }, []);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Reset view when cascade changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [cascade]);

  // Measure container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(400, r.width), h: Math.max(320, r.height - 80) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Replay animation
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let start = 0;
    const dur = 3000;
    const tick = (ts: number) => {
      if (!start) start = ts;
      const t = Math.min(1, (ts - start) / dur);
      setReplayT(t);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    setReplayT(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Reset replay when cascade changes
  useEffect(() => {
    setReplayT(1);
    setPlaying(false);
  }, [cascade]);

  const bottleneck = useMemo(() => (cascade ? detectBottleneck(cascade) : null), [cascade]);

  const { nodes, edges } = useMemo(() => {
    if (!cascade) return { nodes: [], edges: [] };
    return layout === "sankey"
      ? buildSankey(cascade, size.w, size.h, bottleneck)
      : buildRadial(cascade, size.w, size.h, bottleneck);
  }, [cascade, layout, size, bottleneck]);

  const verdict = useMemo(() => (cascade ? computeVerdict(cascade, bottleneck) : null), [cascade, bottleneck]);

  // Max hop for replay scaling
  const maxHop = useMemo(() => nodes.reduce((m, n) => Math.max(m, n.hop), 0), [nodes]);

  // Replay filter — show nodes whose hop is fully "revealed"
  const hopThreshold = replayT * (maxHop + 0.5);
  const visibleNode = (n: PlacedNode) => n.hop <= hopThreshold;
  const visibleEdge = (e: PlacedEdge) => e.toHop <= hopThreshold;

  // Empty / loading state only when *driven by the store*. In compare mode
  // (cascadeProp passed) the parent decides what to show.
  const usingProp = cascadeProp !== undefined;
  if (!usingProp && !selectedId) {
    return (
      <div className="flex h-full items-center justify-center text-center">
        <div className="space-y-2 px-8">
          <div className="mono text-[10px] uppercase tracking-[0.3em] text-muted">Cascade graph</div>
          <div className="text-[12px] text-muted/60 leading-relaxed">
            Select an event from the feed<br />to render its supply-chain graph
          </div>
        </div>
      </div>
    );
  }

  if (!usingProp && loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <div className="h-8 w-8 rounded-full border border-accent/30 border-t-accent animate-spin" />
        <div className="mono text-[11px] uppercase tracking-wider text-accent/70">walking graph…</div>
      </div>
    );
  }

  if (!cascade) {
    return usingProp ? (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 rounded-full border border-accent/30 border-t-accent animate-spin" />
      </div>
    ) : null;
  }

  const isSemantic = cascade.fallback === "related_events" || cascade.fallback === "semantic_no_tickers";

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <style>{`
        @keyframes flow {
          from { stroke-dashoffset: 300; }
          to   { stroke-dashoffset: 0; }
        }
        .flow-edge { animation: flow 4s linear infinite; }
        .graph-zoom-wrap { transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1); }
        .graph-zoom-wrap.dragging { transition: none; }
      `}</style>

      {/* ── Top bar: verdict + controls ─────────────────────────────── */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 px-4 pt-3">
        {/* Verdict pill */}
        {verdict && (
          <motion.div
            key={verdict.text}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="glass-strong flex max-w-md items-start gap-3 rounded-xl px-3 py-2"
          >
            {/* Risk meter */}
            {!isSemantic && (
              <div className="flex shrink-0 flex-col items-center gap-0.5 border-r border-white/10 pr-3">
                <div className="mono text-[8px] uppercase tracking-widest text-muted">risk</div>
                <div className="mono text-[18px] font-bold tabular-nums" style={{ color: POLARITY_COLOR[verdict.tone] }}>
                  {verdict.riskScore}
                </div>
              </div>
            )}
            <div className="min-w-0">
              <div className="mono text-[9px] uppercase tracking-widest" style={{ color: POLARITY_COLOR[verdict.tone] }}>
                {isSemantic ? "semantic match" : verdict.tone === "damage" ? "negative cascade" : verdict.tone === "benefit" ? "asymmetric cascade" : "mixed cascade"}
              </div>
              <div className="mt-0.5 text-[11px] leading-snug text-text/90">{verdict.text}</div>
            </div>
          </motion.div>
        )}

        <div className="flex flex-col items-end gap-1.5">
          {/* Layout switcher */}
          <div className="glass flex items-center gap-0.5 rounded-full p-0.5">
            <button
              onClick={() => setLayout("radial")}
              title="Radial layout (coverage)"
              className={
                "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] uppercase tracking-wider transition " +
                (layout === "radial" ? "bg-accent/20 text-accent" : "text-muted hover:text-text")
              }
            >
              <Network size={10} />
              <span className="hidden lg:inline">Radial</span>
            </button>
            <button
              onClick={() => setLayout("sankey")}
              title="Sankey layout (flow)"
              className={
                "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] uppercase tracking-wider transition " +
                (layout === "sankey" ? "bg-accent/20 text-accent" : "text-muted hover:text-text")
              }
            >
              <GitBranch size={10} />
              <span className="hidden lg:inline">Sankey</span>
            </button>
          </div>
          {/* Zoom controls */}
          <div className="glass flex items-center gap-0.5 rounded-full p-0.5">
            <button
              onClick={() => setZoom((z) => clampZoom(z - 0.15))}
              title="Zoom out"
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-text transition"
            >
              <Minus size={11} />
            </button>
            <div className="mono w-9 text-center text-[9px] tabular-nums text-muted">
              {Math.round(zoom * 100)}%
            </div>
            <button
              onClick={() => setZoom((z) => clampZoom(z + 0.15))}
              title="Zoom in"
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-text transition"
            >
              <Plus size={11} />
            </button>
            <button
              onClick={resetView}
              title="Reset view"
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-text transition"
            >
              <Maximize2 size={10} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Drill-in breadcrumb (only when not compact & user has drilled) ── */}
      {!compact && breadcrumb.length > 0 && (
        <div className="pointer-events-auto absolute left-4 top-16 z-10 flex items-center gap-1 rounded-full glass px-2 py-1 text-[10px]">
          <button
            onClick={popBreadcrumb}
            title="Back to previous cascade"
            className="mono inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-muted hover:bg-white/10 hover:text-text transition"
          >
            ← back
          </button>
          {breadcrumb.map((b) => (
            <span key={b.id} className="mono px-1 text-muted/70">
              {b.label} <span className="text-muted/40">›</span>
            </span>
          ))}
          <span className="mono px-1 font-semibold tracking-wider text-accent">now</span>
        </div>
      )}

      {/* ── SVG canvas ──────────────────────────────────────────────── */}
      <svg
        viewBox={`0 0 ${size.w} ${size.h}`}
        width={size.w}
        height={size.h}
        className="absolute inset-0 mt-12"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ cursor: dragRef.current ? "grabbing" : "grab", touchAction: "none" }}
      >
        <defs>
          <radialGradient id="rootHalo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ff4d6d" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#ff4d6d" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Transformable group — pan & zoom applied here so all children move
            together. Centre-anchored so zoom scales around the viewport centre. */}
        <g
          className={"graph-zoom-wrap " + (dragRef.current ? "dragging" : "")}
          transform={`translate(${size.w / 2 + pan.x} ${size.h / 2 + pan.y}) scale(${zoom}) translate(${-size.w / 2} ${-size.h / 2})`}
        >

        {/* Orbit rings (radial only) */}
        {layout === "radial" && [1, 2, 3].map((h) => (
          <motion.circle
            key={`ring-${h}`}
            cx={size.w / 2} cy={size.h / 2}
            r={RING_R[h]}
            fill="none"
            stroke="rgba(255,255,255,0.05)"
            strokeWidth={1}
            strokeDasharray="3 8"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.6, delay: h * 0.12, ease: "easeOut" }}
            style={{ transformOrigin: `${size.w / 2}px ${size.h / 2}px` }}
          />
        ))}

        {/* Sankey column guides */}
        {layout === "sankey" && [0.12, 0.5, 0.85].map((p, i) => (
          <motion.line
            key={`col-${i}`}
            x1={size.w * p} y1={20} x2={size.w * p} y2={size.h - 20}
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={1}
            strokeDasharray="2 6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: i * 0.1 }}
          />
        ))}

        {/* Edges */}
        {edges.filter(visibleEdge).map((e, i) => {
          // Sankey edge stroke width proportional to weight; radial uses thin lines + particle
          const sw = layout === "sankey" ? 1.5 + e.weight * 7 : 1.4;
          const opacity = layout === "sankey" ? 0.35 + e.weight * 0.35 : 0.6;
          const path = layout === "sankey"
            ? `M ${e.from.x} ${e.from.y} C ${(e.from.x + e.to.x) / 2} ${e.from.y}, ${(e.from.x + e.to.x) / 2} ${e.to.y}, ${e.to.x} ${e.to.y}`
            : `M ${e.from.x} ${e.from.y} Q ${e.cx} ${e.cy} ${e.to.x} ${e.to.y}`;
          return (
            <g key={e.pathId}>
              {/* Base dim path */}
              <path
                id={`path_${e.pathId}`}
                d={path}
                fill="none"
                stroke={e.color}
                strokeWidth={sw}
                strokeOpacity={opacity * 0.4}
              />
              {/* Animated flow */}
              <motion.path
                d={path}
                fill="none"
                stroke={e.color}
                strokeWidth={sw}
                strokeOpacity={opacity}
                strokeLinecap="round"
                strokeDasharray={layout === "sankey" ? "0" : "18 40"}
                className={layout === "radial" ? "flow-edge" : ""}
                style={{
                  animationDelay: `${i * 0.08}s`,
                  filter: `drop-shadow(0 0 ${layout === "sankey" ? 6 : 3}px ${e.color}88)`,
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.25 + i * 0.04, duration: 0.5 }}
              />
              {/* Radial particle */}
              {layout === "radial" && <FlowParticle edge={e} delay={i} />}
            </g>
          );
        })}

        {/* Root halo */}
        {nodes[0] && visibleNode(nodes[0]) && (
          <motion.circle
            cx={nodes[0].x} cy={nodes[0].y} r={60}
            fill="url(#rootHalo)"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            style={{ transformOrigin: `${nodes[0].x}px ${nodes[0].y}px` }}
          />
        )}

        {/* Nodes */}
        {nodes.filter(visibleNode).map((n, i) => {
          const isShared = sharedTickers?.has(n.ticker) ?? false;
          const isDrillable = !n.isRoot && !!n.eventId;
          return (
          <motion.g
            key={n.ticker + i}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 110, damping: 24, mass: 1.1, delay: n.isRoot ? 0 : 0.25 + i * 0.06 }}
            style={{ transformOrigin: `${n.x}px ${n.y}px`, cursor: n.isRoot ? "default" : "pointer" }}
            onPointerDown={!n.isRoot ? (ev) => ev.stopPropagation() : undefined}
            onClick={!n.isRoot ? () => openReasoning(n) : undefined}
          >
            {/* Root pulse rings */}
            {n.isRoot && (
              <>
                <motion.circle cx={n.x} cy={n.y} r={ROOT_R + 10}
                  fill="none" stroke="#ff4d6d" strokeWidth={1} strokeOpacity={0.3}
                  animate={{ r: [ROOT_R + 8, ROOT_R + 18, ROOT_R + 8], opacity: [0.4, 0, 0.4] }}
                  transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                />
                <motion.circle cx={n.x} cy={n.y} r={ROOT_R + 4}
                  fill="none" stroke="#ff4d6d" strokeWidth={1} strokeOpacity={0.5}
                  animate={{ r: [ROOT_R + 2, ROOT_R + 12, ROOT_R + 2], opacity: [0.6, 0, 0.6] }}
                  transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut", delay: 0.8 }}
                />
              </>
            )}

            {/* Bottleneck halo — pulsing red ring */}
            {n.isBottleneck && !n.isRoot && (
              <motion.circle
                cx={n.x} cy={n.y} r={NODE_R + 12}
                fill="none"
                stroke="#ff4d6d"
                strokeWidth={1.5}
                strokeDasharray="3 4"
                animate={{ rotate: 360 }}
                transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
                style={{ transformOrigin: `${n.x}px ${n.y}px`, filter: "drop-shadow(0 0 8px #ff4d6d)" }}
              />
            )}

            {/* Score arc */}
            {!n.isRoot && n.score > 0.1 && (
              <circle
                cx={n.x} cy={n.y} r={NODE_R + 5}
                fill="none"
                stroke={n.color}
                strokeWidth={2}
                strokeOpacity={0.3}
                strokeDasharray={`${n.score * (2 * Math.PI * (NODE_R + 5))} 9999`}
                transform={`rotate(-90 ${n.x} ${n.y})`}
              />
            )}

            {/* Filled node */}
            <circle
              cx={n.x} cy={n.y}
              r={n.isRoot ? ROOT_R : NODE_R}
              fill={`${n.color}1f`}
              stroke={n.color}
              strokeWidth={n.isRoot ? 2.5 : n.isBottleneck ? 2.5 : 1.5}
              style={{ filter: `drop-shadow(0 0 ${n.isRoot ? 12 : n.isBottleneck ? 10 : 6}px ${n.color}88)` }}
            />

            {/* Ticker pill inside node (small, mono) */}
            <text
              x={n.x} y={n.isRoot ? n.y + 4 : n.y + 3}
              textAnchor="middle"
              fill={n.color}
              fontSize={n.isRoot ? 9 : 7}
              fontFamily="ui-monospace, monospace"
              fontWeight={700}
              style={{ userSelect: "none", paintOrder: "stroke", stroke: "rgba(4,6,10,0.85)", strokeWidth: 3, letterSpacing: "0.05em" }}
            >
              {n.ticker.slice(0, 5)}
            </text>

            {/* Company name below — PRIMARY readable label */}
            <text
              x={n.x}
              y={n.y + (n.isRoot ? ROOT_R + 16 : NODE_R + 14)}
              textAnchor="middle"
              fill={n.isRoot ? "#fff" : "rgba(230,237,243,0.92)"}
              fontSize={n.isRoot ? 11 : 9.5}
              fontFamily="ui-sans-serif, system-ui, sans-serif"
              fontWeight={n.isRoot ? 600 : 500}
              style={{ userSelect: "none", paintOrder: "stroke", stroke: "rgba(4,6,10,0.85)", strokeWidth: 3 }}
            >
              {n.company.length > 18 ? n.company.slice(0, 16) + "…" : n.company}
            </text>

            {/* Bottleneck label */}
            {n.isBottleneck && (
              <text
                x={n.x} y={n.y - NODE_R - 10}
                textAnchor="middle"
                fill="#ff4d6d"
                fontSize={7}
                fontFamily="ui-monospace, monospace"
                fontWeight={700}
                style={{ paintOrder: "stroke", stroke: "rgba(4,6,10,0.85)", strokeWidth: 3 }}
              >
                BOTTLENECK
              </text>
            )}

            {/* Compare-mode "shared" ring */}
            {isShared && !n.isRoot && (
              <circle
                cx={n.x} cy={n.y} r={NODE_R + 8}
                fill="none"
                stroke="#fbbf24"
                strokeWidth={2}
                strokeOpacity={0.85}
                strokeDasharray="2 3"
                style={{ filter: "drop-shadow(0 0 6px #fbbf24aa)" }}
              />
            )}
          </motion.g>
          );
        })}

        {/* Sankey column labels */}
        {layout === "sankey" && (
          <>
            {[
              { x: size.w * 0.12, label: "ROOT" },
              { x: size.w * 0.5, label: "L1 · DIRECT" },
              { x: size.w * 0.85, label: "L2 · SECOND-ORDER" },
            ].map((c) => (
              <text
                key={c.label}
                x={c.x} y={size.h - 4}
                textAnchor="middle"
                fill="rgba(139,150,168,0.5)"
                fontSize={8}
                fontFamily="ui-monospace, monospace"
                style={{ letterSpacing: "0.2em" }}
              >
                {c.label}
              </text>
            ))}
          </>
        )}
        </g>
      </svg>

      {/* ── Replay scrubber ─────────────────────────────────────────── */}
      <div className="absolute inset-x-0 bottom-0 z-10 px-4 pb-3">
        <div className="glass mx-auto flex max-w-2xl items-center gap-3 rounded-full px-3 py-1.5">
          <button
            onClick={() => {
              if (replayT >= 1) setReplayT(0);
              setPlaying((p) => !p);
            }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent transition hover:bg-accent/25"
            title={playing ? "Pause replay" : "Play cascade replay"}
          >
            {playing ? <Pause size={12} /> : <Play size={12} />}
          </button>
          <button
            onClick={() => { setReplayT(1); setPlaying(false); }}
            className="text-muted hover:text-text transition"
            title="Show full cascade"
          >
            <RotateCcw size={11} />
          </button>
          <div className="mono text-[9px] uppercase tracking-widest text-muted">replay</div>
          <input
            type="range"
            min={0} max={100}
            value={Math.round(replayT * 100)}
            onChange={(e) => { setPlaying(false); setReplayT(Number(e.target.value) / 100); }}
            className="flex-1 accent-[var(--accent)]"
          />
          <div className="mono w-10 text-right text-[9px] tabular-nums text-muted">
            {Math.round(replayT * (maxHop || 1) * 10) / 10}
          </div>
          <div className="mono flex items-center gap-1 text-[9px] uppercase tracking-widest text-muted">
            <Radio size={10} className="text-accent" />
            <span>{isSemantic ? "$vectorSearch" : `${cascade.nodes.length} nodes`}</span>
          </div>
        </div>
      </div>

      {/* ── Polarity legend ─────────────────────────────────────────── */}
      <div className="absolute right-3 bottom-14 flex flex-col gap-1 text-[8.5px] font-mono uppercase tracking-widest">
        {(["damage", "exposed", "benefit", "related"] as const)
          .filter((p) => nodes.some((n) => n.polarity === p))
          .map((p) => (
            <span key={p} className="flex items-center gap-1.5" style={{ color: POLARITY_COLOR[p] }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: POLARITY_COLOR[p] }} />
              {p}
            </span>
          ))}
      </div>
    </div>
  );
}
