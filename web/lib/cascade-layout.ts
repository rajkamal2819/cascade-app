// Pure layout helpers for 3D cascade rendering.
//
// We do NOT let the force simulation place nodes freely. The hop level is
// the visual spine of the cascade story, so we lock each node to a concentric
// shell at radius R*hop, with angular position grouped by relationship_type
// so customers / suppliers / peers / derivatives separate into sectors.

import type { CascadeEdge, CascadeNode, CascadeResponse } from "./api";

export type Polarity = "damage" | "exposed" | "benefit" | "semantic";

export type Graph3DNode = {
  id: string;
  ticker: string;
  company: string;
  sector: string;
  hop: number;
  polarity: Polarity;
  cascade_score: number;
  relationship_type: string;
  why: string;
  event_id?: string;
  // Pinned coordinates — force-graph honors fx/fy/fz to disable physics on an
  // axis. We pin all three so layout is deterministic and judge-readable.
  fx: number;
  fy: number;
  fz: number;
};

export type Graph3DLink = {
  source: string;
  target: string;
  hop: number;
  weight: number;
  type: string;
};

export type Graph3DData = {
  nodes: Graph3DNode[];
  links: Graph3DLink[];
  maxHop: number;
};

const ROOT_ID = "__root__";

// Polarity → quadrant centroid (in radians). Within each hop shell we still
// spread nodes around the full 360° so they don't bunch, but we anchor each
// polarity to a quadrant so the colours read as distinct regions.
const POLARITY_ANCHOR: Record<Polarity, number> = {
  damage:   -Math.PI / 2,   // top
  exposed:   Math.PI / 2,   // bottom
  benefit:   0,             // right
  semantic:  Math.PI,       // left
};

export function polarityFor(node: CascadeNode): Polarity {
  const t = (node.relationship_type ?? "").toLowerCase();
  if (t.includes("supplier") || t.includes("upstream")) return "exposed";
  if (t.includes("customer") || t.includes("downstream")) return "damage";
  if (t.includes("derivative") || t.includes("inverse") || t.includes("short") || t.includes("benefit")) return "benefit";
  return "semantic";
}

// Distance between hop shells. Each hop step also separates on z so the
// layered planes read at an angle. The shell is tilted on the Y axis so
// nodes form a dome instead of a flat ring — flat rings look like a
// straight line whenever the camera catches them edge-on.
export const HOP_RADIUS = 120;
export const HOP_Z_STEP = 48;
export const HOP_Y_TILT = 0.42;       // fraction of radius pushed up on Y
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~137.5° — irrational

