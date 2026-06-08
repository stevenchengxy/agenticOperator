import { describe, it, expect } from 'vitest';
import { composeEnergyVerifyPrompt, ENERGY_VERIFY_SYSTEM_PROMPT } from './energy-verify-prompt';
import { parseVerification, type VerifyFlag } from './verify-prompt';

const FLAGS: VerifyFlag[] = [
  {
    rule_id: 'CR-HYD-05',
    rule_name_snapshot: '水位汛限',
    severity: 'terminal',
    applicable: true,
    result: 'FAIL',
    evidence: '水位 1613.2m 超汛限 1612m',
    next_action: 'block',
  },
  {
    rule_id: '41',
    rule_name_snapshot: '直通自动采纳五条件(AND)',
    severity: 'flag_only',
    applicable: true,
    result: 'FAIL',
    evidence: '直通五条件汇总',
    next_action: 'continue',
  },
];

describe('composeEnergyVerifyPrompt', () => {
  it('renders stage, deterministic decision, redline, and each rule with evidence', () => {
    const prompt = composeEnergyVerifyPrompt({
      stage: '约束校验',
      domain: '能源调度',
      decision: 'VIOLATED',
      dsNo: 'DS2026053000123',
      redline: true,
      selection: { ok: true, selected: 2, expected: 2, missing: [], extra: [] },
      flags: FLAGS,
      failure_reasons: ['CR-HYD-05 水位汛限'],
    });
    expect(prompt).toContain('约束校验');
    expect(prompt).toContain('VIOLATED');
    expect(prompt).toContain('命中硬红线');
    expect(prompt).toContain('DS2026053000123');
    // every evaluated rule + its evidence is present
    expect(prompt).toContain('CR-HYD-05');
    expect(prompt).toContain('水位 1613.2m 超汛限 1612m');
    expect(prompt).toContain('规则 41');
    // instructs an opinion per evaluated rule
    expect(prompt).toContain('必须恰好 2 条');
  });

  it('surfaces the engine self-check missing list for independent review', () => {
    const prompt = composeEnergyVerifyPrompt({
      stage: '分流与人工确认',
      domain: '能源调度',
      decision: 'MANUAL',
      redline: false,
      selection: { ok: false, selected: 5, expected: 6, missing: ['需裁量'], extra: [] },
      flags: FLAGS,
      failure_reasons: [],
    });
    expect(prompt).toContain('疑似遗漏');
    expect(prompt).toContain('需裁量');
  });

  it('system prompt frames the LLM as an advisory reviewer, not the primary judge', () => {
    expect(ENERGY_VERIFY_SYSTEM_PROMPT).toContain('确定性数值规则引擎');
    expect(ENERGY_VERIFY_SYSTEM_PROMPT).toContain('独立复核');
    // schema parseVerification depends on
    expect(ENERGY_VERIFY_SYSTEM_PROMPT).toContain('rule_opinions');
    expect(ENERGY_VERIFY_SYSTEM_PROMPT).toContain('overall_confidence');
  });
});

describe('parseVerification reused for energy flags', () => {
  it('parses energy rule_ids and computes agreement vs deterministic results', () => {
    const raw = JSON.stringify({
      overall_confidence: 88,
      verdict: 'trustworthy',
      summary: '红线判定与证据一致',
      dimensions: [
        { key: 'selection_coverage', label: '规则选取覆盖', score: 90, reasoning: '抓全' },
        { key: 'numeric_consistency', label: '数值判定一致性', score: 92, reasoning: '自洽' },
      ],
      rule_opinions: [
        {
          rule_id: 'CR-HYD-05',
          selection_ok: true,
          selection_reasoning: '汛限红线该判',
          second_verdict: 'FAIL',
          judgment_reasoning: '水位1613.2m超1612m,FAIL成立',
          confidence: 95,
          dimensions: [{ key: 'judgment_correctness', score: 95 }],
        },
        {
          rule_id: '41',
          selection_ok: true,
          selection_reasoning: '直通条件该判',
          second_verdict: 'FAIL',
          judgment_reasoning: '五条件未全满足',
          confidence: 80,
          dimensions: [],
        },
      ],
      missing_rules: [],
      over_included_rules: [],
    });
    const v = parseVerification(raw, FLAGS);
    expect(v.overall_confidence).toBe(88);
    expect(v.verdict).toBe('trustworthy');
    expect(v.rule_opinions).toHaveLength(2);
    // both second verdicts (FAIL) agree with the deterministic FAIL results
    expect(v.agreement_total).toBe(2);
    expect(v.agreement_count).toBe(2);
    expect(v.agreement_rate).toBe(100);
  });
});
