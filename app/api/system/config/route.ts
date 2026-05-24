// GET /api/system/config — runtime configuration snapshot.
// Used by <InngestPill /> + <SystemConfigModal /> to show ops which
// Inngest server + Allmeta state + RaaS endpoints are currently wired.
//
// Per spec 2026-05-24 §4.1.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { getInngestUrlWithSource, getRaasInngestUrl, type InngestUrlSource } from '@/lib/inngest-url';
import { listFunctions } from '@/lib/inngest-admin-client';

export const dynamic = 'force-dynamic';

export type SystemConfigResponse = {
  inngest: {
    url: string;
    sourceEnv: InngestUrlSource;
    altEnvs: Record<string, string | null>;
    registeredFunctionCount: number;
    runsLast24h: number | null;
    healthy: boolean;
    lastProbeAt: string;
  };
  eventEngine: {
    lastSyncAt: string | null;
    syncedEventCount: number;
    staleSeconds: number | null;
    staleness: 'fresh' | 'stale' | 'never';
    lastError: string | null;
  };
  raas: {
    apiUrl: string | null;
    inngestUrl: string;
    inngestSharedWithLocal: boolean;
    apiHealthy: boolean | null;
  };
  generatedAt: string;
};

const STALENESS_THRESHOLD_MS = 5 * 60 * 1000;

export async function GET(): Promise<Response> {
  const probeStart = new Date();
  const { url: inngestUrl, sourceEnv } = getInngestUrlWithSource();

  const altEnvs: Record<string, string | null> = {
    INNGEST_BASE_URL: process.env.INNGEST_BASE_URL ?? null,
    INNGEST_DEV: process.env.INNGEST_DEV ?? null,
    INNGEST_LOCAL_URL: process.env.INNGEST_LOCAL_URL ?? null,
    INNGEST_ADMIN_URL: process.env.INNGEST_ADMIN_URL ?? null,
  };

  let fnCount = 0;
  let inngestHealthy = false;
  try {
    const fns = await listFunctions();
    fnCount = fns.length;
    inngestHealthy = true;
  } catch {
    inngestHealthy = false;
  }

  // runs24h best-effort. We use AgentActivity (always present) as a proxy
  // for "Inngest run activity in the last 24h". If the audit LogEvent table
  // from spec 2026-05-22 ships first, swap to it for accuracy.
  let runs24h: number | null = null;
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    runs24h = await prisma.agentActivity.count({
      where: { createdAt: { gte: since } },
    });
  } catch {
    runs24h = null;
  }

  const status = await prisma.emSystemStatus.findUnique({ where: { id: 'singleton' } }).catch(() => null);
  const lastSyncAt = status?.neo4jLastSyncAt ?? null;
  const staleSeconds = lastSyncAt ? Math.floor((Date.now() - new Date(lastSyncAt).getTime()) / 1000) : null;
  const staleness: 'fresh' | 'stale' | 'never' = !lastSyncAt
    ? 'never'
    : Date.now() - new Date(lastSyncAt).getTime() < STALENESS_THRESHOLD_MS
      ? 'fresh'
      : 'stale';
  const syncedEventCount = await prisma.eventDefinition
    .count({ where: { source: 'neo4j' } })
    .catch(() => 0);

  const raasInngestUrl = getRaasInngestUrl();
  const body: SystemConfigResponse = {
    inngest: {
      url: inngestUrl,
      sourceEnv,
      altEnvs,
      registeredFunctionCount: fnCount,
      runsLast24h: runs24h,
      healthy: inngestHealthy,
      lastProbeAt: probeStart.toISOString(),
    },
    eventEngine: {
      lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
      syncedEventCount,
      staleSeconds,
      staleness,
      lastError: status?.neo4jLastError ?? null,
    },
    raas: {
      apiUrl: process.env.RAAS_API_BASE_URL ?? null,
      inngestUrl: raasInngestUrl,
      inngestSharedWithLocal: raasInngestUrl === inngestUrl,
      apiHealthy: null,
    },
    generatedAt: new Date().toISOString(),
  };
  return NextResponse.json(body);
}
