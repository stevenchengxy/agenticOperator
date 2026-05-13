import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { streamRuleCheckRun } from '@/server/rule-check/runs-service';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ run_id: string; scenario_id: string }> },
) {
  const { run_id, scenario_id } = await params;
  const run = await prisma.ruleCheckRun.findUnique({ where: { id: run_id } });
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });

  // Drain the single-scenario stream into the throw-away run; then copy the
  // resulting scenario row into the original run_id and delete the throw-away.
  for await (const _ of streamRuleCheckRun({
    model: run.model,
    client_id_override: run.clientIdOverride ?? undefined,
    scenario_ids: [scenario_id],
  })) {
    // event-by-event consumption is required to drive the generator forward
  }

  const tmp = await prisma.ruleCheckRun.findFirst({
    orderBy: { startedAt: 'desc' },
    include: { results: true },
  });
  const newResult = tmp?.results.find((r) => r.scenarioId === scenario_id);
  if (newResult && tmp) {
    const { id: _id, runId: _r, ranAt: _ranAt, ...rest } = newResult;
    await prisma.ruleCheckScenarioResult.upsert({
      where: { runId_scenarioId: { runId: run_id, scenarioId: scenario_id } },
      create: { ...rest, runId: run_id },
      update: rest,
    });
    if (tmp.id !== run_id) {
      await prisma.ruleCheckScenarioResult.deleteMany({ where: { runId: tmp.id } });
      await prisma.ruleCheckRun.delete({ where: { id: tmp.id } });
    }
  }

  await recomputeRunAggregates(run_id);

  const updated = await prisma.ruleCheckScenarioResult.findUnique({
    where: { runId_scenarioId: { runId: run_id, scenarioId: scenario_id } },
  });
  return NextResponse.json({ scenario: updated });
}

async function recomputeRunAggregates(runId: string): Promise<void> {
  const results = await prisma.ruleCheckScenarioResult.findMany({ where: { runId } });
  const pass = results.filter((r) => r.matchKind === 'pass').length;
  const fail = results.length - pass;
  const totalLlmMs = results.reduce((s, r) => s + r.llmMs, 0);
  const capHits = results.filter((r) => r.finishReason === 'length').length;
  await prisma.ruleCheckRun.update({
    where: { id: runId },
    data: { passCount: pass, failCount: fail, totalLlmMs, capHits },
  });
}
