// AI fact-monitor eval endpoint (off-Inngest). POST fires a sampled groundedness
// eval over recent rule-check audits (fire-and-forget — never blocks); GET returns
// recent eval results. The judge degrades to a skip when the gateway is down, so
// this is strictly additive to the authoritative deterministic rule-check.
import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { runEvalSample } from '@/lib/monitor/run-eval';
import { resolveMonitorConfig } from '@/lib/monitor/monitor-config';
import { makeLlmJudge, makeJury } from '@/lib/monitor/llm-judge';
import { createPgEvalStore, getMonitorConfig, recentAuditSamples } from '@/lib/monitor/pg-eval-store';
import { recordNotification } from '@/server/notifications/ingest';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';

const EVAL_WINDOW_MS = 60 * 60_000;

async function runDomainEval(): Promise<void> {
  const domain = RECRUITMENT_DOMAIN_ID;
  const config = resolveMonitorConfig(await getMonitorConfig(domain), domain);
  const samples = await recentAuditSamples(EVAL_WINDOW_MS);
  if (samples.length === 0) return;
  const primaryModel = process.env.AI_MODEL || 'openai/gpt-5.4';
  await runEvalSample({
    samples,
    config,
    primaryJudge: makeLlmJudge(),
    juryJudges: makeJury(primaryModel, 2),
    store: createPgEvalStore(),
    record: (f) => recordNotification(f),
    sweepWindow: new Date().toISOString().slice(0, 13),
  });
}

export async function POST(): Promise<Response> {
  void runDomainEval().catch(() => {});
  return NextResponse.json({ ok: true, started: true });
}

export async function GET(): Promise<Response> {
  const evals = await prisma.monitorEval.findMany({
    where: { kind: 'groundedness' },
    orderBy: { ts: 'desc' },
    take: 50,
    select: {
      id: true,
      ts: true,
      domain: true,
      agent: true,
      verdict: true,
      score: true,
      rationale: true,
      primaryAgreed: true,
      judgeModel: true,
      auditId: true,
      suppressed: true,
    },
  });
  return NextResponse.json({ evals });
}
