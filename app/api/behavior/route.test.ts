import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('@/server/db', () => ({
  prisma: {
    behaviorAlert: {
      findMany: vi.fn(),
    },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

const findMany = prisma.behaviorAlert.findMany as ReturnType<typeof vi.fn>;

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-001',
    alertKey: 'em_degraded',
    severity: 'error',
    ruleId: 'em_degraded',
    details: '{}',
    firstSeenAt: new Date('2026-05-14T10:00:00Z'),
    lastSeenAt: new Date('2026-05-14T10:01:00Z'),
    resolvedAt: null,
    managerActionTaken: null,
    managerActionAt: null,
    ...overrides,
  };
}

describe('GET /api/behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: empty results for all three queries
    findMany.mockResolvedValue([]);
  });

  it('returns 200 with empty data when no alerts exist', async () => {
    const res = await GET(new Request('http://localhost/api/behavior'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kpi).toEqual({ open: 0, in24h: 0, escalated: 0, autoResolved: 0 });
    expect(body.openAlerts).toEqual([]);
    expect(body.recentActions).toEqual([]);
  });

  it('counts open alerts correctly in KPI', async () => {
    const alert = makeAlert();
    // First call = openAlerts, second = recentAlerts, third = recentActions
    findMany
      .mockResolvedValueOnce([alert])
      .mockResolvedValueOnce([alert])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request('http://localhost/api/behavior'));
    const body = await res.json();
    expect(body.kpi.open).toBe(1);
    expect(body.kpi.in24h).toBe(1);
  });

  it('counts escalated correctly', async () => {
    const escalated = makeAlert({ managerActionTaken: 'escalate', managerActionAt: new Date() });
    findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([escalated])
      .mockResolvedValueOnce([escalated]);

    const res = await GET(new Request('http://localhost/api/behavior'));
    const body = await res.json();
    expect(body.kpi.escalated).toBe(1);
    expect(body.recentActions).toHaveLength(1);
    expect(body.recentActions[0].managerActionTaken).toBe('escalate');
  });

  it('serializes dates to ISO strings', async () => {
    const alert = makeAlert();
    findMany
      .mockResolvedValueOnce([alert])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request('http://localhost/api/behavior'));
    const body = await res.json();
    expect(body.openAlerts[0].firstSeenAt).toBe('2026-05-14T10:00:00.000Z');
    expect(body.openAlerts[0].resolvedAt).toBeNull();
  });
});
