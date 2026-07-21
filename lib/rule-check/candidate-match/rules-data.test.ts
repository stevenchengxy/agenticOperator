import { describe, it, expect } from 'vitest';
import {
  loadCandidateMatchRules,
  identityRulesByPriority,
} from './rules-data';

describe('loadCandidateMatchRules', () => {
  it('loads the 3 identity rules from data (not hardcoded)', () => {
    const rs = loadCandidateMatchRules();
    expect(rs.identityRules.map((r) => r.id)).toEqual(['IDENTITY-1', 'IDENTITY-2', 'IDENTITY-3']);
  });

  it('rule 1 is phone-only, exact (no fuzzy fields)', () => {
    const r = loadCandidateMatchRules().identityRules.find((r) => r.id === 'IDENTITY-1')!;
    expect(r.matchFields).toEqual(['phone']);
    expect(r.fuzzyFields).toEqual([]);
    expect(r.needsHumanReview).toBe(false);
  });

  it('rule 2 matches name+email, with name AI-fuzzy-eligible', () => {
    const r = loadCandidateMatchRules().identityRules.find((r) => r.id === 'IDENTITY-2')!;
    expect(r.matchFields).toEqual(['name', 'email']);
    expect(r.fuzzyFields).toContain('name');
    expect(r.fuzzyFields).not.toContain('email');
  });

  it('rule 3 is the 6-field weak signal flagged for human review', () => {
    const r = loadCandidateMatchRules().identityRules.find((r) => r.id === 'IDENTITY-3')!;
    expect(r.matchFields).toEqual(['name', 'gender', 'school', 'major', 'degree', 'graduationYear']);
    expect(r.needsHumanReview).toBe(true);
    // school/major/degree are fuzzy (清华 vs 清华大学); gender/gradYear stay exact.
    expect(r.fuzzyFields).toEqual(expect.arrayContaining(['name', 'school', 'major', 'degree']));
    expect(r.fuzzyFields).not.toContain('gender');
    expect(r.fuzzyFields).not.toContain('graduationYear');
  });

  it('carries the 腾讯 customer-relationship ownership rule scoped to client 腾讯', () => {
    const rs = loadCandidateMatchRules();
    const tencent = rs.ownershipRules.find((r) => r.id === 'OWN-TENCENT-1')!;
    expect(tencent.applicableClient).toBe('腾讯');
    expect(rs.ownershipRules.some((r) => r.id === 'OWN-LOCK-1')).toBe(true);
  });
});

describe('identityRulesByPriority', () => {
  it('returns identity rules sorted ascending by priority', () => {
    const rs = loadCandidateMatchRules();
    const shuffled = { ...rs, identityRules: [...rs.identityRules].reverse() };
    expect(identityRulesByPriority(shuffled).map((r) => r.priority)).toEqual([1, 2, 3]);
  });
});
