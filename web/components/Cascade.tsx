"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Zap, Network, Sparkles, Search, Scale, Eye, Brain, ChevronDown, Trash2 } from "lucide-react";
import { api, type CascadeNode, type CascadeResponse, type CascadeEdge, type MemoryRecentItem, type SocietyResponse } from "@/lib/api";
import { getDeviceId } from "@/lib/deviceId";
import { useStore } from "@/lib/store";
import { GeoCascadePanel } from "./GeoCascadePanel";

// Extract readable company name — for semantic fallback nodes the real name
// hides inside the "why" field as "8-K - Company Name (CIK) (Filer)".
function resolveCompany(ticker: string, company: string | null | undefined, why: string | null | undefined): string {
  const c = (company ?? "").trim();
  if (c && c.toUpperCase() !== ticker.toUpperCase() && c.length > 2 && !/^\$?[A-Z]{1,6}$/.test(c)) {
    return c;
  }
  const w = (why ?? "").trim();
  let m = w.match(/^8-K\s*[-·]\s*(.+?)\s*\(\d{10}\)/i);
  if (m) return m[1].trim();
  m = w.match(/^(.+?)\s*\(\d{10}\)/);
  if (m && m[1].trim().toUpperCase() !== ticker.toUpperCase()) return m[1].trim();
  m = w.match(/^(.+?)\s*[·\-]\s*Item\s+\d/i);
  if (m && m[1].trim().toUpperCase() !== ticker.toUpperCase()) return m[1].trim();
  return c || ticker;
}

