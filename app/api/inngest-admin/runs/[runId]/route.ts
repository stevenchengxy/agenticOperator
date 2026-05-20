// GET /api/inngest-admin/runs/[runId]
// → full run detail with per-step output JSON (V2 trace).
//
// 2026-05-20: switched from V1 `functionRun.history` (only type/stepName/
// attempt/timestamp) to V2 `run(runID:).trace.childrenSpans + outputID`
// which gives durationMs + real step output / input / error per step.

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
    // V2 per-step outputs (每个 step.run / step.sendEvent 的实际 output JSON)
    // — RunTrace.tsx 读 stepOutputs 渲染"Steps · N"列表 + 数据写入摘要。
    // soft-fail:即便 Inngest V2 trace API 暂时返回 outputID 不全也别整条挂。
    let stepOutputs: Awaited<ReturnType<typeof getRunStepOutputs>> = [];
    try {
      stepOutputs = await getRunStepOutputs(run.id);
    } catch {
      // ignore — frontend handles empty stepOutputs gracefully
    }
    const tokenByRun = await getRunTokenUsage([run.id]);
    return NextResponse.json({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      output: run.output ?? null,
      function: run.function,
      steps: run.steps,
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
