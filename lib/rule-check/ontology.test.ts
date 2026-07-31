import { describe, it, expect } from 'vitest';
import {
  applyClientFilter,
  normalizeRawRule,
  deriveBgFromOrgName,
  extractDims,
  matchesDepartment,
  severityForRuleId,
} from './ontology';
import type { Rule } from './types';

describe('normalizeRawRule', () => {
  it('reads enforcementLevel + failurePolicy from raw rule and derives legacy severity', () => {
    const r = normalizeRawRule({
      id: '10-25',
      specificScenarioStage: '简历匹配',
      businessLogicRuleName: 'sample',
      applicableClient: '通用',
      applicableDepartment: 'N/A',
      submissionCriteria: '',
      standardizedLogicRule: 'sample logic',
      relatedEntities: [],
      businessBackgroundReason: '',
      ruleSource: '',
      executor: 'Agent',
      enforcementLevel: 'mandatory',
      failurePolicy: 'block',
    });
    expect(r.enforcementLevel).toBe('mandatory');
    expect(r.failurePolicy).toBe('block');
    expect(r.severity).toBe('terminal'); // mandatory + block → terminal
  });

  it('derives severity=flag_only for optional + warn', () => {
    const r = normalizeRawRule({
      id: '10-26',
      executor: 'Agent',
      applicableClient: '通用',
      applicableDepartment: 'N/A',
      standardizedLogicRule: '',
      enforcementLevel: 'optional',
      failurePolicy: 'warn',
    } as any);
    expect(r.severity).toBe('flag_only');
  });

  // `optional` 是绝对非阻断契约:即便 failurePolicy 自相矛盾地写成 block,也
  // 不升级。与 runner.severityOfRule / api-rule-fetcher.toRule 口径一致。
  it('derives severity=flag_only for optional + block (optional wins over contradictory failurePolicy)', () => {
    const r = normalizeRawRule({
      id: '10-27',
      executor: 'Agent',
      applicableClient: '通用',
      applicableDepartment: 'N/A',
      standardizedLogicRule: '',
      enforcementLevel: 'optional',
      failurePolicy: 'block',
    } as any);
    expect(r.severity).toBe('flag_only');
  });

  it('derives severity=needs_human for mandatory + warn', () => {
    const r = normalizeRawRule({
      id: '10-28',
      executor: 'Agent',
      applicableClient: '通用',
      applicableDepartment: 'N/A',
      standardizedLogicRule: '',
      enforcementLevel: 'mandatory',
      failurePolicy: 'warn',
    } as any);
    expect(r.severity).toBe('needs_human');
  });

  it('falls back to flag_only when enforcement fields missing (legacy json compat)', () => {
    const r = normalizeRawRule({
      id: '10-99',
      executor: 'Agent',
      applicableClient: '通用',
      applicableDepartment: 'N/A',
      standardizedLogicRule: '',
    } as any);
    expect(r.severity).toBe('flag_only');
    expect(r.enforcementLevel).toBeUndefined();
    expect(r.failurePolicy).toBeUndefined();
  });
});

describe('applyClientFilter (unchanged behavior)', () => {
  const sampleRules: Rule[] = [
    { id: '1', applicableClient: '通用', applicableDepartment: 'N/A', executor: 'Agent' } as Rule,
    { id: '2', applicableClient: '字节', applicableDepartment: 'N/A', executor: 'Agent' } as Rule,
    { id: '3', applicableClient: '字节', applicableDepartment: 'IEG', executor: 'Agent' } as Rule,
    { id: '4', applicableClient: '通用', applicableDepartment: 'N/A', executor: 'Human' } as Rule,
  ];

  it('includes 通用 rules and matching-client rules; excludes Human-executor', () => {
    const r = applyClientFilter(sampleRules, { client_id: '字节', business_group: null, studio: null });
    expect(r.map((x) => x.id).sort()).toEqual(['1', '2']);
  });

  it('matches department rule when business_group provided', () => {
    const r = applyClientFilter(sampleRules, { client_id: '字节', business_group: 'IEG', studio: null });
    expect(r.map((x) => x.id).sort()).toEqual(['1', '2', '3']);
  });
});

