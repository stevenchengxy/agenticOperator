import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { AGENT_MAP } from '@/lib/agent-mapping';
import type { InstanceCard, MonitorInstancesResponse } from '@/lib/monitor/types';

// ── /api/monitor/instances ────────────────────────────────────────
//
// Returns enriched WorkflowRun rows as InstanceCard objects.
//
// Query params:
//   ?scope=live    (default) — status IN (running, paused, suspended)
//   ?scope=recent  — completed/failed within the last 1h
//   ?limit=N       (default 30, max 100)
//
// Batched auxiliary queries — no N+1.

const LIVE_STATUSES = ['running', 'paused', 'suspended'];

// Build a lookup from agentName → stage using AGENT_MAP
const AGENT_STAGE_MAP = new Map<string, string>(
  AGENT_MAP.map((a) => [a.short, a.stage]),
);

function parseTriggerData(raw: string | null): {
  client: string | null;
  jdTitle: string | null;
  jdId: string | null;
  candidateName: string | null;
  candidateId: string | null;
  resumeId: string | null;
} {
  const empty = {
    client: null,
    jdTitle: null,
    jdId: null,
    candidateName: null,
    candidateId: null,
    resumeId: null,
  };
  if (!raw) return empty;
  try {
    const p = JSON.parse(raw);
    if (typeof p !== 'object' || p === null) return empty;
    return {
      client:        typeof p.client        === 'string' ? p.client        : typeof p.clientName === 'string' ? p.clientName : null,
      jdTitle:       typeof p.jdTitle       === 'string' ? p.jdTitle       : typeof p.title      === 'string' ? p.title      : null,
      jdId:          typeof p.jdId          === 'string' ? p.jdId          : typeof p.jd_id      === 'string' ? p.jd_id      : null,
      candidateName: typeof p.candidateName === 'string' ? p.candidateName : typeof p.candidate_name === 'string' ? p.candidate_name : null,
      candidateId:   typeof p.candidateId   === 'string' ? p.candidateId   : typeof p.candidate_id   === 'string' ? p.candidate_id   : null,
      resumeId:      typeof p.resumeId      === 'string' ? p.resumeId      : typeof p.resume_id       === 'string' ? p.resume_id       : null,
    };
  } catch {
    return empty;
  }
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const scopeParam = url.searchParams.get('scope') ?? 'live';
  const scope: 'live' | 'recent' = scopeParam === 'recent' ? 'recent' : 'live';
  const limitRaw = Number(url.searchParams.get('limit') ?? 30);
  const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 30 : limitRaw), 100);

  try {
    // ── 1. Fetch WorkflowRun rows ──────────────────────────────────
    let whereClause: Record<string, unknown>;
    if (scope === 'live') {
      whereClause = { status: { in: LIVE_STATUSES } };
    } else {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      whereClause = {
        status: { in: ['completed', 'failed'] },
        lastActivityAt: { gte: oneHourAgo },
      };
    }

    const runs = await prisma.workflowRun.findMany({
      where: whereClause,
      orderBy: { lastActivityAt: 'desc' },
      take: limit,
      select: {
        id: true,
        triggerEvent: true,
        triggerData: true,
        status: true,
        startedAt: true,
        completedAt: true,
        lastActivityAt: true,
      },
    });

    if (runs.length === 0) {
      const body: MonitorInstancesResponse = { scope, total: 0, items: [] };
      return NextResponse.json(body);
    }

    const runIds = runs.map((r) => r.id);

    // ── 2. Batch all auxiliary queries in parallel ─────────────────
    const [allActivities, allHitl] = await Promise.all([
      prisma.agentActivity.findMany({
        where: { runId: { in: runIds } },
        orderBy: { createdAt: 'asc' },
        select: { runId: true, agentName: true, type: true, createdAt: true },
      }),
      prisma.humanTask.findMany({
        where: { runId: { in: runIds }, status: 'pending' },
        select: { runId: true },
      }),
    ]);

    // ── 3. Partition in JS ─────────────────────────────────────────
    // activities by runId
    const activitiesByRun = new Map<string, typeof allActivities>();
    for (const a of allActivities) {
      if (!a.runId) continue;
      const list = activitiesByRun.get(a.runId) ?? [];
      list.push(a);
      activitiesByRun.set(a.runId, list);
    }

    // pending HITL runIds (Set for O(1) lookup)
    const pendingHitlRunIds = new Set(allHitl.map((h) => h.runId));

    // ── 4. Build InstanceCard for each run ────────────────────────
    const items: InstanceCard[] = runs.map((run) => {
      const acts = activitiesByRun.get(run.id) ?? [];

      // Latest activity (last in ordered asc list)
      const latestAct = acts.length > 0 ? acts[acts.length - 1] : null;
      const currentAgent = latestAct?.agentName ?? null;
      const currentStage = currentAgent ? (AGENT_STAGE_MAP.get(currentAgent) ?? null) : null;

      // Distinct agent names touched
      const distinctAgents = new Set(acts.map((a) => a.agentName));
      const agentsTouched = distinctAgents.size;

      // Has any agent_error?
      const hasFailure = acts.some((a) => a.type === 'agent_error');

      // Pending HITL?
      const pendingHitl = pendingHitlRunIds.has(run.id);

      const entities = parseTriggerData(run.triggerData);

      return {
        runId: run.id,
        triggerEvent: run.triggerEvent,
        status: run.status as InstanceCard['status'],
        startedAt: run.startedAt.toISOString(),
        lastActivityAt: run.lastActivityAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        ...entities,
        currentAgent,
        currentStage,
        agentsTouched,
        pendingHitl,
        hasFailure,
      };
    });

    const body: MonitorInstancesResponse = { scope, total: items.length, items };
    return NextResponse.json(body);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[/api/monitor/instances] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
