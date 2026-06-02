"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Side = "left" | "right";

const MIN = 280;
const MAX = 560;

/**
 * A floating rail that can be resized by dragging an edge handle.
 * Width persists to localStorage under `cascade-rail-{side}`.
 */
export function ResizableRail({
  side,
  defaultWidth,
  children,
  className = "",
}: {
  side: Side;
  defaultWidth: number;
  children: React.ReactNode;
  className?: string;
}) {
  const storageKey = `cascade-rail-${side}`;
  const [width, setWidth] = useState(defaultWidth);
  const [dragging, setDragging] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Restore persisted width on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n) && n >= MIN && n <= MAX) setWidth(n);
    } catch {}
  }, [storageKey]);

  const persist = useCallback(
    (w: number) => {
      try {
        localStorage.setItem(storageKey, String(w));
      } catch {}
    },
    [storageKey],
  );

  // Pointer drag.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (ev: PointerEvent) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      // For the left rail, width = pointerX - rect.left.
      // For the right rail, width = rect.right - pointerX.
      const next = side === "left" ? ev.clientX - rect.left : rect.right - ev.clientX;
      const clamped = Math.max(MIN, Math.min(MAX, next));
      setWidth(clamped);
    };
    const onUp = () => {
      setDragging(false);
      persist(width);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, side, persist, width]);

  return (
    <div ref={wrapperRef} className={"relative " + className} style={{ width }}>
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${side} panel`}
        onPointerDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => {
          setWidth(defaultWidth);
          persist(defaultWidth);
        }}
        className={"resize-handle " + (dragging ? "dragging " : "") + (side === "left" ? "-right-1" : "-left-1")}
        style={side === "left" ? { right: -4 } : { left: -4 }}
      />
    </div>
  );
}
