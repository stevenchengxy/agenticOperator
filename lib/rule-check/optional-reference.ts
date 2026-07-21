import type { RuleExplanation, RuleResult } from './types';

type GovernedResult = Pick<
  RuleResult | RuleExplanation,
  'enforcement_level' | 'severity' | 'blocking'
>;

/**
 * Runtime source of truth for the gate/reference split. New runner results
 * always carry `blocking`; the governance fallbacks keep replayed legacy
 * payloads safe without treating an unknown rule as optional.
 */
export function isReferenceOnlyRule(result: GovernedResult): boolean {
  return (
    result.blocking === false ||
    result.enforcement_level === 'optional' ||
    result.severity === 'flag_only'
  );
}

export function blockingExplanations(explanations: RuleExplanation[]): RuleExplanation[] {
  return explanations.filter((explanation) => !isReferenceOnlyRule(explanation));
}

/**
 * Candidate_Match_Result has one canonical `rule_check_reason` string in the
 * ontology. Store every evaluated optional rule there as an explicitly
 * non-blocking JSON reference so Neo4j retains the complete optional outcome,
 * including passes and non-triggered rules—not only warnings.
 */
export function formatOptionalRuleReference(results: RuleResult[]): string {
  const optional = results
    .filter(isReferenceOnlyRule)
    .map((result) => ({
      rule_id: result.rule_id,
      rule_name: result.rule_name,
      status: result.status,
      reason: result.reason ?? '',
      next_action: result.next_action ?? 'review',
      enforcement_level: 'optional' as const,
      failure_policy: result.failure_policy ?? 'warn',
      blocking: false,
    }));

  if (optional.length === 0) return '';
  return `【可选规则参考（不影响通过/未通过）】${JSON.stringify(optional)}`;
}