// Clean up SEC filing noise from the "why" text.
function cleanWhy(why: string | null | undefined): string {
  if (!why) return "";
  return why
    .replace(/\s*\(\d{10}\)\s*\(Filer\)/gi, "")
    .replace(/^8-K\s*[-·]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const REL_COLOR: Record<string, string> = {
  supplier: "var(--supplier)",
  customer: "var(--customer)",
  peer: "var(--peer)",
  sector: "var(--sector)",
  derivative: "#f472b6",
  semantic: "#94a3b8",
};

const POLARITY: Record<string, "damage" | "exposed" | "benefit" | "related"> = {
  supplier: "damage",
  sector: "damage",
  customer: "exposed",
  peer: "exposed",
  derivative: "benefit",
  semantic: "related",
};

const POLARITY_COLOR: Record<string, string> = {
  damage: "#ff4d6d",
  exposed: "#fbbf24",
  benefit: "#4ade80",
  related: "#94a3b8",
};

const POLARITY_LABEL: Record<string, string> = {
  damage: "negative cascade",
  exposed: "mixed cascade",
  benefit: "asymmetric cascade",
  related: "semantic match",
};

interface Verdict {
  riskScore: number;
  tone: "damage" | "exposed" | "benefit" | "related";
  text: string;
  bottleneck: string | null;
  buckets: Record<string, number>;
}

function computeVerdict(cascade: CascadeResponse): Verdict {
  // Bottleneck: L1 ticker that the most L2+ edges route through
  const inDegree = new Map<string, number>();
  for (const e of cascade.edges as CascadeEdge[]) {
    if (e.hop >= 2) inDegree.set(e.from, (inDegree.get(e.from) ?? 0) + 1);
  }
  let bottleneck: string | null = null;
  const totalL2 = cascade.edges.filter((e) => e.hop >= 2).length || 1;
  for (const [k, v] of inDegree) {
    if (v / totalL2 >= 0.4 && v >= 2 && (!bottleneck || v > (inDegree.get(bottleneck) ?? 0))) {
      bottleneck = k;
    }
  }

  // Risk score
  let total = 0;
  for (const n of cascade.nodes) {
    total += (n.cascade_score ?? 0) * Math.pow(0.7, Math.max(0, (n.hop ?? 1) - 1));
  }
  const riskScore = Math.min(100, Math.round(total * 12));

  // Polarity buckets
  const buckets: Record<string, number> = { damage: 0, exposed: 0, benefit: 0, related: 0 };
  for (const n of cascade.nodes) {
    const p = POLARITY[n.relationship_type] ?? "related";
    buckets[p] += 1;
  }
  const dominant = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0][0] as Verdict["tone"];
  const totalNodes = cascade.nodes.length;
  const dominantPct = totalNodes ? Math.round((buckets[dominant] / totalNodes) * 100) : 0;

  const isFallback = cascade.fallback === "related_events";

  let text: string;
  if (isFallback) {
    text = `${totalNodes} semantically related events. Root ticker is outside the supply-chain graph.`;
  } else if (bottleneck) {
    text = `${dominantPct}% of L1 second-order routing concentrates through ${bottleneck}.`;
  } else if (dominant === "damage") {
    text = `${buckets.damage} downstream tickers absorb the shock (suppliers + sector cohort).`;
  } else if (dominant === "benefit") {
    text = `${buckets.benefit} substitutes positioned to benefit from the shock.`;
  } else {
    text = `${totalNodes}-node cascade across ${Object.values(buckets).filter((v) => v > 0).length} relationship types.`;
  }

  return { riskScore, tone: isFallback ? "related" : dominant, text, bottleneck, buckets };
}

const GROUP_LABEL: Record<string, string> = {
  supplier: "Direct suppliers",
  customer: "Direct customers",
  peer: "Sector peers",
  sector: "Sector exposure",
  derivative: "Derivative plays",
  semantic: "Semantically related",
  unknown: "Other",
};

const GROUP_ORDER = ["supplier", "customer", "peer", "sector", "derivative", "semantic", "unknown"];

function groupByRelationship(nodes: CascadeNode[]): Array<[string, CascadeNode[]]> {
  const map = new Map<string, CascadeNode[]>();
  for (const n of nodes) {
    const k = n.relationship_type || "unknown";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(n);
  }
  return GROUP_ORDER.filter((k) => map.has(k)).map((k) => [k, map.get(k)!]);
}

const LEVEL_BG: Record<string, string> = {
  L1: "rgba(74,222,128,0.10)",
  L2: "rgba(96,165,250,0.10)",
  L3: "rgba(192,132,252,0.10)",
};

export function Cascade() {
  const selectedId = useStore((s) => s.selectedEventId);
  const cascade = useStore((s) => s.cascade);
  const loading = useStore((s) => s.cascadeLoading);
  const cascadePhase = useStore((s) => s.cascadePhase);
  const selectEvent = useStore((s) => s.selectEvent);
  const eli5 = useStore((s) => s.eli5);
  const toggleEli5 = useStore((s) => s.toggleEli5);
  const setCascadePhase = useStore((s) => s.setCascadePhase);
  const [tab, setTab] = useState<"cascade" | "society">("cascade");
  const [society, setSociety] = useState<SocietyResponse | null>(null);
  const [geminiExhausted, setGeminiExhausted] = useState(false);

  useEffect(() => {
    if (!selectedId) {
      useStore.getState().setCascade(null);
      setCascadePhase("idle");
      return;
    }
    let cancelled = false;
    useStore.getState().setCascadeLoading(true);
    setCascadePhase("building");
    // Phase animation: building → ranking → synthesising. Approximate timing
    // because the backend doesn't (yet) stream tool-call events.
    const rankT = setTimeout(() => !cancelled && setCascadePhase("ranking"), 700);
    const synthT = setTimeout(() => !cancelled && setCascadePhase("synthesising"), 1400);
    const device_id = getDeviceId();
    api
      .buildCascade({ event_id: selectedId, max_hops: 3, top_k: 14, device_id })
      .then((res) => {
        if (cancelled) return;
        useStore.getState().setCascade(res);
        setCascadePhase(res.narrative ? "ready" : "synthesising");
        // Best-effort log the view so Memory has history next time.
        if (device_id) {
          api
            .logCascadeView({
              device_id,
              event_id: selectedId,
              root_ticker: res.root?.tickers?.[0] ?? "",
              sector: res.root?.sector ?? "",
              headline: res.root?.headline ?? "",
            })
            .catch(() => {});
        }
      })
      .catch(() => !cancelled && useStore.getState().setCascade(null))
      .finally(() => !cancelled && useStore.getState().setCascadeLoading(false));
    return () => {
      cancelled = true;
      clearTimeout(rankT);
      clearTimeout(synthT);
    };
  }, [selectedId, setCascadePhase]);

  // Reset Society on selection change so the panel doesn't show stale data.
  useEffect(() => { setSociety(null); }, [selectedId]);

  // Poll for the Society. Local fallbacks land on the first poll (≤500ms);
  // Gemini upgrades arrive over the following ~15s and bump `_source` from
  // "local" → "gemini". We keep polling for a fixed window so the upgrades
  // are picked up — `done` alone is true on the first poll thanks to locals.
  useEffect(() => {
    if (!selectedId || !cascade) return;
    setGeminiExhausted(false);
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 12;
    const tick = async () => {
      if (cancelled) return;
      if (attempts >= MAX_ATTEMPTS) {
        setGeminiExhausted(true);
        return;
      }
      attempts += 1;
      try {
        const s = await api.society(selectedId);
        if (cancelled) return;
        setSociety(s);
        const allGemini =
          s.critic?._source === "gemini" &&
          s.predictor?._source === "gemini" &&
          s.memory?._source === "gemini";
        if (allGemini) { setGeminiExhausted(true); return; }
      } catch {}
      setTimeout(tick, 1500);
    };
    const id = setTimeout(tick, 400);
    return () => { cancelled = true; clearTimeout(id); };
  }, [selectedId, cascade]);

  // Poll for the Gemini narrative — synthesis runs in the background after
  // /cascade returns, usually ready within 3-6s.
  useEffect(() => {
    if (!selectedId || !cascade || cascade.narrative) return;
    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      if (cancelled || attempts >= 8) return;
      attempts += 1;
      try {
        const n = await api.narrative(selectedId);
        if (cancelled) return;
        if (n.ready && n.narrative) {
          useStore.getState().setCascade({
            ...useStore.getState().cascade!,
            narrative: n.narrative,
            severity: n.severity ?? "",
          });
          setCascadePhase("ready");
          return;
        }
      } catch {}
      setTimeout(tick, 1500);
    };
    const id = setTimeout(tick, 2000);
    return () => { cancelled = true; clearTimeout(id); };
  }, [selectedId, cascade, setCascadePhase]);

  return (
    <motion.aside
      key="cascade-card"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="glass-strong flex h-full min-h-0 flex-col overflow-hidden rounded-2xl"
    >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/5 px-4 pt-3 pb-2.5">
            <div className="flex items-center gap-2">
              <Network size={13} className={cascade?.fallback === "related_events" || cascade?.fallback === "semantic_no_tickers" ? "text-muted" : "text-accent"} />
              <span className="mono text-[10px] uppercase tracking-[0.2em] text-muted">
                {cascade?.fallback === "gemini_geo"
                  ? "Cascade · Gemini Geo + $graphLookup"
                  : cascade?.fallback === "related_events" || cascade?.fallback === "semantic_no_tickers"
                  ? "Related · $vectorSearch"
                  : "Cascade · $graphLookup"}
              </span>
              {selectedId && cascadePhase !== "idle" && cascadePhase !== "ready" && (
                <span className="mono inline-flex items-center gap-1 rounded-full bg-accent/10 px-1.5 py-0.5 text-[8px] uppercase tracking-widest text-accent">
                  <span className="h-1 w-1 animate-pulse rounded-full bg-accent" />
                  {cascadePhase}…
                </span>
              )}
            </div>
            {selectedId && (
              <button
                onClick={() => selectEvent(null)}
                className="rounded p-1 text-muted hover:bg-white/10 hover:text-text"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Tabs: Cascade / Society */}
          {selectedId && cascade && (
            <div className="flex items-center gap-1 border-b border-white/5 px-4 py-1.5">
              <button
                onClick={() => setTab("cascade")}
                className={
                  "rounded px-2 py-1 text-[10px] uppercase tracking-wider transition " +
                  (tab === "cascade" ? "bg-white/10 text-text" : "text-muted hover:text-text")
                }
              >
                Cascade
              </button>
              <button
                onClick={() => setTab("society")}
                className={
                  "rounded px-2 py-1 text-[10px] uppercase tracking-wider transition " +
                  (tab === "society" ? "bg-white/10 text-text" : "text-muted hover:text-text")
                }
                title="Multi-agent constellation: researcher · critic · predictor · memory"
              >
                <span className="inline-flex items-center gap-1">
                  <Sparkles size={10} />
                  Society
                </span>
              </button>
            </div>
          )}

          {!selectedId && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="grid h-16 w-16 place-items-center rounded-full border border-white/10" style={{ background: "radial-gradient(circle, rgba(74,222,128,0.08) 0%, transparent 70%)" }}>
                <Network size={22} className="text-accent/40" />
              </div>
              <div className="space-y-1">
                <div className="mono text-[10px] uppercase tracking-[0.25em] text-muted">Cascade · $graphLookup</div>
                <div className="text-[11px] text-muted/70 leading-relaxed">
                  Select any event from the feed<br />to walk its supply-chain cascade
                </div>
              </div>
              <div className="mono mt-2 flex flex-col items-center gap-1 text-[9px] uppercase tracking-widest text-muted/50">
                <span>voyage rerank-2.5</span>
                <span>3-hop graph walk</span>
              </div>
            </div>
          )}

          {selectedId && loading && (
            <CascadeSkeleton phase={cascadePhase} />
          )}

          {selectedId && !loading && cascade && tab === "society" && (
            <SocietyPanel cascade={cascade} society={society} geminiExhausted={geminiExhausted} />
          )}

          {selectedId && !loading && cascade && tab === "cascade" && (() => {
            const verdict = computeVerdict(cascade);
            const weakSet = new Set((society?.critic?.weak_tickers ?? []).map((t) => t.toUpperCase()));
            const verdictColor = POLARITY_COLOR[verdict.tone];
            const isFallback = cascade.fallback === "related_events" || cascade.fallback === "semantic_no_tickers";
            return (
            <>
              {/* Root */}
              <div className="border-b border-white/5 px-4 py-3">
                <div className="text-[10px] uppercase tracking-wider text-muted">root</div>
                <div className="mt-1 text-sm leading-snug text-text">
                  {cascade.root.headline || "(no headline)"}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {cascade.root.tickers.map((t) => (
                    <span key={t} className="mono rounded bg-critical/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-critical">
                      {t}
                    </span>
                  ))}
                  {cascade.root.sector && (
                    <span className="text-[10px] text-muted">· {cascade.root.sector}</span>
                  )}
                </div>
              </div>

              {/* Verdict — single sentence summary + risk meter */}
              <div className="border-b border-white/5 px-4 py-3">
                <div className="flex items-start gap-3">
                  {!isFallback && (
                    <div className="flex shrink-0 flex-col items-center gap-0.5 border-r border-white/10 pr-3">
                      <div className="mono text-[8px] uppercase tracking-widest text-muted">risk</div>
                      <div className="mono text-[22px] font-bold leading-none tabular-nums" style={{ color: verdictColor }}>
                        {verdict.riskScore}
                      </div>
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="mono text-[9px] uppercase tracking-widest" style={{ color: verdictColor }}>
                      {POLARITY_LABEL[verdict.tone]}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-snug text-text/90">{verdict.text}</div>
                    {cascade.narrative && (
                      <div className="mt-2 rounded-lg border border-accent/15 bg-accent/[0.04] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-text/85">
                        <div className="mono mb-0.5 flex items-center justify-between text-[8px] uppercase tracking-widest text-accent/70">
                          <span className="inline-flex items-center gap-1">
                            <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-accent">gemini</span>
                            <span>narrative</span>
                          </span>
                          <button
                            onClick={toggleEli5}
                            className={
                              "rounded-full px-1.5 py-0.5 text-[8px] uppercase tracking-widest transition " +
                              (eli5 ? "bg-accent/20 text-accent" : "text-muted/60 hover:text-accent")
                            }
                            title="Explain like I'm 5"
                          >
                            ELI5
                          </button>
                        </div>
                        {eli5
                          ? (society?.eli5 || simplifyForEli5(cascade.narrative, cascade))
                          : cascade.narrative}
                      </div>
                    )}
                  </div>
                </div>
                {/* Polarity stack bar */}
                {!isFallback && (
                  <div className="mt-2.5 space-y-1">
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.04]">
                      {(["damage", "exposed", "benefit", "related"] as const).map((p) => {
                        const n = verdict.buckets[p];
                        if (!n) return null;
                        const total = cascade.nodes.length || 1;
                        return (
                          <div key={p} style={{ width: `${(n / total) * 100}%`, background: POLARITY_COLOR[p] }} />
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[9px] uppercase tracking-wider">
                      {(["damage", "exposed", "benefit", "related"] as const).map((p) => {
                        const n = verdict.buckets[p];
                        if (!n) return null;
                        return (
                          <span key={p} className="flex items-center gap-1" style={{ color: POLARITY_COLOR[p] }}>
                            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: POLARITY_COLOR[p] }} />
                            {p} <span className="tabular-nums opacity-70">{n}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
                {verdict.bottleneck && (
                  <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-critical/15 px-2 py-0.5 text-[9px] uppercase tracking-wider text-critical">
                    <span className="h-1.5 w-1.5 rounded-full bg-critical pulse-soft" />
                    bottleneck · {verdict.bottleneck}
                  </div>
                )}
              </div>

              {/* Gemini Geo-Cascade panel — regions, sector exposure, transmission */}
              {cascade.geo_cascade && <GeoCascadePanel cascade={cascade} />}

              {/* Hop summary (only when real cascade) */}
              {(!cascade.fallback || cascade.fallback === "gemini_geo") && cascade.hop_counts && Object.keys(cascade.hop_counts).length > 0 && (
                <div className="flex gap-1.5 border-b border-white/5 px-4 py-2 text-[10px]">
                  {Object.entries(cascade.hop_counts).map(([lvl, n]) => (
                    <span
                      key={lvl}
                      className="mono rounded px-1.5 py-0.5"
                      style={{ background: LEVEL_BG[lvl] ?? "rgba(255,255,255,0.04)", color: "var(--text)" }}
                    >
                      {lvl} · <span className="tabular-nums">{n}</span>
                    </span>
                  ))}
                </div>
              )}

              {cascade.message && (
                <div
                  className={
                    "border-b border-white/5 px-4 py-2.5 text-[11px] leading-snug " +
                    (cascade.fallback ? "bg-white/[0.03] text-muted" : "text-muted")
                  }
                >
                  {cascade.message}
                </div>
              )}

              {/* Nodes — grouped by relationship type */}
              <ul className="thin-scroll flex-1 min-h-0 overflow-y-auto">
                {groupByRelationship(cascade.nodes).map(([rel, group]) => {
                  const isBottleneckTicker = (t: string) => t === verdict.bottleneck;
                  const color = REL_COLOR[rel] ?? "var(--text-muted)";
                  return (
                    <li key={rel} className="border-b border-white/[0.04]">
                      <div
                        className="mono sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.04] bg-[color:var(--surface-2)]/80 px-4 py-1.5 text-[9px] uppercase tracking-widest backdrop-blur"
                        style={{ color }}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
                          {GROUP_LABEL[rel] ?? rel}
                        </span>
                        <span className="tabular-nums text-muted">{group.length}</span>
                      </div>
                      <ul>
                        {group.map((n, i) => {
                          const displayName = resolveCompany(n.ticker, n.company, n.why);
                          const whyClean = cleanWhy(n.why);
                          const isWeak = weakSet.has(n.ticker.toUpperCase());
                          return (
                          <motion.li
                            key={n.ticker + i}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.15, delay: Math.min(0.25, i * 0.02) }}
                            className={
                              "border-b border-white/[0.03] px-4 py-2.5 last:border-b-0 transition " +
                              (isWeak ? "bg-[#fbbf24]/[0.05]" : "")
                            }
                            title={isWeak ? "Critic flagged this edge as likely noise" : undefined}
                          >
                            <div className="flex items-start gap-2">
                              {/* Left: level badge */}
                              <span
                                className="mono mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold tracking-wider"
                                style={{
                                  color,
                                  border: `1px solid ${color}`,
                                  background: "transparent",
                                  boxShadow: `0 0 10px ${color}2a`,
                                }}
                              >
                                {n.level}
                              </span>

                              {/* Centre: name + ticker + why */}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-baseline gap-1.5">
                                  <span className="truncate text-[12px] font-medium text-text leading-tight">
                                    {displayName}
                                  </span>
                                  {isBottleneckTicker(n.ticker) && (
                                    <span className="mono shrink-0 rounded-full bg-critical/20 px-1.5 py-0.5 text-[8px] uppercase tracking-wider text-critical">
                                      bottleneck
                                    </span>
                                  )}
                                  {isWeak && (
                                    <span className="mono shrink-0 rounded-full bg-[#fbbf24]/20 px-1.5 py-0.5 text-[8px] uppercase tracking-wider text-[#fbbf24]">
                                      critic ⚠
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 flex items-center gap-1.5">
                                  <span className="mono text-[10px] font-semibold tracking-wider" style={{ color }}>
                                    {n.ticker}
                                  </span>
                                  <span className="text-muted/50">·</span>
                                  <span className="capitalize text-[10px] text-muted/70">{n.relationship_type}</span>
                                </div>
                                {whyClean && (
                                  <div className="mt-1 line-clamp-2 text-[10px] leading-snug text-muted/75">
                                    {whyClean}
                                  </div>
                                )}
                              </div>

                              {/* Right: score */}
                              <span className="mono ml-1 shrink-0 tabular-nums text-accent text-[11px]">
                                {n.cascade_score.toFixed(2)}
                              </span>
                            </div>
                          </motion.li>
                          );
                        })}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </>
            );
          })()}
    </motion.aside>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Loading skeleton — shimmer rows in cascade-card layout
// ───────────────────────────────────────────────────────────────────────────
function CascadeSkeleton({ phase }: { phase: string }) {
  const label =
    phase === "building"
      ? "walking $graphLookup…"
      : phase === "ranking"
      ? "voyage rerank-2.5…"
      : phase === "synthesising"
      ? "gemini synthesising…"
      : "loading…";
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="border-b border-white/5 px-4 py-3">
        <div className="text-[10px] uppercase tracking-wider text-muted">root</div>
        <div className="shimmer mt-2 h-4 w-3/4 rounded" />
        <div className="mt-2 flex gap-1.5">
          <div className="shimmer h-3.5 w-12 rounded" />
          <div className="shimmer h-3.5 w-14 rounded" />
        </div>
      </div>
      <div className="border-b border-white/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="shimmer h-12 w-12 rounded" />
          <div className="flex-1 space-y-2">
            <div className="shimmer h-3 w-1/2 rounded" />
            <div className="shimmer h-3 w-3/4 rounded" />
            <div className="shimmer h-3 w-2/3 rounded" />
          </div>
        </div>
      </div>
      <div className="space-y-2 px-4 py-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="shimmer h-6 w-8 rounded" />
            <div className="flex-1 space-y-1.5">
              <div className="shimmer h-3 w-3/4 rounded" />
              <div className="shimmer h-2.5 w-1/2 rounded" />
            </div>
            <div className="shimmer h-3 w-8 rounded" />
          </div>
        ))}
      </div>
      <div className="mt-auto px-4 py-3 text-center">
        <div className="mono inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-accent">
          <Zap size={11} className="animate-pulse" />
          {label}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Society panel — Researcher · Critic · Predictor · Memory
// Each agent has its OWN visualisation tuned to its job. Cards collapse
// and expand; state persists per-agent in localStorage.
// ───────────────────────────────────────────────────────────────────────────
type AgentSlug = "researcher" | "critic" | "predictor" | "memory";
const EXPAND_KEY = (s: AgentSlug) => `cascade-agent-${s}-expanded`;

function useExpanded(slug: AgentSlug, initial = false): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(initial);
  useEffect(() => {
    try {
      const v = localStorage.getItem(EXPAND_KEY(slug));
      if (v !== null) setOpen(v === "1");
    } catch {}
  }, [slug]);
  const toggle = () => {
    setOpen((p) => {
      const next = !p;
      try { localStorage.setItem(EXPAND_KEY(slug), next ? "1" : "0"); } catch {}
      return next;
    });
  };
  return [open, toggle];
}

function SocietyPanel({ cascade, society, geminiExhausted }: { cascade: CascadeResponse; society: SocietyResponse | null; geminiExhausted: boolean }) {
  return (
    <div className="thin-scroll flex-1 min-h-0 space-y-3 overflow-y-auto p-3">
      <ResearcherAgent cascade={cascade} />
      <CriticAgent cascade={cascade} society={society} geminiExhausted={geminiExhausted} />
      <PredictorAgent cascade={cascade} society={society} geminiExhausted={geminiExhausted} />
      <MemoryAgent cascade={cascade} society={society} geminiExhausted={geminiExhausted} />
    </div>
  );
}

// ── Shared chrome ─────────────────────────────────────────────────────────
function AgentShell({
  slug, name, role, color, Icon, source, headerBadge, summary, expanded, toggle, children,
}: {
  slug: AgentSlug;
  name: string;
  role: string;
  color: string;
  Icon: typeof Search;
  source: "gemini" | "local" | null;
  headerBadge?: React.ReactNode;
  summary: React.ReactNode;
  expanded: boolean;
  toggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]"
    >
      <button
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.02] transition"
        aria-expanded={expanded}
        aria-controls={`agent-${slug}`}
      >
        <div
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full"
          style={{ background: color + "22", color, border: `1px solid ${color}40` }}
        >
          <Icon size={13} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mono text-[9px] uppercase tracking-widest" style={{ color }}>{role}</div>
          <div className="text-[12px] font-medium text-text">{name}</div>
        </div>
        {headerBadge}
        {source === "gemini" && (
          <span className="mono rounded-full bg-accent/15 px-1.5 py-0.5 text-[8px] uppercase tracking-widest text-accent">gemini</span>
        )}
        {source === "local" && (
          <span className="mono rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[8px] uppercase tracking-widest text-muted">local</span>
        )}
        <ChevronDown
          size={14}
          className={"text-muted transition " + (expanded ? "rotate-180" : "")}
        />
      </button>
      <div className="px-3 pb-2">
        <div className="text-[11px] leading-snug text-text/85">{summary}</div>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={`agent-${slug}`}
            key="detail"
            layout
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="overflow-hidden border-t border-white/[0.06]"
          >
            <div className="p-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function AgentThinking({ color, label }: { color: string; label: string }) {
  return (
    <span className="mono inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest" style={{ color }}>
      <span className="inline-flex gap-0.5">
        <span className="h-1 w-1 animate-bounce rounded-full" style={{ background: color, animationDelay: "0ms" }} />
        <span className="h-1 w-1 animate-bounce rounded-full" style={{ background: color, animationDelay: "120ms" }} />
        <span className="h-1 w-1 animate-bounce rounded-full" style={{ background: color, animationDelay: "240ms" }} />
      </span>
      {label}
    </span>
  );
}

// ── 1. Researcher — Risk Surface (what's at risk + top tickers) ───────────
function ResearcherAgent({ cascade }: { cascade: CascadeResponse }) {
  const [expanded, toggle] = useExpanded("researcher", true);
  const nodes = cascade.nodes;
  const fallback = cascade.fallback === "related_events";

  // Direction heuristic — supplier/sector/peer to a hit root = exposed/down,
  // derivative = beneficiary, customer = exposed.
  const dirOf = (rel: string): "DOWN" | "UP" | "WATCH" => {
    if (rel === "derivative") return "UP";
    if (rel === "supplier" || rel === "customer" || rel === "sector" || rel === "peer" || rel === "geo_exposure") return "DOWN";
    return "WATCH";
  };

  // Exposure buckets (trader-relevant)
  const direct = nodes.filter((n) => (n.hop ?? 1) === 1);
  const downstream = nodes.filter((n) => n.relationship_type === "customer");
  const upstream = nodes.filter((n) => n.relationship_type === "supplier");
  const peers = nodes.filter((n) => n.relationship_type === "peer" || n.relationship_type === "sector");
  const benefit = nodes.filter((n) => n.relationship_type === "derivative");

  // Top 3 by cascade_score (the trade-watch list)
  const top = [...nodes].sort((a, b) => b.cascade_score - a.cascade_score).slice(0, 3);

  // Sector concentration
  const sectorMap = new Map<string, number>();
  for (const n of nodes) {
    const s = (n.sector || "Other").trim() || "Other";
    sectorMap.set(s, (sectorMap.get(s) ?? 0) + 1);
  }
  const sectorRanked = Array.from(sectorMap.entries()).sort((a, b) => b[1] - a[1]);
  const topSector = sectorRanked[0];
  const topSectorPct = topSector ? Math.round((topSector[1] / nodes.length) * 100) : 0;

  return (
    <AgentShell
      slug="researcher"
      name="Researcher"
      role="exposure map"
      color="#4ade80"
      Icon={Search}
      source="local"
      expanded={expanded}
      toggle={toggle}
      summary={
        fallback ? (
          <>No direct supply-chain hits. <b>{nodes.length}</b> semantically related events surfaced via $vectorSearch — worth scanning for sentiment, not trading off the graph.</>
        ) : (
          <><b>{direct.length}</b> direct exposures · <b>{topSector?.[0] ?? "Mixed"}</b> dominates ({topSectorPct}%). Top to watch: <b>{top.map((t) => t.ticker).join(", ") || "—"}</b>.</>
        )
      }
      headerBadge={
        <span className="mono hidden sm:inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[9px] tracking-wider text-muted">
          <span className="text-[#4ade80]">L1·{direct.length}</span>
          {downstream.length > 0 && <><span className="opacity-40">·</span><span>cust·{downstream.length}</span></>}
          {upstream.length > 0 && <><span className="opacity-40">·</span><span>sup·{upstream.length}</span></>}
        </span>
      }
    >
      <div className="space-y-3">
        {/* Top tickers to watch */}
        <div>
          <div className="mono mb-1.5 text-[9px] uppercase tracking-widest text-muted">top exposures · trade watch</div>
          <ul className="space-y-1">
            {top.map((n) => {
              const d = dirOf(n.relationship_type);
              const c = d === "UP" ? "#4ade80" : d === "DOWN" ? "#ff4d6d" : "#94a3b8";
              const arrow = d === "UP" ? "↑" : d === "DOWN" ? "↓" : "→";
              return (
                <li key={n.ticker} className="flex items-center gap-2 rounded-lg bg-white/[0.02] px-2 py-1.5">
                  <span className="mono w-12 text-[11px] font-semibold tabular-nums" style={{ color: c }}>{n.ticker}</span>
                  <span className="text-[10.5px]" style={{ color: c }}>{arrow}</span>
                  <span className="flex-1 truncate text-[10.5px] text-text/80 capitalize">
                    {n.company || n.ticker}
                    <span className="text-muted/60"> · {n.relationship_type}</span>
                  </span>
                  <span className="mono tabular-nums text-[10px] text-muted">{n.cascade_score.toFixed(2)}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Exposure breakdown */}
        {!fallback && (
          <div>
            <div className="mono mb-1.5 text-[9px] uppercase tracking-widest text-muted">exposure surface</div>
            <div className="grid grid-cols-4 gap-1.5">
              <SurfaceCell label="suppliers" value={upstream.length} color="#ff4d6d" hint="upstream risk if root cuts orders" />
              <SurfaceCell label="customers" value={downstream.length} color="#fbbf24" hint="downstream risk if root halts supply" />
              <SurfaceCell label="peers" value={peers.length} color="#60a5fa" hint="sector cohort that moves with root" />
              <SurfaceCell label="benefit" value={benefit.length} color="#4ade80" hint="substitutes positioned to gain" />
            </div>
          </div>
        )}

        {/* Sector concentration bar */}
        {sectorRanked.length > 0 && (
          <div>
            <div className="mono mb-1.5 flex items-center justify-between text-[9px] uppercase tracking-widest text-muted">
              <span>sector concentration</span>
              {topSectorPct >= 60 && (
                <span className="mono rounded-full bg-[#ff4d6d]/15 px-1.5 py-0.5 text-[8.5px] text-[#ff4d6d]">
                  concentrated
                </span>
              )}
            </div>
            <div className="space-y-1">
              {sectorRanked.slice(0, 4).map(([sec, count]) => {
                const pct = Math.round((count / nodes.length) * 100);
                return (
                  <div key={sec} className="flex items-center gap-2">
                    <span className="mono w-24 truncate text-[10px] text-text/85">{sec}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.04]">
                      <div className="h-full rounded-full bg-[#4ade80]/70" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="mono w-8 text-right tabular-nums text-[9.5px] text-muted">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </AgentShell>
  );

  function SurfaceCell({ label, value, color, hint }: { label: string; value: number; color: string; hint: string }) {
    return (
      <div className="rounded-lg bg-white/[0.03] p-1.5 text-center" title={hint}>
        <div className="mono text-[8px] uppercase tracking-widest" style={{ color }}>{label}</div>
        <div className="mono tabular-nums text-[14px] font-semibold text-text">{value}</div>
      </div>
    );
  }
}

// ── 2. Critic — the audit (gauge + histogram + weak edges) ────────────────
function CriticAgent({ cascade, society, geminiExhausted }: { cascade: CascadeResponse; society: SocietyResponse | null; geminiExhausted: boolean }) {
  const [expanded, toggle] = useExpanded("critic", false);
  const ready = society?.critic?._source === "gemini";
  const color = "#fbbf24";

  // Confidence: avg cascade_score of nodes (0..1) × 100, plus a slight bias
  // toward L1 nodes since they're the bones of the cascade.
  const confidence = useMemoConfidence(cascade);
  const sorted = [...cascade.nodes].sort((a, b) => b.cascade_score - a.cascade_score);
  const top3 = sorted.slice(0, 3);
  const weak3 = [...sorted].reverse().slice(0, 3);
  const NOISE_FLOOR = 0.25;

  return (
    <AgentShell
      slug="critic"
      name="Critic"
      role="review"
      color={color}
      Icon={Scale}
      source={ready ? "gemini" : null}
      expanded={expanded}
      toggle={toggle}
      headerBadge={
        ready ? (
          <span className="mono rounded-full bg-[#fbbf24]/15 px-1.5 py-0.5 text-[9px] tracking-wider text-[#fbbf24] tabular-nums">
            {confidence}% conf
          </span>
        ) : (
          <span className="mono rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[9px] tracking-wider text-muted/70 tabular-nums">
            {cascade.nodes.length} edges
          </span>
        )
      }
      summary={
        <>
          {/* Always-on local risk flags */}
          <LocalRiskFlags cascade={cascade} confidence={confidence} />
          {/* Gemini commentary layered on top when it lands */}
          {ready ? (
            <div className="mt-2 border-t border-white/[0.06] pt-2">
              <div className="mono mb-1 text-[8.5px] uppercase tracking-widest text-[#fbbf24]/80">gemini · counter-thesis</div>
              <TypewriterText text={society!.critic!.message} />
              {society!.critic!.weak_tickers?.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {society!.critic!.weak_tickers!.slice(0, 4).map((t) => (
                    <span
                      key={t}
                      className="mono rounded-full border border-[#fbbf24]/40 bg-[#fbbf24]/10 px-1.5 py-0.5 text-[9px] tracking-wider text-[#fbbf24]"
                      title="Critic flagged this edge as likely noise"
                    >
                      {t} ⚠
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : geminiExhausted ? null : (
            <div className="mt-2 flex items-center gap-2 border-t border-white/[0.06] pt-2">
              <AgentThinking color={color} label="gemini counter-thesis" />
            </div>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {/* Confidence gauge */}
        <div className="flex items-center gap-3">
          <ConfidenceDial value={confidence} color={color} />
          <div className="flex-1">
            <div className="mono text-[9px] uppercase tracking-widest text-muted">confidence</div>
            <div className="text-[10.5px] leading-snug text-text/80">
              Avg rerank across all nodes, weighted toward L1. Above 65% is solid;
              below 40% suggests semantic noise.
            </div>
          </div>
        </div>

        {/* Edge-score histogram */}
        <div>
          <div className="mono mb-1.5 flex items-center justify-between text-[9px] uppercase tracking-widest text-muted">
            <span>edge audit</span>
            <span>noise floor {NOISE_FLOOR.toFixed(2)}</span>
          </div>
          <div className="relative h-16 rounded-lg bg-white/[0.02] p-2">
            {/* threshold line */}
            <div
              className="absolute left-2 right-2 border-t border-dashed border-[#fbbf24]/40"
              style={{ top: `calc(${(1 - NOISE_FLOOR) * 100}% + 8px - 1px)` }}
            />
            <div className="flex h-full items-end gap-[2px]">
              {sorted.map((n, i) => {
                const h = Math.max(4, Math.min(100, n.cascade_score * 100));
                const weak = n.cascade_score < NOISE_FLOOR;
                return (
                  <div
                    key={n.ticker + i}
                    className="flex-1 rounded-sm transition"
                    style={{
                      height: `${h}%`,
                      background: weak ? "#fbbf24" : "#4ade8088",
                      opacity: weak ? 1 : 0.85,
                    }}
                    title={`${n.ticker} · ${n.cascade_score.toFixed(2)}`}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Strongest / Weakest */}
        <div className="grid grid-cols-2 gap-2">
          <MiniList title="strongest" color="#4ade80" rows={top3} />
          <MiniList title="weakest" color={color} rows={weak3.reverse()} />
        </div>
      </div>
    </AgentShell>
  );

  function MiniList({ title, color: c, rows }: { title: string; color: string; rows: CascadeNode[] }) {
    return (
      <div className="rounded-lg bg-white/[0.02] p-2">
        <div className="mono mb-1 text-[8.5px] uppercase tracking-widest" style={{ color: c }}>{title}</div>
        <ul className="space-y-0.5">
          {rows.map((n, i) => (
            <li key={n.ticker + i} className="mono flex items-center justify-between text-[10px]">
              <span className="text-text/85 truncate">{n.ticker}</span>
              <span className="tabular-nums text-muted">{n.cascade_score.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
}

// Local, no-LLM risk flags — derived purely from cascade payload. Surfaces
// the things a trader actually needs to see immediately: concentration risk,
// single-points-of-failure, and noise indicators.
function LocalRiskFlags({ cascade, confidence }: { cascade: CascadeResponse; confidence: number }) {
  const flags: { label: string; tone: "high" | "med" | "low"; hint: string }[] = [];
  const nodes = cascade.nodes;

  // Sector concentration
  const sectorMap = new Map<string, number>();
  for (const n of nodes) sectorMap.set(n.sector || "Other", (sectorMap.get(n.sector || "Other") ?? 0) + 1);
  const ranked = Array.from(sectorMap.entries()).sort((a, b) => b[1] - a[1]);
  const topSectorPct = ranked[0] ? Math.round((ranked[0][1] / nodes.length) * 100) : 0;
  if (topSectorPct >= 60) {
    flags.push({ label: `${topSectorPct}% in ${ranked[0][0]}`, tone: "high", hint: "Cascade is concentrated — diversification limited" });
  } else if (topSectorPct >= 40) {
    flags.push({ label: `${topSectorPct}% in ${ranked[0][0]}`, tone: "med", hint: "Moderate sector concentration" });
  }

  // Single supplier dependency (only one L1 supplier across the cascade)
  const suppliers = nodes.filter((n) => n.relationship_type === "supplier" && (n.hop ?? 1) === 1);
  if (suppliers.length === 1) {
    flags.push({ label: `single supplier · ${suppliers[0].ticker}`, tone: "high", hint: "Only one direct supplier — single point of failure" });
  } else if (suppliers.length >= 4) {
    flags.push({ label: `${suppliers.length} suppliers`, tone: "low", hint: "Distributed upstream — replaceable" });
  }

  // Noise nodes (below rerank floor)
  const noise = nodes.filter((n) => n.cascade_score < 0.25).length;
  if (noise >= 3) {
    flags.push({ label: `${noise} noisy edges`, tone: "med", hint: "Multiple low-rerank nodes — consider a stricter view" });
  }

  // Severity gauge text
  const sev = confidence >= 65 ? "trustable" : confidence >= 40 ? "directional only" : "low-conviction";
  flags.push({ label: sev, tone: confidence >= 65 ? "low" : confidence >= 40 ? "med" : "high", hint: `Confidence ${confidence}%` });

  const tones: Record<string, string> = {
    high: "#ff4d6d",
    med: "#fbbf24",
    low: "#4ade80",
  };

  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f, i) => (
        <span
          key={i}
          title={f.hint}
          className="mono inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] tracking-wider"
          style={{
            borderColor: tones[f.tone] + "55",
            color: tones[f.tone],
            background: tones[f.tone] + "10",
          }}
        >
          <span className="h-1 w-1 rounded-full" style={{ background: tones[f.tone] }} />
          {f.label}
        </span>
      ))}
    </div>
  );
}

function useMemoConfidence(cascade: CascadeResponse): number {
  // Inline calc, memoised by reference equality of cascade.nodes via React render.
  const nodes = cascade.nodes;
  if (!nodes.length) return 0;
  let weighted = 0;
  let weightTotal = 0;
  for (const n of nodes) {
    const w = (n.hop ?? 1) === 1 ? 1.5 : (n.hop ?? 1) === 2 ? 1.0 : 0.7;
    weighted += (n.cascade_score ?? 0) * w;
    weightTotal += w;
  }
  return Math.round((weighted / weightTotal) * 100);
}

function ConfidenceDial({ value, color }: { value: number; color: string }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  const tone = value >= 65 ? "#4ade80" : value >= 40 ? color : "#ff4d6d";
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" className="shrink-0">
      <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
      <motion.circle
        cx="32" cy="32" r={r} fill="none" stroke={tone} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={c}
        initial={{ strokeDashoffset: c }}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        transform="rotate(-90 32 32)"
      />
      <text x="32" y="34" textAnchor="middle" dominantBaseline="middle"
            className="mono" fill={tone} fontSize="13" fontWeight="600">
        {value}
      </text>
      <text x="32" y="46" textAnchor="middle" className="mono" fill="rgba(255,255,255,0.4)" fontSize="6">
        CONF
      </text>
    </svg>
  );
}

// ── 3. Predictor — the betting slip (sparklines + analogue) ───────────────
function PredictorAgent({ cascade, society, geminiExhausted }: { cascade: CascadeResponse; society: SocietyResponse | null; geminiExhausted: boolean }) {
  const [expanded, toggle] = useExpanded("predictor", false);
  const ready = society?.predictor?._source === "gemini";
  const color = "#60a5fa";

  // Derive instant directional bias from cascade payload — relationship type
  // implies direction (supplier/customer/sector = DOWN, derivative = UP),
  // cascade_score gives confidence. Replaced by Gemini's structured
  // projections when they land.
  const localBias = useMemo(() => deriveLocalBias(cascade), [cascade]);
  const top = (society?.predictor?.projections?.length ? society.predictor.projections : localBias).slice(0, 3);
  const usingGemini = Boolean(society?.predictor?.projections?.length);

  return (
    <AgentShell
      slug="predictor"
      name="Predictor"
      role="projection"
      color={color}
      Icon={Eye}
      source={ready ? "gemini" : null}
      expanded={expanded}
      toggle={toggle}
      headerBadge={
        ready && top.length > 0 ? (
          <span className="mono inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[9px] tracking-wider text-text/80">
            {top.map((p) => (
              <span key={p.ticker} className="inline-flex items-center gap-0.5">
                <span className="font-semibold">{p.ticker}</span>
                <span style={{ color: dirColor(p.direction) }}>{dirArrow(p.direction)}</span>
              </span>
            )).reduce<React.ReactNode[]>((acc, el, i) => i === 0 ? [el] : [...acc, <span key={"sep"+i} className="opacity-30">·</span>, el], [])}
          </span>
        ) : null
      }
      summary={
        <>
          {/* Always-on local directional bias */}
          {top.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {top.map((p) => <ProjectionChip key={p.ticker} projection={p} />)}
            </div>
          )}
          {/* Gemini commentary layers on top */}
          {ready ? (
            <div className="mt-2 border-t border-white/[0.06] pt-2">
              <div className="mono mb-1 text-[8.5px] uppercase tracking-widest text-[#60a5fa]/80">gemini · 24h read</div>
              <TypewriterText text={society!.predictor!.message} />
            </div>
          ) : geminiExhausted ? null : (
            <div className="mt-2 flex items-center gap-2 border-t border-white/[0.06] pt-2">
              <AgentThinking color={color} label="gemini refining read" />
            </div>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <div className="mono flex items-center justify-between text-[9px] uppercase tracking-widest text-muted">
          <span>24h trade watch · top 3</span>
          <span className={"rounded-full px-1.5 py-0.5 " + (usingGemini ? "bg-accent/15 text-accent" : "bg-white/[0.04] text-muted/70")}>
            {usingGemini ? "gemini" : "local heuristic"}
          </span>
        </div>

        {/* Per-ticker sparkline rows */}
        <div className="space-y-2">
          {top.length === 0 && (
            <div className="rounded-lg bg-white/[0.02] p-3 text-[10.5px] text-muted/70">
              No tickers yet — waiting for the cascade payload.
            </div>
          )}
          {top.map((p) => {
            const c = dirColor(p.direction);
            const node = cascade.nodes.find((n) => n.ticker === p.ticker);
            const score = node?.cascade_score ?? 0.5;
            return (
              <div key={p.ticker} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
                <div className="flex items-center gap-2">
                  <span className="mono w-12 shrink-0 text-[11px] font-semibold tabular-nums" style={{ color: c }}>
                    {p.ticker}
                  </span>
                  <span className="text-[14px] leading-none" style={{ color: c }}>{dirArrow(p.direction)}</span>
                  <div className="flex-1">
                    <Sparkline direction={p.direction} score={score} color={c} />
                  </div>
                  <span className="mono w-9 shrink-0 text-right text-[10px] tabular-nums" style={{ color: c }}>
                    {Math.round((p.confidence ?? 0) * 100)}%
                  </span>
                </div>
                {p.rationale && (
                  <div className="mt-1.5 text-[10px] leading-snug text-muted/85">{p.rationale}</div>
                )}
                <div className="mono mt-1 flex justify-between text-[8px] uppercase tracking-widest text-muted/40">
                  <span>now</span><span>+6h</span><span>+12h</span><span>+24h</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Historical analogue */}
        {society?.predictor?.analogue && (
          <div className="rounded-lg border border-[#60a5fa]/20 bg-[#60a5fa]/[0.04] p-2">
            <div className="mono mb-1 text-[9px] uppercase tracking-widest text-[#60a5fa]">historical analogue</div>
            <div className="text-[10.5px] leading-snug text-text/85">{society.predictor.analogue}</div>
            <div className="mono mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-[#4ade80]/10 px-1.5 py-0.5 text-[8.5px] uppercase tracking-widest text-[#4ade80]">
              <span className="h-1 w-1 rounded-full bg-[#4ade80]" />
              resolved · ~48h
            </div>
          </div>
        )}
      </div>
    </AgentShell>
  );
}

// Local directional bias derived from cascade payload — used as the
// instant-on display in Predictor before Gemini lands.
function deriveLocalBias(cascade: CascadeResponse): Array<{
  ticker: string; direction: string; confidence: number; rationale: string;
}> {
  return [...cascade.nodes]
    .sort((a, b) => b.cascade_score - a.cascade_score)
    .slice(0, 4)
    .map((n) => {
      const rel = n.relationship_type;
      const direction =
        rel === "derivative" ? "UP" :
        rel === "supplier" || rel === "customer" || rel === "sector" || rel === "peer" || rel === "geo_exposure" ? "DOWN" :
        "NEUTRAL";
      // Confidence: cascade_score, slightly damped for indirect hops.
      const dampen = (n.hop ?? 1) === 1 ? 1 : (n.hop ?? 1) === 2 ? 0.85 : 0.7;
      return {
        ticker: n.ticker,
        direction,
        confidence: Math.min(0.95, n.cascade_score * dampen),
        rationale: `${rel} · L${n.hop ?? 1}`,
      };
    });
}

function dirColor(d: string | undefined): string {
  const x = (d || "").toUpperCase();
  return x === "UP" ? "#4ade80" : x === "DOWN" ? "#ff4d6d" : "#94a3b8";
}
function dirArrow(d: string | undefined): string {
  const x = (d || "").toUpperCase();
  return x === "UP" ? "↑" : x === "DOWN" ? "↓" : "→";
}

function Sparkline({ direction, score, color }: { direction: string; score: number; color: string }) {
  // Synthesise a 24-point trajectory shaped by direction + cascade_score.
  // Higher score = more pronounced move; UP = monotone-ish up, DOWN = down,
  // NEUTRAL = oscillate.
  const dir = (direction || "").toUpperCase();
  const points = useMemo(() => {
    const n = 24;
    const amp = Math.min(1, score) * 18;
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      let y = 20;
      if (dir === "UP") {
        y = 25 - amp * t + (Math.sin(i * 0.8) * amp * 0.15);
      } else if (dir === "DOWN") {
        y = 5 + amp * t + (Math.cos(i * 0.9) * amp * 0.15);
      } else {
        y = 18 + Math.sin(i * 0.6) * amp * 0.4;
      }
      out.push({ x: (i / (n - 1)) * 100, y });
    }
    return out;
  }, [dir, score]);

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const areaPath = path + ` L 100 30 L 0 30 Z`;
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-7 w-full">
      <defs>
        <linearGradient id={`spark-${dir}-${score.toFixed(2)}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#spark-${dir}-${score.toFixed(2)})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function ProjectionChip({
  projection,
}: {
  projection: { ticker: string; direction: string; confidence: number; rationale: string };
}) {
  const dir = projection.direction?.toUpperCase();
  const color = dir === "UP" ? "#4ade80" : dir === "DOWN" ? "#ff4d6d" : "#94a3b8";
  const arrow = dir === "UP" ? "↑" : dir === "DOWN" ? "↓" : "→";
  return (
    <span
      title={projection.rationale}
      className="mono inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] tracking-wider"
      style={{ borderColor: color + "55", color, background: color + "10" }}
    >
      <span className="font-semibold">{projection.ticker}</span>
      <span>{arrow}</span>
      <span className="tabular-nums opacity-80">{Math.round((projection.confidence ?? 0) * 100)}%</span>
    </span>
  );
}

// ── 4. Memory — your radar (timeline + sector spider + déjà vu) ───────────
function MemoryAgent({ cascade, society }: { cascade: CascadeResponse; society: SocietyResponse | null; geminiExhausted: boolean }) {
  const [expanded, toggle] = useExpanded("memory", false);
  const ready = Boolean(society?.memory?.message);
  const color = "#c084fc";
  const [recent, setRecent] = useState<MemoryRecentItem[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);

  // Fetch recent history immediately on mount — needed for both the
  // collapsed summary (déjà vu + cross-reference chips) and the expanded
  // visualisations.
  useEffect(() => {
    const id = getDeviceId();
    if (!id) return;
    setLoadingRecent(true);
    api.recentMemory(id, 30)
      .then((r) => setRecent(r.items))
      .catch(() => {})
      .finally(() => setLoadingRecent(false));
  }, []);

  // Tickers from your history that ALSO appear in this cascade — high-signal
  // cross-reference for a trader who already tracks some of these names.
  const overlap = useMemo(() => {
    if (!recent.length) return [];
    const here = new Set([
      ...(cascade.root?.tickers ?? []),
      ...cascade.nodes.map((n) => n.ticker),
    ].filter(Boolean).map((t) => t.toUpperCase()));
    const counts = new Map<string, number>();
    for (const h of recent) {
      const t = (h.root_ticker || "").toUpperCase();
      if (t && here.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [recent, cascade]);

  const dejaVu = useMemo(() => computeDejaVu(cascade, recent), [cascade, recent]);
  const sectorBias = useMemo(() => computeSectorBias(recent), [recent]);

  return (
    <AgentShell
      slug="memory"
      name="Memory"
      role="context"
      color={color}
      Icon={Brain}
      source={society?.memory?._source === "gemini" ? "gemini" : "local"}
      expanded={expanded}
      toggle={toggle}
      headerBadge={
        ready ? (
          <span className="mono rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[9px] tracking-wider text-muted tabular-nums">
            history · {society?.memory?._history_size ?? recent.length}
          </span>
        ) : null
      }
      summary={
        <>
          {/* Always-on local content: déjà vu line + overlap chips */}
          {recent.length === 0 && !loadingRecent ? (
            <div className="text-text/75">First cascade on this device. Every open is logged here so future cards can cross-reference your history.</div>
          ) : (
            <div className="text-text/85">{dejaVu.label}</div>
          )}
          {overlap.length > 0 && (
            <div className="mt-2">
              <div className="mono mb-1 text-[8.5px] uppercase tracking-widest text-muted">in your history · {overlap.length} overlap</div>
              <div className="flex flex-wrap gap-1">
                {overlap.map(([t, n]) => (
                  <span
                    key={t}
                    title={`You've opened ${n} cascade${n !== 1 ? "s" : ""} with ${t} as root`}
                    className="mono inline-flex items-center gap-1 rounded-full border border-[#c084fc]/40 bg-[#c084fc]/10 px-1.5 py-0.5 text-[9.5px] tracking-wider text-[#c084fc]"
                  >
                    <span className="font-semibold">{t}</span>
                    <span className="opacity-70">×{n}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {/* Gemini commentary layers on top */}
          {ready && (
            <div className="mt-2 border-t border-white/[0.06] pt-2">
              <div className="mono mb-1 text-[8.5px] uppercase tracking-widest text-[#c084fc]/80">
                {society?.memory?._source === "gemini" ? "gemini · context" : "local · context"}
              </div>
              <TypewriterText text={society!.memory!.message} />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {(society!.memory!.tags ?? []).slice(0, 4).map((tag) => (
                  <span
                    key={tag}
                    className="mono rounded-full bg-[#c084fc]/12 px-1.5 py-0.5 text-[9px] tracking-wider text-[#c084fc]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {/* Déjà vu */}
        <div className="rounded-lg border border-[#c084fc]/20 bg-[#c084fc]/[0.04] p-2">
          <div className="mono mb-1.5 flex items-center justify-between text-[9px] uppercase tracking-widest text-[#c084fc]">
            <span>déjà vu</span>
            <span className="tabular-nums">{dejaVu.score}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.04]">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${dejaVu.score}%` }}
              transition={{ duration: 0.7, ease: "easeOut" }}
              className="h-full rounded-full bg-[#c084fc]"
            />
          </div>
          <div className="mt-1.5 text-[10.5px] leading-snug text-text/80">{dejaVu.label}</div>
        </div>

        {/* Sector affinity radar */}
        {sectorBias.length > 0 && (
          <div>
            <div className="mono mb-1.5 text-[9px] uppercase tracking-widest text-muted">sector affinity · last 30 views</div>
            <SectorRadar bias={sectorBias} color={color} />
          </div>
        )}

        {/* Timeline strip — last 14 days */}
        <div>
          <div className="mono mb-1.5 flex items-center justify-between text-[9px] uppercase tracking-widest text-muted">
            <span>14-day view timeline</span>
            <span className="tabular-nums">{recent.length} entries</span>
          </div>
          <MemoryTimeline items={recent} loading={loadingRecent} />
        </div>

        {/* Forget me */}
        <div className="flex items-center justify-between border-t border-white/[0.06] pt-2">
          <span className="mono text-[8.5px] uppercase tracking-widest text-muted/60">device-only · no account · no PII</span>
          <button
            onClick={async () => {
              const id = getDeviceId();
              if (!id) return;
              if (!window.confirm("Wipe this device's cascade history?")) return;
              try { await api.forgetMemory(id); setRecent([]); } catch {}
            }}
            className="mono inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-0.5 text-[9px] uppercase tracking-widest text-muted hover:bg-[#ff4d6d]/15 hover:text-[#ff4d6d] transition"
          >
            <Trash2 size={9} /> forget me
          </button>
        </div>
      </div>
    </AgentShell>
  );
}

function computeDejaVu(cascade: CascadeResponse, history: MemoryRecentItem[]): { score: number; label: string } {
  if (!history.length) return { score: 0, label: "No prior cascades to compare against — this is the first one." };
  const currentTickers = new Set([
    ...(cascade.root?.tickers ?? []),
    ...cascade.nodes.slice(0, 6).map((n) => n.ticker),
  ].filter(Boolean).map((t) => t.toUpperCase()));
  const currentSector = (cascade.root?.sector || "").toLowerCase();
  let best: { item: MemoryRecentItem; score: number } | null = null;
  for (const h of history) {
    const t = (h.root_ticker || "").toUpperCase();
    const s = (h.sector || "").toLowerCase();
    let score = 0;
    if (t && currentTickers.has(t)) score += 50;
    if (s && s === currentSector) score += 30;
    if (h.headline && cascade.root?.headline) {
      const a = h.headline.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const b = new Set(cascade.root.headline.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
      const overlap = a.filter((w) => b.has(w)).length;
      score += Math.min(20, overlap * 5);
    }
    if (!best || score > best.score) best = { item: h, score };
  }
  if (!best || best.score < 15) {
    return { score: best?.score ?? 0, label: "No close match in your recent history." };
  }
  const when = best.item.viewed_at ? relativeAgo(best.item.viewed_at) : "earlier";
  const head = (best.item.headline || best.item.root_ticker || "a prior cascade").trim().slice(0, 60);
  return { score: Math.min(99, best.score), label: `Looks ${Math.min(99, best.score)}% like one you opened ${when}: "${head}"` };
}

function relativeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "earlier";
  const mins = Math.max(1, Math.floor((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function computeSectorBias(history: MemoryRecentItem[]): { sector: string; count: number; pct: number }[] {
  if (!history.length) return [];
  const m = new Map<string, number>();
  for (const h of history) {
    const s = (h.sector || "Unknown").trim() || "Unknown";
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  const arr = Array.from(m.entries())
    .map(([sector, count]) => ({ sector, count, pct: Math.round((count / history.length) * 100) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  return arr;
}

function SectorRadar({ bias, color }: { bias: { sector: string; pct: number }[]; color: string }) {
  const N = Math.max(5, bias.length);
  const filled = [...bias];
  while (filled.length < N) filled.push({ sector: "", pct: 0 });
  const cx = 60, cy = 60, R = 44;
  const angle = (i: number) => (-Math.PI / 2) + (i / N) * Math.PI * 2;
  const point = (pct: number, i: number) => {
    const r = (pct / 100) * R;
    return [cx + Math.cos(angle(i)) * r, cy + Math.sin(angle(i)) * r] as const;
  };
  const polyPoints = filled.map((b, i) => point(b.pct, i).join(",")).join(" ");
  const gridPoints = (rPct: number) => filled.map((_, i) => {
    const [x, y] = [cx + Math.cos(angle(i)) * R * rPct, cy + Math.sin(angle(i)) * R * rPct];
    return `${x},${y}`;
  }).join(" ");

  return (
    <div className="flex items-center gap-3">
      <svg width="120" height="120" viewBox="0 0 120 120" className="shrink-0">
        {[0.33, 0.66, 1].map((r) => (
          <polygon key={r} points={gridPoints(r)} fill="none" stroke="rgba(255,255,255,0.06)" />
        ))}
        {filled.map((_, i) => {
          const [x, y] = [cx + Math.cos(angle(i)) * R, cy + Math.sin(angle(i)) * R];
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(255,255,255,0.05)" />;
        })}
        <motion.polygon
          points={polyPoints}
          fill={color + "33"}
          stroke={color}
          strokeWidth="1.5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6 }}
        />
      </svg>
      <ul className="flex-1 space-y-0.5">
        {bias.map((b) => (
          <li key={b.sector} className="mono flex items-center justify-between text-[10px]">
            <span className="truncate text-text/85">{b.sector || "—"}</span>
            <span className="tabular-nums text-muted">{b.pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MemoryTimeline({ items, loading }: { items: MemoryRecentItem[]; loading: boolean }) {
  // Bucket by day for last 14 days, rendering each day as a column.
  const DAYS = 14;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days: { date: Date; entries: MemoryRecentItem[] }[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    days.push({ date: d, entries: [] });
  }
  for (const it of items) {
    if (!it.viewed_at) continue;
    const t = new Date(it.viewed_at);
    const idx = days.findIndex((d) => sameDay(d.date, t));
    if (idx >= 0) days[idx].entries.push(it);
  }
  const maxCount = days.reduce((m, d) => Math.max(m, d.entries.length), 1);

  if (loading) {
    return <div className="shimmer h-12 w-full rounded-md" />;
  }
  if (!items.length) {
    return (
      <div className="rounded-lg bg-white/[0.02] p-3 text-[10.5px] text-muted/70">
        No view history yet on this device. Every cascade you open is logged here so Memory can ground its observations.
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-end gap-[3px] h-12">
        {days.map((d, i) => {
          const h = d.entries.length / maxCount;
          return (
            <div key={i} className="group relative flex-1" title={`${d.date.toLocaleDateString()} · ${d.entries.length} cascade${d.entries.length !== 1 ? "s" : ""}`}>
              <div
                className="w-full rounded-sm transition"
                style={{
                  height: `${Math.max(6, h * 100)}%`,
                  background: d.entries.length === 0 ? "rgba(255,255,255,0.04)" : "#c084fc",
                  opacity: d.entries.length === 0 ? 0.3 : 0.8,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="mono mt-1 flex justify-between text-[8px] uppercase tracking-widest text-muted/40">
        <span>-13d</span><span>-7d</span><span>today</span>
      </div>
    </div>
  );
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Typewriter — reveals text character-by-character once. Stable across
// re-renders for the same `text` so the animation doesn't restart on poll.
function TypewriterText({ text, speed = 12 }: { text: string; speed?: number }) {
  const [shown, setShown] = useState("");
  const seenRef = useRef("");
  useEffect(() => {
    if (seenRef.current === text) return;
    seenRef.current = text;
    setShown("");
    let i = 0;
    const id = setInterval(() => {
      i += 2;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [text, speed]);
  return <>{shown}</>;
}

// Lightweight ELI5 rewriter — strips jargon for a novice audience.
// In Phase 7.5 Session 5 this will be replaced by a Gemini call with
// audience=novice; for now we do a deterministic client-side simplification
// so the UI affordance is real even before the API exists.
function simplifyForEli5(text: string, cascade: CascadeResponse): string {
  const sectorBits = cascade.root.sector ? ` in ${cascade.root.sector.toLowerCase()}` : "";
  const total = cascade.nodes.length;
  return (
    `Imagine ${cascade.root.tickers[0] || "this company"}${sectorBits} sneezes. ` +
    `Because they're connected to ${total} other companies through supply-chain links, ` +
    `those companies might catch a cold too. ` +
    `The red ones are most exposed; the green ones might actually benefit. ` +
    `That's a cascade.`
  );
}

