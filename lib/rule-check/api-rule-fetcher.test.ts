import { describe, it, expect } from 'vitest';
import { ruleSurvivesFilter, ruleProvenance } from './api-rule-fetcher';

// Raw API rule shape (subset) — the fields passFilter inspects.
type RawApiRule = {
  id: string;
  executor?: string;
  enforcementLevel?: string;
  applicableClient?: string;
  applicableDepartment?: string;
};

const cdgRule: RawApiRule = {
  id: '10-42',
  executor: 'Agent',
  enforcementLevel: 'mandatory',
  applicableClient: '腾讯',
  applicableDepartment: 'CDG',
};

const clientWideRule: RawApiRule = {
  id: '10-25',
  executor: 'Agent',
  enforcementLevel: 'mandatory',
  applicableClient: '腾讯',
  applicableDepartment: 'N/A',
};

const generalRule: RawApiRule = {
  id: '10-1',
  executor: 'Agent',
  enforcementLevel: 'mandatory',
  applicableClient: '通用',
  applicableDepartment: 'N/A',
};

describe('ruleSurvivesFilter — client + department filtering', () => {
  it('THE BUG: excludes a CDG rule for a 腾讯/IEG position', () => {
    // 陈思颖 的真实 case:岗位是腾讯互娱(IEG),CDG 规则 10-42 不该被摘取。
    expect(ruleSurvivesFilter(cdgRule, '腾讯', 'IEG')).toBe(false);
  });

  it('keeps a CDG rule for a 腾讯/CDG position', () => {
    expect(ruleSurvivesFilter(cdgRule, '腾讯', 'CDG')).toBe(true);
  });

  it('fail-closed: excludes a department-specific rule when bg is unresolved (null)', () => {
    expect(ruleSurvivesFilter(cdgRule, '腾讯', null)).toBe(false);
  });

  it('keeps client-wide (N/A dept) rules regardless of business group', () => {
    expect(ruleSurvivesFilter(clientWideRule, '腾讯', 'IEG')).toBe(true);
    expect(ruleSurvivesFilter(clientWideRule, '腾讯', null)).toBe(true);
  });

  it('keeps 通用 rules for any client', () => {
    expect(ruleSurvivesFilter(generalRule, '腾讯', null)).toBe(true);
    expect(ruleSurvivesFilter(generalRule, '字节', 'IEG')).toBe(true);
  });

  it('excludes rules of a different client', () => {
    expect(ruleSurvivesFilter(cdgRule, '字节', 'CDG')).toBe(false);
  });

  it('excludes Human-executor and non-mandatory rules', () => {
    expect(ruleSurvivesFilter({ ...clientWideRule, executor: 'Human' }, '腾讯', null)).toBe(false);
    expect(
      ruleSurvivesFilter({ ...clientWideRule, enforcementLevel: 'optional' }, '腾讯', null),
    ).toBe(false);
  });
});

describe('ruleProvenance — 三层 + 为何纳入/排除', () => {
  it('general tier: 通用规则无条件纳入', () => {
    const p = ruleProvenance(generalRule, '腾讯', null);
    expect(p.tier).toBe('general');
    expect(p.included).toBe(true);
    expect(p.reason).toContain('通用');
  });

  it('client tier: 客户命中纳入', () => {
    const p = ruleProvenance(clientWideRule, '腾讯', 'IEG');
    expect(p.tier).toBe('client');
    expect(p.included).toBe(true);
  });

  it('department tier excluded: CDG 规则 vs IEG 岗位 — 说明部门不匹配', () => {
    const p = ruleProvenance(cdgRule, '腾讯', 'IEG');
    expect(p.tier).toBe('department');
    expect(p.included).toBe(false);
    expect(p.reason).toContain('CDG');
    expect(p.reason).toContain('IEG');
  });

  it('department tier included: CDG 规则 vs CDG 岗位', () => {
    const p = ruleProvenance(cdgRule, '腾讯', 'CDG');
    expect(p.tier).toBe('department');
    expect(p.included).toBe(true);
  });

  it('department tier fail-closed when bg unresolved', () => {
    const p = ruleProvenance(cdgRule, '腾讯', null);
    expect(p.included).toBe(false);
    expect(p.reason).toContain('未解析');
  });

  it('excluded on client mismatch names the clients', () => {
    const p = ruleProvenance(cdgRule, '字节', 'CDG');
    expect(p.included).toBe(false);
    expect(p.reason).toContain('客户');
  });
});
