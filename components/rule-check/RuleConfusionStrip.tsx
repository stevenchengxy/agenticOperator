"use client";

import React from "react";
import { bucketCell } from "./bucketing";
import type { ScenarioResultPayload } from "./use-run-stream";
import type { RuleStatus } from "@/lib/rule-check/types";

export type RuleConfusionStripProps = {
  results: ScenarioResultPayload[];
  expectedByScenario: Record<string, Record<string, RuleStatus>>;
  ruleFilter: string | null;
  setRuleFilter: (r: string | null) => void;
};

export function RuleConfusionStrip({ results, expectedByScenario, ruleFilter, setRuleFilter }: RuleConfusionStripProps) {
  const counts = new Map<string, { TP: number; TN: number; FP: number; FN: number; excluded: number }>();
  for (const sr of results) {
    const expected = expectedByScenario[sr.scenario_id] ?? {};
    const actualMap = new Map(sr.rule_results.map((r) => [r.rule_id, r.status as RuleStatus]));
    const allRules = new Set<string>([...Object.keys(expected), ...actualMap.keys()]);
    for (const rid of allRules) {
      const exp = (expected[rid] as RuleStatus | undefined) ?? 'missing-from-expected';
      const act = (actualMap.get(rid) as RuleStatus | undefined) ?? 'missing-from-actual';
      const { bucket } = bucketCell(exp as never, act as never);
      const c = counts.get(rid) ?? { TP: 0, TN: 0, FP: 0, FN: 0, excluded: 0 };
      c[bucket]++;
      counts.set(rid, c);
    }
  }

  const sortedRules = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (sortedRules.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 py-2 border-b border-line bg-surface text-[10.5px]">
      {sortedRules.map(([rid, c]) => (
        <button
          key={rid}
          onClick={() => setRuleFilter(ruleFilter === rid ? null : rid)}
          className={`flex items-center gap-1 px-2 py-1 rounded border ${ruleFilter === rid ? 'border-[color:var(--c-accent)]' : 'border-line'} hover:bg-panel`}
        >
          <span className="font-mono text-ink-1">{rid}</span>
          <span className="text-ok">TP:{c.TP}</span>
          <span className="text-ink-3">TN:{c.TN}</span>
          <span className="text-[color:var(--c-err)]">FP:{c.FP}</span>
          <span className="text-[color:var(--c-err)]">FN:{c.FN}</span>
        </button>
      ))}
    </div>
  );
}
