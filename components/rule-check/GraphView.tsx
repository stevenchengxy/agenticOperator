"use client";

import React from "react";
import { buildNeo4jBrowserUrl, type NodeKind } from "./neo4j-jump";

export type GraphViewProps = {
  graph: {
    candidate?: Record<string, unknown> | null;
    resume?: Record<string, unknown> | null;
    job_requisition?: Record<string, unknown> | null;
    applications?: Array<Record<string, unknown>>;
    blacklist_hits?: Array<Record<string, unknown>>;
    employment_links?: Array<Record<string, unknown>>;
  } | null | undefined;
  highlightNodes: Set<NodeKind>;
  neo4jBrowserBase?: string;
};

type SlotKind = Exclude<NodeKind, 'subgraph'>;

const POSITIONS: Record<SlotKind, { x: number; y: number; w: number; h: number; label: string }> = {
  candidate:   { x: 190, y: 20,  w: 120, h: 50, label: 'Candidate' },
  blacklist:   { x:  20, y: 130, w: 120, h: 50, label: 'Blacklist' },
  resume:      { x: 190, y: 130, w: 120, h: 50, label: 'Resume' },
  application: { x: 360, y: 130, w: 120, h: 50, label: 'Application' },
  jd:          { x: 360, y: 260, w: 120, h: 50, label: 'Job_Requisition' },
  employment:  { x: 100, y: 380, w: 300, h: 50, label: 'Employment_links' },
};

const EDGES: Array<{ from: SlotKind; to: SlotKind; label: string }> = [
  { from: 'blacklist',   to: 'candidate',   label: 'BLOCKS_CANDIDATE' },
  { from: 'candidate',   to: 'resume',      label: 'CANDIDATE_HAS_RESUME' },
  { from: 'candidate',   to: 'application', label: 'CANDIDATE_HAS_APPLICATIONS' },
  { from: 'application', to: 'jd',          label: 'TARGETS_REQUISITION' },
];

export function GraphView({ graph, highlightNodes, neo4jBrowserBase }: GraphViewProps) {
  const g = graph ?? {};
  const presence: Record<SlotKind, boolean> = {
    candidate: !!g.candidate,
    resume: !!g.resume,
    jd: !!g.job_requisition,
    application: (g.applications?.length ?? 0) > 0,
    blacklist: (g.blacklist_hits?.length ?? 0) > 0,
    employment: (g.employment_links?.length ?? 0) > 0,
  };

  const idOf = (kind: SlotKind): string | undefined => {
    switch (kind) {
      case 'candidate': return g.candidate?.candidate_id as string | undefined;
      case 'resume': return g.resume?.resume_id as string | undefined;
      case 'jd': return g.job_requisition?.job_requisition_id as string | undefined;
      case 'application': return g.applications?.[0]?.application_id as string | undefined;
      case 'blacklist': return g.blacklist_hits?.[0]?.blacklist_id as string | undefined;
      default: return undefined;
    }
  };

  return (
    <svg viewBox="0 0 500 460" className="w-full max-w-[500px] border border-line rounded">
      {EDGES.map((e) => {
        const a = POSITIONS[e.from], b = POSITIONS[e.to];
        const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
        const bx = b.x + b.w / 2, by = b.y + b.h / 2;
        const present = presence[e.from] && presence[e.to];
        return (
          <g key={e.label} opacity={present ? 1 : 0.3}>
            <line x1={ax} y1={ay} x2={bx} y2={by}
                  stroke="var(--c-line)" strokeWidth={1} strokeDasharray={present ? undefined : '3 3'} />
            <text x={(ax + bx) / 2} y={(ay + by) / 2 - 4} fontSize="9" fill="var(--c-ink-4)" textAnchor="middle">{e.label}</text>
          </g>
        );
      })}
      {(Object.keys(POSITIONS) as SlotKind[]).map((kind) => {
        const p = POSITIONS[kind];
        const present = presence[kind];
        const highlighted = highlightNodes.has(kind);
        const id = idOf(kind);
        const url = id ? buildNeo4jBrowserUrl(neo4jBrowserBase, kind, id) : null;
        return (
          <g key={kind} opacity={present ? 1 : 0.4} style={{ cursor: url ? 'pointer' : 'default' }}
             onClick={() => url && window.open(url, '_blank')}
          >
            <rect x={p.x} y={p.y} width={p.w} height={p.h}
                  rx={4}
                  fill="var(--c-surface)"
                  stroke={highlighted ? "var(--c-accent)" : "var(--c-line)"}
                  strokeWidth={highlighted ? 2 : 1} />
            <text x={p.x + p.w / 2} y={p.y + 18} fontSize="11" fill="var(--c-ink-1)" textAnchor="middle">{p.label}</text>
            <text x={p.x + p.w / 2} y={p.y + 34} fontSize="9" fill="var(--c-ink-3)" textAnchor="middle">
              {present ? (id ?? '(linked)') : '(empty)'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
