"use client";

import React from "react";
import type { ScenarioResultPayload } from "./use-run-stream";
import type { RuleStatus } from "@/lib/rule-check/types";

export type ScenarioMatrixProps = {
  scenarios: Array<{ id: string; name: string; expected: { decision: string; rule_status: Record<string, string> } }>;
  results: ScenarioResultPayload[];
  ruleFilter: string | null;
  runningScenarioIds: Set<string>;
  onCellClick: (scenarioId: string, ruleId: string) => void;
  compareResults?: ScenarioResultPayload[];
  modelLabel?: string;
};

// Color cells by ACTUAL status — every evaluated rule shows its judgment,
// not just the few that have a fixture pin. Pinned-but-mismatched cells get
// a red outline overlay so reviewers can still see the disagreement.
type ActualKind = RuleStatus | 'missing-from-actual' | 'no-result';

const STATUS_STYLE: Record<ActualKind, { bg: string; symbol: string }> = {
  pass:              { bg: 'bg-[color:var(--c-ok-bg)] text-[color:var(--c-ok)]',     symbol: '✓' },
  not_triggered:     { bg: 'bg-surface text-ink-3',                                  symbol: '–' },
  fail:              { bg: 'bg-[color:var(--c-err-bg)] text-[color:var(--c-err)]',   symbol: '✗' },
  pending:           { bg: 'bg-[color:var(--c-warn-bg)] text-[color:var(--c-warn)]', symbol: '⏸' },
  insufficient_info: { bg: 'bg-[color:var(--c-warn-bg)] text-[color:var(--c-warn)]', symbol: '?' },
  not_executed:      { bg: 'bg-panel text-ink-4',                                    symbol: '⊘' },
  'missing-from-actual': { bg: 'bg-[color:var(--c-warn-bg)] text-[color:var(--c-warn)]', symbol: '⚠' },
  'no-result':       { bg: 'bg-surface text-ink-4',                                  symbol: '·' },
};

export function ScenarioMatrix({
  scenarios, results, ruleFilter, runningScenarioIds, onCellClick,
  compareResults, modelLabel,
}: ScenarioMatrixProps) {
  const resultsById = new Map(results.map((r) => [r.scenario_id, r]));
  const compareById = compareResults ? new Map(compareResults.map((r) => [r.scenario_id, r])) : null;

  const ruleIds = new Set<string>();
  for (const s of scenarios) {
    for (const rid of Object.keys(s.expected.rule_status)) ruleIds.add(rid);
  }
  for (const r of results) {
    for (const rr of r.rule_results) ruleIds.add(rr.rule_id);
  }
  if (compareResults) {
    for (const r of compareResults) {
      for (const rr of r.rule_results) ruleIds.add(rr.rule_id);
    }
  }
  const cols = [...ruleIds].sort().filter((rid) => !ruleFilter || rid === ruleFilter);

  return (
    <div className="flex flex-col">
      {modelLabel && (
        <div className="px-3 py-1 text-[10.5px] text-ink-3 bg-panel border-t border-line">{modelLabel}</div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[10.5px] mono">
          <thead className="sticky top-0 bg-panel">
            <tr>
              <th className="text-left px-2 py-1 border-r border-line">Scenario</th>
              <th className="text-left px-2 py-1 border-r border-line">Expected → Actual</th>
              {cols.map((rid) => (
                <th key={rid} className="px-1 py-1 text-ink-2 font-normal">{rid}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s) => {
              const sr = resultsById.get(s.id);
              const cr = compareById?.get(s.id);
              const isRunning = runningScenarioIds.has(s.id);
              return (
                <tr key={s.id} className="border-t border-line">
                  <td className="px-2 py-1 text-ink-1 whitespace-nowrap border-r border-line">{s.id} {s.name}</td>
                  <td className="px-2 py-1 text-ink-2 whitespace-nowrap border-r border-line">
                    {s.expected.decision} → {sr ? sr.actual.decision : (isRunning ? '…' : '—')}
                    {sr && s.expected.decision === sr.actual.decision && <span className="text-[color:var(--c-ok)] ml-1">✓</span>}
                    {sr && s.expected.decision !== sr.actual.decision && <span className="text-[color:var(--c-err)] ml-1">✗</span>}
                  </td>
                  {cols.map((rid) => {
                    const expected = (s.expected.rule_status[rid] as RuleStatus | undefined) ?? 'missing-from-expected';
                    const actualRaw = sr?.rule_results.find((r) => r.rule_id === rid)?.status as RuleStatus | undefined;
                    let kind: ActualKind;
                    if (!sr) kind = 'no-result';
                    else if (actualRaw !== undefined) kind = actualRaw;
                    else if (expected !== 'missing-from-expected') kind = 'missing-from-actual';
                    else kind = 'no-result';
                    const style = STATUS_STYLE[kind];

                    // Fixture-pin mismatch: red outline so it stands out among
                    // the colored cells (cell color is now derived from actual,
                    // so we need a separate channel for "expected ≠ actual").
                    const pinnedMismatch =
                      expected !== 'missing-from-expected' &&
                      actualRaw !== undefined &&
                      expected !== actualRaw;
                    const outlinePinned = pinnedMismatch
                      ? 'outline outline-2 outline-[color:var(--c-err)] outline-offset-[-2px]'
                      : '';

                    // Compare-mode: dotted warn outline when this run disagrees with the compare run.
                    const compareStatus = cr?.rule_results.find((r) => r.rule_id === rid)?.status as RuleStatus | undefined;
                    const diffsFromCompare = !!sr && !!cr && compareStatus !== undefined && actualRaw !== compareStatus;
                    const outlineCompare = diffsFromCompare && !pinnedMismatch
                      ? 'outline outline-1 outline-[color:var(--c-warn)]'
                      : '';

                    return (
                      <td key={rid}
                          onClick={() => sr && onCellClick(s.id, rid)}
                          className={`text-center px-1 py-1 ${sr ? 'cursor-pointer' : ''} ${style.bg} ${outlinePinned} ${outlineCompare}`}
                          title={`${rid}: expected=${expected} actual=${actualRaw ?? '(missing)'} ${pinnedMismatch ? '— PIN MISMATCH' : ''}`}
                      >
                        {!sr ? (isRunning ? '⏳' : '·') : style.symbol}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
