import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    workflowRun: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    agentActivity: { findMany: vi.fn(), groupBy: vi.fn() },
    humanTask: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    eventInstance: { findMany: vi.fn() },
  },
}));

import { GET, _resetCacheForTest } from './route';
import { prisma } from '@/server/db';

describe('GET /api/monitor/overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCacheForTest();
    (prisma.workflowRun.findMany as any).mockResolvedValue([]);
    (prisma.workflowRun.count as any).mockResolvedValue(0);
    (prisma.workflowRun.groupBy as any).mockResolvedValue([]);
    (prisma.agentActivity.findMany as any).mockResolvedValue([]);
    (prisma.agentActivity.groupBy as any).mockResolvedValue([]);
    (prisma.humanTask.findMany as any).mockResolvedValue([]);
    (prisma.humanTask.count as any).mockResolvedValue(0);
    (prisma.humanTask.groupBy as any).mockResolvedValue([]);
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
  });

  it('returns the canonical shape with all sections, even when DB is empty', async () => {
    const res = await GET(new Request('http://x/api/monitor/overview'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.filter.sinceMs).toBeGreaterThan(0);
    expect(j.kpi).toMatchObject({
      activeRuns: 0,
      pendingHitl: 0,
      failuresInWindow: 0,
      tokensInWindow: 0,
      queueDepth: 0,
    });
    expect(Array.isArray(j.nodes)).toBe(true);
    expect(j.nodes.length).toBe(24); // matches workflow-graph-meta NODES (22 canonical agents + ruleCheck + trig)
    expect(Array.isArray(j.edges)).toBe(true);
    expect(j.edges.length).toBe(30); // matches workflow-graph-meta EDGES.length (28 prior + 2 ruleCheck out)
    expect(Array.isArray(j.failures)).toBe(true);
    expect(Array.isArray(j.hitl)).toBe(true);
    expect(Array.isArray(j.recentRuns)).toBe(true);
  });

  it('honours ?windowMs= and reflects it in filter.sinceMs', async () => {
    const res = await GET(new Request('http://x/api/monitor/overview?windowMs=3600000'));
    const j = await res.json();
    expect(j.filter.sinceMs).toBe(3_600_000);
  });

  it('clamps absurd windowMs values to the safe range', async () => {
    const res = await GET(new Request('http://x/api/monitor/overview?windowMs=999999999999999'));
    const j = await res.json();
    expect(j.filter.sinceMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  it('500 when prisma blows up', async () => {
    (prisma.workflowRun.findMany as any).mockRejectedValue(new Error('db down'));
    const res = await GET(new Request('http://x/api/monitor/overview'));
    expect(res.status).toBe(500);
  });
});
