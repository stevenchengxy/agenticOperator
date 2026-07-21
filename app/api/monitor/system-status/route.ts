import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import type { SubsystemHealth, MonitorSystemStatusResponse } from '@/lib/monitor/types';
import { getInfraStatus } from '@/server/ops/infra-status';
import { applyRuntimeConfigToEnv } from '@/server/ops/runtime-config';

// ── /api/monitor/system-status ────────────────────────────────────
//
// Returns health for AO runtime subsystems. Infra-facing dependencies are
// delegated to server/ops/infra-status so /monitor, /api/infra/status and
// notification sweeps all agree on one health model.
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

export async function GET(): Promise<Response> {
  await applyRuntimeConfigToEnv();
  const [em, infra] = await Promise.all([
    buildEmHealth(),
    getInfraStatus(),
  ]);

  const infraSubsystems: SubsystemHealth[] = infra.subsystems.map((s) => ({
    id: s.id,
    label: s.label,
    state: s.state,
    lastUpdate:
      s.id === 'neo4j'
        ? infra.neo4j.lastSyncAt
        : infra.generatedAt,
    metrics: s.metrics.map((m) => (
      m.label === 'last sync'
        ? { label: m.label, value: relativeTime(infra.neo4j.lastSyncAt) }
        : m
    )),
    detail: s.detail,
  }));

  const body: MonitorSystemStatusResponse = {
    subsystems: [em, ...infraSubsystems],
    fetchedAt: new Date().toISOString(),
  };

  return NextResponse.json(body);
}
