import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/clients/ws', () => ({
  wsClient: {
    fetchRuns: vi.fn(),
    fetchActivityFeed: vi.fn(),
  },
  WsClientError: class extends Error {},
}));

const mockListFunctions = vi.fn();
vi.mock('@/lib/inngest-admin-client', () => ({
  listFunctions: () => mockListFunctions(),
}));

import { GET } from './route';
import { wsClient } from '@/server/clients/ws';

describe('GET /api/agents', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: empty live registry → all AGENT_MAP entries marked unbuilt.
    mockListFunctions.mockResolvedValue([]);
    const reg = await import('@/lib/inngest-registry');
    reg.__resetRegistryCacheForTests();
  });

  it('returns agents with merged static + dynamic data', async () => {
    (wsClient.fetchRuns as any).mockResolvedValue({ runs: [], total: 0 });
    (wsClient.fetchActivityFeed as any).mockResolvedValue({ items: [], total: 0 });
    const res = await GET(new Request('http://x/api/agents'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.agents.length).toBeGreaterThanOrEqual(23);
    const matcher = json.agents.find((a: any) => a.short === 'Matcher');
    expect(matcher.wsId).toBe('10');
    expect(matcher.displayName).toBe('display_matcher');
  });

  it('on WS error: returns 200 with meta.partial=["ws"]', async () => {
    (wsClient.fetchRuns as any).mockRejectedValue(new Error('down'));
    (wsClient.fetchActivityFeed as any).mockRejectedValue(new Error('down'));
    const res = await GET(new Request('http://x/api/agents'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.meta.partial).toEqual(['ws']);
    expect(json.agents[0].p50Ms).toBeNull();
    expect(json.agents[0].lastActivityAt).toBeNull();
  });

  it('realness count tracks live Inngest registry (not hardcoded 4)', async () => {
    (wsClient.fetchRuns as any).mockResolvedValue({ runs: [], total: 0 });
    (wsClient.fetchActivityFeed as any).mockResolvedValue({ items: [], total: 0 });
    mockListFunctions.mockResolvedValue([
      // Only 2 real fns registered live (not the static 4)
      { id: 'create-jd-agent',     slug: 'agentic-operator-main-create-jd-agent',     name: 'Create JD',     triggers: [] },
      { id: 'resume-parser-agent', slug: 'agentic-operator-main-resume-parser-agent', name: 'Resume Parser', triggers: [] },
      { id: 'agent.reqsync',       slug: 'agentic-operator-main-agent.reqsync',       name: 'ReqSync',       triggers: [] },
    ]);
    const reg = await import('@/lib/inngest-registry');
    reg.__resetRegistryCacheForTests();
    const res = await GET(new Request('http://x/api/agents'));
    const json = await res.json();
    const reals = json.agents.filter((a: { realness: string }) => a.realness === 'real');
    // 2 reals (jd + parser) — NOT the static 4
    expect(reals).toHaveLength(2);
    const shells = json.agents.filter((a: { realness: string }) => a.realness === 'shell');
    expect(shells.length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces live fns not in AGENT_MAP', async () => {
    (wsClient.fetchRuns as any).mockResolvedValue({ runs: [], total: 0 });
    (wsClient.fetchActivityFeed as any).mockResolvedValue({ items: [], total: 0 });
    mockListFunctions.mockResolvedValue([
      { id: 'brand-new-agent', slug: 'agentic-operator-main-brand-new-agent', name: 'New', triggers: [] },
    ]);
    const reg = await import('@/lib/inngest-registry');
    reg.__resetRegistryCacheForTests();
    const res = await GET(new Request('http://x/api/agents'));
    const json = await res.json();
    expect(json.agents.find((a: { short: string }) => a.short === 'brand-new')).toBeDefined();
  });
});
