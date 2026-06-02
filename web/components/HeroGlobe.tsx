"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";

const GlobeGL = dynamic(() => import("react-globe.gl"), { ssr: false });

// Pre-baked HQ coordinates for hero globe pulses (no API call needed).
const SAMPLE_HQS = [
  { lat: 37.3349, lng: -122.0090, color: "#ff4d6d" }, // Apple
  { lat: 24.7740, lng: 120.9982, color: "#fbbf24" }, // TSMC
  { lat: 47.6228, lng: -122.3375, color: "#60a5fa" }, // Amazon
  { lat: 1.3521, lng: 103.8198, color: "#4ade80" },  // Singapore port
  { lat: 51.5074, lng: -0.1278, color: "#60a5fa" },  // London
  { lat: 35.6762, lng: 139.6503, color: "#fbbf24" }, // Tokyo
  { lat: 22.3193, lng: 114.1694, color: "#ff4d6d" }, // Hong Kong
  { lat: 40.7128, lng: -74.0060, color: "#4ade80" }, // NYC
  { lat: 52.5200, lng: 13.4050, color: "#60a5fa" },  // Berlin
  { lat: -23.5505, lng: -46.6333, color: "#fbbf24" }, // São Paulo
  { lat: 19.0760, lng: 72.8777, color: "#ff4d6d" },  // Mumbai
  { lat: 31.2304, lng: 121.4737, color: "#fbbf24" }, // Shanghai
];

const SAMPLE_ARCS = [
  { startLat: 37.3349, startLng: -122.0090, endLat: 24.7740, endLng: 120.9982, color: "#ff4d6d" },
  { startLat: 24.7740, startLng: 120.9982, endLat: 22.3193, endLng: 114.1694, color: "#fbbf24" },
  { startLat: 40.7128, startLng: -74.0060, endLat: 51.5074, endLng: -0.1278, color: "#60a5fa" },
  { startLat: 47.6228, startLng: -122.3375, endLat: 35.6762, endLng: 139.6503, color: "#4ade80" },
  { startLat: 1.3521, startLng: 103.8198, endLat: 22.3193, endLng: 114.1694, color: "#fbbf24" },
];

export function HeroGlobe() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<any>(null);
  const [size, setSize] = useState({ width: 800, height: 800 });

  useEffect(() => {
    const measure = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const d = Math.min(rect.width, rect.height);
      setSize({ width: d, height: d });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    const g = globeRef.current;
    if (!g?.controls) return;
    const c = g.controls();
    c.autoRotate = true;
    c.autoRotateSpeed = 0.25;
    c.enableZoom = false;
    c.enablePan = false;
    c.enableRotate = false;
  }, []);

  const points = useMemo(
    () =>
      SAMPLE_HQS.map((p) => ({
        ...p,
        altitude: 0.01,
        radius: 0.6,
      })),
    []
  );

  const rings = useMemo(
    () =>
      SAMPLE_HQS.slice(0, 6).map((p, i) => ({
        lat: p.lat,
        lng: p.lng,
        color: p.color,
        maxR: 3,
        period: 2200 + i * 250,
      })),
    []
  );

  return (
    <div ref={containerRef} className="grid h-full w-full place-items-center">
      <GlobeGL
        ref={globeRef}
        width={size.width}
        height={size.height}
        backgroundColor="rgba(0,0,0,0)"
        globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
        showAtmosphere
        atmosphereColor="#3b82f6"
        atmosphereAltitude={0.22}
        pointsData={points}
        pointAltitude={(d: any) => d.altitude}
        pointColor={(d: any) => d.color}
        pointRadius={(d: any) => d.radius}
        pointResolution={6}
        arcsData={SAMPLE_ARCS}
        arcColor={(d: any) => d.color}
        arcStroke={0.4}
        arcDashLength={0.35}
        arcDashGap={0.15}
        arcDashAnimateTime={2400}
        arcAltitudeAutoScale={0.5}
        ringsData={rings}
        ringColor={(d: any) => () => d.color}
        ringMaxRadius={(d: any) => d.maxR}
        ringPropagationSpeed={2}
        ringRepeatPeriod={(d: any) => d.period}
      />
    </div>
  );
}
