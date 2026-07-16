import { describe, it, expect } from 'vitest';
import { foldDecision, explanationTag, formatExplanation, severityOfRule } from './runner';
import type { RuleExplanation, RuleResult, RuleStatus, Severity } from './types';

function rr(rule_id: string, status: RuleStatus): RuleResult {
  return { rule_id, rule_name: rule_id, step_id: 's', status };
}
function sev(entries: Record<string, Severity>): Map<string, Severity> {
  return new Map(Object.entries(entries));
}

describe('foldDecision (2026-06-01: fail-closed on unconfirmable 底线规则)', () => {
  it('confirmed fail on optional/flag_only → PASS (result retained, gate not blocked)', () => {
    expect(foldDecision([rr('10-1', 'fail')], sev({ '10-1': 'flag_only' }))).toBe('PASS');
  });

  it('confirmed fail on terminal → FAIL', () => {
    expect(foldDecision([rr('10-1', 'fail')], sev({ '10-1': 'terminal' }))).toBe('FAIL');
  });

  it('insufficient_info on terminal → FAIL', () => {
    expect(foldDecision([rr('10-1', 'insufficient_info')], sev({ '10-1': 'terminal' }))).toBe('FAIL');
  });

  it('pending on needs_human → FAIL', () => {
    expect(foldDecision([rr('10-1', 'pending')], sev({ '10-1': 'needs_human' }))).toBe('FAIL');
  });

  it('not_executed on terminal → FAIL', () => {
    expect(foldDecision([rr('10-1', 'not_executed')], sev({ '10-1': 'terminal' }))).toBe('FAIL');
  });

  it('insufficient_info on flag_only → PASS (提示类不阻断,gate)', () => {
    expect(foldDecision([rr('10-1', 'insufficient_info')], sev({ '10-1': 'flag_only' }))).toBe('PASS');
  });

  it('unknown severity (rule_id not in map) on insufficient_info → FAIL (fail-closed default)', () => {
    expect(foldDecision([rr('10-1', 'insufficient_info')], new Map())).toBe('FAIL');
  });

  it('not_triggered only → PASS (规则不适用本候选人)', () => {
    expect(foldDecision([rr('10-1', 'not_triggered')], sev({ '10-1': 'terminal' }))).toBe('PASS');
  });

  it('all pass → PASS', () => {
    expect(
      foldDecision([rr('10-1', 'pass'), rr('10-2', 'pass')], sev({ '10-1': 'terminal', '10-2': 'terminal' })),
    ).toBe('PASS');
  });

  it('mixed: one terminal insufficient_info blocks despite passes', () => {
    expect(
      foldDecision(
        [rr('10-1', 'pass'), rr('10-2', 'insufficient_info')],
        sev({ '10-1': 'terminal', '10-2': 'terminal' }),
      ),
    ).toBe('FAIL');
  });
});

describe('explanationTag / formatExplanation (人工复核标注)', () => {
  it('tags the unconfirmable statuses; fail stays untagged', () => {
    expect(explanationTag('insufficient_info')).toContain('信息不足');
    expect(explanationTag('pending')).toContain('HSM');
    expect(explanationTag('not_executed')).toContain('未能评估');
    expect(explanationTag('fail')).toBe('');
  });

  it('formatExplanation embeds id, name, tag and reason — never blank for insufficient_info', () => {
    const e: RuleExplanation = {
      rule_id: '10-5',
      rule_name: '腾讯CDG正式编制核验',
      step_id: 's',
      status: 'insufficient_info',
      reason: '简历未提供编制字段,无法确认',
    };
    const out = formatExplanation(e);
    expect(out).toContain('[10-5]');
    expect(out).toContain('腾讯CDG正式编制核验');
    expect(out).toContain('信息不足');
    expect(out).toContain('简历未提供编制字段');
  });
});

describe('severityOfRule', () => {
  it('optional governance wins over a stale contradictory severity field', () => {
    expect(
      severityOfRule({ severity: 'terminal', enforcementLevel: 'optional', failurePolicy: 'warn' }),
    ).toBe('flag_only');
  });
  it('derives needs_human from mandatory + warn', () => {
    expect(severityOfRule({ enforcementLevel: 'mandatory', failurePolicy: 'warn' })).toBe('needs_human');
  });
  it('derives flag_only from optional + warn', () => {
    expect(severityOfRule({ enforcementLevel: 'optional', failurePolicy: 'warn' })).toBe('flag_only');
  });
  it('unknown (fields missing) → terminal (fail-closed default)', () => {
    expect(severityOfRule({})).toBe('terminal');
  });
});
