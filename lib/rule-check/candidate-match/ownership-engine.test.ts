import { describe, it, expect } from 'vitest';
import { decideOwnership, type OwnershipContext } from './ownership-engine';
import { loadCandidateMatchRules } from './rules-data';

const RULES = loadCandidateMatchRules().ownershipRules;

const ctx = (over: Partial<OwnershipContext>): OwnershipContext => ({
  lockState: 1,
  blacklisted: false,
  lockByEmail: null,
  claimantEmail: 'me@corp.com',
  client: null,
  tencentRelationship: false,
  ...over,
});

describe('decideOwnership — lock rule (OWN-LOCK-1)', () => {
  it('FREE → proceed', () => {
    const r = decideOwnership(ctx({ lockState: 1 }), RULES);
    expect(r.decision).toBe('proceed');
    expect(r.matchedRuleId).toBe('OWN-LOCK-1');
  });
  it('blacklisted → lock-only conflict', () => {
    const r = decideOwnership(ctx({ blacklisted: true }), RULES);
    expect(r.decision).toBe('lock-only');
    expect(r.conflict).toBe(true);
  });
  it('PROTECTED → lock-only', () => {
    expect(decideOwnership(ctx({ lockState: 3 }), RULES).decision).toBe('lock-only');
  });
  it('LOCKED by the same recruiter (case-insensitive) → proceed', () => {
    const r = decideOwnership(ctx({ lockState: 2, lockByEmail: 'ME@corp.com', claimantEmail: 'me@corp.com' }), RULES);
    expect(r.decision).toBe('proceed');
  });
  it('LOCKED by another recruiter → lock-only', () => {
    const r = decideOwnership(ctx({ lockState: 2, lockByEmail: 'other@corp.com', claimantEmail: 'me@corp.com' }), RULES);
    expect(r.decision).toBe('lock-only');
  });
});

describe('decideOwnership — 腾讯 customer relationship (OWN-TENCENT-1) overrides lock', () => {
  it('腾讯 + existing relationship + non-owner claimant → lock-only even when FREE', () => {
    const r = decideOwnership(
      ctx({ client: '腾讯', tencentRelationship: true, lockState: 1, lockByEmail: 'owner@corp.com', claimantEmail: 'me@corp.com' }),
      RULES,
    );
    expect(r.decision).toBe('lock-only');
    expect(r.matchedRuleId).toBe('OWN-TENCENT-1');
  });
  it('腾讯 + relationship + claimant IS the original owner → proceed', () => {
    const r = decideOwnership(
      ctx({ client: '腾讯', tencentRelationship: true, lockByEmail: 'me@corp.com', claimantEmail: 'me@corp.com' }),
      RULES,
    );
    expect(r.decision).toBe('proceed');
    expect(r.matchedRuleId).toBe('OWN-TENCENT-1');
  });
  it('腾讯 + relationship but no recorded owner + a claimant → conservative lock-only', () => {
    const r = decideOwnership(
      ctx({ client: '腾讯', tencentRelationship: true, lockByEmail: null }),
      RULES,
    );
    expect(r.decision).toBe('lock-only');
    expect(r.matchedRuleId).toBe('OWN-TENCENT-1');
  });
  it('non-腾讯 client falls through to the lock rule', () => {
    const r = decideOwnership(ctx({ client: '字节跳动', tencentRelationship: true, lockState: 1 }), RULES);
    expect(r.matchedRuleId).toBe('OWN-LOCK-1');
    expect(r.decision).toBe('proceed');
  });
  it('腾讯 client but NO relationship falls through to the lock rule', () => {
    const r = decideOwnership(ctx({ client: '腾讯', tencentRelationship: false, lockState: 2, lockByEmail: 'other@corp.com' }), RULES);
    expect(r.matchedRuleId).toBe('OWN-LOCK-1');
    expect(r.decision).toBe('lock-only');
  });
});

describe('decideOwnership — hard states (blacklist/PROTECTED) are never overridden by 腾讯', () => {
  it('blacklisted candidate → lock-only even when the 腾讯 original owner claims', () => {
    const r = decideOwnership(
      ctx({ client: '腾讯', tencentRelationship: true, blacklisted: true, lockByEmail: 'me@c.com', claimantEmail: 'me@c.com' }),
      RULES,
    );
    expect(r.decision).toBe('lock-only');
    expect(r.conflict).toBe(true);
  });
  it('PROTECTED candidate → lock-only even when the 腾讯 original owner claims', () => {
    const r = decideOwnership(
      ctx({ client: '腾讯', tencentRelationship: true, lockState: 3, lockByEmail: 'me@c.com', claimantEmail: 'me@c.com' }),
      RULES,
    );
    expect(r.decision).toBe('lock-only');
  });
});

describe('decideOwnership — client scope is data-driven (rule.applicableClient, not a TS constant)', () => {
  it('honors a customer-relationship rule retargeted to another client via data', () => {
    const retargeted = RULES.map((r) =>
      r.id === 'OWN-TENCENT-1' ? { ...r, applicableClient: '字节跳动' } : r,
    );
    const r = decideOwnership(
      ctx({ client: '字节跳动', tencentRelationship: true, lockByEmail: 'owner@c.com', claimantEmail: 'me@c.com' }),
      retargeted,
    );
    expect(r.matchedRuleId).toBe('OWN-TENCENT-1');
    expect(r.decision).toBe('lock-only');
  });
  it('treats applicableClient 通用 as a wildcard (fires for any client with a relationship)', () => {
    const universal = RULES.map((r) =>
      r.id === 'OWN-TENCENT-1' ? { ...r, applicableClient: '通用' } : r,
    );
    const r = decideOwnership(
      ctx({ client: '任意客户', tencentRelationship: true, lockByEmail: 'owner@c.com', claimantEmail: 'me@c.com' }),
      universal,
    );
    expect(r.matchedRuleId).toBe('OWN-TENCENT-1');
  });
});
