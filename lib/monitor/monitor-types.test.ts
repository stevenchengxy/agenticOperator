import { describe, it, expect } from 'vitest';
import { domainForRun, DEFAULT_THRESHOLDS } from './monitor-types';
import {
  ENERGY_DOMAIN_ID,
  COST_CONTROL_DOMAIN_ID,
  RECRUITMENT_DOMAIN_ID,
} from '@/lib/domain-ids';

describe('domainForRun', () => {
  it('maps energy-namespaced events to the energy domain', () => {
    expect(
      domainForRun({ functionSlug: 'agentic-operator-x', eventName: 'energy/DISPATCH_CYCLE_STARTED' }),
    ).toBe(ENERGY_DOMAIN_ID);
  });

  it('maps feikong-namespaced events to the cost-control domain', () => {
    expect(domainForRun({ functionSlug: 'x', eventName: 'feikong/EXPENSE_SUBMITTED' })).toBe(
      COST_CONTROL_DOMAIN_ID,
    );
  });

  it('defaults to recruitment for un-namespaced events', () => {
    expect(domainForRun({ functionSlug: 'match-resume', eventName: 'RESUME_PROCESSED' })).toBe(
      RECRUITMENT_DOMAIN_ID,
    );
  });

  it('falls back to functionSlug when eventName is absent', () => {
    expect(domainForRun({ functionSlug: 'energy/validate', eventName: null })).toBe(ENERGY_DOMAIN_ID);
  });
});

describe('DEFAULT_THRESHOLDS', () => {
  it('provides sane numeric defaults', () => {
    expect(DEFAULT_THRESHOLDS.stallMs).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.minVolume).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_THRESHOLDS.errorRatePct).toBeGreaterThan(0);
  });
});
