"use client";
import React from "react";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-graph-meta";
import type { MonitorEdgeAgg } from "@/lib/monitor/types";

type Props = {
  edge: WorkflowEdge;
  fromNode: WorkflowNode;
  toNode: WorkflowNode;
  agg?: MonitorEdgeAgg;
  /** True when both endpoints were touched by the current run trail. */
  isTrailEdge?: boolean;
  /** True when rendering in trail mode (suppresses density animation). */
  isTrailMode?: boolean;
};

function endpoint(n: WorkflowNode) {
  return { x: n.x, y: n.y };
}

export function MonitorEdge({ edge, fromNode, toNode, agg, isTrailEdge, isTrailMode }: Props) {
  const f = endpoint(fromNode);
  const t = endpoint(toNode);
  // Simple straight line; dash + label match the original /workflow look.
  // Density: stroke-width grows with countInWindow.
  const count = agg?.countInWindow ?? 0;
  // In trail mode, touched edges are bolder; untouched are faint.
  const strokeWidth = isTrailMode
    ? (isTrailEdge ? 2.0 : 0.5)
    : (count >= 100 ? 2.2 : count >= 10 ? 1.6 : 1);
  const stroke = isTrailMode && !isTrailEdge
    ? "var(--c-claude-line)"
    : "var(--c-claude-line)";

  const mid = { x: (f.x + t.x) / 2, y: (f.y + t.y) / 2 };

  return (
    <g>
      <line
        x1={f.x} y1={f.y} x2={t.x} y2={t.y}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={edge.dashed ? "5 4" : undefined}
      />
      {/* Density animation: a small dot travels along the edge if count>0 (aggregate mode only) */}
      {count > 0 && !isTrailMode && (
        <circle r={3} fill="var(--c-claude-accent)">
          <animateMotion
            dur={`${Math.max(2, 8 - Math.log10(count))}s`}
            repeatCount="indefinite"
            path={`M${f.x},${f.y} L${t.x},${t.y}`}
          />
        </circle>
      )}
      {edge.label && (
        <text
          x={mid.x}
          y={mid.y - 6}
          fontSize={10.5}
          fill="var(--c-claude-ink-3)"
          textAnchor="middle"
        >
          {edge.label}
        </text>
      )}
    </g>
  );
}
