import { describe, expect, it } from 'vitest';
import { blockingExplanations, formatOptionalRuleReference } from './optional-reference';
import type { RuleExplanation, RuleResult } from './types';

describe('optional rule references', () => {
  it('keeps optional failures out of the blocking explanation set', () => {
    const explanations: RuleExplanation[] = [
      {
        rule_id: 'M-1',
        rule_name: 'mandatory',
        step_id: 's',
        status: 'fail',
        reason: 'blocked',
        enforcement_level: 'mandatory',
        severity: 'terminal',
        blocking: true,
      },
      {
        rule_id: 'O-1',
        rule_name: 'optional',
        step_id: 's',
        status: 'fail',
        reason: 'reference only',
        enforcement_level: 'optional',
        severity: 'flag_only',
        blocking: false,
      },
    ];

    expect(blockingExplanations(explanations).map((item) => item.rule_id)).toEqual(['M-1']);
  });

  it('serializes every optional outcome for Candidate_Match_Result in Neo4j', () => {
    const results: RuleResult[] = [
      {
        rule_id: 'O-1',
        rule_name: 'optional warning',
        step_id: 's',
        status: 'fail',
        reason: 'weak signal hit',
        next_action: 'review',
        enforcement_level: 'optional',
        failure_policy: 'warn',
        severity: 'flag_only',
        blocking: false,
      },
      {
        rule_id: 'O-2',
        rule_name: 'optional pass',
        step_id: 's',
        status: 'pass',
        reason: 'clear',
        next_action: 'continue',
        enforcement_level: 'optional',
        failure_policy: 'warn',
        severity: 'flag_only',
        blocking: false,
      },
      {
        rule_id: 'M-1',
        rule_name: 'mandatory',
        step_id: 's',
        status: 'pass',
        enforcement_level: 'mandatory',
        severity: 'terminal',
        blocking: true,
      },
    ];

    const reference = formatOptionalRuleReference(results);
    expect(reference).toContain('不影响通过/未通过');
    expect(reference).toContain('O-1');
    expect(reference).toContain('O-2');
    expect(reference).not.toContain('M-1');
  });
});
