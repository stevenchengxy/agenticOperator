"use client";
import React from "react";
import clsx from "clsx";
import type { WorkflowNode } from "@/lib/workflow-graph-meta";
import type { MonitorNodeAgg, NodeStatus } from "@/lib/monitor/types";

const STATUS_FILL: Record<NodeStatus, string> = {
  idle:     "var(--c-claude-panel)",
  healthy:  "var(--c-claude-surface)",
  degraded: "color-mix(in oklch, var(--c-claude-warn) 18%, var(--c-claude-surface))",
  failing:  "color-mix(in oklch, var(--c-claude-err) 22%, var(--c-claude-surface))",
};
const STATUS_STROKE: Record<NodeStatus, string> = {
  idle:     "var(--c-claude-line)",
  healthy:  "var(--c-claude-line)",
  degraded: "var(--c-claude-warn)",
  failing:  "var(--c-claude-err)",
};

const NODE_W = 154;
const NODE_H = 64;

const TRAIL_FILL = {
  success: "color-mix(in oklch, var(--c-claude-ok) 22%, var(--c-claude-surface))",
  failure: "color-mix(in oklch, var(--c-claude-err) 22%, var(--c-claude-surface))",
  pending: "color-mix(in oklch, var(--c-claude-warn) 22%, var(--c-claude-surface))",
  skipped: "var(--c-claude-panel)",
};
const TRAIL_STROKE = {
  success: "var(--c-claude-ok)",
  failure: "var(--c-claude-err)",
  pending: "var(--c-claude-warn)",
  skipped: "var(--c-claude-line)",
};

type TrailEntry = { result: 'success' | 'failure' | 'pending' | 'skipped'; current: boolean };

type Props = {
  node: WorkflowNode;
  agg?: MonitorNodeAgg;
  onClick?: () => void;
  onRunningClick?: () => void;
  onHitlClick?: () => void;
  onQueueClick?: () => void;
  /** When set, this node was touched by the run and should render with trail colors. */
  trailEntry?: TrailEntry;
  /** When true, aggregate badges (running/hitl/queue) are hidden and untouched nodes are greyed. */
  isTrailMode?: boolean;
};

export function MonitorNode({ node, agg, onClick, onRunningClick, onHitlClick, onQueueClick, trailEntry, isTrailMode }: Props) {
  const status = agg?.status ?? "idle";
  const running = agg?.running ?? 0;
  const hitl = agg?.hitlPending ?? 0;
  const queue = agg?.queueDepth ?? 0;

  // Trail mode overrides fill/stroke colors
  const fill   = trailEntry ? TRAIL_FILL[trailEntry.result]   : STATUS_FILL[status];
  const stroke = trailEntry ? TRAIL_STROKE[trailEntry.result] : STATUS_STROKE[status];
  const strokeWidth = trailEntry
    ? (trailEntry.result === 'failure' || trailEntry.result === 'pending' ? 1.5 : 1)
    : (status === "idle" || status === "healthy" ? 1 : 1.5);

  // Untouched nodes in trail mode: dim to 30% opacity
  const opacity = isTrailMode && !trailEntry ? 0.3 : 1;

  // Pulsing: aggregate mode uses agg.pulse; trail mode pulses the current pending node
  const shouldPulse = trailEntry?.current || agg?.pulse;

  return (
    <g
      transform={`translate(${node.x - NODE_W / 2}, ${node.y - NODE_H / 2})`}
      onClick={onClick}
      opacity={opacity}
      className={clsx(onClick && "cursor-pointer", shouldPulse && "monitor-pulse")}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={10}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      <text x={10} y={20} fontSize={12.5} fontWeight={500} fill="var(--c-claude-ink-1)">
        {node.title}
      </text>
      {/* Aggregate badges: only rendered in aggregate mode (not trail mode) */}
      {!isTrailMode && (
        <g transform="translate(10, 38)">
          {running > 0 && (
            <g
              onClick={(e) => { e.stopPropagation(); onRunningClick?.(); }}
              className={clsx(onRunningClick && "cursor-pointer")}
            >
              <rect width={36} height={18} rx={9} fill="var(--c-claude-accent-bg)" />
              <text x={18} y={13} fontSize={11} textAnchor="middle" fill="var(--c-claude-accent)" fontWeight={500}>
                {running} ▶
              </text>
            </g>
          )}
          {hitl > 0 && (
            <g
              transform={`translate(${running > 0 ? 42 : 0}, 0)`}
              onClick={(e) => { e.stopPropagation(); onHitlClick?.(); }}
              className={clsx(onHitlClick && "cursor-pointer")}
            >
              <rect width={32} height={18} rx={9} fill="color-mix(in oklch, var(--c-claude-warn) 22%, transparent)" />
              <text x={16} y={13} fontSize={11} textAnchor="middle" fill="var(--c-claude-warn)" fontWeight={500}>
                {hitl} ⏸
              </text>
            </g>
          )}
          {queue > 0 && (
            <g
              transform={`translate(${(running > 0 ? 42 : 0) + (hitl > 0 ? 36 : 0)}, 0)`}
              onClick={(e) => { e.stopPropagation(); onQueueClick?.(); }}
              className={clsx(onQueueClick && "cursor-pointer")}
            >
              <rect width={36} height={18} rx={9} fill="var(--c-claude-panel)" />
              <text x={18} y={13} fontSize={11} textAnchor="middle" fill="var(--c-claude-ink-2)" fontWeight={500}>
                Q {queue}
              </text>
            </g>
          )}
        </g>
      )}
      {/* Trail mode: show result indicator text below the title */}
      {isTrailMode && trailEntry && (
        <text x={10} y={50} fontSize={10.5} fill={TRAIL_STROKE[trailEntry.result]} opacity={0.9}>
          {trailEntry.result}{trailEntry.current ? " (running)" : ""}
        </text>
      )}
    </g>
  );
}
