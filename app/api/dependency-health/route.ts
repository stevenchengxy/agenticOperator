// GET /api/dependency-health — per-provider health for the Dependency Health
// card. Reads the degraded-call window (same source the monitor judges) and
// rolls it up per provider, attaching the firing 消息通知 alert id for a
// deep-link. Never 500s the fleet page: on any read failure it returns all
// providers healthy with a `partial` flag.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { createPgReadPort } from '@/lib/monitor/pg-read-port';
import { DEFAULT_THRESHOLDS } from '@/lib/monitor/monitor-types';
import { summarizeDependencyHealth, type ProviderHealth } from '@/lib/dependency-health/summarize';
import type { DepProvider } from '@/lib/dependency-health/types';

export interface DependencyHealthRow extends ProviderHealth {
  /** Firing alert id in the 消息通知 center, for deep-linking (null when none). */
  notificationId: string | null;
}

export interface DependencyHealthResponse {
  providers: DependencyHealthRow[];
  windowMinutes: number;
  generatedAt: string;
  partial: boolean;
}

export async function GET(): Promise<Response> {
  const windowMs = DEFAULT_THRESHOLDS.depFailWindowMs;
  const windowMinutes = Math.round(windowMs / 60_000);

  try {
    const port = createPgReadPort();
    const [failures, firing] = await Promise.all([
      port.dependencyFailures(windowMs),
      prisma.notification.findMany({
        where: { status: 'firing', dedupeKey: { startsWith: 'dep_down.' } },
        select: { id: true, dedupeKey: true },
      }),
    ]);

    // dedupeKey is `dep_down.<provider>.<domain>` — first firing alert per provider.
    const firingByProvider = new Map<string, string>();
    for (const n of firing) {
      const provider = n.dedupeKey?.split('.')[1];
      if (provider && !firingByProvider.has(provider)) firingByProvider.set(provider, n.id);
    }

    const providers: DependencyHealthRow[] = summarizeDependencyHealth(failures, DEFAULT_THRESHOLDS).map((p) => ({
      ...p,
      notificationId: firingByProvider.get(p.provider) ?? null,
    }));

    const body: DependencyHealthResponse = {
      providers,
      windowMinutes,
      generatedAt: new Date().toISOString(),
      partial: false,
    };
    return NextResponse.json(body);
  } catch (e) {
    // Degrade gracefully — the fleet page must never break because this read failed.
    console.warn(`[dependency-health] read failed: ${(e as Error).message}`);
    const healthy = (['robohire', 'llm'] as DepProvider[]).map((provider) => ({
      provider,
      label: 'healthy' as const,
      severity: 'ok' as const,
      failureCount: 0,
      sinceTs: null,
      lastReason: null,
      affectedOps: [],
      affectedDomains: [],
      notificationId: null,
    }));
    const body: DependencyHealthResponse = {
      providers: healthy,
      windowMinutes,
      generatedAt: new Date().toISOString(),
      partial: true,
    };
    return NextResponse.json(body);
  }
}
