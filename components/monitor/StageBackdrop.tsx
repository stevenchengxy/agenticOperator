"use client";
import React from "react";
import { NODES, type WorkflowNode } from "@/lib/workflow-graph-meta";
import { byShort } from "@/lib/agent-mapping";

// Compute bounding rect per stage from member node coordinates. Renders
// soft band labels at the top-left of each stage cluster — subtle, doesn't
// crowd the diagram.

type Cluster = {
  stage: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  nodeCount: number;
};

const NODE_W = 154;
const NODE_H = 64;
const PAD = 20;

function computeClusters(): Cluster[] {
  const byStage = new Map<string, WorkflowNode[]>();
  for (const n of NODES) {
    const meta = byShort(n.agentName ?? n.title);
    const stage = meta?.stage ?? n.kind;
    const list = byStage.get(stage) ?? [];
    list.push(n);
    byStage.set(stage, list);
  }
  const out: Cluster[] = [];
  for (const [stage, ns] of byStage) {
    if (ns.length < 2) continue; // singletons aren't worth labeling
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x - NODE_W / 2);
      minY = Math.min(minY, n.y - NODE_H / 2);
      maxX = Math.max(maxX, n.x + NODE_W / 2);
      maxY = Math.max(maxY, n.y + NODE_H / 2);
    }
    out.push({
      stage,
      minX: minX - PAD,
      minY: minY - PAD,
      maxX: maxX + PAD,
      maxY: maxY + PAD,
      nodeCount: ns.length,
    });
  }
  return out;
}

const STAGE_LABELS: Record<string, string> = {
  system: "STORAGE / AUTOMATION",
  requirement: "REQUIREMENT INTAKE",
  jd: "JD GENERATION",
  resume: "RESUME PROCESSING",
  match: "MATCHING",
  interview: "INTERVIEW",
  eval: "EVALUATION",
  package: "PACKAGE",
  submit: "SUBMISSION",
  // Node kinds used as fallback
  trigger: "TRIGGER",
  branch: "BRANCHING",
  hitl: "HUMAN IN THE LOOP",
  guard: "COMPLIANCE",
  done: "TERMINAL",
};

export function StageBackdrop() {
  const clusters = React.useMemo(computeClusters, []);
  return (
    <g>
      {clusters.map((c) => (
        <g key={c.stage}>
          {/* Rect starts 16px below minY to leave room for the label above */}
          <rect
            x={c.minX}
            y={c.minY + 16}
            width={c.maxX - c.minX}
            height={c.maxY - c.minY - 16}
            rx={14}
            fill="var(--c-claude-bg)"
            stroke="var(--c-claude-line)"
            strokeWidth={0.5}
            strokeDasharray="3 4"
            opacity={0.22}
          />
          {/* Label sits above the rect in the 16px buffer zone */}
          <text
            x={(c.minX + c.maxX) / 2}
            y={c.minY + 10}
            fontSize={9.5}
            letterSpacing="0.14em"
            fill="var(--c-claude-ink-4)"
            fontWeight={500}
            textAnchor="middle"
          >
            {STAGE_LABELS[c.stage] ?? c.stage.toUpperCase()}
          </text>
        </g>
      ))}
    </g>
  );
}
