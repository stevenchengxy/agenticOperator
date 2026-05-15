import type { ExtractorFn, InferenceStep, NodeKind } from './types';
import { monthsDiffYM, asArray } from './_date-utils';

const COMPETITOR_NAMES = ['OPPO', '小米'];

export const extract10_26: ExtractorFn = (graph, runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const workExp = asArray<{ company: string; start_date: string; end_date: string; title?: string }>(
    (graph.resume as Record<string, unknown> | null)?.work_experience,
  );
  const hit = workExp.find((w) => COMPETITOR_NAMES.some((c) => w.company.includes(c)));

  if (hit) {
    steps.push({
      kind: 'graph_node', node: 'resume', field: 'work_experience[]',
      value: `${hit.company} · ${hit.title ?? ''} · ${hit.start_date} ~ ${hit.end_date}`,
    });
    highlight.push('resume');

    const today = (runtime.received_at ?? '').slice(0, 10);
    steps.push({ kind: 'computation', label: 'Today (received_at)', value: today || '(unknown)' });

    const months = monthsDiffYM(hit.end_date, today);
    if (months !== null) {
      steps.push({ kind: 'computation', label: `${hit.company} 离职至今`, value: `≈ ${months.toFixed(1)} months` });
    }
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};
