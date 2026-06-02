"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { ArrowRight, Play, Ship, Mountain, FileText, Image as ImageIcon } from "lucide-react";

const HeroGlobe = dynamic(() => import("@/components/HeroGlobe").then((m) => m.HeroGlobe), {
  ssr: false,
  loading: () => <div className="absolute inset-0" />,
});

type Stats = {
  total_events: number;
  cascade_count: number;
  sector_counts: Record<string, number>;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

const SCENARIOS = [
  {
    icon: Ship,
    label: "Ship stalls",
    title: "Container ship stalls near Kaohsiung",
    sub: "See TSM · FDX · ZIM cascade",
    replay: "ship-stall",
  },
  {
    icon: Mountain,
    label: "Quake hits",
    title: "M6.4 quake hits Taiwan",
    sub: "200km HQ radius lights up",
    replay: "taiwan-quake",
  },
  {
    icon: FileText,
    label: "8-K drops",
    title: "Apple files 8-K after hours",
    sub: "Foxconn → JBL within 48h",
    replay: "aapl-8k",
  },
  {
    icon: ImageIcon,
    label: "Pattern brush",
    title: "Drop a chart",
    sub: "Find when semis broke this pattern",
    replay: "pattern-brush",
  },
];

export default function LandingPage() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/stats?hours_back=72`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && setStats(s))
      .catch(() => {});
  }, []);

  const eventCount = stats?.total_events ?? 0;
  const sectorCount = stats ? Object.keys(stats.sector_counts ?? {}).length : 0;

  return (
    <main className="relative min-h-screen overflow-hidden bg-bg text-text">
      {/* Live globe behind the hero */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.55]">
        <HeroGlobe />
      </div>
      {/* Vignette so text reads */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 60% at 50% 45%, rgba(7,9,13,0) 0%, rgba(7,9,13,0.55) 60%, rgba(7,9,13,0.9) 100%)",
        }}
      />

      {/* Top live status pill */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="absolute inset-x-0 top-5 z-10 flex justify-center"
      >
        <div className="glass mono inline-flex items-center gap-2.5 rounded-full px-3.5 py-1.5 text-[10px] uppercase tracking-[0.25em]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" style={{ boxShadow: "0 0 10px var(--accent-glow)" }} />
          <span className="text-text">Live</span>
          <span className="text-muted/60">·</span>
          <span className="text-text tabular-nums">{eventCount.toLocaleString()} events</span>
          <span className="text-muted/60">·</span>
          <span className="text-text tabular-nums">8 sources</span>
          <span className="text-muted/60">·</span>
          <span className="text-text tabular-nums">{sectorCount || 11} sectors</span>
        </div>
      </motion.div>

      {/* Hero */}
      <div className="relative mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-6 py-24 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="text-5xl font-semibold tracking-tight sm:text-7xl"
        >
          Watch the world cascade.
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.35 }}
          className="mt-5 max-w-2xl text-base leading-relaxed text-muted sm:text-lg"
        >
          News. Ships. Quakes. Filings. Mapped as one live, breaking graph.
          See what disrupts what, the instant it does.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.5 }}
          className="mt-9 flex flex-wrap items-center justify-center gap-3"
        >
          <Link
            href="/terminal"
            className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-medium text-black shadow-[0_0_30px_var(--accent-glow)] transition hover:bg-accent/90 hover:shadow-[0_0_40px_var(--accent-glow)]"
          >
            Open terminal
            <ArrowRight size={16} />
          </Link>
          <Link
            href="/terminal?demo=1"
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.03] px-6 py-3 text-sm text-text backdrop-blur-md transition hover:bg-white/[0.08]"
          >
            <Play size={14} />
            Watch demo
          </Link>
        </motion.div>

        <p className="mt-6 text-[11px] uppercase tracking-[0.25em] text-muted/60">
          Built for traders · analysts · journalists · supply-chain ops
        </p>

        {/* Scenario cards */}
        <div className="mt-16 grid w-full max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SCENARIOS.map((s, i) => {
            const Icon = s.icon;
            return (
              <motion.div
                key={s.replay}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.7 + i * 0.07 }}
              >
                <Link
                  href={`/terminal?replay=${s.replay}`}
                  className="group glass block rounded-xl px-4 py-4 text-left transition hover:bg-white/[0.06]"
                >
                  <div className="flex items-center gap-2 text-accent">
                    <Icon size={14} />
                    <span className="mono text-[10px] uppercase tracking-[0.25em]">{s.label}</span>
                  </div>
                  <div className="mt-2 text-[13px] font-medium leading-snug text-text">
                    {s.title}
                  </div>
                  <div className="mt-1 text-[11px] text-muted">{s.sub}</div>
                  <div className="mt-3 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted/70 transition group-hover:text-accent">
                    Try it
                    <ArrowRight size={10} className="transition group-hover:translate-x-0.5" />
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Bottom infra credit */}
      <div className="absolute inset-x-0 bottom-4 z-10 flex justify-center">
        <p className="mono text-[9px] uppercase tracking-[0.3em] text-muted/40">
          MongoDB Atlas · Vertex AI Gemini · Voyage AI · Google ADK · Vercel
        </p>
      </div>
    </main>
  );
}
