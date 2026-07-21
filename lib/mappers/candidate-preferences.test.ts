// candidate-preferences.test.ts — extracting a candidate's job-seeking
// expectations (求职意向/期望) from a parsed resume and rendering them into the
// free-form `candidatePreferences` string RoboHire /match-resume accepts.

import { describe, it, expect } from 'vitest';
import {
  extractCandidateExpectation,
  formatCandidatePreferences,
} from './candidate-preferences';

describe('extractCandidateExpectation — 从简历文本抽候选人期望', () => {
  it('抽期望职位 → expected_roles', () => {
    const exp = extractCandidateExpectation('求职意向\n期望职位：后端工程师');
    expect(exp).toMatchObject({ expected_roles: ['后端工程师'] });
  });

  it('抽期望城市(多城市按分隔符拆) → expected_cities', () => {
    const exp = extractCandidateExpectation('期望城市：深圳、广州');
    expect(exp).toMatchObject({ expected_cities: ['深圳', '广州'] });
  });

  it('抽期望薪资区间(K) → 月薪 min/max', () => {
    const exp = extractCandidateExpectation('期望薪资：15-20K');
    expect(exp).toMatchObject({
      expected_salary_monthly_min: 15000,
      expected_salary_monthly_max: 20000,
    });
  });

  it('抽单值期望月薪(万) → min===max', () => {
    const exp = extractCandidateExpectation('期望月薪 1.5万');
    expect(exp).toMatchObject({
      expected_salary_monthly_min: 15000,
      expected_salary_monthly_max: 15000,
    });
  });

  it('抽工作模式(远程) → expected_work_mode', () => {
    const exp = extractCandidateExpectation('可接受远程办公');
    expect(exp).toMatchObject({ expected_work_mode: '远程' });
  });

  it('结构化输入里已有的字段直接透传(不依赖 rawText)', () => {
    const exp = extractCandidateExpectation({
      parsed: { expected_roles: ['数据分析师'], expected_cities: ['北京'] },
      rawText: null,
    });
    expect(exp).toMatchObject({
      expected_roles: ['数据分析师'],
      expected_cities: ['北京'],
    });
  });

  it('什么都抽不到时返回空对象(下游不会发 candidatePreferences)', () => {
    expect(extractCandidateExpectation('张三 后端五年经验 精通 TS')).toEqual({});
    expect(extractCandidateExpectation(null)).toEqual({});
    expect(extractCandidateExpectation(undefined)).toEqual({});
    expect(extractCandidateExpectation('')).toEqual({});
  });
});

describe('formatCandidatePreferences — 结构化期望 → RoboHire 自由文本', () => {
  it('渲染成带标签的多行文本(职位/城市/薪资/模式都在)', () => {
    const text = formatCandidatePreferences({
      expected_salary_monthly_min: 15000,
      expected_salary_monthly_max: 20000,
      expected_cities: ['深圳', '广州'],
      expected_industries: ['互联网'],
      expected_roles: ['后端工程师'],
      expected_work_mode: '远程',
    });
    expect(text).toContain('后端工程师');
    expect(text).toContain('深圳');
    expect(text).toContain('广州');
    expect(text).toContain('15000');
    expect(text).toContain('20000');
    expect(text).toContain('互联网');
    expect(text).toContain('远程');
  });

  it('空期望 → 空串', () => {
    expect(formatCandidatePreferences({})).toBe('');
    expect(formatCandidatePreferences(null)).toBe('');
    expect(formatCandidatePreferences(undefined)).toBe('');
  });

  it('只有部分字段时只渲染有值的那几行', () => {
    const text = formatCandidatePreferences({
      expected_salary_monthly_min: null,
      expected_salary_monthly_max: null,
      expected_cities: ['上海'],
      expected_industries: [],
      expected_roles: [],
      expected_work_mode: null,
    });
    expect(text).toContain('上海');
    expect(text).not.toContain('期望职位');
    expect(text).not.toContain('期望月薪');
  });
});
