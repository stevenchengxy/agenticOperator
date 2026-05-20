// GET /api/inngest-admin/runs/[runId]
// → full run detail: status + step-by-step history + output.

import { NextResponse } from 'next/server';
import { getRunHistory, getRunStepOutputs } from '@/lib/inngest-admin-client';
import { getRunTokenUsage } from '@/lib/monitor/run-token-usage';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const run = await getRunHistory(runId);
    if (!run || !run.id) {
      return NextResponse.json({ error: 'run-not-found' }, { status: 404 });
    }
    // Group history into step-level summary
    const stepEvents = run.history?.filter((h) =>
      ['StepStarted', 'StepCompleted', 'StepFailed', 'StepErrored', 'StepScheduled'].includes(h.type),
    ) ?? [];
    // Build per-step latest-state map
    const stepsBy: Record<string, { stepName: string; states: typeof stepEvents }> = {};
    for (const e of stepEvents) {
      if (!e.stepName) continue;
      if (!stepsBy[e.stepName]) stepsBy[e.stepName] = { stepName: e.stepName, states: [] };
      stepsBy[e.stepName].states.push(e);
    }
    const tokenByRun = await getRunTokenUsage([run.id]);

    // Per-step outputs from V2 trace API (the JSON each step.run returned).
    // Best-effort: a failure here doesn't kill the response — the drawer
    // already renders without step outputs, this just adds them when available.
    let stepOutputs: Awaited<ReturnType<typeof getRunStepOutputs>> = [];
    try {
      stepOutputs = await getRunStepOutputs(run.id);
    } catch (stepErr) {
      console.warn(
        `[run-detail] step outputs unavailable for ${run.id}: ${(stepErr as Error).message}`,
      );
    }

    return NextResponse.json({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      output: run.output ?? null,
      function: run.function,
      history: run.history ?? [],
      steps: Object.values(stepsBy),
      stepOutputs,
      // Surface the triggering event so the drawer's "replay" button can
      // re-emit by event id (replay endpoint requires eventId, not runId).
      event: run.event ?? null,
      tokenUsage: tokenByRun[run.id] ?? { prompt: 0, completion: 0, total: 0 },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'inngest-admin-failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}
