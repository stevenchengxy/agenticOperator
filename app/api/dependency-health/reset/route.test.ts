import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    logEvent: { create: vi.fn() },
    notification: { findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { POST } from './route';
import { prisma } from '@/server/db';

function req(body: unknown): Request {
  return new Request('http://x/api/dependency-health/reset', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/dependency-health/reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.logEvent.create as any).mockResolvedValue({});
    (prisma.notification.findMany as any).mockResolvedValue([{ dedupeKey: 'dep_down.robohire.招聘-v1' }]);
    (prisma.notification.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.notification.deleteMany as any).mockResolvedValue({ count: 0 });
  });

  it('writes a dependency_reset marker and resolves the firing alert', async () => {
    const res = await POST(req({ provider: 'robohire' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ ok: true, provider: 'robohire', resolved: 1 });

    // marker written for the provider
    const createArg = (prisma.logEvent.create as any).mock.calls[0][0].data;
    expect(createArg.category).toBe('dependency_reset');
    expect(JSON.parse(createArg.payloadJson)).toEqual({ provider: 'robohire' });

    // firing dep_down.robohire.* alert flipped to resolved
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'firing', dedupeKey: { startsWith: 'dep_down.robohire.' } }) }),
    );
    expect(prisma.notification.updateMany).toHaveBeenCalled();
  });

  it('rejects an invalid provider with 400 and writes nothing', async () => {
    const res = await POST(req({ provider: 'bogus' }));
    expect(res.status).toBe(400);
    expect(prisma.logEvent.create).not.toHaveBeenCalled();
  });

  it('still succeeds (marker is durable) when resolving the alert throws', async () => {
    (prisma.notification.findMany as any).mockRejectedValue(new Error('db blip'));
    const res = await POST(req({ provider: 'llm' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ ok: true, provider: 'llm', resolved: 0 });
    expect(prisma.logEvent.create).toHaveBeenCalled();
  });
});
