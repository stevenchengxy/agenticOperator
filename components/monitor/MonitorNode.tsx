"use client";
import React from "react";
import clsx from "clsx";
import type { WorkflowNode } from "@/lib/workflow-graph-meta";
import type { MonitorNodeAgg, NodeStatus } from "@/lib/monitor/types";
import { getAgentDescription } from "@/lib/monitor/agent-descriptions";
import { useApp } from "@/lib/i18n";

const STATUS_FILL: Record<NodeStatus, string> = {
  idle:     "var(--c-claude-panel)",
  healthy:  "var(--c-claude-surface)",
  degraded: "color-mix(in oklch, var(--c-claude-warn) 22%, var(--c-claude-surface))",
  failing:  "color-mix(in oklch, var(--c-claude-err) 28%, var(--c-claude-surface))",
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
  /** When true, this node's detail panel is open — render with stronger accent outline. */
  selected?: boolean;
};

export function MonitorNode({ node, agg, onClick, onRunningClick, onHitlClick, onQueueClick, trailEntry, isTrailMode, selected }: Props) {
  const { t } = useApp();
  const status = agg?.status ?? "idle";
  const running = agg?.running ?? 0;
  const hitl = agg?.hitlPending ?? 0;
  const queue = agg?.queueDepth ?? 0;

  // Resolve tooltip text: use agent description if available, fallback to sub / title
  const canonicalShort = node.agentName ?? node.title;
  const desc = getAgentDescription(canonicalShort);
  const tooltipText = desc?.description ?? node.sub ?? node.title;

  // Deployment status (only present on WorkflowNode v2+; default to 'stubbed')
  const deployment = (node as WorkflowNode).deployment ?? 'stubbed';

  // Trail mode overrides fill/stroke colors
  const fill   = trailEntry ? TRAIL_FILL[trailEntry.result]   : STATUS_FILL[status];
  // Selected node gets accent outline regardless of status/trail.
  // Conceptual (Human) nodes get a dashed stroke to indicate no Inngest function.
  const stroke = selected
    ? "var(--c-claude-accent)"
    : (trailEntry ? TRAIL_STROKE[trailEntry.result] : STATUS_STROKE[status]);
  const strokeWidth = selected
    ? 2
    : trailEntry
      ? (trailEntry.result === 'failure' || trailEntry.result === 'pending' ? 1.5 : 1)
      : (status === "idle" || status === "healthy" ? 1 : 1.5);
  // Conceptual nodes: use "4 4" dash pattern (clearer than "4 3") to distinguish Human actors
  const strokeDasharray = !selected && !trailEntry && deployment === 'conceptual'
    ? '4 4'
    : undefined;

  // Untouched nodes in trail mode: dim to 30% opacity
  const opacity = isTrailMode && !trailEntry ? 0.3 : 1;

  // Pulsing: aggregate mode uses agg.pulse; trail mode pulses the current pending node
  const shouldPulse = trailEntry?.current || agg?.pulse;

  // Running shimmer: applied as a class on the <g> so the CSS selector
  // `[data-style="claude"] .monitor-node-running rect.shimmer` can target it.
  const isRunning = running > 0 && !isTrailMode;

  return (
    <g
      data-node-clickable="true"
      transform={`translate(${node.x - NODE_W / 2}, ${node.y - NODE_H / 2})`}
      onClick={onClick}
      opacity={opacity}
      className={clsx(
        onClick && "cursor-pointer",
        shouldPulse && "monitor-pulse",
        isRunning && "monitor-node-running",
      )}
    >
      {/* Native SVG tooltip — appears after ~1s hover, lightweight, no JS state */}
      <title>{tooltipText}</title>
      {selected && (
        <rect
          x={-3}
          y={-3}
          width={NODE_W + 6}
          height={NODE_H + 6}
          rx={13}
          fill="none"
          stroke="var(--c-claude-accent)"
          strokeWidth={1}
          opacity={0.25}
        />
      )}
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={10}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray}
      />
      {/* Shimmer overlay for running nodes — marching dashed accent outline */}
      {isRunning && (
        <rect
          className="shimmer"
          x={-1}
          y={-1}
          width={NODE_W + 2}
          height={NODE_H + 2}
          rx={11}
        />
      )}
      {/* Deployed indicator: green dot + LIVE badge at top-right corner */}
      {deployment === 'deployed' && (
        <g transform={`translate(${NODE_W - 38}, -6)`}>
          <rect width={34} height={14} rx={7} fill="var(--c-claude-ok)" opacity={0.9} />
          <circle cx={7} cy={7} r={3} fill="white" />
          <text x={13} y={10.5} fontSize={8.5} fontWeight={700} fill="white" letterSpacing={0.5}>
            {t('monitor_node_deployment_deployed')}
          </text>
        </g>
      )}
      <text x={10} y={20} fontSize={13.5} fontWeight={500} fill="var(--c-claude-ink-1)">
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
              <rect width={46} height={20} rx={10} fill="var(--c-claude-accent-bg)" />
              <text x={23} y={14} fontSize={13} fontWeight={700} textAnchor="middle" fill="var(--c-claude-accent)">
                {running} ▶
              </text>
            </g>
          )}
          {hitl > 0 && (
            <g
              transform={`translate(${running > 0 ? 52 : 0}, 0)`}
              onClick={(e) => { e.stopPropagation(); onHitlClick?.(); }}
              className={clsx(onHitlClick && "cursor-pointer")}
            >
              <rect width={34} height={20} rx={10} fill="color-mix(in oklch, var(--c-claude-warn) 22%, transparent)" />
              <text x={17} y={14} fontSize={11} textAnchor="middle" fill="var(--c-claude-warn)" fontWeight={500}>
                {hitl} ⏸
              </text>
            </g>
          )}
          {queue > 0 && (
            <g
              transform={`translate(${(running > 0 ? 52 : 0) + (hitl > 0 ? 40 : 0)}, 0)`}
              onClick={(e) => { e.stopPropagation(); onQueueClick?.(); }}
              className={clsx(onQueueClick && "cursor-pointer")}
            >
              <rect width={38} height={20} rx={10} fill="var(--c-claude-panel)" />
              <text x={19} y={14} fontSize={11} textAnchor="middle" fill="var(--c-claude-ink-2)" fontWeight={500}>
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
      {/* Human actor badge: bottom-right corner of conceptual (actor=Human) nodes */}
      {deployment === 'conceptual' && (
        <g transform={`translate(${NODE_W - 38}, ${NODE_H - 14})`}>
          <rect width={34} height={11} rx={5} fill="var(--c-claude-panel)" stroke="var(--c-claude-line)" strokeWidth={0.5} />
          <text x={17} y={8} fontSize={8} textAnchor="middle" fill="var(--c-claude-ink-3)" letterSpacing="0.06em">HUMAN</text>
        </g>
      )}
    </g>
  );
}
