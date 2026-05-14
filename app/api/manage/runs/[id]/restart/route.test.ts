import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    workflowRun: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock('@/server/em', () => ({
  em: {
    publish: vi.fn(),
  },
}));

import { POST } from './route';
import { prisma } from '@/server/db';
import { em } from '@/server/em';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/manage/runs/[id]/restart', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when run is not found', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue(null);
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('missing'));
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.error).toBe('not_found');
  });

  it('returns 409 when run status is not restartable', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue({
      id: 'r1',
      triggerEvent: 'TEST_EVENT',
      triggerData: '{}',
      status: 'running',
    });
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('r1'));
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toBe('INVALID_STATUS');
  });

  it('happy path: publishes event and writes AuditLog', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue({
      id: 'r1',
      triggerEvent: 'REQUIREMENT_LOGGED',
      triggerData: '{"foo":"bar"}',
      status: 'failed',
    });
    (em.publish as any).mockResolvedValue({ accepted: true, eventId: 'new-event-id', schemaVersionUsed: 'passthrough' });
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ reason: 'test' }) }),
      ctx('r1'),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.restarted).toBe('new-event-id');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'manage.run.restart',
          traceId: 'r1',
          source: 'manage-api',
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
