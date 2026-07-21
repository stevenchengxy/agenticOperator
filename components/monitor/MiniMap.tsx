"use client";
import React from "react";
import { NODES, GRAPH_WIDTH, GRAPH_HEIGHT } from "@/lib/workflow-graph-meta";
import type { MonitorNodeAgg } from "@/lib/monitor/types";

const MINIMAP_W = 140;
const MINIMAP_H = Math.round(MINIMAP_W * (GRAPH_HEIGHT / GRAPH_WIDTH) * 10) / 10; // ~50.9

function nodeFillForMiniMap(status: string): string {
  if (status === "failing") return "var(--c-claude-err)";
  if (status === "degraded") return "var(--c-claude-warn)";
  if (status === "running" || status === "healthy") return "var(--c-claude-ok)";
  return "var(--c-claude-ink-4)";
}

type MiniMapProps = {
  nodeAggs?: MonitorNodeAgg[];
  scale: number;
  pan: { x: number; y: number };
  containerWidth: number;
  containerHeight: number;
  onPanTo: (newPan: { x: number; y: number }) => void;
};

export function MiniMap({
  nodeAggs,
  scale,
  pan,
  containerWidth,
  containerHeight,
  onPanTo,
}: MiniMapProps) {
  const sx = MINIMAP_W / GRAPH_WIDTH;
  const sy = MINIMAP_H / GRAPH_HEIGHT;

  const aggMap = new Map((nodeAggs ?? []).map((a) => [a.name, a]));

  // Viewport rectangle in graph coords, then converted to minimap coords
  const viewportX = (-pan.x / scale) * sx;
  const viewportY = (-pan.y / scale) * sy;
  const viewportW = (containerWidth / scale) * sx;
  const viewportH = (containerHeight / scale) * sy;

  const clampedX = Math.max(0, Math.min(MINIMAP_W - viewportW, viewportX));
  const clampedY = Math.max(0, Math.min(MINIMAP_H - viewportH, viewportY));

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Convert minimap coords to graph coords
    const graphX = mx / sx;
    const graphY = my / sy;
    // Center viewport on this graph point
    const newPanX = containerWidth / 2 - graphX * scale;
    const newPanY = containerHeight / 2 - graphY * scale;
    onPanTo({ x: newPanX, y: newPanY });
  };

  return (
    <svg
      width={MINIMAP_W}
      height={MINIMAP_H}
      viewBox={`0 0 ${MINIMAP_W} ${MINIMAP_H}`}
      className="border border-claude-line bg-claude-surface/90 rounded-md cursor-pointer"
      onClick={onClick}
      // Do not capture wheel events — let them bubble to the main SVG for zoom
      style={{ display: "block" }}
    >
      {/* Nodes as small filled circles */}
      {NODES.map((node) => {
        const agg = aggMap.get(node.id);
        const fill = nodeFillForMiniMap(agg?.status ?? "idle");
        return (
          <circle
            key={node.id}
            cx={node.x * sx}
            cy={node.y * sy}
            r={2.5}
            fill={fill}
          />
        );
      })}
      {/* Viewport rectangle */}
      <rect
        x={clampedX}
        y={clampedY}
        width={Math.min(viewportW, MINIMAP_W - clampedX)}
        height={Math.min(viewportH, MINIMAP_H - clampedY)}
        fill="var(--c-claude-accent)"
        fillOpacity={0.15}
        stroke="var(--c-claude-accent)"
        strokeWidth={1}
      />
    </svg>
  );
}
