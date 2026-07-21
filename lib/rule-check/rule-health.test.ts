import { describe, it, expect } from 'vitest';
import {
  extractBlockingRuleIds,
  classifyRuleHealth,
  aggregateRuleHealth,
  type AuditOutcome,
  type RuleMeta,
} from './rule-health';

describe('extractBlockingRuleIds', () => {
  it('pulls the leading [rule-id] out of each formatExplanation entry', () => {
    const json = JSON.stringify([
      '[10-45] 腾讯正编转外包回流标记（信息不足·需人工复核）: 无法核实',
      '[10-5] 简历匹配硬性要求一票否决: 学历不符',
    ]);
    expect(extractBlockingRuleIds(json)).toEqual(['10-45', '10-5']);
  });

  it('tolerates null / non-array / malformed JSON', () => {
    expect(extractBlockingRuleIds(null)).toEqual([]);
    expect(extractBlockingRuleIds('')).toEqual([]);
    expect(extractBlockingRuleIds('not json')).toEqual([]);
    expect(extractBlockingRuleIds('"a string"')).toEqual([]);
    expect(extractBlockingRuleIds(JSON.stringify(['no brackets here']))).toEqual([]);
  });
});

describe('classifyRuleHealth', () => {
  it('fired → blocking/idle;in-scope 未发火 → dead;out-of-scope → unassessed', () => {
    expect(classifyRuleHealth(0, 0)).toBe('dead'); // 默认 inScope=true
    expect(classifyRuleHealth(0, 0, true)).toBe('dead');
    expect(classifyRuleHealth(0, 0, false)).toBe('unassessed'); // 非简历匹配阶段
    expect(classifyRuleHealth(5, 2)).toBe('blocking');
    expect(classifyRuleHealth(5, 0)).toBe('idle');
    expect(classifyRuleHealth(5, 0, false)).toBe('idle'); // 发过火就算 idle,不看 inScope
  });
});

