import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    agentActivity: { findMany: vi.fn(), groupBy: vi.fn() },
    agentEpisode: { findMany: vi.fn() },
    agentConfig: { findUnique: vi.fn() },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

describe('GET /api/monitor/agents/[name]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.agentActivity.findMany as any).mockResolvedValue([]);
    (prisma.agentActivity.groupBy as any).mockResolvedValue([]);
    (prisma.agentEpisode.findMany as any).mockResolvedValue([]);
    (prisma.agentConfig.findUnique as any).mockResolvedValue(null);
  });

  it('returns 404 when name is not a known node id', async () => {
    const res = await GET(new Request('http://x/api/monitor/agents/banana'), ctx('banana'));
    expect(res.status).toBe(404);
  });

  it('returns 200 with the canonical shape for a known node id', async () => {
    const res = await GET(new Request('http://x/api/monitor/agents/jdGenerator'), ctx('jdGenerator'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.name).toBe('jdGenerator');
    expect(j.title).toBe('JDGenerator');
    expect(Array.isArray(j.recentEpisodes)).toBe(true);
    expect(Array.isArray(j.tokenSpend)).toBe(true);
    expect(j.tokenSpend).toHaveLength(24); // 24 hourly buckets
    expect(Array.isArray(j.candidateDistribution)).toBe(true);
    expect(Array.isArray(j.recentEventActivity)).toBe(true);
  });
});
