"use client";

import React from "react";

type InferenceStep =
  | { kind: 'graph_node'; node: string; field?: string; value: string }
  | { kind: 'rule_logic'; markdown: string }
  | { kind: 'computation'; label: string; value: string }
  | { kind: 'verdict'; status: string; reason: string };

export type InferenceChainViewProps = {
  chain: { rule_id: string; steps: InferenceStep[]; highlight_nodes: string[] } | undefined;
};

export function InferenceChainView({ chain }: InferenceChainViewProps) {
  if (!chain) return <div className="text-ink-4 italic text-[11px]">(no chain available)</div>;
  return (
    <ol className="flex flex-col gap-1.5 text-[11px]">
      {chain.steps.map((step, i) => (
        <li key={i} className="flex gap-2 items-start">
          <span className="text-ink-4 mono w-5 shrink-0">{i + 1}.</span>
          <div className="flex-1">{renderStep(step)}</div>
        </li>
      ))}
    </ol>
  );
}

function renderStep(step: InferenceStep): React.ReactNode {
  switch (step.kind) {
    case 'graph_node':
      return (
        <div>
          <span className="px-1 rounded bg-[color:var(--c-accent-bg)] text-[color:var(--c-accent)] text-[10px]">graph</span>{' '}
          <span className="text-ink-2 mono">{step.node}{step.field ? `.${step.field}` : ''}:</span>{' '}
          <span className="text-ink-1">{step.value}</span>
        </div>
      );
    case 'computation':
      return (
        <div>
          <span className="px-1 rounded bg-panel text-ink-2 text-[10px]">calc</span>{' '}
          <span className="text-ink-2">{step.label}:</span>{' '}
          <span className="text-ink-1 mono">{step.value}</span>
        </div>
      );
    case 'rule_logic':
      return (
        <div>
          <span className="px-1 rounded bg-panel text-ink-3 text-[10px]">rule</span>
          <blockquote className="border-l-2 border-line pl-2 mt-1 text-ink-2 whitespace-pre-wrap">{step.markdown}</blockquote>
        </div>
      );
    case 'verdict':
      return (
        <div>
          <span className={`px-1 rounded text-[10px] ${verdictColor(step.status)}`}>{step.status}</span>{' '}
          <span className="text-ink-1">{step.reason}</span>
        </div>
      );
  }
}

function verdictColor(status: string): string {
  if (status === 'pass') return 'bg-[color:var(--c-ok-bg)] text-[color:var(--c-ok)]';
  if (status === 'fail') return 'bg-[color:var(--c-err-bg)] text-[color:var(--c-err)]';
  if (status === 'pending' || status === 'insufficient_info') return 'bg-[color:var(--c-warn-bg)] text-[color:var(--c-warn)]';
  return 'bg-panel text-ink-3';
}
