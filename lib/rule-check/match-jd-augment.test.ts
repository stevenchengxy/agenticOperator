import { describe, it, expect } from 'vitest';
import { appendRuleCheckToJd, formatRuleCheckBlockForJd, type JdRuleLine } from './match-jd-augment';

const RULES: JdRuleLine[] = [
  { rule_id: '10-25', rule_name: '学历底线', status: 'pass', reason: '本科,满足岗位要求' },
  { rule_id: '10-42', rule_name: 'CDG 回流冷冻', status: 'not_triggered', reason: '候选人无腾讯任职经历' },
  { rule_id: '10-46', rule_name: '竞业限制核查', status: 'insufficient_info', reason: '简历未提供在职公司性质' },
];

describe('formatRuleCheckBlockForJd — 规则检查结论 → JD 追加文本块', () => {
  it('含标题标注、逐条「规则号 规则名:状态 — 依据」,全中文状态', () => {
    const block = formatRuleCheckBlockForJd(RULES);
    expect(block).toContain('入岗前规则检查');
    expect(block).toContain('系统注入');
    expect(block).toContain('10-25 学历底线:通过 — 本科,满足岗位要求');
    expect(block).toContain('10-42 CDG 回流冷冻:不触发 — 候选人无腾讯任职经历');
    expect(block).toContain('10-46 竞业限制核查:信息不足 — 简历未提供在职公司性质');
  });
  it('单条 reason 超长截断(≤200 字),整块 ≤2000 字', () => {
    const long = [{ rule_id: 'x', rule_name: 'n', status: 'pass' as const, reason: '长'.repeat(500) }];
    const block = formatRuleCheckBlockForJd(long);
    expect(block.length).toBeLessThan(600);
    const many = Array.from({ length: 60 }, (_, i) => ({ rule_id: `r${i}`, rule_name: '规则', status: 'pass' as const, reason: '理由'.repeat(50) }));
    expect(formatRuleCheckBlockForJd(many).length).toBeLessThanOrEqual(2000);
  });
});

describe('appendRuleCheckToJd — 拼进 JD 文本(领导方案:rule check 结果进 jd)', () => {
  it('JD 原文在前,规则块追加在后', () => {
    const jd = appendRuleCheckToJd('岗位:行政文秘\n要求:本科以上', RULES);
    expect(jd.startsWith('岗位:行政文秘')).toBe(true);
    expect(jd.indexOf('入岗前规则检查')).toBeGreaterThan(jd.indexOf('要求:本科以上'));
  });
  it('无规则(空数组 / undefined)→ 原样返回,不加空块', () => {
    expect(appendRuleCheckToJd('JD 原文', [])).toBe('JD 原文');
    expect(appendRuleCheckToJd('JD 原文', undefined)).toBe('JD 原文');
  });
});
