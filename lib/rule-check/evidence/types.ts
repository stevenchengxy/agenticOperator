import type { RuleStatus } from '../types';

export type NodeKind =
  | 'candidate' | 'resume' | 'jd' | 'application' | 'blacklist' | 'employment';

export type InferenceStep =
  | { kind: 'graph_node'; node: NodeKind; field?: string; value: string }
  | { kind: 'rule_logic'; markdown: string }
  | { kind: 'computation'; label: string; value: string }
  | { kind: 'verdict'; status: RuleStatus; reason: string };

export type InferenceChain = {
  rule_id: string;
  steps: InferenceStep[];
  highlight_nodes: NodeKind[];
};

export type ExtractorFn = (
  graph: import('../graph-context').GraphContext,
  runtime: import('../types').RuleCheckRuntimeContext,
  rule: import('../types').Rule,
  ruleResult: import('../types').RuleResult,
) => InferenceChain;
