import { describe, it, expect } from 'vitest';
import {
  agentsForDomain,
  lookupAgent,
  agentLabel,
  JR_COMPLIANCE_AGENT_ID,
} from './agent-registry';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';

describe('agentsForDomain', () => {
  it('returns the recruitment rule-check agents for the recruitment domain', () => {
    const ids = agentsForDomain(RECRUITMENT_DOMAIN_ID).map((a) => a.id);
    expect(ids).toContain('jr-compliance');
    expect(ids).toContain('rule-check-candidate-identity');
    expect(ids).toContain('rule-check-candidate-ownership');
  });

  it('treats empty/undefined domain as recruitment (app default)', () => {
    expect(agentsForDomain(undefined).map((a) => a.id)).toEqual(
      agentsForDomain(RECRUITMENT_DOMAIN_ID).map((a) => a.id),
    );
    expect(agentsForDomain('').length).toBeGreaterThan(0);
  });

  it('accepts the legacy RAAS-v1 / raas ids as recruitment', () => {
    const n = agentsForDomain(RECRUITMENT_DOMAIN_ID).length;
    expect(agentsForDomain('RAAS-v1').length).toBe(n);
    expect(agentsForDomain('raas').length).toBe(n);
  });

  it('returns [] for a non-recruitment domain (facets there are data-driven)', () => {
    expect(agentsForDomain('能源调度-v1')).toEqual([]);
  });

  it('marks all recruitment rule-check agents live (all are built + registered)', () => {
    const byId = new Map(agentsForDomain(RECRUITMENT_DOMAIN_ID).map((a) => [a.id, a]));
    expect(byId.get('jr-compliance')?.status).toBe('live');
    expect(byId.get('rule-check-candidate-identity')?.status).toBe('live');
    expect(byId.get('rule-check-candidate-ownership')?.status).toBe('live');
  });

  it('exposes the live compliance agent id as a constant for stamping audits', () => {
    expect(JR_COMPLIANCE_AGENT_ID).toBe('jr-compliance');
  });
});

describe('lookupAgent', () => {
  it('finds a recruitment agent by id', () => {
    expect(lookupAgent(RECRUITMENT_DOMAIN_ID, 'jr-compliance')?.label.zh).toBe('岗位合规校验');
  });
  it('returns undefined for an unknown id', () => {
    expect(lookupAgent(RECRUITMENT_DOMAIN_ID, 'nope')).toBeUndefined();
  });
});

describe('agentLabel', () => {
  it('returns the localized label', () => {
    expect(agentLabel(RECRUITMENT_DOMAIN_ID, 'jr-compliance', 'zh')).toBe('岗位合规校验');
    expect(agentLabel(RECRUITMENT_DOMAIN_ID, 'jr-compliance', 'en')).toBe('JD Compliance');
  });
  it('falls back to the raw id for unknown agents (e.g. data-driven energy slugs)', () => {
    expect(agentLabel(RECRUITMENT_DOMAIN_ID, 'energy-validate-constraints', 'zh')).toBe(
      'energy-validate-constraints',
    );
  });
});
