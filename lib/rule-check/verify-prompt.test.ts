import { describe, it, expect } from 'vitest';
import {
  composeVerifyPrompt,
  parseVerification,
  type VerifyFlag,
  type VerifyPromptInput,
} from './verify-prompt';

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

const baseFlag: VerifyFlag = {
  rule_id: '10-25',
  rule_name_snapshot: '通用A',
  severity: 'terminal',
  applicable: true,
  result: 'PASS',
  evidence: 'ev',
  next_action: 'continue',
};
const baseInput: VerifyPromptInput = {
  decision: 'PASS',
  failure_reasons: [],
  client_name: '腾讯',
  business_group: null,
  user_prompt: null,
  resume: { name: '陈思颖' },
  jr: { client_job_title: '测试岗位' },
  flags: [baseFlag],
  rule_provenance: [],
  filtered_out_rules: [],
  excluded_rules: [
    {
      rule_id: '10-42',
      rule_name: 'CDG拦截',
      applicable_client: '腾讯',
      applicable_department: 'CDG',
      tier: 'department',
      reason: '岗位 bg 未解析,fail-closed',
      definition: '离职不满6个月必须阻断…',
    },
  ],
};

describe('composeVerifyPrompt — 排除规则段', () => {
  it('渲染被排除规则段,含 id/名称/定义/排除理由', () => {
    const p = composeVerifyPrompt(baseInput);
    expect(p).toContain('被排除的规则');
    expect(p).toContain('10-42');
    expect(p).toContain('CDG拦截');
    expect(p).toContain('fail-closed');
  });
  it('opinions 总数提示 = 已评估 + 被排除', () => {
    const p = composeVerifyPrompt(baseInput);
    // 1 评估 + 1 排除 = 2
    expect(p).toMatch(/2\s*条/);
  });
});

describe('parseVerification — 排除规则意见保留且不计入一致率', () => {
  it('排除规则 opinion(不在 flags 中)保留 selection_ok,但不进 agreement_total', () => {
    const raw = JSON.stringify({
      overall_confidence: 80,
      verdict: 'trustworthy',
      summary: 's',
      dimensions: [],
      rule_opinions: [
        { rule_id: '10-25', selection_ok: true, second_verdict: 'PASS', confidence: 90, dimensions: [] },
        { rule_id: '10-42', selection_ok: true, second_verdict: 'NOT_APPLICABLE', confidence: 70, dimensions: [] },
      ],
      missing_rules: [],
      over_included_rules: [],
    });
    const v = parseVerification(raw, [baseFlag]);
    const cdg = v.rule_opinions.find((o) => o.rule_id === '10-42')!;
    expect(cdg).toBeTruthy();
    expect(cdg.selection_ok).toBe(true);
    // 只有 10-25 在 flags 中 → agreement_total 只数它
    expect(v.agreement_total).toBe(1);
  });
});
