// POST /api/inngest-admin/functions/[slug]/toggle  body { paused: boolean }
// → enable/disable an agent.
//
// Inngest dev server has no pause API, so we use AgentConfig.enabled in
// Prisma. The agent itself must check this flag at the top of its handler
// (we'll wire that next).

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import {
  invalidateAgentPauseCache,
  invalidatePausedSetCache,
} from '@/lib/agent-pause-guard';
import { invalidateHandlerCache } from '@/app/api/inngest/route';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const body = (await req.json()) as { paused?: boolean };
    const paused = Boolean(body.paused);
    await prisma.agentConfig.upsert({
      where: { id: slug },
      update: { enabled: !paused },
      create: {
        id: slug,
        enabled: !paused,
        description: `Inngest function ${slug}`,
      },
    });
    // ★ Invalidate caches so the next request reflects new state immediately:
    //   1. agent-pause-guard 5s cache(used by in-handler short-circuit fallback)
    //   2. paused-slug set cache(used by /api/inngest filter)
    //   3. serve handler cache(rebuild Inngest registration without paused fn)
    invalidateAgentPauseCache(slug);
    invalidatePausedSetCache();
    invalidateHandlerCache();

    // ★ Trigger Inngest dev server to re-introspect AO main so it sees the
    //   reduced function set immediately. Without this, Inngest holds the old
    //   registration until its next scheduled sync(can be minutes).
    try {
      const origin = process.env.INNGEST_SERVE_ORIGIN ?? 'http://localhost:3002';
      await fetch(`${origin}/api/inngest`, { method: 'PUT' });
    } catch {
      // Soft fail — the in-handler guard still works as belt+suspenders.
    }

    return NextResponse.json({ ok: true, slug, paused });
  } catch (err) {
    return NextResponse.json(
      { error: 'toggle-failed', message: (err as Error).message },
      { status: 500 },
    );
  }
}
