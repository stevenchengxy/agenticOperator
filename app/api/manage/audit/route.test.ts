import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    auditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'al-001',
    eventName: 'manage.run.cancel',
    traceId: 'run-xyz',
    payload: '{"actor":"operator-unknown"}',
    source: 'manage-api',
    createdAt: new Date('2026-05-14T10:00:00Z'),
    payloadDigest: 'abc123',
    ...overrides,
  };
}

const url = (params = '') =>
  new Request(`http://localhost/api/manage/audit${params ? `?${params}` : ''}`);

describe('GET /api/manage/audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.auditLog.findMany as any).mockResolvedValue([]);
    (prisma.auditLog.count as any).mockResolvedValue(0);
  });

  it('returns 200 with empty rows when no logs exist', async () => {
    const res = await GET(url());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.rows).toEqual([]);
    expect(j.total).toBe(0);
    expect(j.limit).toBe(50);
    expect(j.offset).toBe(0);
  });

  it('returns rows serialized with ISO dates', async () => {
    const row = makeRow();
    (prisma.auditLog.findMany as any).mockResolvedValue([row]);
    (prisma.auditLog.count as any).mockResolvedValue(1);

    const res = await GET(url());
    const j = await res.json();
    expect(j.rows).toHaveLength(1);
    expect(j.rows[0].action).toBe('manage.run.cancel');
    expect(j.rows[0].traceId).toBe('run-xyz');
    expect(j.rows[0].createdAt).toBe('2026-05-14T10:00:00.000Z');
    expect(j.total).toBe(1);
  });

  it('filters by action param', async () => {
    (prisma.auditLog.findMany as any).mockResolvedValue([]);
    (prisma.auditLog.count as any).mockResolvedValue(0);

    await GET(url('action=manage.run.restart'));

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventName: 'manage.run.restart' }),
      }),
    );
  });

  it('filters by traceId param', async () => {
    await GET(url('traceId=run-abc123'));

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ traceId: 'run-abc123' }),
      }),
    );
  });

  it('applies limit and offset', async () => {
    await GET(url('limit=10&offset=20'));

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 20 }),
    );
    const res = await GET(url('limit=10&offset=20'));
    const j = await res.json();
    expect(j.limit).toBe(10);
    expect(j.offset).toBe(20);
  });

  it('caps limit at 200', async () => {
    await GET(url('limit=9999'));

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it('returns 400 for invalid since param', async () => {
    const res = await GET(url('since=not-a-date'));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('BAD_REQUEST');
  });

  it('filters by valid since param', async () => {
    await GET(url('since=2026-05-01T00:00:00Z'));

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      }),
    );
  });

  it('returns 500 on prisma error', async () => {
    (prisma.auditLog.findMany as any).mockRejectedValue(new Error('db down'));
    const res = await GET(url());
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.error).toBe('internal');
  });
});
