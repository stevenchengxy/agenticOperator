import { describe, it, expect } from 'vitest';
import { foldVerdict, applyAuditFacets, type FacetableRow } from './audit-facets';

describe('foldVerdict', () => {
  it('PASS → pass', () => {
    expect(foldVerdict('PASS', null)).toBe('pass');
  });
  it('FAIL with no fail_reason → fail (real violation)', () => {
    expect(foldVerdict('FAIL', null)).toBe('fail');
    expect(foldVerdict('FAIL', undefined)).toBe('fail');
  });
  it('FAIL with an infra fail_reason → parked (candidate not rejected)', () => {
    expect(foldVerdict('FAIL', 'llm-call-error')).toBe('parked');
    expect(foldVerdict('FAIL', 'ontology-graph-unavailable')).toBe('parked');
  });
  it('a non-infra fail_reason string is still a real fail', () => {
    expect(foldVerdict('FAIL', 'rule-violation')).toBe('fail');
  });
});

describe('applyAuditFacets', () => {
  const rows: FacetableRow[] = [
    { agent_id: 'jr-compliance', stage: '简历筛查', verdict: 'pass' },
    { agent_id: 'jr-compliance', stage: '简历筛查', verdict: 'parked' },
    { agent_id: 'candidate-identity', stage: '候选人入库', verdict: 'fail' },
  ];

  it('no selection → returns all rows', () => {
    expect(applyAuditFacets(rows, {})).toHaveLength(3);
  });
  it('filters by agent', () => {
    expect(applyAuditFacets(rows, { agent: 'candidate-identity' })).toEqual([rows[2]]);
  });
  it('filters by stage', () => {
    expect(applyAuditFacets(rows, { stage: '候选人入库' })).toEqual([rows[2]]);
  });
  it('filters by verdict', () => {
    expect(applyAuditFacets(rows, { verdict: 'parked' })).toEqual([rows[1]]);
  });
  it('combines facets with AND', () => {
    expect(applyAuditFacets(rows, { agent: 'jr-compliance', verdict: 'pass' })).toEqual([rows[0]]);
  });
  it('ignores empty-string selections (treated as "all")', () => {
    expect(applyAuditFacets(rows, { agent: '', stage: '', verdict: '' })).toHaveLength(3);
  });
});
