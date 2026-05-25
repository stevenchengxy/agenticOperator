"use client";

import React from "react";
import type { NodeKind } from "./neo4j-jump";

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

export function GraphView({ graph, highlightNodes }: GraphViewProps) {
  const g = graph ?? {};
  const [selected, setSelected] = React.useState<SlotKind | null>(null);

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

  const dataOf = (kind: SlotKind): unknown => {
    switch (kind) {
      case 'candidate': return g.candidate ?? null;
      case 'resume': return g.resume ?? null;
      case 'jd': return g.job_requisition ?? null;
      case 'application': return g.applications ?? [];
      case 'blacklist': return g.blacklist_hits ?? [];
      case 'employment': return g.employment_links ?? [];
    }
  };

  return (
    <div className="flex flex-col gap-2">
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
          const isSelected = selected === kind;
          const id = idOf(kind);
          return (
            <g key={kind} opacity={present ? 1 : 0.4} style={{ cursor: present ? 'pointer' : 'default' }}
               onClick={() => present && setSelected((s) => (s === kind ? null : kind))}
            >
              <rect x={p.x} y={p.y} width={p.w} height={p.h}
                    rx={4}
                    fill={isSelected ? 'var(--c-accent-bg)' : 'var(--c-surface)'}
                    stroke={isSelected ? 'var(--c-accent)' : (highlighted ? 'var(--c-accent)' : 'var(--c-line)')}
                    strokeWidth={isSelected || highlighted ? 2 : 1} />
              <text x={p.x + p.w / 2} y={p.y + 18} fontSize="11" fill="var(--c-ink-1)" textAnchor="middle">{p.label}</text>
              <text x={p.x + p.w / 2} y={p.y + 34} fontSize="9" fill="var(--c-ink-3)" textAnchor="middle">
                {present ? (id ?? '(linked)') : '(empty)'}
              </text>
            </g>
          );
        })}
      </svg>
      {selected && (
        <NodeDetailPanel
          kind={selected}
          label={POSITIONS[selected].label}
          data={dataOf(selected)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

// 2026-05-25: removed "↗ Open in Neo4j" / "↗ 图引擎" link per user request —
// no direct entry into the graph engine browser. Node payload still
// shown inline; users inspect data here without leaving AO.
function NodeDetailPanel({ kind, label, data, onClose }: {
  kind: SlotKind; label: string; data: unknown; onClose: () => void;
}) {
  const isEmpty = data === null || (Array.isArray(data) && data.length === 0);
  return (
    <div className="border border-line rounded bg-panel">
      <div className="flex items-center justify-between px-2 py-1 border-b border-line">
        <div className="text-[11px] text-ink-2">
          <span className="text-ink-1 mono">{label}</span> <span className="text-ink-4 mono">({kind})</span>
        </div>
        <button onClick={onClose} className="text-ink-3 hover:text-ink-1 text-[11px]">× close</button>
      </div>
      <pre className="text-[10.5px] mono text-ink-2 p-2 overflow-x-auto max-h-[260px] whitespace-pre-wrap">
        {isEmpty ? '(no data — slot empty)' : safeStringify(data)}
      </pre>
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => {
      // Neo4j temporal types come back as nested {year:{low,high}, …} objects.
      // Flatten them for readability.
      if (val && typeof val === 'object' && 'low' in val && 'high' in val && Object.keys(val).length <= 2) {
        return (val as { low: number }).low;
      }
      return val;
    }, 2);
  } catch {
    return String(v);
  }
}
