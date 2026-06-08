import { describe, it, expect } from 'vitest';
import { enrichProvenanceWithNames, buildExcludedRules } from './excluded-rule-enrich';
import type { RuleProvenance } from './types';

const prov: RuleProvenance[] = [
  { rule_id: '10-25', tier: 'general', included: true, reason: '通用规则(CSI),无条件纳入' },
  { rule_id: '10-42', tier: 'department', included: false, reason: '排除：岗位 bg 未解析,部门专属规则(CDG)fail-closed' },
  { rule_id: 'ZZ-NOPE', tier: 'client', included: false, reason: '不在目录里' },
];

describe('enrichProvenanceWithNames', () => {
  it('给在目录里的规则补 rule_name,保留原字段', () => {
    const out = enrichProvenanceWithNames(prov);
    const cdg = out.find((p) => p.rule_id === '10-42')!;
    expect(cdg.rule_name).toBe('CDG事业群6个月回流冷冻期绝对拦截');
    expect(cdg.included).toBe(false);
    expect(cdg.reason).toContain('fail-closed');
  });
  it('目录里没有的 id 不报错,rule_name 省略/空', () => {
    const out = enrichProvenanceWithNames(prov);
    const miss = out.find((p) => p.rule_id === 'ZZ-NOPE')!;
    expect(miss.rule_name ?? '').toBe('');
  });
});

describe('buildExcludedRules', () => {
  it('只取 included=false,补 name/client/dept/definition', () => {
    const out = buildExcludedRules(prov);
    expect(out.map((r) => r.rule_id)).toEqual(['10-42', 'ZZ-NOPE']);
    const cdg = out[0];
    expect(cdg.rule_name).toBe('CDG事业群6个月回流冷冻期绝对拦截');
    expect(cdg.applicable_department).toBe('CDG');
    expect(cdg.tier).toBe('department');
    expect(cdg.definition.length).toBeGreaterThan(20); // standardizedLogicRule 不空
  });
  it('目录缺失的排除规则降级为仅 id+reason(name/definition 空字符串)', () => {
    const out = buildExcludedRules(prov);
    const miss = out.find((r) => r.rule_id === 'ZZ-NOPE')!;
    expect(miss.rule_name).toBe('');
    expect(miss.definition).toBe('');
    expect(miss.reason).toBe('不在目录里');
  });
});
