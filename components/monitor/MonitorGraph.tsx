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

  const [scale, setScale] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const dragRef = React.useRef<{ x: number; y: number; pan: typeof pan } | null>(null);
  // Track dragging state for cursor styling
  const [isDragging, setIsDragging] = React.useState(false);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setScale(prev => Math.max(0.5, Math.min(2.5, prev * factor)));
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const tag = (e.target as Element).tagName.toLowerCase();
    // Only start drag if clicking the empty SVG background or a group (not a node rect/text)
    if (tag === 'svg' || tag === 'g' || tag === 'rect' && (e.target as Element).getAttribute('class') === null) {
      // Check that we're not clicking a node by seeing if the current target is the SVG itself
      if ((e.currentTarget as Element).tagName.toLowerCase() === 'svg') {
        const svgEl = e.currentTarget as SVGElement;
        const svgRect = svgEl.getBoundingClientRect();
        // Only drag on the SVG element directly (background), not on node children
        if (e.target === svgEl || (e.target as Element).tagName.toLowerCase() === 'svg') {
          dragRef.current = { x: e.clientX, y: e.clientY, pan };
          setIsDragging(true);
        }
      }
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;
    setPan({ x: dragRef.current.pan.x + dx, y: dragRef.current.pan.y + dy });
  };

  const onMouseUp = () => {
    dragRef.current = null;
    setIsDragging(false);
  };

  const reset = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div className="w-full overflow-auto rounded-[12px] border border-claude-line bg-claude-surface relative">
      <svg
        viewBox={GRAPH_VIEWBOX}
        width="100%"
        height={graphHeight ?? GRAPH_HEIGHT}
        preserveAspectRatio="xMidYMid meet"
        style={{ minWidth: GRAPH_WIDTH, cursor: isDragging ? 'grabbing' : 'grab' }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
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
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
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
        </g>
      </svg>
      {/* Zoom controls overlay — top-right of the graph card */}
      <div className="absolute top-3 right-3 inline-flex items-center gap-1 rounded-full bg-claude-surface/80 backdrop-blur-sm border border-claude-line px-2 py-1 text-[11px] text-claude-ink-3">
        <button
          onClick={() => setScale(s => Math.min(2.5, s * 1.2))}
          className="px-1.5 hover:text-claude-ink-1"
          title="Zoom in"
        >
          +
        </button>
        <span className="tabular-nums px-1">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale(s => Math.max(0.5, s / 1.2))}
          className="px-1.5 hover:text-claude-ink-1"
          title="Zoom out"
        >
          −
        </button>
        <span className="text-claude-ink-4">·</span>
        <button onClick={reset} className="px-1.5 hover:text-claude-ink-1" title="Reset view">
          ⟲
        </button>
      </div>
      {/* Legend overlay in bottom-right corner of the graph card */}
      <NodeStateLegend />
    </div>
  );
}
