import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    behaviorAlert: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { POST } from './route';
import { prisma } from '@/server/db';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown = {}) =>
  new Request('http://localhost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-001',
    alertKey: 'agent_error_rate.JDGenerator',
    severity: 'error',
    ruleId: 'agent_error_rate',
    details: '{}',
    firstSeenAt: new Date('2026-05-14T10:00:00Z'),
    lastSeenAt: new Date('2026-05-14T10:01:00Z'),
    resolvedAt: null,
    managerActionTaken: null,
    managerActionAt: null,
    autoRestartCount: 0,
    lastAutoRestartAt: null,
    ...overrides,
  };
}

describe('POST /api/behavior/alerts/[id]/resolve', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when alert not found', async () => {
    (prisma.behaviorAlert.findUnique as any).mockResolvedValue(null);
    const res = await POST(req(), ctx('missing'));
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.error).toBe('not_found');
  });

  it('returns 409 when alert is already resolved', async () => {
    (prisma.behaviorAlert.findUnique as any).mockResolvedValue(
      makeAlert({ resolvedAt: new Date('2026-05-14T09:00:00Z') }),
    );
    const res = await POST(req(), ctx('alert-001'));
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toBe('ALREADY_RESOLVED');
    expect(j.message).toMatch(/already resolved/);
  });

  it('happy path: resolves alert and writes audit log', async () => {
    (prisma.behaviorAlert.findUnique as any).mockResolvedValue(makeAlert());
    (prisma.behaviorAlert.update as any).mockResolvedValue({});
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(req({ note: 'false alarm' }), ctx('alert-001'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.resolvedAt).toBeTruthy();

    expect(prisma.behaviorAlert.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'alert-001' },
        data: expect.objectContaining({ resolvedAt: expect.any(Date) }),
      }),
    );

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'behavior.alert.resolve',
          traceId: 'alert-001',
        }),
      }),
    );
  });

  it('resolves without a note (empty body)', async () => {
    (prisma.behaviorAlert.findUnique as any).mockResolvedValue(makeAlert());
    (prisma.behaviorAlert.update as any).mockResolvedValue({});
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(req(), ctx('alert-001'));
    expect(res.status).toBe(200);
  });

  it('returns 500 on prisma error', async () => {
    (prisma.behaviorAlert.findUnique as any).mockRejectedValue(new Error('db error'));
    const res = await POST(req(), ctx('alert-001'));
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.error).toBe('internal');
  });
});
