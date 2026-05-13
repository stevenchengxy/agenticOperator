import type { GraphContext } from '../graph-context';
import type { Rule, RuleResult, RuleCheckRuntimeContext } from '../types';
import type { InferenceChain, ExtractorFn } from './types';

const EXTRACTORS: Record<string, ExtractorFn> = {};

export function registerExtractor(ruleId: string, fn: ExtractorFn): void {
  EXTRACTORS[ruleId] = fn;
}

export function buildInferenceChain(
  graph: GraphContext,
  runtime: RuleCheckRuntimeContext,
  rule: Rule,
  ruleResult: RuleResult,
): InferenceChain {
  const extractor = EXTRACTORS[rule.id];
  if (extractor) return extractor(graph, runtime, rule, ruleResult);
  return {
    rule_id: rule.id,
    highlight_nodes: [],
    steps: [
      { kind: 'rule_logic', markdown: rule.standardizedLogicRule },
      { kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' },
    ],
  };
}

export type { InferenceChain, InferenceStep, ExtractorFn, NodeKind } from './types';

// Per-rule extractor registrations.
import { extract10_5 } from './rule-10-5';
import { extract10_9 } from './rule-10-9';
import { extract10_10 } from './rule-10-10';
import { extract10_17 } from './rule-10-17';
import { extract10_21 } from './rule-10-21';
import { extract10_25 } from './rule-10-25';
import { extract10_26 } from './rule-10-26';
import { extract10_27 } from './rule-10-27';
import { extract10_32 } from './rule-10-32';

registerExtractor('10-5', extract10_5);
registerExtractor('10-9', extract10_9);
registerExtractor('10-10', extract10_10);
registerExtractor('10-17', extract10_17);
registerExtractor('10-21', extract10_21);
registerExtractor('10-25', extract10_25);
registerExtractor('10-26', extract10_26);
registerExtractor('10-27', extract10_27);
registerExtractor('10-32', extract10_32);
