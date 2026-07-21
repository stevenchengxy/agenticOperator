import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    workflowRun: {
      findUnique: vi.fn(),
    },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

describe('GET /api/runs/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns run detail when found', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue({
      id: 'r1',
      triggerEvent: 'X',
      triggerData: '{}',
      status: 'running',
      startedAt: new Date('2026-01-01'),
      lastActivityAt: new Date('2026-01-01'),
      completedAt: null,
      suspendedReason: null,
    });
    const res = await GET(new Request('http://x/api/runs/r1'), {
      params: Promise.resolve({ id: 'r1' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.id).toBe('r1');
  });

  it('404 when run not found', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue(null);
    const res = await GET(new Request('http://x/api/runs/missing'), {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(res.status).toBe(404);
  });
});
