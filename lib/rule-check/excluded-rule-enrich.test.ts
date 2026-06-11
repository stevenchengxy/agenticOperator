import { describe, it, expect, vi, beforeEach } from 'vitest';

// 用 mock 的 live 目录测 enrichment 逻辑(证明它走 live 中身,而不是打包文件)。
vi.mock('./live-rule-catalog', () => ({ getLiveRuleCatalog: vi.fn() }));

import { enrichProvenanceWithNames, buildExcludedRules } from './excluded-rule-enrich';
import { getLiveRuleCatalog } from './live-rule-catalog';
import type { RuleProvenance, Rule } from './types';

const mCat = vi.mocked(getLiveRuleCatalog);

function rule(id: string, name: string, logic: string, dept: string): Rule {
  return {
    id,
    specificScenarioStage: '简历匹配',
    businessLogicRuleName: name,
    applicableClient: '腾讯',
    applicableDepartment: dept,
    submissionCriteria: '',
    standardizedLogicRule: logic,
    relatedEntities: [],
    businessBackgroundReason: '',
    ruleSource: '客户SOP',
    executor: 'Agent',
    enforcementLevel: 'mandatory',
    failurePolicy: 'block',
    severity: 'terminal',
  };
}

const prov: RuleProvenance[] = [
  { rule_id: '10-25', tier: 'general', included: true, reason: '通用规则(CSI),无条件纳入' },
  { rule_id: '10-42', tier: 'department', included: false, reason: '排除：岗位 bg 未解析,部门专属规则(CDG)fail-closed' },
  { rule_id: 'ZZ-NOPE', tier: 'client', included: false, reason: '不在目录里' },
];

beforeEach(() => {
  mCat.mockReset();
  // live 目录:10-42 的 logic 是 Neo4j 当前值「永不回流」(不是打包的「6个月」)
  mCat.mockResolvedValue(
    new Map([
      ['10-25', rule('10-25', '华为荣耀竞对与客户互不挖角红线', '…通用红线…', 'N/A')],
      ['10-42', rule('10-42', 'CDG事业群6个月回流冷冻期绝对拦截', 'CDG永不回流。', 'CDG')],
    ]),
  );
});

describe('enrichProvenanceWithNames（走 live 目录）', () => {
  it('补 rule_name(live),保留原字段', async () => {
    const out = await enrichProvenanceWithNames(prov);
    const cdg = out.find((p) => p.rule_id === '10-42')!;
    expect(cdg.rule_name).toBe('CDG事业群6个月回流冷冻期绝对拦截');
    expect(cdg.included).toBe(false);
  });
  it('目录里没有的 id 不报错,rule_name 空', async () => {
    const out = await enrichProvenanceWithNames(prov);
    expect((out.find((p) => p.rule_id === 'ZZ-NOPE')!.rule_name) ?? '').toBe('');
  });
});

describe('buildExcludedRules（走 live 目录,定义是 live 永不回流）', () => {
  it('只取 included=false,定义用 live standardizedLogicRule', async () => {
    const out = await buildExcludedRules(prov);
    expect(out.map((r) => r.rule_id)).toEqual(['10-42', 'ZZ-NOPE']);
    const cdg = out[0];
    expect(cdg.rule_name).toBe('CDG事业群6个月回流冷冻期绝对拦截');
    expect(cdg.applicable_department).toBe('CDG');
    expect(cdg.definition).toBe('CDG永不回流。'); // ← live,不是打包的「6个月」
  });
  it('目录缺失的排除规则降级为仅 id+reason', async () => {
    const out = await buildExcludedRules(prov);
    const miss = out.find((r) => r.rule_id === 'ZZ-NOPE')!;
    expect(miss.rule_name).toBe('');
    expect(miss.definition).toBe('');
  });
});
