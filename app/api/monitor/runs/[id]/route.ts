import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { NODES } from '@/lib/workflow-graph-meta';
import { sumTokensFromActivities } from '@/lib/monitor/aggregations';
import type { MonitorRunDetail, RunTrailStep } from '@/lib/monitor/types';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const run = await prisma.workflowRun.findUnique({ where: { id } });
    if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const [activities, hitlRows, eventRows] = await Promise.all([
      prisma.agentActivity.findMany({
        where: { runId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          agentName: true,
          type: true,
          metadata: true,
          createdAt: true,
          narrative: true,
          runId: true,
        },
      }),
      prisma.humanTask.findMany({
        where: { runId: id },
        select: {
          id: true,
          status: true,
          title: true,
          createdAt: true,
          completedAt: true,
        },
      }),
      // EventInstance has no FK to WorkflowRun. We fetch by time window
      // scoped to the run's lifespan — a reasonable approximation for v1.
      prisma.eventInstance.findMany({
        where: {
          ts: { gte: run.startedAt, lte: run.completedAt ?? new Date() },
        },
        orderBy: { ts: 'asc' },
        take: 200,
        select: { id: true, name: true, ts: true, source: true },
      }),
    ]);

    // ── Build trail ──────────────────────────────────────────────
    // For each NODES entry, find activities matching this run's agent
    // (match by node.title which equals agentName in the DB).
    // The "ResumeParser+DupeCheck" node title is what the Task 3 fix
    // uses for lookup, so this is consistent.
    const trail: RunTrailStep[] = [];
    for (const n of NODES) {
      const ofThis = activities.filter(a => a.agentName === n.title);
      if (ofThis.length === 0) continue;

      const start = ofThis.find(a => a.type === 'agent_start');
      const done  = ofThis.find(a => a.type === 'agent_complete');
      const fail  = ofThis.find(a => a.type === 'agent_error');

      const enteredAt = (start ?? ofThis[0]).createdAt;
      const leftAt    = (done ?? fail)?.createdAt ?? null;

      const result: RunTrailStep['result'] =
        fail ? 'failure' : done ? 'success' : 'pending';

      const toolRows = ofThis.filter(a => a.type === 'tool');
      const tokens = sumTokensFromActivities(toolRows);

      trail.push({
        nodeId: n.id,
        enteredAt: enteredAt.toISOString(),
        leftAt: leftAt?.toISOString() ?? null,
        result,
        durationMs: leftAt ? leftAt.getTime() - enteredAt.getTime() : null,
        stepCount: ofThis.length,
        tokensUsed: tokens.total,
        relatedEpisodeId: null,
      });
    }

    // ── tokensByAgent rollup ─────────────────────────────────────
    const tokensByAgent: MonitorRunDetail['tokensByAgent'] = {};
    for (const a of activities) {
      if (a.type !== 'tool') continue;
      const parsed = a.metadata ? safeParse(a.metadata) : null;
      const promptTokens     = numericOrZero(parsed?.promptTokens);
      const completionTokens = numericOrZero(parsed?.completionTokens);
      const totalTokens      = numericOrZero(parsed?.totalTokens) || (promptTokens + completionTokens);
      const model            = typeof parsed?.model === 'string' ? parsed.model : null;
      const k = a.agentName;
      const cur = tokensByAgent[k] ?? { prompt: 0, completion: 0, total: 0, model };
      cur.prompt += promptTokens;
      cur.completion += completionTokens;
      cur.total += totalTokens;
      if (!cur.model) cur.model = model;
      tokensByAgent[k] = cur;
    }

    const detail: MonitorRunDetail = {
      run: {
        id: run.id,
        triggerEvent: run.triggerEvent,
        triggerData: safeParse(run.triggerData ?? '{}') ?? {},
        status: run.status as MonitorRunDetail['run']['status'],
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        lastActivityAt: run.lastActivityAt.toISOString(),
      },
      trail,
      events: eventRows.map(e => ({
        name: e.name,
        ts: e.ts.toISOString(),
        source: 'inbound' as const, // v1 simplification; labelling refined when source is more reliable
        eventInstanceId: e.id,
      })),
      activity: activities.map(a => ({
        ts: a.createdAt.toISOString(),
        agent: a.agentName,
        type: a.type,
        narrative: a.narrative,
        metadata: a.metadata ? safeParse(a.metadata) : undefined,
      })),
      tokensByAgent,
      hitl: hitlRows.map(h => ({
        taskId: h.id,
        status: h.status,
        title: h.title,
        createdAt: h.createdAt.toISOString(),
        completedAt: h.completedAt?.toISOString() ?? null,
      })),
    };
    return NextResponse.json(detail);
  } catch (e) {
    console.error('[/api/monitor/runs/[id]] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

function safeParse(s: string): Record<string, any> | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}

function numericOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
