import type { ExtractorFn, InferenceStep, NodeKind } from './types';

export const extract10_27: ExtractorFn = (graph, _runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const decl = (graph.candidate as Record<string, unknown> | null)?.conflict_interest_declaration as string | undefined;
  if (decl && decl !== '无' && decl.trim().length > 0) {
    steps.push({
      kind: 'graph_node', node: 'candidate', field: 'conflict_interest_declaration',
      value: decl,
    });
    highlight.push('candidate');
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};
