import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/server/db', () => ({
  prisma: {
    eventInstance: { findMany: vi.fn(), count: vi.fn() },
    dLQEntry:      { findMany: vi.fn(), count: vi.fn() },
  },
}));
import { GET } from './route';
import { prisma } from '@/server/db';

describe('GET /api/monitor/queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
    (prisma.eventInstance.count as any).mockResolvedValue(0);
    (prisma.dLQEntry.findMany as any).mockResolvedValue([]);
    (prisma.dLQEntry.count as any).mockResolvedValue(0);
  });

  it('defaults bucket=accepted, returns canonical shape', async () => {
    const res = await GET(new Request('http://x/api/monitor/queue'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.bucket).toBe('accepted');
    expect(j.offset).toBe(0);
    expect(j.limit).toBe(50);
    expect(Array.isArray(j.rows)).toBe(true);
  });

  it('?bucket=dlq queries DLQEntry, not EventInstance', async () => {
    (prisma.dLQEntry.findMany as any).mockResolvedValue([
      { id: 'd1', eventName: 'X', reason: 'no consumer', retries: 3, createdAt: new Date(), resolvedAt: null },
    ]);
    (prisma.dLQEntry.count as any).mockResolvedValue(1);
    const res = await GET(new Request('http://x/api/monitor/queue?bucket=dlq'));
    const j = await res.json();
    expect(j.bucket).toBe('dlq');
    expect(j.total).toBe(1);
    expect(j.rows[0].eventName).toBe('X');
  });

  it('rejects unknown bucket', async () => {
    const res = await GET(new Request('http://x/api/monitor/queue?bucket=banana'));
    expect(res.status).toBe(400);
  });
});