describe('aggregateRuleHealth', () => {
  // 全部标 stage=简历匹配 → 在 rule-check 评估范围内(未发火算 dead 而非 unassessed)。
  const meta = new Map<string, RuleMeta>([
    ['10-45', { name: '腾讯回流标记', severity: 'terminal', stage: '简历匹配' }],
    ['10-5', { name: '硬性要求一票否决', severity: 'flag_only', stage: '简历匹配' }],
    ['10-10', { name: '空窗期', severity: 'flag_only', stage: '简历匹配' }],
    ['10-99', { name: '从不触发的规则', severity: 'flag_only', stage: '简历匹配' }],
  ]);
  const ontologyIds = ['10-45', '10-5', '10-10', '10-99'];

  it('counts evaluated/passed/failed audit-centrically, with passed = evaluated − failed', () => {
    const audits: AuditOutcome[] = [
      // PASS audit: assessed 10-45 + 10-10, blocked nothing
      { decision: 'PASS', fail_reason: null, failure_reasons: '[]', assessed_rule_ids: ['10-45', '10-10'] },
      // FAIL audit: 10-45 was the blocker; 10-5 also assessed but didn't block
      { decision: 'FAIL', fail_reason: null, failure_reasons: JSON.stringify(['[10-45] …: x']), assessed_rule_ids: ['10-45', '10-5'] },
    ];
    const { rules } = aggregateRuleHealth(audits, meta, ontologyIds);
    const by = Object.fromEntries(rules.map((r) => [r.rule_id, r]));
    expect(by['10-45']).toMatchObject({ evaluated: 2, failed: 1, passed: 1, health: 'blocking' });
    expect(by['10-5']).toMatchObject({ evaluated: 1, failed: 0, passed: 1, health: 'idle' });
    expect(by['10-10']).toMatchObject({ evaluated: 1, failed: 0, passed: 1, health: 'idle' });
    // invariant
    for (const r of rules) expect(r.passed + r.failed).toBe(r.evaluated);
  });

  it('skips infra-parked audits entirely (no rule attribution)', () => {
    const audits: AuditOutcome[] = [
      { decision: 'FAIL', fail_reason: 'llm-call-error', failure_reasons: JSON.stringify(['AI 模型余额不足']), assessed_rule_ids: [] },
      { decision: 'PASS', fail_reason: null, failure_reasons: '[]', assessed_rule_ids: ['10-5'] },
    ];
    const { rules, totals } = aggregateRuleHealth(audits, meta, ontologyIds);
    // rules 现在是全量目录(含未发火的);只有 10-5 evaluated>0。
    expect(rules.filter((r) => r.evaluated > 0).map((r) => r.rule_id)).toEqual(['10-5']);
    expect(totals.rules_fired).toBe(1);
  });

  it('counts a blocker even if it was missing from assessed_rule_ids (failure_reasons is authority)', () => {
    const audits: AuditOutcome[] = [
      { decision: 'FAIL', fail_reason: null, failure_reasons: JSON.stringify(['[10-45] …']), assessed_rule_ids: [] },
    ];
    const { rules } = aggregateRuleHealth(audits, meta, ontologyIds);
    expect(rules[0]).toMatchObject({ rule_id: '10-45', evaluated: 1, failed: 1, passed: 0 });
  });

  it('reports Dead rules + totals from the ontology set', () => {
    const audits: AuditOutcome[] = [
      { decision: 'PASS', fail_reason: null, failure_reasons: '[]', assessed_rule_ids: ['10-45'] },
      { decision: 'FAIL', fail_reason: null, failure_reasons: JSON.stringify(['[10-5] …']), assessed_rule_ids: ['10-5'] },
    ];
    const { dead_rules, totals } = aggregateRuleHealth(audits, meta, ontologyIds);
    expect(dead_rules.map((d) => d.rule_id)).toEqual(['10-10', '10-99']);
    expect(totals).toMatchObject({ rules_total: 4, rules_fired: 2, rules_dead: 2, blocking_rules: 1 });
  });

  it('不提取已不在本体的孤儿规则:发过火但 rule_id 不在本体集 → 不列出', () => {
    const audits: AuditOutcome[] = [
      { decision: 'FAIL', fail_reason: null, failure_reasons: JSON.stringify(['[99-99] off-ontology rule …']), assessed_rule_ids: ['99-99'] },
    ];
    const { rules, dead_rules, totals } = aggregateRuleHealth(audits, meta, ontologyIds);
    // 99-99 已不在 live 本体 → 孤儿,不提取(总览只反映当前本体)。
    expect(rules.map((r) => r.rule_id)).not.toContain('99-99');
    expect(dead_rules.map((d) => d.rule_id)).not.toContain('99-99');
    expect(totals.rules_total).toBe(4); // 本体集大小不变
    expect(totals.rules_fired).toBe(0); // 本体里的规则本窗口都没发火(只有孤儿 99-99 发了,已剔除)
  });

  it('本体不可用(ontologyIds 空)时降级:列发过火的规则,避免总览空白', () => {
    const audits: AuditOutcome[] = [
      { decision: 'PASS', fail_reason: null, failure_reasons: '[]', assessed_rule_ids: ['10-5'] },
    ];
    const { rules } = aggregateRuleHealth(audits, meta, []); // 本体集空
    expect(rules.map((r) => r.rule_id)).toEqual(['10-5']); // 降级显示发过火的
  });

  it('does NOT fake rules_total from fired count when the ontology set is empty (no false 100% coverage)', () => {
    const audits: AuditOutcome[] = [
      { decision: 'PASS', fail_reason: null, failure_reasons: '[]', assessed_rule_ids: ['10-5'] },
    ];
    const { totals } = aggregateRuleHealth(audits, new Map(), []);
    expect(totals.rules_total).toBe(0); // → component renders coverage as unknown, not 100%
    expect(totals.rules_fired).toBe(1);
  });

  it('sorts most-impactful first (failed desc, then evaluated desc)', () => {
    const audits: AuditOutcome[] = [
      { decision: 'PASS', fail_reason: null, failure_reasons: '[]', assessed_rule_ids: ['10-10', '10-10'] },
      { decision: 'FAIL', fail_reason: null, failure_reasons: JSON.stringify(['[10-5] …']), assessed_rule_ids: ['10-5'] },
      { decision: 'FAIL', fail_reason: null, failure_reasons: JSON.stringify(['[10-45] …', '[10-45] …']), assessed_rule_ids: ['10-45'] },
      { decision: 'FAIL', fail_reason: null, failure_reasons: JSON.stringify(['[10-45] …']), assessed_rule_ids: ['10-45'] },
    ];
    const { rules } = aggregateRuleHealth(audits, meta, ontologyIds);
    // 10-45 failed twice → first;10-5 failed once → second;10-10 idle(ev>0);10-99 dead(ev=0)→ last
    expect(rules.map((r) => r.rule_id)).toEqual(['10-45', '10-5', '10-10', '10-99']);
  });

  it('全量目录:本体全部规则各一行,带 stage;非简历匹配阶段 → unassessed(不算 dead)', () => {
    const mixedMeta = new Map<string, RuleMeta>([
      ['10-5', { name: '简历匹配规则', severity: 'flag_only', stage: '简历匹配' }],
      ['20-1', { name: '推荐包生成规则', severity: 'flag_only', stage: '推荐包生成' }],
      ['30-1', { name: '客户推送规则', severity: 'terminal', stage: '客户推送' }],
    ]);
    const audits: AuditOutcome[] = [
      { decision: 'PASS', fail_reason: null, failure_reasons: '[]', assessed_rule_ids: ['10-5'] },
    ];
    const { rules, totals } = aggregateRuleHealth(audits, mixedMeta, ['10-5', '20-1', '30-1']);
    const by = Object.fromEntries(rules.map((r) => [r.rule_id, r]));
    expect(rules).toHaveLength(3); // 全量目录,不止发火的
    expect(by['10-5']).toMatchObject({ stage: '简历匹配', health: 'idle' });
    expect(by['20-1']).toMatchObject({ stage: '推荐包生成', health: 'unassessed' });
    expect(by['30-1']).toMatchObject({ stage: '客户推送', health: 'unassessed' });
    expect(totals).toMatchObject({ rules_total: 3, rules_fired: 1, rules_dead: 0, rules_unassessed: 2 });
  });
});
