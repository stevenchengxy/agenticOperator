import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    eventInstance: { findUnique: vi.fn() },
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

describe('POST /api/manage/events/[id]/replay', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when event instance is not found', async () => {
    (prisma.eventInstance.findUnique as any).mockResolvedValue(null);
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('missing'));
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.error).toBe('not_found');
  });

  it('happy path: re-publishes event and writes AuditLog', async () => {
    (prisma.eventInstance.findUnique as any).mockResolvedValue({
      id: 'ev1',
      name: 'REQUIREMENT_LOGGED',
      status: 'accepted',
      payloadSummary: '{"req_id":"123"}',
    });
    (em.publish as any).mockResolvedValue({ accepted: true, eventId: 'new-ev-id', schemaVersionUsed: 'passthrough' });
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ reason: 'missed by consumer' }) }),
      ctx('ev1'),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.newEventId).toBe('new-ev-id');
    expect(em.publish).toHaveBeenCalledWith(
      'REQUIREMENT_LOGGED',
      expect.any(Object),
      expect.objectContaining({
        source: 'manage.replay',
        causedBy: { eventId: 'ev1', name: 'REQUIREMENT_LOGGED' },
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'manage.event.replay',
          traceId: 'ev1',
        }),
      }),
    );
  });

  it('returns 500 when prisma throws', async () => {
    (prisma.eventInstance.findUnique as any).mockRejectedValue(new Error('db error'));
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }), ctx('ev1'));
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.error).toBe('internal');
  });
});
