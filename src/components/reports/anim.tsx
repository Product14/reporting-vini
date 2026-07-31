"use client";

/* Small, dependency-free motion primitives shared across the live/training report designs. Motion is
 * triggered when an element SCROLLS INTO VIEW (not on mount) — otherwise it fires during the client data
 * fetch and finishes before anyone's looking. So numbers roll up and bars grow in as you reach them, and
 * anything already on screen animates right after paint. All respect prefers-reduced-motion (jump to final). */

import React from "react";

const easeOut = (p: number) => 1 - Math.pow(1 - p, 3); // fast start, gentle settle

/* Fire once, the first time the ref'd element intersects the viewport. Falls back to "in view" when
 * IntersectionObserver is unavailable (SSR/older engines). */
export function useInView<T extends Element = HTMLElement>(threshold = 0.35): readonly [React.RefObject<T | null>, boolean] {
  const ref = React.useRef<T | null>(null);
  const [inView, setInView] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setInView(true); io.disconnect(); } },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return [ref, inView] as const;
}

/* Count a number up from 0 → value the first time it scrolls into view. `format` renders each frame, so
 * callers keep full control of "%", " leads", thousands separators, durations, etc. */
export function CountUp({
  value,
  format = (n: number) => Math.round(n).toLocaleString(),
  durationMs = 1100,
  className,
  style,
}: {
  value: number;
  format?: (n: number) => string;
  durationMs?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [ref, inView] = useInView<HTMLSpanElement>(0.5);
  const [display, setDisplay] = React.useState(0);
  React.useEffect(() => {
    if (!inView) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (reduce || !Number.isFinite(value)) { setDisplay(value); return; }
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      setDisplay(value * easeOut(p));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value, durationMs]);
  return <span ref={ref} className={className} style={style}>{format(display)}</span>;
}
