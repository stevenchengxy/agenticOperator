import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the underlying fetcher BEFORE importing the route handler.
vi.mock('@/lib/rule-check/ontology-source', () => ({
  fetchRulesForMatchResume: vi.fn(),
}));

import { fetchRulesForMatchResume } from '@/lib/rule-check/ontology-source';
import { GET } from './route';

const mockFetch = vi.mocked(fetchRulesForMatchResume);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('GET /api/ontology/rules', () => {
  it('returns rules from ontology-api on success', async () => {
    mockFetch.mockResolvedValue({
      rules: [{ id: 'R-001', name: 'rule one' } as any],
      source: 'ontology-api',
    });
    const res = await GET(new Request("http://x/api/ontology/rules"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.rules).toHaveLength(1);
    expect(body.source).toBe('ontology-api');
    expect(body.fetched_at).toEqual(expect.any(String));
  });

  it('returns json-fallback source when ontology API unavailable', async () => {
    mockFetch.mockResolvedValue({
      rules: [{ id: 'R-002', name: 'rule two' } as any],
      source: 'json-fallback',
      api_error: 'ECONNREFUSED',
    });
    const res = await GET(new Request("http://x/api/ontology/rules"));
    const body = await res.json();
    expect(body.source).toBe('json-fallback');
    expect(body.api_error).toBe('ECONNREFUSED');
  });

  it('forwards drift report when present', async () => {
    mockFetch.mockResolvedValue({
      rules: [],
      source: 'ontology-api',
      drift: { only_in_api: ['R-X'], only_in_json: [] },
    });
    const res = await GET(new Request("http://x/api/ontology/rules"));
    const body = await res.json();
    expect(body.drift).toEqual({ only_in_api: ['R-X'], only_in_json: [] });
  });

  it('500 + ok:false when fetcher throws', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    const res = await GET(new Request("http://x/api/ontology/rules"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('boom');
  });
});
