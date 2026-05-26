import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/partner-pg/client', () => ({ isPartnerPgConfigured: () => true }));
vi.mock('@/lib/partner-pg/requirements', () => ({
  getRequirementDetail: vi.fn(),
}));

import { getRequirementDetail } from '@/lib/partner-pg/requirements';
import { getInstanceFallback, hasInstanceFallback } from './pg-fallback';

const mReq = vi.mocked(getRequirementDetail);

beforeEach(() => mReq.mockReset());

describe('pg-fallback registry', () => {
  it('Job_Requisition is registered; Candidate is not (no verified mapper/reader)', () => {
    expect(hasInstanceFallback('Job_Requisition')).toBe(true);
    expect(hasInstanceFallback('Candidate')).toBe(false);
  });

  it('getInstanceFallback(Job_Requisition) returns the pg row (1:1 core fields)', async () => {
    mReq.mockResolvedValue({
      job_requisition_id: 'JR1',
      job_responsibility: '写文档',
      must_have_skills: ['word'],
      work_years: 2,
    } as never);
    const r = await getInstanceFallback('Job_Requisition', 'JR1');
    expect(r).toMatchObject({ job_requisition_id: 'JR1', work_years: 2 });
    expect(mReq).toHaveBeenCalledWith('JR1');
  });

  it('getInstanceFallback returns null when pg has no row', async () => {
    mReq.mockResolvedValue(null);
    expect(await getInstanceFallback('Job_Requisition', 'JRX')).toBeNull();
  });

  it('getInstanceFallback returns null for an unregistered label', async () => {
    expect(await getInstanceFallback('Candidate', 'c1')).toBeNull();
    expect(mReq).not.toHaveBeenCalled();
  });
});
