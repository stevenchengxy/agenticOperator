import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    agentConfig: { findUnique: vi.fn(), upsert: vi.fn() },
    agentConfigHistory: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

import { POST } from './route';
import { prisma } from '@/server/db';

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

describe('POST /api/manage/agents/[name]/config', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 for invalid body', async () => {
    const res = await POST(
      new Request('http://x', { method: 'POST', body: 'not-json', headers: { 'Content-Type': 'text/plain' } }),
      ctx('matcher'),
    );
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('VALIDATION');
  });

  it('returns 400 for out-of-range temperature', async () => {
    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ temperature: 5 }) }),
      ctx('matcher'),
    );
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('VALIDATION');
  });

  it('happy path: upserts config and writes history + AuditLog', async () => {
    (prisma.agentConfig.findUnique as any).mockResolvedValue({ id: 'matcher', temperature: 0.7, maxRetries: 3 });
    (prisma.agentConfig.upsert as any).mockResolvedValue({ id: 'matcher', temperature: 0.9, maxRetries: 3, updatedAt: new Date() });
    (prisma.agentConfigHistory.create as any).mockResolvedValue({});
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ temperature: 0.9, reason: 'tuning' }) }),
      ctx('matcher'),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.config).toBeDefined();
    expect(prisma.agentConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'matcher' } }),
    );
    expect(prisma.agentConfigHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ agentId: 'matcher', changedBy: 'operator-unknown' }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'manage.agent.config',
          traceId: 'matcher',
        }),
      }),
    );
  });

  it('creates new config when none exists (upsert with null before)', async () => {
    (prisma.agentConfig.findUnique as any).mockResolvedValue(null);
    (prisma.agentConfig.upsert as any).mockResolvedValue({ id: 'newAgent', temperature: 0.5, updatedAt: new Date() });
    (prisma.agentConfigHistory.create as any).mockResolvedValue({});
    (prisma.auditLog.create as any).mockResolvedValue({});

    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ temperature: 0.5 }) }),
      ctx('newAgent'),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
  });

  it('returns 500 when prisma throws', async () => {
    (prisma.agentConfig.findUnique as any).mockRejectedValue(new Error('db error'));
    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ temperature: 0.5 }) }),
      ctx('matcher'),
    );
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.error).toBe('internal');
  });
});
