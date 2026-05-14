import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma before importing the route
vi.mock('@/server/db', () => ({
  prisma: {
    emSystemStatus: { findUnique: vi.fn() },
    raasMessage: { count: vi.fn(), findFirst: vi.fn() },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

// ── helpers ────────────────────────────────────────────────────────

const emEmpty = null;
const emPopulated = {
  id: 'singleton',
  state: 'healthy',
  degradedSince: null,
  lastError: null,
  lastErrorAt: null,
  fallbackCount24h: 5,
  publishCount24h: 200,
  rejectCount24h: 3,
  neo4jLastSyncAt: new Date('2026-05-14T10:00:00.000Z'),
  neo4jLastError: null,
  neo4jUpsertedLast: 42,
  updatedAt: new Date('2026-05-14T11:00:00.000Z'),
};

// ── Test 1: Empty EmSystemStatus → unknowns, no crash ──────────────

describe('GET /api/monitor/system-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.emSystemStatus.findUnique as any).mockResolvedValue(emEmpty);
    (prisma.raasMessage.count as any).mockResolvedValue(0);
    (prisma.raasMessage.findFirst as any).mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  it('empty EmSystemStatus row → all subsystems return unknown or sensible defaults; no crash', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.subsystems).toHaveLength(4);
    expect(j.fetchedAt).toBeTruthy();

    const em = j.subsystems.find((s: any) => s.id === 'em');
    expect(em).toBeDefined();
    expect(em.state).toBe('unknown');
    expect(em.lastUpdate).toBeNull();

    const neo4j = j.subsystems.find((s: any) => s.id === 'neo4j');
    expect(neo4j).toBeDefined();
    expect(neo4j.state).toBe('unknown');

    const raas = j.subsystems.find((s: any) => s.id === 'raas');
    expect(raas).toBeDefined();
    expect(raas.state).toBe('unknown');
    expect(raas.metrics[0].value).toBe('0');

    const inngest = j.subsystems.find((s: any) => s.id === 'inngest');
    expect(inngest).toBeDefined();
    // healthy because fetch mock returns ok:true in this suite
    expect(inngest.state).toBe('healthy');
  });

  // ── Test 2: Populated EmSystemStatus row → reflect actual values ──

  it('populated EmSystemStatus row → subsystems reflect actual values', async () => {
    (prisma.emSystemStatus.findUnique as any).mockResolvedValue(emPopulated);
    (prisma.raasMessage.count as any).mockResolvedValue(17);
    (prisma.raasMessage.findFirst as any).mockResolvedValue({
      receivedAt: '2026-05-14T10:30:00.000Z',
      classification: 'matched_valid',
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();

    const em = j.subsystems.find((s: any) => s.id === 'em');
    expect(em.state).toBe('healthy');
    expect(em.lastUpdate).toBe('2026-05-14T11:00:00.000Z');
    expect(em.metrics.find((m: any) => m.label === '24h publish').value).toBe('200');
    expect(em.metrics.find((m: any) => m.label === '24h reject').value).toBe('3');
    expect(em.metrics.find((m: any) => m.label === '24h fallback').value).toBe('5');
    expect(em.detail).toBeNull(); // healthy → no detail

    const neo4j = j.subsystems.find((s: any) => s.id === 'neo4j');
    expect(neo4j.state).toBe('healthy');
    expect(neo4j.lastUpdate).toBe('2026-05-14T10:00:00.000Z');
    expect(neo4j.metrics.find((m: any) => m.label === 'upserted last').value).toBe('42');

    const raas = j.subsystems.find((s: any) => s.id === 'raas');
    expect(raas.state).toBe('healthy');
    expect(raas.lastUpdate).toBe('2026-05-14T10:30:00.000Z');
    expect(raas.metrics.find((m: any) => m.label === '24h received').value).toBe('17');
    expect(raas.metrics.find((m: any) => m.label === 'recent classification').value).toBe('matched_valid');
  });

  // ── Test 3: Inngest probe failure → inngest.state='down', others OK ─

  it('Inngest probe failure → inngest.state=down, other subsystems still return', async () => {
    (prisma.emSystemStatus.findUnique as any).mockResolvedValue(emPopulated);
    (prisma.raasMessage.count as any).mockResolvedValue(5);
    (prisma.raasMessage.findFirst as any).mockResolvedValue(null);
    // Stub global fetch to reject (simulating Inngest down)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();

    const inngest = j.subsystems.find((s: any) => s.id === 'inngest');
    expect(inngest.state).toBe('down');

    // EM and Neo4j should still have real data (they use prisma, not fetch)
    const em = j.subsystems.find((s: any) => s.id === 'em');
    expect(em.state).toBe('healthy');

    const neo4j = j.subsystems.find((s: any) => s.id === 'neo4j');
    expect(neo4j.state).toBe('healthy');
  });
});
