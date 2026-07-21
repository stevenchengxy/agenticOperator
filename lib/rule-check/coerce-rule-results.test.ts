import { describe, it, expect } from 'vitest';
import { defaultNextAction, coerceRuleResults } from './runner';
import type { MatchResumeStepGroup, Rule } from './types';

function rule(id: string): Rule {
  return {
    id,
    specificScenarioStage: '',
    businessLogicRuleName: `rule ${id}`,
    applicableClient: '通用',
    applicableDepartment: 'N/A',
    submissionCriteria: '',
    standardizedLogicRule: '',
    relatedEntities: [],
    businessBackgroundReason: '',
    ruleSource: '',
    executor: 'Agent',
    enforcementLevel: 'mandatory',
    failurePolicy: 'block',
    severity: 'terminal',
  };
}

const steps: MatchResumeStepGroup[] = [
  { step_id: 's1', order: 1, name: 'set1', description: '', condition: '', rules: [rule('10-1'), rule('10-2')] },
];

describe('defaultNextAction', () => {
  it('maps status → action', () => {
    expect(defaultNextAction('fail')).toBe('block');
    expect(defaultNextAction('pass')).toBe('continue');
    expect(defaultNextAction('not_triggered')).toBe('continue');
    expect(defaultNextAction('insufficient_info')).toBe('supplement');
    expect(defaultNextAction('pending')).toBe('review');
    expect(defaultNextAction('not_executed')).toBe('continue');
  });
});

describe('coerceRuleResults next_action', () => {
  it('keeps a valid LLM-supplied next_action', () => {
    const out = coerceRuleResults(
      [{ rule_id: '10-1', status: 'fail', reason: 'x', next_action: 'block' }],
      steps,
    );
    expect(out[0].next_action).toBe('block');
  });

  it('defaults next_action from status when missing/invalid', () => {
    const out = coerceRuleResults(
      [
        { rule_id: '10-1', status: 'pass', reason: 'ok' },
        { rule_id: '10-2', status: 'fail', reason: 'bad', next_action: 'nonsense' },
      ],
      steps,
    );
    expect(out.find((r) => r.rule_id === '10-1')!.next_action).toBe('continue');
    expect(out.find((r) => r.rule_id === '10-2')!.next_action).toBe('block');
  });
});
