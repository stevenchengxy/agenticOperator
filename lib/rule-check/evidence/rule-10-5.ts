import type { ExtractorFn, InferenceStep, NodeKind } from './types';

export const extract10_5: ExtractorFn = (graph, _runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const candidateDegree = (graph.candidate as Record<string, unknown> | null)?.highest_acquired_degree as string | undefined;
  const requiredDegree = (graph.job_requisition as Record<string, unknown> | null)?.degree_requirement as string | undefined;

  if (candidateDegree) {
    steps.push({ kind: 'graph_node', node: 'candidate', field: 'highest_acquired_degree', value: candidateDegree });
    highlight.push('candidate');
  }
  if (requiredDegree) {
    steps.push({ kind: 'graph_node', node: 'jd', field: 'degree_requirement', value: requiredDegree });
    highlight.push('jd');
  }
  if (candidateDegree && requiredDegree) {
    steps.push({ kind: 'computation', label: '学历匹配', value: `${candidateDegree} vs 要求 ${requiredDegree}` });
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};
