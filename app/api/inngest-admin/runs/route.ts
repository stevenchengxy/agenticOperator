// GET /api/inngest-admin/runs?page=1&pageSize=50&fn=<slug>&domain=&status=&event=&sinceHours=24
// → list recent runs (optionally filtered to one function slug).

import { NextResponse } from 'next/server';
import { listRecentRunsPage } from '@/lib/inngest-source';
import { getRunTokenUsage } from '@/lib/monitor/run-token-usage';
import { prisma } from '@/server/db';
import { deriveRunOutcome } from '@/lib/monitor/run-outcome';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fn = url.searchParams.get('fn') ?? undefined;
  const legacyLimit = positiveInt(url.searchParams.get('limit'), 50, 500);
  const page = positiveInt(url.searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(url.searchParams.get('pageSize'), legacyLimit, 500);
  const domain = url.searchParams.get('domain')?.trim() || undefined;
  const statuses = url.searchParams.get('status')
    ?.split(',')
    .map((s) => titleCase(s.trim()))
    .filter(Boolean);
  const eventName = url.searchParams.get('event')?.trim() || undefined;
  const requestedRunId = url.searchParams.get('runId')?.trim() || undefined;
  const sinceHoursRaw = url.searchParams.get('sinceHours');
  const sinceHours =
    sinceHoursRaw && sinceHoursRaw !== 'all'
      ? Number(sinceHoursRaw)
      : undefined;

  try {
    const result = await listRecentRunsPage({
      page,
      pageSize,
      functionSlug: fn,
      domain,
      status: statuses,
      eventName,
      ...(Number.isFinite(sinceHours) && sinceHours! > 0 ? { sinceHours } : {}),
    });
    let runs = [...result.items];
    // A notification may point at a run outside the current page/window. Pull
    // that exact archived row into the response so the monitor can always
    // scroll to and expand its evidence instead of opening an empty page.
    if (requestedRunId && !runs.some((run) => run.id === requestedRunId)) {
      const target = await prisma.inngestRunArchive.findUnique({ where: { runId: requestedRunId } });
      if (target) {
        runs.unshift({
          id: target.runId,
          status: target.status,
          startedAt: target.startedAt?.toISOString() ?? '',
          finishedAt: target.endedAt?.toISOString() ?? undefined,
          function: {
            name: target.functionName ?? target.functionSlug,
            slug: target.functionSlug,
            appID: target.appId ?? undefined,
          },
          eventName: target.eventName ?? undefined,
          eventId: firstTriggerId(target.triggerEventIds),
        });
      }
    }
    const tokenByRun = await getRunTokenUsage(runs.map((r) => r.id));
    const runIds = runs.map((r) => r.id);
    const [archives, dependencyLogs] = await Promise.all([
      runIds.length
        ? prisma.inngestRunArchive.findMany({
            where: { runId: { in: runIds } },
            select: { runId: true, output: true, functionSlug: true, eventName: true },
          })
        : [],
      runIds.length
        ? prisma.logEvent.findMany({
            where: { runId: { in: runIds }, category: 'dependency' },
            orderBy: { ts: 'desc' },
            select: { runId: true, payloadJson: true, message: true, source: true },
          })
        : [],
    ]);
    const archiveByRun = new Map(archives.map((row) => [row.runId, row]));
    const dependencyByRun = new Map<string, { reason?: string | null; detail?: string | null; provider?: string | null }>();
    for (const log of dependencyLogs) {
      if (!log.runId || dependencyByRun.has(log.runId)) continue;
      const parsed = safeObject(log.payloadJson);
      dependencyByRun.set(log.runId, {
        reason: typeof parsed?.reason === 'string' ? parsed.reason : null,
        detail: typeof parsed?.detail === 'string' ? parsed.detail : log.message,
        provider: typeof parsed?.provider === 'string' ? parsed.provider : log.source,
      });
    }
    return NextResponse.json({
      runs: runs.map((r) => ({
        outcome: deriveRunOutcome({
          status: r.status,
          functionSlug: archiveByRun.get(r.id)?.functionSlug ?? r.function?.slug,
          triggerEvent: archiveByRun.get(r.id)?.eventName ?? r.eventName,
          output: safeJson(archiveByRun.get(r.id)?.output ?? null),
          dependencyFailure: dependencyByRun.get(r.id) ?? null,
        }),
        id: r.id,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt ?? null,
        eventName: r.eventName ?? null,
        eventId: r.eventId ?? null,
        function: r.function,
        durationMs: r.finishedAt
          ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
          : null,
        tokenUsage: tokenByRun[r.id] ?? { prompt: 0, completion: 0, total: 0 },
      })),
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
      meta: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
        source: result.source,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'inngest-admin-failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}

function safeJson(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safeObject(value: string | null): Record<string, unknown> | null {
  const parsed = safeJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function firstTriggerId(value: string | null): string | undefined {
  const parsed = safeJson(value);
  return Array.isArray(parsed) && parsed.length > 0 ? String(parsed[0]) : undefined;
}

function positiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : value;
}
