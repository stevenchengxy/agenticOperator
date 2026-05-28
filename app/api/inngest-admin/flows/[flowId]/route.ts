// GET /api/inngest-admin/flows/[flowId]
// → Per-flow detail: assembles all runs (across ALL agents) that share this flow id.
//   flowId format: "upload:<upload_id>" | "jr:<job_req_id>" | "evt:<event_id>"
//
// This is "Level 4" in the macro→micro hierarchy:
//   System → Agent → Flow → Step (with I/O JSON)

import { NextResponse } from 'next/server';
import {
  listFunctions,
  listRunsWithEvents,
  deriveFlowId,
  flowLabel,
  getRunHistory,
} from '@/lib/inngest-source';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ flowId: string }> }) {
  const { flowId: encoded } = await params;
  const flowId = decodeURIComponent(encoded);

  try {
    const fns = await listFunctions();
    // Pull recent runs from each function, then filter to this flowId.
    const allRuns: Awaited<ReturnType<typeof listRunsWithEvents>> = [];
    for (const fn of fns) {
      const runs = await listRunsWithEvents(fn.slug, { limit: 60, sinceHours: 24 });
      for (const r of runs) {
        if (r.flowId === flowId) {
          allRuns.push(r);
        }
      }
    }

    // Sort by startedAt ASC → timeline order
    allRuns.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

    // For each run, also load the full V2 trace (per-step durations + output JSON)
    const enriched = await Promise.all(
      allRuns.map(async (r) => {
        let detail = null as Awaited<ReturnType<typeof getRunHistory>> | null;
        try {
          detail = await getRunHistory(r.runId);
        } catch {
          /* soft fail */
        }
        return {
          ...r,
          functionName: (fns.find((f) => f.slug === r.eventName) ?? null)?.name ?? null,
          detail,
        };
      }),
    );

    // Synthesize a label from the first event payload that has fields
    let label: ReturnType<typeof flowLabel> = {};
    for (const r of allRuns) {
      const l = flowLabel(r.eventPayload);
      label = { ...label, ...l };
      if (label.candidateName && label.jrId) break;
    }

    return NextResponse.json({
      flowId,
      label,
      runCount: allRuns.length,
      runs: enriched.map((r) => ({
        runId: r.runId,
        functionSlug: fns.find((f) => f.slug)?.slug ?? null,
        eventName: r.eventName,
        eventId: r.eventId,
        eventPayload: r.eventPayload,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
        steps: r.detail?.steps ?? [],
        output: r.detail?.output ?? null,
        function: r.detail?.function ?? null,
      })),
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'flow-detail-failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}
