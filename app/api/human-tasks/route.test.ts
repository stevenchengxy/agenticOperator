import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    humanTask: {
      findMany: vi.fn(),
    },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

describe('GET /api/human-tasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns count + recent', async () => {
    (prisma.humanTask.findMany as any).mockResolvedValue([
      {
        id: 't1',
        runId: 'r1',
        nodeId: '5',
        title: 'JD review',
        assignee: null,
        deadline: null,
        createdAt: new Date('2026-01-01'),
        triggeringEventInstanceId: null,
        triggeringEventName: null,
        status: 'pending',
      },
    ]);
    const res = await GET(new Request('http://x/api/human-tasks'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.total).toBe(1);
    expect(j.recent[0].agentShort).toBe('JDReviewer');
  });

  it('returns empty + meta.partial when DB error', async () => {
    (prisma.humanTask.findMany as any).mockRejectedValue(new Error('down'));
    const res = await GET(new Request('http://x/api/human-tasks'));
    const j = await res.json();
    expect(res.status).toBe(500);
    expect(j.error).toBe('INTERNAL');
  });
});
