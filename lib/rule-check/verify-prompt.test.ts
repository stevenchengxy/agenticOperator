import { describe, it, expect } from 'vitest';
import { parseVerification, type VerifyFlag } from './verify-prompt';

function flags(): VerifyFlag[] {
  return [
    {
      rule_id: '10-5',
      rule_name_snapshot: '编制核验',
      severity: 'terminal',
      applicable: true,
      result: 'INSUFFICIENT_INFO',
      evidence: '',
      next_action: 'supplement',
    },
    {
      rule_id: '10-6',
      rule_name_snapshot: '黑名单',
      severity: 'terminal',
      applicable: true,
      result: 'FAIL',
      evidence: '',
      next_action: 'block',
    },
  ];
}

function verifierJson(rule_id: string, second_verdict: string): string {
  return JSON.stringify({
    overall_confidence: 70,
    verdict: 'needs_review',
    summary: 's',
    dimensions: [],
    rule_opinions: [
      {
        rule_id,
        selection_ok: true,
        selection_reasoning: '',
        second_verdict,
        judgment_reasoning: '因信息不足而不通过',
        confidence: 60,
        dimensions: [],
      },
    ],
    missing_rules: [],
    over_included_rules: [],
  });
}

describe('parseVerification — INSUFFICIENT_INFO second_verdict (2026-06-01)', () => {
  it('INSUFFICIENT_INFO agrees with an original INSUFFICIENT_INFO flag', () => {
    const v = parseVerification(verifierJson('10-5', 'INSUFFICIENT_INFO'), flags());
    const op = v.rule_opinions.find((o) => o.rule_id === '10-5');
    expect(op?.second_verdict).toBe('INSUFFICIENT_INFO');
    expect(op?.agrees).toBe(true);
  });

  it('INSUFFICIENT_INFO does NOT agree with an original FAIL flag', () => {
    const v = parseVerification(verifierJson('10-6', 'INSUFFICIENT_INFO'), flags());
    const op = v.rule_opinions.find((o) => o.rule_id === '10-6');
    expect(op?.second_verdict).toBe('INSUFFICIENT_INFO');
    expect(op?.agrees).toBe(false);
  });

  it('normalizes loose spellings ("insufficient info") to INSUFFICIENT_INFO', () => {
    const v = parseVerification(verifierJson('10-5', 'insufficient info'), flags());
    expect(v.rule_opinions[0]?.second_verdict).toBe('INSUFFICIENT_INFO');
  });
});
