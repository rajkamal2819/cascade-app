"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import * as THREE from "three";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "@/lib/store";
import {
  layout3D,
  POLARITY_COLOR,
  ROOT_COLOR,
  HOP_RADIUS,
  HOP_Z_STEP,
  type Graph3DLink,
  type Graph3DNode,
} from "@/lib/cascade-layout";
import { HopStepper } from "./HopStepper";
import { toReasoningInfo } from "./NodeReasoning";

// Build a Sprite that renders a ticker label using a canvas-baked texture.
// Sprites always face the camera, which keeps labels readable from every
// angle without rotating manually.
function makeLabelSprite(text: string, color = "#e2e8f0", isRoot = false): THREE.Sprite {
  const w = isRoot ? 256 : 224;
  const h = isRoot ? 112 : 96;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  // Pill background so labels never melt into the scene.
  ctx.fillStyle = "rgba(2,6,12,0.78)";
  const pad = 8;
  const rad = 14;
  ctx.beginPath();
  ctx.moveTo(pad + rad, pad);
  ctx.lineTo(w - pad - rad, pad);
  ctx.quadraticCurveTo(w - pad, pad, w - pad, pad + rad);
  ctx.lineTo(w - pad, h - pad - rad);
  ctx.quadraticCurveTo(w - pad, h - pad, w - pad - rad, h - pad);
  ctx.lineTo(pad + rad, h - pad);
  ctx.quadraticCurveTo(pad, h - pad, pad, h - pad - rad);
  ctx.lineTo(pad, pad + rad);
  ctx.quadraticCurveTo(pad, pad, pad + rad, pad);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = `${isRoot ? 700 : 600} ${isRoot ? 44 : 38}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const scale = isRoot ? 60 : 48;
  sprite.scale.set(scale, scale * (h / w), 1);
  return sprite;
}

// Translucent hop ring guides — placed once per cascade onto the scene so
// users can read each hop as a distinct shell instead of guessing depth.
function buildHopRings(maxHop: number): THREE.Group {
  const group = new THREE.Group();
  group.userData.cascadeHopRings = true;
  for (let hop = 1; hop <= maxHop; hop++) {
    const r = HOP_RADIUS * hop;
    const z = (hop - 1) * HOP_Z_STEP;
    // Dashed ring at the hop's plane — punchier so back hops stay readable.
    const geo = new THREE.RingGeometry(r - 1.6, r + 1.6, 128);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.45 + 0.08 * hop,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.z = z;
    group.add(ring);

    // Hop label sprite on the ring (top edge), so the viewer knows what
    // they're looking at without leaving the canvas.
    const label = makeLabelSprite(`L${hop}`, "rgba(148,163,184,0.85)", false);
    label.position.set(0, r + 14, z + 2);
    label.scale.multiplyScalar(0.7);
    group.add(label);
  }
  return group;
}

// react-force-graph-3d ships a window-only bundle; force lazy ssr:false.
const ForceGraph3D = dynamic(() => import("react-force-graph-3d").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 grid place-items-center text-[11px] uppercase tracking-widest text-muted">
      booting 3d cascade…
    </div>
  ),
});

type HoverState = { node: Graph3DNode; x: number; y: number } | null;

export function CascadeGraph3D() {
  const cascade = useStore((s) => s.cascade);
  const counterfactual = useStore((s) => s.counterfactual);
  const setReasoningNode = useStore((s) => s.setReasoningNode);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Force-graph instance — we use its imperative API for camera moves.
  // The library's TS types aren't exhaustive enough for our use, so we keep
  // this loose and access only documented methods.
  const fgRef = useRef<{
    cameraPosition: (pos: { x: number; y: number; z: number }, lookAt?: { x: number; y: number; z: number }, ms?: number) => void;
    zoomToFit: (ms?: number, padding?: number) => void;
    scene: () => THREE.Scene;
  } | null>(null);

  const data = useMemo(() => layout3D(cascade), [cascade]);

  const [hop, setHop] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [hover, setHover] = useState<HoverState>(null);
  const [dim, setDim] = useState<{ w: number; h: number }>({ w: 800, h: 600 });

  // Observe container size for responsive canvas.
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      setDim({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // When a new cascade lands, reset reveal + autoplay from L0.
  useEffect(() => {
    if (!cascade) return;
    setHop(0);
    setPlaying(true);
    // Reframe camera after first render tick — tilted isometric so the
    // layered hop planes are obvious instead of looking flat.
    const t = setTimeout(() => {
      if (!fgRef.current) return;
      const r = HOP_RADIUS * Math.max(2, data.maxHop);
      // Strong bird's-eye: camera high above and slightly forward so the
      // dome of each hop reads as a separate shell instead of a flat ring.
      fgRef.current.cameraPosition(
        { x: r * 0.35, y: -r * 1.25, z: r * 1.05 },
        { x: 0, y: 0, z: ((data.maxHop - 1) * HOP_Z_STEP) / 2 },
        1200,
      );
    }, 80);
    return () => clearTimeout(t);
  }, [cascade?.root?.id, data.maxHop]);

  // Add translucent hop ring guides to the underlying THREE scene, scoped
  // to the current cascade. Tear them down when the cascade changes.
  useEffect(() => {
    if (!fgRef.current || data.maxHop === 0) return;
    const scene = fgRef.current.scene();
    const rings = buildHopRings(data.maxHop);
    scene.add(rings);
    // Very gentle fog — kicks in only past the last hop so rings stay sharp.
    const prevFog = scene.fog;
    scene.fog = new THREE.Fog(
      0x000000,
      HOP_RADIUS * (data.maxHop + 1) * 1.2,
      HOP_RADIUS * (data.maxHop + 3) * 2.0,
    );
    return () => {
      scene.remove(rings);
      rings.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry?.dispose?.();
        const m = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose?.();
      });
      scene.fog = prevFog;
    };
  }, [data.maxHop, cascade?.root?.id]);

  // Slow auto-orbit for the beauty shot, but cancel it the moment the user
  // interacts (wheel-zoom or drag-rotate). That way the demo gets the
  // rotating camera AND the user retains full control.
  const userInteractedRef = useRef(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const stop = () => { userInteractedRef.current = true; };
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("mousedown", stop);
    el.addEventListener("touchstart", stop, { passive: true });
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("mousedown", stop);
      el.removeEventListener("touchstart", stop);
    };
  }, []);
  // Reset interaction flag when a new cascade lands.
  useEffect(() => { userInteractedRef.current = false; }, [cascade?.root?.id]);

  useEffect(() => {
    if (!fgRef.current) return;
    if (hop < data.maxHop) return;
    let raf = 0;
    let theta = Math.PI * 0.25;
    const tick = () => {
      if (userInteractedRef.current) return; // user took over — leave camera alone
      theta += 0.0005;
      const r = HOP_RADIUS * Math.max(2, data.maxHop) * 1.15;
      if (!fgRef.current) {
        raf = requestAnimationFrame(tick);
        return;
      }
      fgRef.current.cameraPosition(
        {
          x: Math.cos(theta) * r * 0.4,
          y: -r * 1.1,
          z: Math.sin(theta) * r * 0.4 + ((data.maxHop - 1) * HOP_Z_STEP) / 2 + r * 0.6,
        },
        { x: 0, y: 0, z: ((data.maxHop - 1) * HOP_Z_STEP) / 2 },
        0,
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hop, data.maxHop]);

  // Filter nodes/edges by current hop reveal.
  const visible = useMemo(() => {
    const ns = data.nodes.filter((n) => n.hop <= hop);
    const nset = new Set(ns.map((n) => n.id));
    const ls = data.links.filter((l) => {
      const s = typeof l.source === "string" ? l.source : (l.source as { id: string }).id;
      const t = typeof l.target === "string" ? l.target : (l.target as { id: string }).id;
      return nset.has(s) && nset.has(t);
    });
    return { nodes: ns, links: ls };
  }, [data, hop]);

  // Build a Three.js group per node: core sphere + glow halo + ticker label.
  // Group keeps the label and halo positioned relative to the node, so the
  // force-graph engine moves all three together when the node moves.
  const buildNode = useCallback((rawNode: object) => {
    const n = rawNode as Graph3DNode;
    const isRoot = n.id === "__root__";
    const r = isRoot ? 10 : 5 + (n.cascade_score ?? 0) * 5.5;
    const base = isRoot ? ROOT_COLOR : POLARITY_COLOR[n.polarity];
    let opacity = 0.95;
    if (counterfactual && !isRoot) {
      if (n.polarity === "exposed" || n.polarity === "damage") opacity = 0.18;
      if (n.polarity === "benefit") opacity = 0.95;
    }

    const group = new THREE.Group();

    // Core sphere
    const geo = new THREE.SphereGeometry(r, 24, 24);
    const mat = new THREE.MeshBasicMaterial({ color: base, transparent: true, opacity });
    const sphere = new THREE.Mesh(geo, mat);
    group.add(sphere);

    // Glow halo — a slightly larger, transparent, additively-blended sphere.
    const haloGeo = new THREE.SphereGeometry(r * 1.55, 16, 16);
    const haloMat = new THREE.MeshBasicMaterial({
      color: base,
      transparent: true,
      opacity: opacity * 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    group.add(new THREE.Mesh(haloGeo, haloMat));

    // Root gets an orbital ring on top of the halo for instant identification.
    if (isRoot) {
      const ringGeo = new THREE.RingGeometry(r + 3, r + 4.5, 48);
      const ringMat = new THREE.MeshBasicMaterial({
        color: base, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2.6;
      group.add(ring);
    }

    // Ticker label sprite — floats above the node so it's always readable.
    const labelColor = isRoot ? "#67e8f9" : base;
    const label = makeLabelSprite(n.ticker, labelColor, isRoot);
    label.position.set(0, r + (isRoot ? 16 : 12), 0);
    if (counterfactual && !isRoot && (n.polarity === "exposed" || n.polarity === "damage")) {
      (label.material as THREE.SpriteMaterial).opacity = 0.25;
    }
    group.add(label);

    return group;
  }, [counterfactual]);

  // Hover tooltip — coords come from the canvas pointer, not the camera.
  const onNodeHover = useCallback((rawNode: object | null) => {
    if (!rawNode) {
      setHover(null);
      return;
    }
    const n = rawNode as Graph3DNode;
    // We can't easily get screen coords without traversing the camera — pin to
    // the cursor position via a mousemove listener instead.
    setHover({ node: n, x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (!hover) return;
    const el = containerRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      setHover((h) => h && { ...h, x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    el.addEventListener("mousemove", onMove);
    return () => el.removeEventListener("mousemove", onMove);
  }, [hover?.node?.id]);

  const onNodeClick = useCallback((rawNode: object) => {
    const n = rawNode as Graph3DNode;
    // Clicking a node opens the reasoning popover instead of drilling
    // immediately. The popover itself offers a "drill into this event"
    // button — so the click → reason → drill funnel stays one step longer
    // but much more informative.
    setReasoningNode(toReasoningInfo(n));
  }, [setReasoningNode]);

  if (!cascade || data.nodes.length <= 1) {
    return (
      <div className="absolute inset-0 grid place-items-center">
        <div className="glass mono rounded-full px-4 py-2 text-[10px] uppercase tracking-widest text-muted">
          select an event to walk its 3d cascade
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <ForceGraph3D
        ref={fgRef as unknown as never}
        width={dim.w}
        height={dim.h}
        graphData={visible as { nodes: Graph3DNode[]; links: Graph3DLink[] }}
        backgroundColor="rgba(0,0,0,0)"
        showNavInfo={false}
        nodeThreeObject={buildNode}
        nodeLabel={(n: object) => {
          const v = n as Graph3DNode;
          return `${v.ticker} · ${v.company} · L${v.hop}`;
        }}
        onNodeHover={onNodeHover}
        onNodeClick={onNodeClick}
        linkColor={(l: object) => {
          const v = l as Graph3DLink;
          const t = (v.type ?? "").toLowerCase();
          if (t.includes("customer")) return "rgba(248,113,113,0.85)";
          if (t.includes("supplier")) return "rgba(251,191,36,0.85)";
          if (t.includes("derivative") || t.includes("inverse")) return "rgba(52,211,153,0.85)";
          return "rgba(148,163,184,0.75)";
        }}
        linkWidth={(l: object) => 1.2 + ((l as Graph3DLink).weight ?? 0.5) * 2.4}
        linkOpacity={0.95}
        linkDirectionalParticles={(l: object) => 3 + Math.round(((l as Graph3DLink).weight ?? 0.5) * 5)}
        linkDirectionalParticleWidth={2.2}
        linkDirectionalParticleSpeed={0.008}
        enableNodeDrag={false}
        cooldownTicks={0}     // we pin coords; no force sim needed
        warmupTicks={0}
      />

      {/* Hop legend (top-left of canvas) */}
      <div className="pointer-events-none absolute left-3 top-3">
        <div className="glass mono rounded-lg border border-white/10 bg-black/55 px-2.5 py-1.5 text-[10px] uppercase tracking-widest text-muted">
          <div className="mb-1 text-text/85">cascade · 3d</div>
          <div className="flex flex-col gap-0.5">
            <LegendDot color={ROOT_COLOR}              label="root (L0)" />
            <LegendDot color={POLARITY_COLOR.damage}   label="downstream · customers" />
            <LegendDot color={POLARITY_COLOR.exposed}  label="upstream · suppliers" />
            <LegendDot color={POLARITY_COLOR.benefit}  label="inverse · benefit" />
            <LegendDot color={POLARITY_COLOR.semantic} label="peer / sector" />
          </div>
        </div>
      </div>

      {/* Hop stepper (bottom-centre) */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <HopStepper
          maxHop={data.maxHop}
          current={hop}
          setCurrent={setHop}
          playing={playing}
          setPlaying={setPlaying}
          onReplay={() => { setHop(0); setPlaying(true); }}
        />
      </div>

      {/* Hover tooltip */}
      <AnimatePresence>
        {hover && (
          <motion.div
            key={hover.node.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none absolute z-10 max-w-[280px] -translate-x-1/2 -translate-y-[calc(100%+14px)] rounded-xl border border-white/10 bg-black/85 px-3 py-2 text-[11px] text-text shadow-[0_18px_42px_rgba(0,0,0,0.55)] backdrop-blur-md"
            style={{ left: hover.x, top: hover.y }}
          >
            <div className="mono flex items-center justify-between gap-2 text-[10px] uppercase tracking-widest text-muted">
              <span className="text-text">{hover.node.ticker}</span>
              <span>L{hover.node.hop} · {hover.node.relationship_type}</span>
            </div>
            <div className="mt-1 text-text/90">{hover.node.company}</div>
            {hover.node.why && <div className="mt-1 text-muted">{hover.node.why}</div>}
            <div className="mono mt-1 flex items-center gap-2 text-[10px] text-muted">
              <span>rerank</span>
              <span className="text-text">{(hover.node.cascade_score ?? 0).toFixed(2)}</span>
              {hover.node.event_id && <span className="ml-auto text-accent">click to drill →</span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="block h-2 w-2 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      <span className="text-text/80 normal-case tracking-normal">{label}</span>
    </div>
  );
}
