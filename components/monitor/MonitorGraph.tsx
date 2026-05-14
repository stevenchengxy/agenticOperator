"use client";
import React from "react";
import {
  GRAPH_VIEWBOX,
  GRAPH_WIDTH,
  GRAPH_HEIGHT,
  NODES,
  EDGES,
  nodeById,
} from "@/lib/workflow-graph-meta";
import type {
  MonitorNodeAgg,
  MonitorEdgeAgg,
} from "@/lib/monitor/types";
import { MonitorNode } from "./MonitorNode";
import { MonitorEdge } from "./MonitorEdge";
import { StageBackdrop } from "./StageBackdrop";
import { NodeStateLegend } from "./NodeStateLegend";

type TrailEntry = { result: 'success' | 'failure' | 'pending' | 'skipped'; current: boolean };

type Props = {
  nodeAggs?: MonitorNodeAgg[];
  edgeAggs?: MonitorEdgeAgg[];
  onNodeClick?: (nodeId: string) => void;
  onRunningClick?: (nodeId: string) => void;
  onHitlClick?: (nodeId: string) => void;
  onQueueClick?: (nodeId: string) => void;
  /** Trail map for run-detail mode. When provided, nodes switch to trail-colored rendering. */
  trail?: Map<string, TrailEntry>;
  /** The node whose detail panel is currently open. */
  selectedNodeId?: string | null;
  /** Override the SVG rendered height (defaults to GRAPH_HEIGHT). */
  graphHeight?: number;
};

export function MonitorGraph({ nodeAggs, edgeAggs, onNodeClick, onRunningClick, onHitlClick, onQueueClick, trail, selectedNodeId, graphHeight }: Props) {
  const aggByName = new Map((nodeAggs ?? []).map(a => [a.name, a]));
  const edgeAggByKey = new Map((edgeAggs ?? []).map(e => [`${e.from}->${e.to}`, e]));
  const isTrailMode = trail != null;

  return (
    <div className="w-full overflow-auto rounded-[12px] border border-claude-line bg-claude-surface relative">
      <svg
        viewBox={GRAPH_VIEWBOX}
        width="100%"
        height={graphHeight ?? GRAPH_HEIGHT}
        preserveAspectRatio="xMidYMid meet"
        style={{ minWidth: GRAPH_WIDTH }}
      >
        <defs>
          {/* Regular arrowhead for normal edges */}
          <marker
            id="monitor-arrowhead"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--c-claude-ink-4)" />
          </marker>
          {/* Accent arrowhead for trail-traversed edges */}
          <marker
            id="monitor-arrowhead-accent"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--c-claude-accent)" />
          </marker>
        </defs>
        {/* Stage backdrop bands behind everything */}
        <StageBackdrop />
        {/* Edges drawn next so nodes overlay them */}
        {EDGES.map((e, i) => {
          const from = nodeById(e.from);
          const to   = nodeById(e.to);
          if (!from || !to) return null;
          // In trail mode, edges connecting touched nodes get bolder
          const trailFrom = trail?.get(e.from);
          const trailTo   = trail?.get(e.to);
          const isTrailEdge = isTrailMode && trailFrom != null && trailTo != null;
          return (
            <MonitorEdge
              key={i}
              edge={e}
              fromNode={from}
              toNode={to}
              agg={edgeAggByKey.get(`${e.from}->${e.to}`)}
              isTrailEdge={isTrailEdge}
              isTrailMode={isTrailMode}
            />
          );
        })}
        {NODES.map(n => (
          <MonitorNode
            key={n.id}
            node={n}
            agg={aggByName.get(n.id)}
            onClick={onNodeClick ? () => onNodeClick(n.id) : undefined}
            onRunningClick={onRunningClick ? () => onRunningClick(n.id) : undefined}
            onHitlClick={onHitlClick ? () => onHitlClick(n.id) : undefined}
            onQueueClick={onQueueClick ? () => onQueueClick(n.id) : undefined}
            trailEntry={trail?.get(n.id)}
            isTrailMode={isTrailMode}
            selected={n.id === selectedNodeId}
          />
        ))}
      </svg>
      {/* Legend overlay in bottom-right corner of the graph card */}
      <NodeStateLegend />
    </div>
  );
}
