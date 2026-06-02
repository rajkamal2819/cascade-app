"use client";

import { Globe2, Sparkles, TrendingDown, TrendingUp, Minus, MapPin } from "lucide-react";
import type { CascadeResponse, GeoCascadeMeta } from "@/lib/api";
import { useStore } from "@/lib/store";

// Rendered above the related-nodes list when the cascade was built via
// Gemini 2.5 Pro impact hypothesis (tickerless events: geopolitics,
// natural disaster, macro, regulatory). Surfaces the structured fields
// that the semantic vector-search fallback can't: affected regions, sector
// exposure, transmission mechanism, historical analog.
//
// The L1 ticker nodes themselves render through the existing related-list
// renderer in Cascade.tsx — this panel is the *why* layer above them.

const ROLE_LABEL: Record<string, string> = {
  manufacturing_hub: "Manufacturing hub",
  logistics_chokepoint: "Logistics chokepoint",
  exporter: "Exporter",
  consumer: "Consumer market",
  other: "Region",
};

const EXPOSURE_LABEL: Record<string, string> = {
  supply_disruption: "Supply disruption",
  demand_shock: "Demand shock",
  price_spike: "Price spike",
  regulatory: "Regulatory",
  currency: "FX",
  other: "Exposure",
};

function DirectionIcon({ d }: { d?: number }) {
  if (d === 1) return <TrendingUp size={11} className="text-accent" />;
  if (d === -1) return <TrendingDown size={11} className="text-critical" />;
  return <Minus size={11} className="text-muted" />;
}

const ARC_MODE_LABEL: Record<string, string> = {
  all: "arcs · all",
  primary: "arcs · primary",
  off: "arcs · off",
};

export function GeoCascadePanel({ cascade }: { cascade: CascadeResponse }) {
  const geo: GeoCascadeMeta | null | undefined = cascade.geo_cascade;
  const geoArcMode = useStore((s) => s.geoArcMode);
  const cycleGeoArcMode = useStore((s) => s.cycleGeoArcMode);
  if (!geo) return null;
  const mappedRegions = geo.regions.filter(
    (r) => typeof r.lat === "number" && typeof r.lon === "number",
  ).length;

  return (
    <div className="border-b border-white/5 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Sparkles size={11} className="text-accent" />
        <span className="mono text-[9px] uppercase tracking-[0.22em] text-accent">
          Gemini Geo-Cascade
        </span>
        {geo.model && (
          <span className="mono rounded bg-white/5 px-1 py-px text-[8px] uppercase text-muted">
            {geo.model.replace("gemini-", "")}
          </span>
        )}
        {geo.time_horizon && (
          <span className="ml-auto mono text-[9px] uppercase tracking-widest text-muted">
            horizon · {geo.time_horizon}
          </span>
        )}
      </div>

      {/* Transmission mechanism — the headline narrative */}
      {geo.transmission_mechanism && (
        <div className="mb-3 rounded border border-accent/15 bg-accent/[0.04] p-2.5">
          <div className="mono mb-1 text-[8px] uppercase tracking-widest text-accent/80">
            Transmission
          </div>
          <div className="text-[11px] leading-relaxed text-text/90">
            {geo.transmission_mechanism}
          </div>
        </div>
      )}

      {/* Regions */}
      {geo.regions.length > 0 && (
        <div className="mb-2.5">
          <div className="mono mb-1 flex items-center justify-between gap-1 text-[8px] uppercase tracking-widest text-muted">
            <span className="flex items-center gap-1">
              <Globe2 size={9} /> Regions
              {mappedRegions > 0 && (
                <span className="ml-1 text-accent/70">· {mappedRegions} mapped</span>
              )}
            </span>
            {mappedRegions > 0 && (
              <button
                onClick={cycleGeoArcMode}
                className="mono inline-flex items-center gap-1 rounded border border-accent/25 bg-accent/[0.06] px-1.5 py-0.5 text-[8px] uppercase tracking-widest text-accent transition hover:bg-accent/10"
                title="Toggle globe arc density"
              >
                <MapPin size={8} />
                {ARC_MODE_LABEL[geoArcMode]}
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {geo.regions.map((r, i) => {
              const mapped = typeof r.lat === "number" && typeof r.lon === "number";
              return (
                <span
                  key={`${r.name}-${i}`}
                  className="mono inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px]"
                  title={
                    mapped
                      ? `${ROLE_LABEL[r.role || "other"] || r.role} · ${r.lat?.toFixed(2)}, ${r.lon?.toFixed(2)}`
                      : ROLE_LABEL[r.role || "other"] || r.role
                  }
                >
                  {mapped && <MapPin size={8} className="text-accent/70" />}
                  <span className="text-text">{r.name}</span>
                  {r.role && r.role !== "other" && (
                    <span className="text-muted">· {ROLE_LABEL[r.role] || r.role}</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Sectors */}
      {geo.sectors.length > 0 && (
        <div className="mb-2.5">
          <div className="mono mb-1 text-[8px] uppercase tracking-widest text-muted">
            Sector exposure
          </div>
          <div className="flex flex-wrap gap-1.5">
            {geo.sectors.map((s, i) => {
              const c = Math.round((s.confidence ?? 0.5) * 100);
              return (
                <span
                  key={`${s.name}-${i}`}
                  className="mono inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px]"
                >
                  <span className="text-text">{s.name}</span>
                  <span className="text-muted">
                    · {EXPOSURE_LABEL[s.exposure || "other"] || s.exposure}
                  </span>
                  <span className="text-accent/80">{c}%</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Historical analog */}
      {geo.historical_analog && (
        <div className="mono mt-2 text-[10px] text-muted">
          <span className="uppercase tracking-widest text-muted/70">Analog · </span>
          <span className="text-text/80">{geo.historical_analog}</span>
        </div>
      )}
    </div>
  );
}

/** Per-node mechanism chip — slots into the related-list row when present. */
export function GeoNodeMechanism({ node }: { node: { why?: string; direction?: number } }) {
  if (!node.why) return null;
  return (
    <span className="mt-1 inline-flex items-start gap-1 text-[10px] leading-snug text-muted">
      <DirectionIcon d={node.direction} />
      <span className="flex-1">{node.why}</span>
    </span>
  );
}
