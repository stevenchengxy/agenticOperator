import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import type { SubsystemHealth, MonitorSystemStatusResponse } from '@/lib/monitor/types';

// ── /api/monitor/system-status ────────────────────────────────────
//
// Returns health for 4 subsystems: EM, RaaS, Neo4j/Allmeta, Inngest.
// Every sub-query is wrapped in .catch() so a single DB failure never
// takes down the whole endpoint. Responds 200 with partial unknowns
// rather than 500 unless catastrophic.

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const m = Math.floor(totalSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

async function buildEmHealth(): Promise<SubsystemHealth> {
  try {
    const row = await prisma.emSystemStatus.findUnique({ where: { id: 'singleton' } });
    if (!row) {
      return {
        id: 'em',
        label: 'Event Manager',
        state: 'unknown',
        lastUpdate: null,
        metrics: [
          { label: '24h publish', value: '—' },
          { label: '24h reject', value: '—' },
          { label: '24h fallback', value: '—' },
        ],
        detail: null,
      };
    }
    const state = (row.state === 'healthy' || row.state === 'degraded' || row.state === 'down')
      ? row.state as 'healthy' | 'degraded' | 'down'
      : 'unknown';
    return {
      id: 'em',
      label: 'Event Manager',
      state,
      lastUpdate: row.updatedAt.toISOString(),
      metrics: [
        { label: '24h publish', value: String(row.publishCount24h) },
        { label: '24h reject', value: String(row.rejectCount24h) },
        { label: '24h fallback', value: String(row.fallbackCount24h) },
      ],
      detail: state !== 'healthy' ? (row.lastError ?? null) : null,
    };
  } catch {
    return {
      id: 'em',
      label: 'Event Manager',
      state: 'unknown',
      lastUpdate: null,
      metrics: [
        { label: '24h publish', value: '—' },
        { label: '24h reject', value: '—' },
        { label: '24h fallback', value: '—' },
      ],
      detail: null,
    };
  }
}

async function buildRaasHealth(): Promise<SubsystemHealth> {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [count24h, latestRow] = await Promise.all([
      prisma.raasMessage.count({
        where: { receivedAt: { gte: since24h } },
      }).catch(() => null),
      prisma.raasMessage.findFirst({
        orderBy: { receivedAt: 'desc' },
      }).catch(() => null),
    ]);

    const state: 'healthy' | 'unknown' = (count24h !== null && count24h > 0) ? 'healthy' : 'unknown';

    return {
      id: 'raas',
      label: 'RaaS Bridge',
      state,
      lastUpdate: latestRow?.receivedAt ?? null,
      metrics: [
        { label: '24h received', value: count24h !== null ? String(count24h) : '—' },
        { label: 'recent classification', value: latestRow?.classification ?? '—' },
      ],
      detail: 'External Kafka inbound · classified via gateway filter rules.',
    };
  } catch {
    return {
      id: 'raas',
      label: 'RaaS Bridge',
      state: 'unknown',
      lastUpdate: null,
      metrics: [
        { label: '24h received', value: '—' },
        { label: 'recent classification', value: '—' },
      ],
      detail: 'External Kafka inbound · classified via gateway filter rules.',
    };
  }
}

async function buildNeo4jHealth(): Promise<SubsystemHealth> {
  try {
    const row = await prisma.emSystemStatus.findUnique({ where: { id: 'singleton' } });
    if (!row) {
      return {
        id: 'neo4j',
        label: 'Allmeta Ontology',
        state: 'unknown',
        lastUpdate: null,
        metrics: [
          { label: 'last sync', value: '—' },
          { label: 'upserted last', value: '—' },
        ],
        detail: 'Graph engine sync via Allmeta Ontology.',
      };
    }
    const neo4jSyncAt = row.neo4jLastSyncAt?.toISOString() ?? null;
    const state: 'healthy' | 'degraded' | 'unknown' =
      row.neo4jLastError != null ? 'degraded'
      : neo4jSyncAt ? 'healthy'
      : 'unknown';

    return {
      id: 'neo4j',
      label: 'Allmeta Ontology',
      state,
      lastUpdate: neo4jSyncAt,
      metrics: [
        { label: 'last sync', value: relativeTime(neo4jSyncAt) },
        { label: 'upserted last', value: String(row.neo4jUpsertedLast) },
      ],
      detail: row.neo4jLastError ?? 'Graph engine sync via Allmeta Ontology.',
    };
  } catch {
    return {
      id: 'neo4j',
      label: 'Allmeta Ontology',
      state: 'unknown',
      lastUpdate: null,
      metrics: [
        { label: 'last sync', value: '—' },
        { label: 'upserted last', value: '—' },
      ],
      detail: 'Graph engine sync via Allmeta Ontology.',
    };
  }
}

async function probeInngest(): Promise<SubsystemHealth> {
  const probeTime = new Date().toISOString();
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 1_000);
    let ok = false;
    try {
      const res = await fetch('http://localhost:8288/health', {
        signal: ac.signal,
        cache: 'no-store',
      });
      ok = res.ok;
    } finally {
      clearTimeout(timeout);
    }

    return {
      id: 'inngest',
      label: 'Inngest Dev Server',
      state: ok ? 'healthy' : 'down',
      lastUpdate: probeTime,
      metrics: [{ label: 'endpoint', value: 'localhost:8288' }],
      detail: 'Local Inngest dev server. Used by the workflow event bus.',
    };
  } catch {
    return {
      id: 'inngest',
      label: 'Inngest Dev Server',
      state: 'down',
      lastUpdate: probeTime,
      metrics: [{ label: 'endpoint', value: 'localhost:8288' }],
      detail: 'Local Inngest dev server. Used by the workflow event bus.',
    };
  }
}

export async function GET(): Promise<Response> {
  const [em, raas, neo4j, inngest] = await Promise.all([
    buildEmHealth(),
    buildRaasHealth(),
    buildNeo4jHealth(),
    probeInngest(),
  ]);

  const body: MonitorSystemStatusResponse = {
    subsystems: [em, raas, neo4j, inngest],
    fetchedAt: new Date().toISOString(),
  };

  return NextResponse.json(body);
}
