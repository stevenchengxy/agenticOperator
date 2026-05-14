"use client";
import React from "react";
import { NODES } from "@/lib/workflow-graph-meta";

// Column x-coordinate → human-readable stage label.
// Each column is defined by the shared x value of all nodes in that column.
const COLUMN_LABELS: Record<number, string> = {
  100:  'START',
  320:  'REQUIREMENT INTAKE',
  620:  'JD GENERATION',
  920:  'RESUME PROCESSING',
  1220: 'MATCHING',
  1520: 'INTERVIEW & EVAL',
  1820: 'PACKAGE',
  2080: 'SUBMIT',
};

export function StageBackdrop() {
  // Derive unique x values in ascending order so labels render left-to-right.
  const columnXs = React.useMemo(
    () => [...new Set(NODES.map(n => n.x))].sort((a, b) => a - b),
    [],
  );

  return (
    <g>
      {columnXs.map(x => {
        const label = COLUMN_LABELS[x];
        if (!label) return null;
        return (
          <text
            key={x}
            x={x}
            y={30}
            textAnchor="middle"
            fontSize={10}
            letterSpacing="0.14em"
            fill="var(--c-claude-ink-4)"
            fontWeight={500}
          >
            {label}
          </text>
        );
      })}
    </g>
  );
}
