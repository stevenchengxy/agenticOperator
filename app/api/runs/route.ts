import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import {
  normalizeRunStatus,
  InvalidStatusError,
} from '@/server/normalize/status';
import type { RunsResponse, RunSummary } from '@/lib/api/types';

// P3 chunk 4 (partial): switched from wsClient (HTTP to sidecar 5175) to
// in-process prisma queries against data/ao.db. Response shape unchanged.
// Sidecar still owns the writers; data/ao.db is hydrated by
// `prisma/seed-from-sidecars.ts` until P3 chunk 2 ports the agents
// in-process.

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get('status')?.split(',');
  const legacyLimit = positiveInt(url.searchParams.get('limit'), 10, 500);
  const page = positiveInt(url.searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(url.searchParams.get('pageSize'), legacyLimit, 500);
  const sinceParam = url.searchParams.get('since');
  const since = sinceParam ? new Date(sinceParam) : undefined;
  // New filters (added 2026-05-09): the /live left rail wires these as
  // chips so ops can carve "runs that touched JDGenerator AND failed AND
  // are still pending HITL". All optional; absence means no filter.
  const agentParam = url.searchParams.get('agent');
  const agents = agentParam
    ? agentParam.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const hasError = url.searchParams.get('hasError') === '1';
  const hasHitl = url.searchParams.get('hasHitl') === '1';

  try {
    const where: Record<string, unknown> = {};
    if (status && status.length) where.status = { in: status };
    if (since && !isNaN(since.getTime())) where.startedAt = { gte: since };
    if (agents && agents.length) {
      // "run touched any of these agents" — at least one AgentActivity row
      // with agentName in the list.
      where.activities = { some: { agentName: { in: agents } } };
    }
    if (hasError) {
      // "run had any failed step" — defining "errored" by step status, not
      // run status, so a run that recovered after a failed step still
      // surfaces here.
      where.steps = { some: { status: 'failed' } };
    }
    // HumanTask has no Prisma relation to WorkflowRun, so resolve the exact
    // pending-run id set first and put it into the SQL run filter. This keeps
    // total/page boundaries correct (the old 3x post-filter heuristic did not).
    if (hasHitl) {
      const pending = await prisma.humanTask.findMany({
        where: { status: 'pending' },
        select: { runId: true },
        distinct: ['runId'],
      });
      where.id = { in: pending.map((row) => row.runId) };
    }

    const [items, total] = await Promise.all([
      prisma.workflowRun.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.workflowRun.count({ where }),
    ]);

    // Resolve pending HITL counts in one batch query rather than N+1.
    // Defensive: in tests / partial mocks `prisma.humanTask` may be
    // undefined. Falling through to zero counts is fine — the UI just
    // won't badge HITL until the real schema is in place.
    const runIds = items.map((r) => r.id);
    const pendingByRun = new Map<string, number>();
    if (runIds.length > 0 && prisma.humanTask) {
      try {
        const groups = await prisma.humanTask.groupBy({
          by: ['runId'],
          where: { runId: { in: runIds }, status: 'pending' },
          _count: { _all: true },
        });
        for (const g of groups) {
          if (g.runId) pendingByRun.set(g.runId, g._count._all);
        }
      } catch {
        // Schema mismatch / mock without humanTask — skip silently.
      }
    }

    let runs: RunSummary[] = items.map((r) => ({
      id: r.id,
      triggerEvent: r.triggerEvent,
      triggerData: parseTriggerData(r.triggerData),
      status: normalizeRunStatus(r.status),
      startedAt: r.startedAt.toISOString(),
      lastActivityAt: r.lastActivityAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      agentCount: 0,
      pendingHumanTasks: pendingByRun.get(r.id) ?? 0,
      suspendedReason: r.suspendedReason ?? null,
    }));

    const body: RunsResponse = {
      runs,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      meta: { generatedAt: new Date().toISOString() },
    };
    return NextResponse.json(body);
  } catch (e) {
    if (e instanceof InvalidStatusError) {
      return NextResponse.json(
        { error: 'PROTOCOL', message: e.message },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: 'INTERNAL', message: (e as Error).message },
      { status: 500 },
    );
  }
}

function positiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
}

function parseTriggerData(s: unknown): { client: string; jdId: string } {
  try {
    const o =
      typeof s === 'string'
        ? (JSON.parse(s) as Record<string, unknown>)
        : (s as Record<string, unknown> | null) ?? {};
    return {
      client: (o.client as string) ?? '—',
      jdId: ((o.jdId ?? o.requisition_id) as string) ?? '—',
    };
  } catch {
    return { client: '—', jdId: '—' };
  }
}
