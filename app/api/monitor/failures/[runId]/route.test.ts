import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    workflowRun: { findUnique: vi.fn() },
    workflowStep: { findMany: vi.fn() },
    agentActivity: { findMany: vi.fn() },
    eventInstance: { findMany: vi.fn() },
    logEvent: { findMany: vi.fn() },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

const ctx = (runId: string) => ({ params: Promise.resolve({ runId }) });

describe('GET /api/monitor/failures/[runId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
    (prisma.logEvent.findMany as any).mockResolvedValue([]);
  });

  it('returns 404 when run is not found', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue(null);
    const res = await GET(new Request('http://x/api/monitor/failures/missing'), ctx('missing'));
    expect(res.status).toBe(404);
  });

  it('returns 200 with run + failed steps + retry history when found', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue({
      id: 'r1',
      triggerEvent: 'REQUIREMENT_LOGGED',
      triggerData: '{}',
      status: 'failed',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      completedAt: new Date('2026-01-01T00:10:00Z'),
      lastActivityAt: new Date('2026-01-01T00:10:00Z'),
    });
    (prisma.workflowStep.findMany as any).mockResolvedValue([
      {
        id: 'step1',
        runId: 'r1',
        nodeId: 'jd',
        stepName: 'Generate JD',
        status: 'failed',
        error: 'Error: API timeout after 30s',
        startedAt: new Date('2026-01-01T00:04:00Z'),
        completedAt: new Date('2026-01-01T00:05:00Z'),
        durationMs: 60000,
      },
    ]);
    (prisma.agentActivity.findMany as any).mockResolvedValue([
      {
        id: 'a1',
        runId: 'r1',
        type: 'step.retrying',
        agentName: 'JDGenerator',
        narrative: 'Retry attempt 1',
        createdAt: new Date('2026-01-01T00:05:30Z'),
        metadata: null,
      },
    ]);

    const res = await GET(new Request('http://x/api/monitor/failures/r1'), ctx('r1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.run.id).toBe('r1');
    expect(j.steps).toHaveLength(1);
    expect(j.steps[0].nodeId).toBe('jd');
    expect(j.retries).toHaveLength(1);
    expect(j.events).toBeInstanceOf(Array);
  });
});
