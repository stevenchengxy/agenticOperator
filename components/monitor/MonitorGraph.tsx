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

type Props = {
  nodeAggs?: MonitorNodeAgg[];
  edgeAggs?: MonitorEdgeAgg[];
  onNodeClick?: (nodeId: string) => void;
  onRunningClick?: (nodeId: string) => void;
};

export function MonitorGraph({ nodeAggs, edgeAggs, onNodeClick, onRunningClick }: Props) {
  const aggByName = new Map((nodeAggs ?? []).map(a => [a.name, a]));
  const edgeAggByKey = new Map((edgeAggs ?? []).map(e => [`${e.from}->${e.to}`, e]));

  return (
    <div className="w-full overflow-auto rounded-[12px] border border-claude-line bg-claude-surface">
      <svg
        viewBox={GRAPH_VIEWBOX}
        width="100%"
        height={GRAPH_HEIGHT}
        preserveAspectRatio="xMidYMid meet"
        style={{ minWidth: GRAPH_WIDTH }}
      >
        {/* Edges drawn first so nodes overlay them */}
        {EDGES.map((e, i) => {
          const from = nodeById(e.from);
          const to   = nodeById(e.to);
          if (!from || !to) return null;
          return (
            <MonitorEdge
              key={i}
              edge={e}
              fromNode={from}
              toNode={to}
              agg={edgeAggByKey.get(`${e.from}->${e.to}`)}
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
          />
        ))}
      </svg>
    </div>
  );
}
