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

/** Compute a cubic bezier path string between two points.
 *  For mostly-horizontal edges, bend the control points horizontally.
 *  For mostly-vertical edges, bend vertically. */
function bezierPath(f: { x: number; y: number }, t: { x: number; y: number }): string {
  const dx = t.x - f.x;
  const dy = t.y - f.y;
  let c1x: number, c1y: number, c2x: number, c2y: number;
  if (Math.abs(dy) > Math.abs(dx)) {
    // Mostly vertical — bend control points vertically
    c1x = f.x;
    c1y = f.y + dy * 0.35;
    c2x = t.x;
    c2y = t.y - dy * 0.35;
  } else {
    // Mostly horizontal — bend control points horizontally
    c1x = f.x + dx * 0.35;
    c1y = f.y;
    c2x = t.x - dx * 0.35;
    c2y = t.y;
  }
  return `M ${f.x} ${f.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${t.x} ${t.y}`;
}

export function MonitorEdge({ edge, fromNode, toNode, agg, isTrailEdge, isTrailMode }: Props) {
  const f = endpoint(fromNode);
  const t = endpoint(toNode);
  const count = agg?.countInWindow ?? 0;

  // Stroke width: trail mode uses a 2-tier scale; aggregate mode uses density
  const strokeWidth = isTrailMode
    ? (isTrailEdge ? 2.5 : 1.0)
    : (count >= 100 ? 2.5 : count >= 10 ? 2.0 : 1.5);

  // Stroke color: trail-traversed edges get the accent; all others use ink-4 (visible on warm bg)
  const stroke = isTrailEdge
    ? "var(--c-claude-accent)"
    : "var(--c-claude-ink-4)";

  // Untouched edges in trail mode fade out
  const opacity = isTrailMode && !isTrailEdge ? 0.25 : 1;

  const d = bezierPath(f, t);

  // Label chip sizing: rough per-char width + padding
  const mid = { x: (f.x + t.x) / 2, y: (f.y + t.y) / 2 };
  const labelW = edge.label ? edge.label.length * 7 + 8 : 0;

  // Marker reference: accent variant for trail edges, regular otherwise
  const markerEnd = isTrailEdge
    ? "url(#monitor-arrowhead-accent)"
    : "url(#monitor-arrowhead)";

  return (
    <g opacity={opacity}>
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={edge.dashed ? "5 4" : undefined}
        markerEnd={markerEnd}
      />
      {/* Density animation: a small dot travels along the bezier if count > 0 (aggregate mode only) */}
      {count > 0 && !isTrailMode && (
        <circle r={3} fill="var(--c-claude-accent)">
          <animateMotion
            dur={`${Math.max(2, 8 - Math.log10(count))}s`}
            repeatCount="indefinite"
            path={d}
          />
        </circle>
      )}
      {edge.label && (
        <g>
          <rect
            x={mid.x - labelW / 2}
            y={mid.y - 8}
            width={labelW}
            height={14}
            rx={3}
            fill="var(--c-claude-surface)"
            stroke="var(--c-claude-line)"
            strokeWidth={0.5}
          />
          <text
            x={mid.x}
            y={mid.y + 3}
            fontSize={10}
            textAnchor="middle"
            fill="var(--c-claude-ink-2)"
          >
            {edge.label}
          </text>
        </g>
      )}
    </g>
  );
}
