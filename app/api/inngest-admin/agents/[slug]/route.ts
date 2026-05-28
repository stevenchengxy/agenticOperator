// GET /api/inngest-admin/agents/[slug]
// → Agent detail: meta + recent runs grouped by flow (upload_id or job_requisition_id).
//
// Powers the /monitor/agents/[slug] page (Level 3 — single agent drill-in).

import { NextResponse } from 'next/server';
import {
  listFunctions,
  listRunsWithEvents,
  groupRunsByFlow,
} from '@/lib/inngest-source';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  try {
    // 1) Function meta
    const allFns = await listFunctions();
    const fn = allFns.find((f) => f.slug === slug);
    if (!fn) {
      return NextResponse.json({ error: 'agent-not-found', slug }, { status: 404 });
    }

    // 2) Pause state from Prisma
    let paused = false;
    let cachedSummary: string | null = null;
    try {
      const cfg = await prisma.agentConfig.findUnique({
        where: { id: slug },
        select: { enabled: true, description: true, tuningNotes: true },
      });
      paused = cfg ? cfg.enabled === false : false;
      // Reuse `tuningNotes` to store cached AI summary JSON.
      cachedSummary = cfg?.tuningNotes ?? null;
    } catch {
      /* soft fail */
    }

    // 3) Recent runs (last 24h) with event payloads
    const runs = await listRunsWithEvents(slug, { limit: 100, sinceHours: 24 });

    // 4) Group by flow
    const flows = groupRunsByFlow(runs);

    // 5) Stats
    const total = runs.length;
    const completed = runs.filter((r) => r.status === 'Completed').length;
    const failed = runs.filter((r) => r.status === 'Failed').length;
    const running = runs.filter((r) => r.status === 'Running').length;
    const successRate = total > 0 ? Math.round((completed / total) * 100) : null;

    return NextResponse.json({
      agent: {
        id: fn.id,
        name: fn.name,
        slug: fn.slug,
        concurrency: fn.concurrency,
        triggers: fn.triggers,
        url: fn.url,
        paused,
      },
      stats: { total, completed, failed, running, successRate },
      cachedSummary,
      flows: flows.map((g) => {
        const latest = g.runs[0];
        return {
          flowId: g.flowId,
          latestStartedAt: g.latestStartedAt,
          runCount: g.runs.length,
          status: latest.status,
          durationMs: latest.durationMs,
          label: latest.label,
          eventName: latest.eventName,
          eventId: latest.eventId,
          runs: g.runs.map((r) => ({
            id: r.runId,
            status: r.status,
            startedAt: r.startedAt,
            durationMs: r.durationMs,
          })),
        };
      }),
      meta: { generatedAt: new Date().toISOString() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'agent-detail-failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}
