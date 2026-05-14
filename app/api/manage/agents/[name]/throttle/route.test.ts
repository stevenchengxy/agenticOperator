import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    agentConfig: { findUnique: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { POST } from './route';
import { prisma } from '@/server/db';

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });
const req = (body: unknown) =>
  new Request('http://localhost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/manage/agents/[name]/throttle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when untilMs is missing', async () => {
    const res = await POST(req({}), ctx('JDGenerator'));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('BAD_REQUEST');
    expect(j.message).toMatch(/untilMs/);
  });

  it('returns 400 when untilMs is zero or negative', async () => {
    const res = await POST(req({ untilMs: -100 }), ctx('JDGenerator'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when untilMs exceeds 1 hour', async () => {
    const res = await POST(req({ untilMs: 3_600_001 }), ctx('JDGenerator'));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.message).toMatch(/3600000/);
  });

  it('happy path: sets throttleUntil and writes audit log', async () => {
    (prisma.agentConfig.findUnique as any).mockResolvedValue(null);
    const futureDate = new Date(Date.now() + 60_000);
    (prisma.agentConfig.upsert as any).mockResolvedValue({
      id: 'JDGenerator',
      throttleUntil: futureDate,
      throttleReason: 'test throttle',
    });
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(req({ untilMs: 60_000, reason: 'test throttle' }), ctx('JDGenerator'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.agentName).toBe('JDGenerator');
    expect(j.throttleUntil).toBeTruthy();

    expect(prisma.agentConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'JDGenerator' },
        update: expect.objectContaining({ throttleReason: 'test throttle' }),
      }),
    );

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'manage.agent.throttle',
          traceId: 'JDGenerator',
        }),
      }),
    );
  });

  it('returns 500 on prisma error', async () => {
    (prisma.agentConfig.findUnique as any).mockRejectedValue(new Error('db error'));
    const res = await POST(req({ untilMs: 30_000 }), ctx('JDGenerator'));
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.error).toBe('internal');
  });
});
