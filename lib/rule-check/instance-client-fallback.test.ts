import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./pg-fallback', () => ({
  hasInstanceFallback: (label: string) => label === 'Job_Requisition',
  getInstanceFallback: vi.fn(),
}));

import { getInstance } from './instance-client';
import { getInstanceFallback } from './pg-fallback';

const mFallback = vi.mocked(getInstanceFallback);

beforeEach(() => {
  mFallback.mockReset();
  process.env.ALLMETA_BASE_URL = 'http://localhost:3500';
  process.env.ALLMETA_API_KEY = 'tok';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getInstance Neo4j→pg fallback', () => {
  it('falls back to partner-pg when Neo4j 404s (registered label)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => 'nf' })));
    mFallback.mockResolvedValue({ job_requisition_id: 'JR1', work_years: 2 });
    const r = await getInstance('Job_Requisition', 'JR1');
    expect(r).toMatchObject({ job_requisition_id: 'JR1' });
    expect(mFallback).toHaveBeenCalledWith('Job_Requisition', 'JR1');
  });

  it('returns null for unregistered label on 404 (no fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => 'nf' })));
    const r = await getInstance('Candidate', 'c1');
    expect(r).toBeNull();
    expect(mFallback).not.toHaveBeenCalled();
  });

  it('does NOT fall back when Neo4j returns data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ job_requisition_id: 'JR1', from: 'neo4j' }),
    })));
    const r = await getInstance('Job_Requisition', 'JR1');
    expect(r).toMatchObject({ from: 'neo4j' });
    expect(mFallback).not.toHaveBeenCalled();
  });

  it('falls back when Neo4j returns 200 with empty body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    mFallback.mockResolvedValue({ job_requisition_id: 'JR1' });
    const r = await getInstance('Job_Requisition', 'JR1');
    expect(r).toMatchObject({ job_requisition_id: 'JR1' });
    expect(mFallback).toHaveBeenCalled();
  });
});
