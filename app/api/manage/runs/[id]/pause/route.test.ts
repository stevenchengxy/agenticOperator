import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    workflowRun: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { POST } from './route';
import { prisma } from '@/server/db';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/manage/runs/[id]/pause', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when run is not found', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue(null);
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('missing'));
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.error).toBe('not_found');
  });

  it('returns 409 when run is not in running status', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue({ id: 'r1', status: 'paused' });
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('r1'));
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toBe('INVALID_STATUS');
  });

  it('happy path: updates status to paused and writes AuditLog', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue({ id: 'r1', status: 'running' });
    (prisma.workflowRun.update as any).mockResolvedValue({ id: 'r1', status: 'paused' });
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ reason: 'hold requested' }) }),
      ctx('r1'),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(prisma.workflowRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
        data: expect.objectContaining({ status: 'paused' }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'manage.run.pause',
          traceId: 'r1',
        }),
      }),
    );
  });

  it('returns 500 when prisma throws', async () => {
    (prisma.workflowRun.findUnique as any).mockRejectedValue(new Error('db error'));
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('r1'));
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.error).toBe('internal');
  });
});
