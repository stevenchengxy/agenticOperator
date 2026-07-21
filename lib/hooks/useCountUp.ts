"use client";
import React from "react";

// Animate a number from its previous value to `target` over `durationMs`.
// Used for KPI / tab-count emphasis. Honors prefers-reduced-motion (jumps
// straight to the target). Non-finite targets pass through unchanged so a
// "…" loading placeholder upstream still works (caller guards the null case).
export function useCountUp(target: number, durationMs = 600): number {
  const [value, setValue] = React.useState(target);
  const fromRef = React.useRef(target);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!Number.isFinite(target)) {
      setValue(target);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const from = fromRef.current;
    if (reduce || from === target) {
      fromRef.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(from + (target - from) * eased);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);

  return value;
}
