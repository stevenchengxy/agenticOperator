import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { NODES } from '@/lib/workflow-graph-meta';
import { sumTokensFromActivities, safeParse } from '@/lib/monitor/aggregations';
import type { MonitorRunDetail, RunTrailStep } from '@/lib/monitor/types';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const run = await prisma.workflowRun.findUnique({ where: { id } });
    if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const [activities, hitlRows, eventRows, stepRows] = await Promise.all([
      prisma.agentActivity.findMany({
        // Chatbot rows are conversational ABOUT the run, not part of its execution. Filter for the timeline.
        where: { runId: id, agentName: { not: 'Chatbot' } },
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
        select: { id: true, name: true, ts: true },
      }),
      prisma.workflowStep.findMany({
        where: { runId: id },
        orderBy: { startedAt: 'asc' },
        select: {
          id: true,
          nodeId: true,
          stepName: true,
          status: true,
          error: true,
          startedAt: true,
          completedAt: true,
          durationMs: true,
        },
      }),
    ]);

    // ── Build trail ──────────────────────────────────────────────
    // For each NODES entry, find activities matching this run's agent
    // (match by node.agentName if present, else fall back to node.title).
    // The "ResumeParser+DupeCheck" node has agentName "ResumeParser",
    // matching the DB agentName exactly.
    const trail: RunTrailStep[] = [];
    for (const n of NODES) {
      const ofThis = activities.filter(a => a.agentName === (n.agentName ?? n.title));
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
    // Group activities by agent name (for per-agent token rollup), then call
    // sumTokensFromActivities on each group.
    const tokenActivitiesByAgent = new Map<string, typeof activities>();
    for (const a of activities) {
      if (a.type !== 'tool') continue;
      const list = tokenActivitiesByAgent.get(a.agentName) ?? [];
      list.push(a);
      tokenActivitiesByAgent.set(a.agentName, list);
    }
    const tokensByAgent: MonitorRunDetail['tokensByAgent'] = {};
    for (const [agentName, rows] of tokenActivitiesByAgent) {
      const tokens = sumTokensFromActivities(rows);
      // Extract model from the first row that has it
      let model: string | null = null;
      for (const r of rows) {
        const m = r.metadata ? safeParse(r.metadata) : null;
        if (m && typeof m.model === 'string') { model = m.model; break; }
      }
      tokensByAgent[agentName] = { ...tokens, model };
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
      steps: stepRows.map(s => ({
        id: s.id,
        nodeId: s.nodeId,
        stepName: s.stepName,
        status: s.status,
        error: s.error,
        startedAt: s.startedAt.toISOString(),
        completedAt: s.completedAt?.toISOString() ?? null,
        durationMs: s.durationMs,
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
    // eslint-disable-next-line no-console
    console.error('[/api/monitor/runs/[id]] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
