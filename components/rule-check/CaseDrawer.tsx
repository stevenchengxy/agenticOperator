"use client";

import React from "react";
import { Btn } from "@/components/shared/atoms";
import type { ScenarioResultPayload } from "./use-run-stream";
import type { NodeKind } from "./neo4j-jump";
import { InferenceChainView } from "./InferenceChainView";
import { GraphView } from "./GraphView";

// 2026-05-25: removed Neo4j Browser "Open Candidate/Resume in Neo4j"
// jump links per user request — no direct entry into the graph engine.
// `neo4jBrowserBase` prop kept in the type for callsite compatibility but
// no longer used.

export type CaseDrawerProps = {
  result: ScenarioResultPayload | null;
  open: boolean;
  onClose: () => void;
  selectedRuleId: string | null;
  setSelectedRuleId: (rid: string | null) => void;
  /** @deprecated unused since the Neo4j Browser links were removed. */
  neo4jBrowserBase?: string | undefined;
  onReplay: () => void;
  replayInFlight: boolean;
};

export function CaseDrawer({ result, open, onClose, selectedRuleId, setSelectedRuleId, onReplay, replayInFlight }: CaseDrawerProps) {
  if (!open || !result) return null;
  const selectedRule = result.rule_results.find((r) => r.rule_id === selectedRuleId) ?? result.rule_results[0];
  const selectedChain = result.inference_chain.find((c) => c.rule_id === selectedRule?.rule_id);

  const highlightNodes = new Set<NodeKind>((selectedChain?.highlight_nodes ?? []) as NodeKind[]);

  return (
    <div className="fixed top-[56px] right-0 h-[calc(100vh-56px)] w-[60vw] bg-surface border-l border-line shadow-sh-1 overflow-y-auto z-20">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <div>
          <div className="text-[13px] text-ink-1">{result.scenario_id} · {result.scenario_name}</div>
          <div className="text-[10.5px] text-ink-3">
            Expected: {result.expected.decision}  ·  Actual: {result.actual.decision}
            {result.match_kind === 'pass' ? <span className="text-[color:var(--c-ok)] ml-1">✓</span> : <span className="text-[color:var(--c-err)] ml-1">✗ {result.match_kind}</span>}
          </div>
        </div>
        <Btn variant="ghost" onClick={onClose}>× Close</Btn>
      </div>

      <div className="flex flex-wrap gap-2 px-3 py-2 border-b border-line text-[11px]">
        <Btn variant="primary" onClick={onReplay} disabled={replayInFlight}>{replayInFlight ? '⏳ Replaying…' : '▶ Replay this scenario'}</Btn>
      </div>

      <div className="px-3 py-2 text-[10.5px] text-ink-3 border-b border-line mono">
        Audit: {result.audit.llm_ms}ms · {result.audit.graph_calls} graph fetches · {result.audit.completion_tokens ?? '?'}t out · finish={result.audit.finish_reason ?? '?'}
      </div>

      <div className="grid grid-cols-2 gap-0">
        <div className="border-r border-line p-3">
          <div className="text-[11px] text-ink-3 mb-1">Per-rule breakdown</div>
          <div className="flex flex-col gap-1">
            {result.rule_results.map((r) => (
              <button
                key={r.rule_id}
                onClick={() => setSelectedRuleId(r.rule_id)}
                className={`text-left px-2 py-1 rounded text-[11px] hover:bg-panel ${selectedRule?.rule_id === r.rule_id ? 'bg-panel border border-[color:var(--c-accent)]' : 'border border-transparent'}`}
              >
                <span className="font-mono text-ink-1">{r.rule_id}</span>
                <span className="ml-2">{statusBadge(r.status)}</span>
                {r.reason && <div className="text-ink-3 mt-0.5">{r.reason}</div>}
              </button>
            ))}
          </div>

          <div className="mt-3 border-t border-line pt-2">
            <div className="text-ink-3 mb-1 text-[11px]">Inference chain · <span className="mono text-ink-1">{selectedRule?.rule_id}</span></div>
            <InferenceChainView chain={selectedChain as never} />
          </div>

          {result.failures.length > 0 && (
            <div className="mt-3 border-t border-line pt-2">
              <div className="text-ink-3 mb-1 text-[11px]">Failures</div>
              <ul className="text-[10.5px] text-[color:var(--c-err)] list-disc pl-4">
                {result.failures.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </div>
          )}

          {result.audit.raw_llm_text && (
            <details className="mt-3 text-[11px]">
              <summary className="cursor-pointer text-ink-3">Show raw LLM JSON (parse-error diagnostic)</summary>
              <pre className="bg-panel p-2 rounded mt-1 text-[10px] overflow-x-auto whitespace-pre-wrap">{result.audit.raw_llm_text}</pre>
            </details>
          )}
        </div>

        <div className="p-3">
          <div className="text-[11px] text-ink-3 mb-1">Graph view</div>
          <GraphView graph={result.graph_context as never} highlightNodes={highlightNodes} />
        </div>
      </div>
    </div>
  );
}

function statusBadge(status: string): React.ReactNode {
  const color: Record<string, string> = {
    pass: 'text-[color:var(--c-ok)]',
    not_triggered: 'text-ink-3',
    fail: 'text-[color:var(--c-err)]',
    pending: 'text-[color:var(--c-warn)]',
    insufficient_info: 'text-[color:var(--c-warn)]',
    not_executed: 'text-ink-4',
  };
  return <span className={`text-[11px] ${color[status] ?? 'text-ink-2'}`}>{status}</span>;
}
