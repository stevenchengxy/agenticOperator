import type { ExtractorFn, InferenceStep, NodeKind } from './types';
import { yearsBetween } from './_date-utils';

export const extract10_21: ExtractorFn = (graph, runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const birth = (graph.candidate as Record<string, unknown> | null)?.birth_date as string | undefined;
  const ageRange = (graph.job_requisition as Record<string, unknown> | null)?.age_range as string | undefined;
  const today = (runtime.received_at ?? '').slice(0, 10);

  if (birth) {
    steps.push({ kind: 'graph_node', node: 'candidate', field: 'birth_date', value: birth });
    highlight.push('candidate');
    const age = yearsBetween(birth, today);
    if (age !== null) steps.push({ kind: 'computation', label: 'Age (today)', value: `${age}` });
  }
  if (ageRange) {
    steps.push({ kind: 'graph_node', node: 'jd', field: 'age_range', value: ageRange });
    highlight.push('jd');
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};
