import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    workflowRun: { findUnique: vi.fn() },
    agentActivity: { findMany: vi.fn() },
    humanTask: { findMany: vi.fn() },
    eventInstance: { findMany: vi.fn() },
    workflowStep: { findMany: vi.fn() },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('GET /api/monitor/runs/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when run is not found', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue(null);
    const res = await GET(new Request('http://x/api/monitor/runs/missing'), ctx('missing'));
    expect(res.status).toBe(404);
  });

  it('returns 200 with full run detail when found', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue({
      id: 'r1',
      triggerEvent: 'REQUIREMENT_LOGGED',
      triggerData: '{}',
      status: 'running',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      lastActivityAt: new Date('2026-01-01T00:10:00Z'),
      completedAt: null,
    });
    (prisma.agentActivity.findMany as any).mockResolvedValue([
      {
        agentName: 'ReqSync',
        type: 'agent_complete',
        metadata: null,
        createdAt: new Date('2026-01-01T00:01:00Z'),
        narrative: 'done',
        runId: 'r1',
      },
    ]);
    (prisma.humanTask.findMany as any).mockResolvedValue([]);
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
    (prisma.workflowStep.findMany as any).mockResolvedValue([]);
    const res = await GET(new Request('http://x/api/monitor/runs/r1'), ctx('r1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.run.id).toBe('r1');
    expect(j.trail).toBeInstanceOf(Array);
    expect(j.activity).toHaveLength(1);
  });

  it('correctly maps parse node activity (ResumeParser agentName) to the parse node id', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue({
      id: 'r-parse',
      triggerEvent: 'RESUME_DOWNLOADED',
      triggerData: '{}',
      status: 'completed',
      startedAt: new Date('2026-05-14T00:00:00Z'),
      completedAt: new Date('2026-05-14T00:01:00Z'),
      lastActivityAt: new Date('2026-05-14T00:01:00Z'),
    });
    (prisma.agentActivity.findMany as any).mockResolvedValue([
      { agentName: 'ResumeParser', type: 'agent_start',    metadata: null, createdAt: new Date('2026-05-14T00:00:30Z'), narrative: 'start',    runId: 'r-parse' },
      { agentName: 'ResumeParser', type: 'agent_complete', metadata: null, createdAt: new Date('2026-05-14T00:00:55Z'), narrative: 'complete', runId: 'r-parse' },
    ]);
    (prisma.humanTask.findMany as any).mockResolvedValue([]);
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
    (prisma.workflowStep.findMany as any).mockResolvedValue([]);

    const res = await GET(new Request('http://x/api/monitor/runs/r-parse'), ctx('r-parse'));
    const j = await res.json();
    expect(res.status).toBe(200);
    const parseStep = j.trail.find((t: any) => t.nodeId === 'parse');
    expect(parseStep).toBeDefined();
    expect(parseStep.result).toBe('success');
    expect(parseStep.stepCount).toBe(2);
  });
});