describe('deriveBgFromOrgName (sd_org_name → BG token)', () => {
  it('maps 互娱 org name to IEG', () => {
    // 真实 partner-pg JR 的 sd_org_name 是 "腾讯互娱事业部"(简称),
    // 不是 BG_DISPLAY 里的 canonical "互动娱乐事业群" — 必须 substring 匹配。
    expect(deriveBgFromOrgName('腾讯互娱事业部')).toBe('IEG');
    expect(deriveBgFromOrgName('互动娱乐事业群')).toBe('IEG');
  });

  it('maps 企业发展 org name to CDG', () => {
    expect(deriveBgFromOrgName('腾讯企业发展事业群')).toBe('CDG');
  });

  it('maps other tencent BGs', () => {
    expect(deriveBgFromOrgName('平台与内容事业群')).toBe('PCG');
    expect(deriveBgFromOrgName('微信事业群')).toBe('WXG');
    expect(deriveBgFromOrgName('云与智慧产业事业群')).toBe('CSIG');
    expect(deriveBgFromOrgName('技术工程事业群')).toBe('TEG');
  });

  it('returns null for empty / unknown org names', () => {
    expect(deriveBgFromOrgName(null)).toBeNull();
    expect(deriveBgFromOrgName('')).toBeNull();
    expect(deriveBgFromOrgName('某不认识的部门')).toBeNull();
  });
});

describe('extractDims business_group resolution order', () => {
  it('prefers explicit client_business_group', () => {
    const dims = extractDims({
      client_id: 'CLI_TENCENT',
      client_business_group: 'PCG',
      sd_org_name: '腾讯互娱事业部',
    });
    expect(dims.business_group).toBe('PCG');
  });

  it('falls back to sd_org_name when department_id is an opaque UUID', () => {
    // 陈思颖 这个真实 case:client_department_id 是 UUID,
    // deriveBgFromDepartmentId 解析不出来,必须靠 sd_org_name 兜底。
    const dims = extractDims({
      client_id: 'cb932a56-6e57-4535-a121-0e36e51d458a',
      client_department_id: 'cb73a7b9-e71d-4f25-ae84-a29aaefc03b0',
      sd_org_name: '腾讯互娱事业部',
    });
    expect(dims.business_group).toBe('IEG');
  });

  it('returns null business_group when nothing resolves', () => {
    const dims = extractDims({
      client_id: 'CLI_TENCENT',
      client_department_id: 'cb73a7b9-e71d-4f25-ae84-a29aaefc03b0',
    });
    expect(dims.business_group).toBeNull();
  });
});

describe('severityForRuleId (catalog lookup — fixes flag_only hardcode)', () => {
  it('returns terminal for a mandatory+block rule (10-42 CDG 冷冻期)', () => {
    // audit detail API 之前从 llm_raw 回填 flag 时硬编码 severity=flag_only,
    // 把 terminal 阻断规则误显成"提示规则不影响推进"。必须查 catalog 真值。
    expect(severityForRuleId('10-42')).toBe('terminal');
  });

  it('returns flag_only for an optional+warn rule (10-1)', () => {
    expect(severityForRuleId('10-1')).toBe('flag_only');
  });

  it('falls back to flag_only for an unknown rule id', () => {
    expect(severityForRuleId('99-999')).toBe('flag_only');
  });
});

describe('matchesDepartment (exported for the API-path filter)', () => {
  it('excludes a CDG rule for an IEG business_group', () => {
    expect(matchesDepartment('CDG', 'IEG')).toBe(false);
  });

  it('includes a CDG rule for a CDG business_group', () => {
    expect(matchesDepartment('CDG', 'CDG')).toBe(true);
  });

  it('fail-closed: excludes a department-specific rule when bg is null', () => {
    expect(matchesDepartment('CDG', null)).toBe(false);
  });

  it('includes client-wide rules (N/A / 通用) regardless of bg', () => {
    expect(matchesDepartment('N/A', null)).toBe(true);
    expect(matchesDepartment('通用', 'IEG')).toBe(true);
  });
});
