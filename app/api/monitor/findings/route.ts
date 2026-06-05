// Monitor findings — firing monitor alerts (clustered by triage) + recent AI
// evals, domain-scoped. Read-only surface for the monitor view.
import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { clusterFiring, type FiringAlert } from '@/lib/monitor/triage';

const MONITOR_PREFIXES = ['run_stalled.', 'sla_breach.', 'cost.', 'error_rate.', 'groundedness.'];

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const domain = url.searchParams.get('domain')?.trim() || null;

  const firing = await prisma.notification.findMany({
    where: { status: 'firing', OR: MONITOR_PREFIXES.map((p) => ({ dedupeKey: { startsWith: p } })) },
    orderBy: { ts: 'desc' },
    take: 200,
    select: { dedupeKey: true, domain: true, source: true, severity: true, count: true },
  });

  const alerts: FiringAlert[] = firing
    .filter((f) => f.dedupeKey)
    .map((f) => ({
      dedupeKey: f.dedupeKey as string,
      domain: f.domain,
      source: f.source,
      severity: f.severity,
      count: f.count,
    }));
  // system alerts (domain=null) always show; otherwise scope to the active domain
  const scoped = domain ? alerts.filter((a) => a.domain === domain || a.domain === null) : alerts;

  const recentEvals = await prisma.monitorEval.findMany({
    where: { kind: 'groundedness' },
    orderBy: { ts: 'desc' },
    take: 50,
    select: { id: true, ts: true, domain: true, agent: true, verdict: true, score: true, primaryAgreed: true, auditId: true },
  });

  return NextResponse.json({ clusters: clusterFiring(scoped), alerts: scoped, recentEvals });
}
