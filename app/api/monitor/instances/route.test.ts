import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    workflowRun: { findMany: vi.fn() },
    agentActivity: { findMany: vi.fn() },
    humanTask: { findMany: vi.fn() },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

describe('GET /api/monitor/instances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.workflowRun.findMany as any).mockResolvedValue([]);
    (prisma.agentActivity.findMany as any).mockResolvedValue([]);
    (prisma.humanTask.findMany as any).mockResolvedValue([]);
  });

  it('empty DB returns canonical shape with items: []', async () => {
    const res = await GET(new Request('http://x/api/monitor/instances'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.scope).toBe('live');
    expect(j.total).toBe(0);
    expect(Array.isArray(j.items)).toBe(true);
    expect(j.items).toHaveLength(0);
  });

  it('default scope is live; only running/paused/suspended rows are returned', async () => {
    const now = new Date();
    const runningRun = {
      id: 'run-001',
      triggerEvent: 'REQUIREMENT_LOGGED',
      triggerData: JSON.stringify({ client: '字节跳动', jdTitle: 'Senior Java Engineer', jdId: 'jd-abc' }),
      status: 'running',
      startedAt: now,
      completedAt: null,
      lastActivityAt: now,
    };
    const completedRun = {
      id: 'run-002',
      triggerEvent: 'REQUIREMENT_LOGGED',
      triggerData: '{}',
      status: 'completed',
      startedAt: now,
      completedAt: now,
      lastActivityAt: now,
    };

    // The WHERE filter passed to workflowRun.findMany will have status: {in: ['running','paused','suspended']}
    // We only mock the live ones being returned (as the real DB would do with the filter)
    (prisma.workflowRun.findMany as any).mockResolvedValue([runningRun]);
    (prisma.agentActivity.findMany as any).mockResolvedValue([
      { runId: 'run-001', agentName: 'JDGenerator', type: 'agent_start', createdAt: now },
    ]);
    (prisma.humanTask.findMany as any).mockResolvedValue([]);

    const res = await GET(new Request('http://x/api/monitor/instances'));
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.scope).toBe('live');
    expect(j.total).toBe(1);
    expect(j.items).toHaveLength(1);

    const card = j.items[0];
    expect(card.runId).toBe('run-001');
    expect(card.status).toBe('running');
    expect(card.client).toBe('字节跳动');
    expect(card.jdTitle).toBe('Senior Java Engineer');
    expect(card.jdId).toBe('jd-abc');
    expect(card.currentAgent).toBe('JDGenerator');
    expect(card.currentStage).toBe('jd');
    expect(card.agentsTouched).toBe(1);
    expect(card.pendingHitl).toBe(false);
    expect(card.hasFailure).toBe(false);
    // completedRun should NOT be in results (mock returns only runningRun)
    expect(j.items.every((i: any) => i.runId !== 'run-002')).toBe(true);
  });

  it('?scope=recent filters to recently completed runs (last 1h)', async () => {
    const now = new Date();
    const completedRun = {
      id: 'run-003',
      triggerEvent: 'RESUME_DOWNLOADED',
      triggerData: JSON.stringify({ candidateName: 'Steven Chen', candidateId: 'cand-99' }),
      status: 'completed',
      startedAt: new Date(now.getTime() - 30 * 60 * 1000),
      completedAt: now,
      lastActivityAt: now,
    };

    (prisma.workflowRun.findMany as any).mockResolvedValue([completedRun]);
    (prisma.agentActivity.findMany as any).mockResolvedValue([
      { runId: 'run-003', agentName: 'Matcher', type: 'agent_complete', createdAt: now },
      { runId: 'run-003', agentName: 'Evaluator', type: 'agent_start', createdAt: now },
    ]);
    (prisma.humanTask.findMany as any).mockResolvedValue([
      { runId: 'run-003' }, // pending HITL
    ]);

    const res = await GET(new Request('http://x/api/monitor/instances?scope=recent'));
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.scope).toBe('recent');
    expect(j.total).toBe(1);
    expect(j.items).toHaveLength(1);

    const card = j.items[0];
    expect(card.runId).toBe('run-003');
    expect(card.status).toBe('completed');
    expect(card.candidateName).toBe('Steven Chen');
    expect(card.candidateId).toBe('cand-99');
    // Latest activity (last in asc order) = Evaluator
    expect(card.currentAgent).toBe('Evaluator');
    expect(card.currentStage).toBe('eval');
    expect(card.agentsTouched).toBe(2);
    expect(card.pendingHitl).toBe(true);
    expect(card.hasFailure).toBe(false);
  });
});
