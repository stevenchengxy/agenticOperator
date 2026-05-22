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

async function probeRaasApi(): Promise<SubsystemHealth> {
  const probeTime = new Date().toISOString();
  const baseUrl = process.env.RAAS_API_BASE_URL ?? '';
  const endpointLabel = baseUrl
    ? baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    : '—';

  if (!baseUrl) {
    return {
      id: 'raas',
      label: 'RaaS API',
      state: 'unknown',
      lastUpdate: probeTime,
      metrics: [
        { label: 'endpoint', value: endpointLabel },
        { label: 'http status', value: '—' },
      ],
      detail: 'RAAS_API_BASE_URL not configured.',
    };
  }

  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 2_000);
    let status = 0;
    try {
      const res = await fetch(baseUrl, {
        method: 'HEAD',
        signal: ac.signal,
        cache: 'no-store',
      });
      status = res.status;
    } finally {
      clearTimeout(timeout);
    }

    return {
      id: 'raas',
      label: 'RaaS API',
      state: status > 0 ? 'healthy' : 'down',
      lastUpdate: probeTime,
      metrics: [
        { label: 'endpoint', value: endpointLabel },
        { label: 'http status', value: status > 0 ? String(status) : '—' },
      ],
      detail: 'RAAS API Server reachability probe.',
    };
  } catch {
    return {
      id: 'raas',
      label: 'RaaS API',
      state: 'down',
      lastUpdate: probeTime,
      metrics: [
        { label: 'endpoint', value: endpointLabel },
        { label: 'http status', value: '—' },
      ],
      detail: 'RAAS API Server unreachable (network error or timeout).',
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
  const { getInngestUrl } = await import('@/lib/inngest-url');
  const base = getInngestUrl();
  // Strip protocol for the display label so the metrics row stays compact.
  const displayEndpoint = base.replace(/^https?:\/\//, '');
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 1_000);
    let ok = false;
    try {
      const res = await fetch(`${base}/health`, {
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
      metrics: [{ label: 'endpoint', value: displayEndpoint }],
      detail: 'Shared Inngest server (configured via INNGEST_BASE_URL).',
    };
  } catch {
    return {
      id: 'inngest',
      label: 'Inngest Dev Server',
      state: 'down',
      lastUpdate: probeTime,
      metrics: [{ label: 'endpoint', value: displayEndpoint }],
      detail: 'Shared Inngest server (configured via INNGEST_BASE_URL).',
    };
  }
}

export async function GET(): Promise<Response> {
  const [em, raas, neo4j, inngest] = await Promise.all([
    buildEmHealth(),
    probeRaasApi(),
    buildNeo4jHealth(),
    probeInngest(),
  ]);

  const body: MonitorSystemStatusResponse = {
    subsystems: [em, raas, neo4j, inngest],
    fetchedAt: new Date().toISOString(),
  };

  return NextResponse.json(body);
}
