// GET /api/inngest-admin/functions
// → list registered Inngest functions + their triggers + pause state.
//
// Pause state is tracked in our Prisma AgentConfig table (functionSlug column).
// Inngest dev server has no pause API, so we enforce pause at the AO side:
// when paused, the agent's handler returns early.

import { NextResponse } from 'next/server';
import { listFunctions } from '@/lib/inngest-admin-client';
import { prisma } from '@/server/db';
import { AGENT_MAP } from '@/lib/agent-mapping';

export const dynamic = 'force-dynamic';

const INNGEST_APP_PREFIX = 'agentic-operator-main';

// Ghost-entry fallback for paused agents. Our serve handler drops paused
// agents from Inngest registration so Inngest stops reporting them — but
// the UI must still render the row (grey, "paused") so the user can resume
// it. Without this map, pausing an agent makes it disappear from /fleet and
// /monitor with no way back.
//
// Replaces the static REAL_ID_BY_SHORT hardcode (deleted per spec 2026-05-24).
// `inngestId` override (when present on AgentMeta) takes precedence over the
// stub-factory convention `agent.<short.toLowerCase()>`. Computed on every
// request because AGENT_MAP edits at dev-time should reflect immediately.
function buildMonitoredFallback(): Record<string, { name: string; triggers: Array<{ type: string; value: string }> }> {
  const out: Record<string, { name: string; triggers: Array<{ type: string; value: string }> }> = {};
  for (const a of AGENT_MAP) {
    if ((a.triggersEvents ?? []).length === 0) continue;
    const fnId = a.inngestId ?? `agent.${a.short.toLowerCase()}`;
    const slug = `${INNGEST_APP_PREFIX}-${fnId}`;
    out[slug] = {
      name: a.inngestName ?? a.short,
      triggers: a.triggersEvents.map((value) => ({ type: 'EVENT', value })),
    };
  }
  return out;
}

export async function GET() {
  try {
    const functions = await listFunctions();

    // Read every disabled agent slug so we can (a) mark live ones as paused
    // and (b) inject ghost entries for ones Inngest no longer sees.
    //
    // A silent catch here caused paused agents to flicker back to "deployed"
    // every time the AgentConfig query transiently failed (e.g. SQLite lock
    // mid-write). Log loudly so misconfigured deploys are visible, and let
    // the agent-pause-guard cache act as the resilient source of truth.
    let pausedSlugs: string[] = [];
    try {
      const disabled = await prisma.agentConfig.findMany({
        where: { enabled: false },
        select: { id: true },
      });
      pausedSlugs = disabled.map((c) => c.id);
    } catch (e) {
      console.warn(
        '[functions-admin] AgentConfig query failed; pause state may be temporarily wrong:',
        (e as Error).message,
      );
    }

    const liveSlugs = new Set(functions.map((f) => f.slug));
    const liveMapped = functions.map((f) => ({
      id: f.id,
      name: f.name,
      slug: f.slug,
      concurrency: f.concurrency ?? null,
      triggers: f.triggers,
      url: f.url ?? null,
      paused: pausedSlugs.includes(f.slug),
    }));
    const fallback = buildMonitoredFallback();
    const ghostPaused = pausedSlugs
      .filter((slug) => !liveSlugs.has(slug) && fallback[slug])
      .map((slug) => {
        const meta = fallback[slug];
        return {
          id: `paused:${slug}`,
          name: meta.name,
          slug,
          concurrency: 0,
          triggers: meta.triggers,
          url: null as string | null,
          paused: true,
        };
      });

    const combined = [...liveMapped, ...ghostPaused];
    return NextResponse.json({
      functions: combined,
      meta: {
        total: combined.length,
        liveCount: liveMapped.length,
        pausedCount: combined.filter((f) => f.paused).length,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'inngest-admin-failed', message: (err as Error).message },
      { status: 502 },
    );
  }
}
