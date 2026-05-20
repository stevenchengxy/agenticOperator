// GET /api/inngest-admin/functions
// → list registered Inngest functions + their triggers + pause state.
//
// Pause state is tracked in our Prisma AgentConfig table (functionSlug column).
// Inngest dev server has no pause API, so we enforce pause at the AO side:
// when paused, the agent's handler returns early.

import { NextResponse } from 'next/server';
import { listFunctions } from '@/lib/inngest-admin-client';
import { prisma } from '@/server/db';
import { AGENT_MAP, deploymentKind } from '@/lib/agent-mapping';

export const dynamic = 'force-dynamic';

// Ghost-entry fallback for paused agents. Our serve handler drops paused
// agents from Inngest registration, so Inngest stops reporting them — but
// the UI must still render the row (grey, "paused") so the user can resume
// it. Without this map, pausing an agent makes it disappear from /fleet and
// /monitor with no way back.
//
// Derived from AGENT_MAP so every real and shell agent is covered. Slugs
// match the Inngest function ids:
//   - real agents: explicit ids in server/inngest/agents/*.ts
//   - shells:      `agent.<short.toLowerCase()>` from stub-factory
const MONITORED_FALLBACK: Record<string, { name: string; triggers: Array<{ type: string; value: string }> }> = (() => {
  const out: Record<string, { name: string; triggers: Array<{ type: string; value: string }> }> = {};
  const REAL_ID_BY_SHORT: Record<string, string> = {
    JDGenerator: 'create-jd-agent',
    ResumeParser: 'resume-parser-agent',
    Matcher: 'match-resume-agent',
    RuleCheck: 'rule-check-agent',
  };
  for (const a of AGENT_MAP) {
    const kind = deploymentKind(a.short);
    if (kind === 'unbuilt') continue;
    const fnId =
      kind === 'real'
        ? REAL_ID_BY_SHORT[a.short] ?? `agent.${a.short.toLowerCase()}`
        : `agent.${a.short.toLowerCase()}`;
    const slug = `agentic-operator-main-${fnId}`;
    out[slug] = {
      name: a.inngestName ?? a.short,
      triggers: (a.triggersEvents ?? []).map((value) => ({ type: 'EVENT', value })),
    };
  }
  return out;
})();

export async function GET() {
  try {
    const functions = await listFunctions();

    // Read every disabled agent slug so we can (a) mark live ones as paused
    // and (b) inject ghost entries for ones Inngest no longer sees.
    let pausedSlugs: string[] = [];
    try {
      const disabled = await prisma.agentConfig.findMany({
        where: { enabled: false },
        select: { id: true },
      });
      pausedSlugs = disabled.map((c) => c.id);
    } catch {
      // table missing → fall through with no pause state
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
    const ghostPaused = pausedSlugs
      .filter((slug) => !liveSlugs.has(slug) && MONITORED_FALLBACK[slug])
      .map((slug) => {
        const meta = MONITORED_FALLBACK[slug];
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
