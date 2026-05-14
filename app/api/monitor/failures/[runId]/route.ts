import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

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
    return NextResponse.json({ run, steps, retries, events });
  } catch (e) {
    console.error('[/api/monitor/failures/[runId]] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