// Deterministically lay each node out in its hop shell, distributed within its
// relationship sector. Same input → same layout, so judges replaying a scenario
// see the cascade in the same spatial arrangement every time.
export function layout3D(cascade: CascadeResponse | null | undefined): Graph3DData {
  if (!cascade || !cascade.root) return { nodes: [], links: [], maxHop: 0 };

  const rootTicker = cascade.root.tickers?.[0] ?? "ROOT";

  // Root sits at the origin.
  const root: Graph3DNode = {
    id: ROOT_ID,
    ticker: rootTicker,
    company: cascade.root.headline ?? rootTicker,
    sector: cascade.root.sector ?? "—",
    hop: 0,
    polarity: "damage",
    cascade_score: 1,
    relationship_type: "root",
    why: cascade.root.headline ?? "",
    fx: 0,
    fy: 0,
    fz: 0,
  };

  // Group nodes by hop only — within a hop we spread around the full 360°
  // shell, but bias each polarity towards its anchor quadrant so colors
  // cluster regionally while still occupying the whole ring.
  const byHop = new Map<number, CascadeNode[]>();
  for (const n of cascade.nodes ?? []) {
    const hop = Math.max(1, n.hop ?? 1);
    if (!byHop.has(hop)) byHop.set(hop, []);
    byHop.get(hop)!.push(n);
  }

  const nodes: Graph3DNode[] = [root];
  let maxHop = 0;

  for (const [hop, groupRaw] of byHop.entries()) {
    maxHop = Math.max(maxHop, hop);
    const group = [...groupRaw];

    // Sort nodes by polarity so same-coloured nodes land adjacent on the
    // ring, then by cascade_score desc within polarity. Result: each
    // quadrant is a visually contiguous arc of one colour.
    group.sort((a, b) => {
      const pa = POLARITY_ANCHOR[polarityFor(a)];
      const pb = POLARITY_ANCHOR[polarityFor(b)];
      if (pa !== pb) return pa - pb;
      return (b.cascade_score ?? 0) - (a.cascade_score ?? 0);
    });

    const r = HOP_RADIUS * hop;
    const z = (hop - 1) * HOP_Z_STEP;
    const n = group.length;

    group.forEach((node, i) => {
      // Golden-angle around the ring — irrational ratio so adjacent
      // indices never line up along an axis. This breaks the "edge-on
      // ring looks like a line" failure mode.
      const polarityAnchor = POLARITY_ANCHOR[polarityFor(node)];
      const angle = polarityAnchor + i * GOLDEN_ANGLE;
      const score = node.cascade_score ?? 0.4;
      const radiusOffset = -score * 14;
      const rEffective = r + radiusOffset;

      // Y tilt: lift the back half of the shell into a dome so the
      // structure reads as 3D from any camera angle. Adding a small
      // per-node phase keeps nodes from sharing the exact same y.
      const tilt = HOP_Y_TILT * r;
      const phase = (i / Math.max(1, n)) * Math.PI * 2;

      nodes.push({
        id: node.ticker,
        ticker: node.ticker,
        company: node.company,
        sector: node.sector,
        hop,
        polarity: polarityFor(node),
        cascade_score: score,
        relationship_type: node.relationship_type ?? "semantic",
        why: node.why ?? "",
        event_id: node.event_id,
        fx: Math.cos(angle) * rEffective,
        fy: Math.sin(angle) * rEffective * 0.55 + Math.sin(phase) * tilt * 0.35,
        fz: z + Math.cos(phase) * tilt * 0.45 + ((i % 3) - 1) * 8,
      });
    });
  }

  // Edges: map cascade edges; default to root → node if edges array is empty.
  const links: Graph3DLink[] = [];
  const knownIds = new Set(nodes.map((n) => n.id));
  if (cascade.edges && cascade.edges.length) {
    for (const e of cascade.edges) {
      const from = e.from === rootTicker ? ROOT_ID : e.from;
      const to = e.to === rootTicker ? ROOT_ID : e.to;
      if (!knownIds.has(from) || !knownIds.has(to)) continue;
      links.push({
        source: from,
        target: to,
        hop: e.hop ?? 1,
        weight: e.weight ?? 0.5,
        type: e.type ?? "semantic",
      });
    }
  } else {
    // Synthesize root → node edges so the graph is connected.
    for (const n of nodes) {
      if (n.id === ROOT_ID) continue;
      links.push({
        source: ROOT_ID,
        target: n.id,
        hop: n.hop,
        weight: Math.max(0.2, n.cascade_score ?? 0.5),
        type: n.relationship_type,
      });
    }
  }

  return { nodes, links, maxHop };
}

export const POLARITY_COLOR: Record<Polarity, string> = {
  damage:   "#f87171", // rose-400
  exposed:  "#fbbf24", // amber-400
  benefit:  "#34d399", // emerald-400
  semantic: "#94a3b8", // slate-400
};

export const ROOT_COLOR = "#22d3ee"; // cyan-400

// Shape of the data the NodeReasoning popover needs. Lives here (not in the
// component) so the Zustand store can hold it without creating a circular
// component <-> store import.
export type NodeReasoningInfo = {
  ticker: string;
  company: string;
  sector?: string;
  hop: number;
  relationship_type: string;
  cascade_score: number;
  why: string;
  event_id?: string;
  polarity?: Polarity;
};
