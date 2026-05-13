import type { ExtractorFn, InferenceStep, NodeKind } from './types';

export const extract10_17: ExtractorFn = (graph, _runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const hits = (graph.blacklist_hits ?? []) as Array<Record<string, unknown>>;
  if (hits.length > 0) {
    for (const h of hits) {
      steps.push({
        kind: 'graph_node', node: 'blacklist', field: 'lock_reason',
        value: `${h.blacklist_id ?? '?'} · ${h.lock_reason ?? '(no reason)'}`,
      });
    }
    highlight.push('blacklist', 'candidate');
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};
