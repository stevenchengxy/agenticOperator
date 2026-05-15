"use client";

import React from "react";
import type { ScenarioResultPayload } from "./use-run-stream";

export type MetricsStripProps = {
  results: ScenarioResultPayload[];
  expectedTotal: number;
};

export function MetricsStrip({ results, expectedTotal }: MetricsStripProps) {
  const pass = results.filter((r) => r.match_kind === 'pass').length;
  const avgMs = results.length ? Math.round(results.reduce((s, r) => s + r.audit.llm_ms, 0) / results.length) : 0;
  const totalOut = results.reduce((s, r) => s + (r.audit.completion_tokens ?? 0), 0);
  const totalIn = results.reduce((s, r) => s + (r.audit.prompt_tokens ?? 0), 0);
  const capHits = results.filter((r) => r.audit.finish_reason === 'length').length;
  const parseErrors = results.filter((r) => r.match_kind === 'fail-parse').length;

  return (
    <div className="flex flex-wrap items-center gap-4 px-3 py-2 border-b border-line bg-surface text-[11px] text-ink-2">
      <span><span className="text-ok mr-1">✓</span>{pass}/{expectedTotal} passed</span>
      <span>Avg <span className="text-ink-1">{(avgMs / 1000).toFixed(1)}s</span></span>
      <span>Σ <span className="text-ink-1">{totalOut.toLocaleString()}t</span> out / <span className="text-ink-1">{totalIn.toLocaleString()}t</span> in</span>
      <span>{capHits} cap-hits</span>
      <span>{parseErrors} parse-errors</span>
    </div>
  );
}
