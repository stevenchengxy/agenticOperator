"use client";

import React from "react";
import { bucketCell, type CellMarker } from "./bucketing";
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

const CELL_BG: Record<CellMarker, string> = {
  match: 'bg-[color:var(--c-ok-bg)] text-[color:var(--c-ok)]',
  partial: 'bg-[color:var(--c-warn-bg)] text-[color:var(--c-warn)]',
  mismatch: 'bg-[color:var(--c-err-bg)] text-[color:var(--c-err)]',
  missing: 'bg-[color:var(--c-warn-bg)] text-[color:var(--c-warn)]',
  excluded: 'bg-panel text-ink-4',
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
                    {sr && sr.match_kind === 'pass' && <span className="text-[color:var(--c-ok)] ml-1">✓</span>}
                    {sr && sr.match_kind !== 'pass' && <span className="text-[color:var(--c-err)] ml-1">✗</span>}
                  </td>
                  {cols.map((rid) => {
                    const expected = (s.expected.rule_status[rid] as RuleStatus | undefined) ?? 'missing-from-expected';
                    const actual = (sr?.rule_results.find((r) => r.rule_id === rid)?.status as RuleStatus | undefined)
                      ?? (sr ? 'missing-from-actual' : 'missing-from-expected');
                    const outcome = bucketCell(expected as never, actual as never);
                    const compareStatus = cr?.rule_results.find((r) => r.rule_id === rid)?.status as RuleStatus | undefined;
                    const diffsFromCompare = !!sr && !!cr && compareStatus !== undefined && actual !== compareStatus;
                    return (
                      <td key={rid}
                          onClick={() => sr && onCellClick(s.id, rid)}
                          className={`text-center px-1 py-1 ${sr ? 'cursor-pointer' : ''} ${sr ? CELL_BG[outcome.marker] : 'bg-surface text-ink-4'} ${diffsFromCompare ? 'outline outline-1 outline-[color:var(--c-warn)]' : ''}`}
                          title={`${rid}: expected=${expected} actual=${actual} (${outcome.bucket})`}
                      >
                        {sr
                          ? (outcome.marker === 'match' ? '✓' : outcome.marker === 'partial' ? '~' : outcome.marker === 'mismatch' ? '✗' : outcome.marker === 'missing' ? '⚠' : '·')
                          : (isRunning ? '⏳' : '·')}
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
