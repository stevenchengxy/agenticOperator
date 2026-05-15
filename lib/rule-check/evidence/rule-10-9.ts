import type { ExtractorFn, InferenceStep, NodeKind } from './types';
import { monthsDiffYM, asArray } from './_date-utils';

const GAP_THRESHOLD_MONTHS = 3;

export const extract10_9: ExtractorFn = (graph, _runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const workExp = asArray<{ company: string; start_date: string; end_date: string }>(
    (graph.resume as Record<string, unknown> | null)?.work_experience,
  );
  const sorted = [...workExp].sort((a, b) => a.start_date.localeCompare(b.start_date));
  for (let i = 0; i < sorted.length - 1; i++) {
    const months = monthsDiffYM(sorted[i].end_date, sorted[i + 1].start_date);
    if (months !== null && months > GAP_THRESHOLD_MONTHS) {
      steps.push({
        kind: 'graph_node', node: 'resume', field: `work_experience[${i}→${i + 1}]`,
        value: `${sorted[i].company} (end ${sorted[i].end_date}) → ${sorted[i + 1].company} (start ${sorted[i + 1].start_date})`,
      });
      steps.push({ kind: 'computation', label: '空窗期', value: `≈ ${months.toFixed(1)} months` });
      highlight.push('resume');
    }
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};
