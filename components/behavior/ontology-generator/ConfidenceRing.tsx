"use client";
import React from "react";

// SVG ring gauge for an inferred agent's confidence. The arc stroke draws in on
// mount via the `.og-ring-arc` transition (reduced-motion safe). Green ≥ 90,
// amber otherwise — mirrors the rule-check gauge vocabulary.
export function ConfidenceRing({
  value,
  size = 64,
  stroke = 5,
  showLabel = true,
}: {
  value: number;
  size?: number;
  stroke?: number;
  showLabel?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const color = pct >= 90 ? "var(--c-ok)" : "oklch(0.7 0.15 75)";

  const [drawn, setDrawn] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const offset = drawn ? circ * (1 - pct / 100) : circ;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--c-line)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          className="og-ring-arc"
        />
      </svg>
      {showLabel && (
        <span
          className="absolute mono font-semibold"
          style={{ color, fontSize: size * 0.26 }}
        >
          {pct}%
        </span>
      )}
    </div>
  );
}
