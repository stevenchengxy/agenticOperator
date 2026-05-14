import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import type { MonitorFailureDetailResponse } from '@/lib/monitor/types';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await ctx.params;
  try {
    const [run, steps, retries, events] = await Promise.all([
      prisma.workflowRun.findUnique({ where: { id: runId } }),
      prisma.workflowStep.findMany({
        where: { runId, status: 'failed' },
        orderBy: { completedAt: 'desc' },
      }),
      prisma.agentActivity.findMany({
        where: { runId, type: { in: ['step.retrying', 'agent_error', 'anomaly'] } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.eventInstance.findMany({
        where: { causedByEventId: { not: null } /* loose proxy; refine if needed */ },
        take: 50,
      }).catch(() => []),
    ]);
    if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const body: MonitorFailureDetailResponse = {
      run: {
        id: run.id,
        triggerEvent: run.triggerEvent,
        status: run.status as MonitorFailureDetailResponse['run']['status'],
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        lastActivityAt: run.lastActivityAt.toISOString(),
      },
      steps: steps.map(s => ({
        id: s.id,
        runId: s.runId,
        nodeId: s.nodeId,
        stepName: s.stepName,
        status: s.status,
        error: s.error,
        startedAt: s.startedAt.toISOString(),
        completedAt: s.completedAt?.toISOString() ?? null,
        durationMs: s.durationMs,
      })),
      retries: retries.map(r => ({
        id: r.id,
        runId: r.runId,
        agentName: r.agentName,
        type: r.type,
        narrative: r.narrative,
        metadata: r.metadata,
        createdAt: r.createdAt.toISOString(),
      })),
      events: (events as Array<{ id: string; name: string; source: string; status: string; ts: Date }>).map(e => ({
        id: e.id,
        name: e.name,
        source: e.source,
        status: e.status,
        ts: e.ts.toISOString(),
      })),
    };
    return NextResponse.json(body);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[/api/monitor/failures/[runId]] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
