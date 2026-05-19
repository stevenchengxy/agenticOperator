import { describe, it, expect } from 'vitest';
import { applyClientFilter, normalizeRawRule } from './ontology';
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

  it('derives severity=needs_human for mixed enforcement/failure combo', () => {
    const r = normalizeRawRule({
      id: '10-27',
      executor: 'Agent',
      applicableClient: '通用',
      applicableDepartment: 'N/A',
      standardizedLogicRule: '',
      enforcementLevel: 'optional',
      failurePolicy: 'block',
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
