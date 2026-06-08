import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    notification: { findUnique: vi.fn() },
    logEvent: { findMany: vi.fn() },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request('http://localhost/api/notifications/x');

function makeNotification(over: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    ts: new Date('2026-06-01T12:00:00Z'),
    kind: 'alert',
    severity: 'critical',
    category: 'system',
    source: '系统',
    title: '后端异常重启',
    body: '后端异常重启 · 上次未正常关闭',
    aiSummary: '后端崩溃后已自动重启,需确认原因',
    aiSource: 'llm',
    llmModel: 'x',
    count: 1,
    firstSeenAt: new Date('2026-06-01T12:00:00Z'),
    lastSeenAt: new Date('2026-06-01T12:00:00Z'),
    status: 'firing',
    disposition: 'needs_human',
    managerAction: null,
    readAt: null,
    runId: null,
    traceId: null,
    agent: null,
    linkKind: 'none',
    linkId: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/notifications/[id]', () => {
  it('returns 404 when the notification does not exist', async () => {
    (prisma.notification.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(req(), ctx('missing'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('returns the notification plus correlated logs', async () => {
    (prisma.notification.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeNotification());
    (prisma.logEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'l1',
        ts: new Date('2026-06-01T11:59:00Z'),
        level: 'critical',
        category: 'error',
        source: 'system',
        agent: null,
        message: 'OOM killed',
        payloadJson: null,
      },
    ]);

    const res = await GET(req(), ctx('n1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.notification.id).toBe('n1');
    expect(body.notification.aiSummary).toContain('崩溃');
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0].message).toBe('OOM killed');
  });

  it('builds a run-scoped log query when the notification has a runId', async () => {
    (prisma.notification.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeNotification({ runId: 'R9', linkKind: 'run', linkId: 'R9' }),
    );
    (prisma.logEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await GET(req(), ctx('n1'));
    const body = await res.json();
    expect(body.href).toBe('/monitor/runs/R9');
    const call = (prisma.logEvent.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where).toEqual({ runId: 'R9' });
  });
});
