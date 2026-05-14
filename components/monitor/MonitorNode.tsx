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

type Props = {
  node: WorkflowNode;
  agg?: MonitorNodeAgg;
  onClick?: () => void;
  onRunningClick?: () => void;
  onHitlClick?: () => void;
  onQueueClick?: () => void;
};

export function MonitorNode({ node, agg, onClick, onRunningClick, onHitlClick, onQueueClick }: Props) {
  const status = agg?.status ?? "idle";
  const running = agg?.running ?? 0;
  const hitl = agg?.hitlPending ?? 0;
  const queue = agg?.queueDepth ?? 0;
  return (
    <g
      transform={`translate(${node.x - NODE_W / 2}, ${node.y - NODE_H / 2})`}
      onClick={onClick}
      className={clsx(onClick && "cursor-pointer", agg?.pulse && "monitor-pulse")}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={10}
        fill={STATUS_FILL[status]}
        stroke={STATUS_STROKE[status]}
        strokeWidth={status === "idle" || status === "healthy" ? 1 : 1.5}
      />
      <text x={10} y={20} fontSize={12.5} fontWeight={500} fill="var(--c-claude-ink-1)">
        {node.title}
      </text>
      {/* Aggregate badges, only rendered when meaningful */}
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
    </g>
  );
}
