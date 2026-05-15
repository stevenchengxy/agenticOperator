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
import type { WorkflowEdge } from "@/lib/workflow-graph-meta";
import { MonitorNode } from "./MonitorNode";
import { MonitorEdge } from "./MonitorEdge";
import { StageBackdrop } from "./StageBackdrop";
import { NodeStateLegend } from "./NodeStateLegend";
import { MiniMap } from "./MiniMap";

type TrailEntry = { result: 'success' | 'failure' | 'pending' | 'skipped'; current: boolean };

type HoveredEdgeInfo = {
  edge: WorkflowEdge;
  agg?: MonitorEdgeAgg;
  x: number;
  y: number;
};

type InngestLiveMap = Map<
  string,
  { paused: boolean; total: number; completed: number; failed: number; running: number }
>;

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
  /** ★ Inngest live overlay: wsId → run state. Drives LIVE/PAUSED badges on deployed nodes. */
  inngestLiveByWsId?: InngestLiveMap;
};

export function MonitorGraph({ nodeAggs, edgeAggs, onNodeClick, onRunningClick, onHitlClick, onQueueClick, trail, selectedNodeId, graphHeight, inngestLiveByWsId }: Props) {
  const aggByName = new Map((nodeAggs ?? []).map(a => [a.name, a]));
  const edgeAggByKey = new Map((edgeAggs ?? []).map(e => [`${e.from}->${e.to}`, e]));
  const isTrailMode = trail != null;

  const [scale, setScale] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const dragRef = React.useRef<{ x: number; y: number; pan: typeof pan } | null>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);
  const svgWrapperRef = React.useRef<HTMLDivElement>(null);
  // Track dragging state for cursor styling
  const [isDragging, setIsDragging] = React.useState(false);
  // Container size for MiniMap viewport math
  const [containerSize, setContainerSize] = React.useState({ width: 1000, height: 600 });
  // Edge hover popover state
  const [hoveredEdge, setHoveredEdge] = React.useState<HoveredEdgeInfo | null>(null);

  // Measure container size with ResizeObserver so MiniMap viewport rect stays accurate.
  // The ResizeObserver callback fires async — the wrapper element can be detached
  // (HMR remount, route change) between when we observe() and when update() runs,
  // so re-check `current` inside the callback instead of trusting the effect-time guard.
  React.useEffect(() => {
    const el = svgWrapperRef.current;
    if (!el) return;
    const update = () => {
      const node = svgWrapperRef.current;
      if (!node) return;
      const r = node.getBoundingClientRect();
      setContainerSize({ width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel zoom — must use addEventListener with { passive: false } because
  // React's synthetic onWheel uses passive listeners, which silently ignores
  // e.preventDefault() and causes the page to scroll instead of zooming.
  React.useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      setScale(prev => Math.max(0.5, Math.min(2.5, prev * factor)));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    const t = e.target as Element;
    // Don't start drag if click is on a node
    if (t.closest('g[data-node-clickable]')) return;
    // Don't start drag if click is on an interactive control (zoom buttons)
    if (t.closest('button')) return;
    dragRef.current = { x: e.clientX, y: e.clientY, pan };
    setIsDragging(true);
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
    <div ref={svgWrapperRef} className="w-full overflow-auto rounded-[12px] border border-claude-line bg-claude-surface relative">
      <svg
        ref={svgRef}
        viewBox={GRAPH_VIEWBOX}
        width="100%"
        height={graphHeight ?? GRAPH_HEIGHT}
        preserveAspectRatio="xMidYMid meet"
        style={{ minWidth: GRAPH_WIDTH, cursor: isDragging ? 'grabbing' : 'grab', userSelect: 'none' }}
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
                onHover={setHoveredEdge}
                svgWrapper={svgWrapperRef.current}
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
              inngestLive={inngestLiveByWsId?.get(n.wsId)}
            />
          ))}
        </g>
      </svg>

      {/* Edge hover popover — pointer-events: none so it doesn't interfere with the SVG */}
      {hoveredEdge && (
        <div
          className="absolute z-20 pointer-events-none bg-claude-surface border border-claude-line shadow-sm rounded-md px-2 py-1 text-[11px]"
          style={{
            left: `${hoveredEdge.x + 10}px`,
            top: `${hoveredEdge.y - 36}px`,
          }}
        >
          <div className="font-mono text-claude-ink-1">
            {hoveredEdge.edge.eventName ?? hoveredEdge.edge.label ?? '—'}
          </div>
          <div className="text-claude-ink-3">
            {hoveredEdge.agg?.countInWindow ?? 0} in 24h
            {hoveredEdge.agg?.lastEventAt
              ? ` · last ${new Date(hoveredEdge.agg.lastEventAt).toLocaleTimeString()}`
              : null}
          </div>
        </div>
      )}

      {/* Zoom controls overlay — top-left of the graph card */}
      <div className="absolute top-3 left-3 inline-flex items-center gap-1 rounded-full bg-claude-surface/80 backdrop-blur-sm border border-claude-line px-2 py-1 text-[11px] text-claude-ink-3">
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

      {/* MiniMap — top-right corner */}
      <div className="absolute top-3 right-3 pointer-events-auto">
        <MiniMap
          nodeAggs={nodeAggs}
          scale={scale}
          pan={pan}
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
          onPanTo={setPan}
        />
      </div>

      {/* Legend overlay in bottom-right corner of the graph card */}
      <NodeStateLegend />
    </div>
  );
}
