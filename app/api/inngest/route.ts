// Inngest serve adapter for Next.js App Router.
//
// ★ v0_1_010 update: pause-aware dynamic registration.
//   When an agent is paused (AgentConfig.enabled=false), it's filtered out of
//   the registered function set BEFORE Inngest sees it. This means:
//     - Inngest doesn't dispatch events to paused functions(no run records)
//     - "Real pause" — events for the paused function queue at the Inngest side
//     - On resume, queued events flow through normally
//
// This is paired with the in-handler `assertNotPaused()` guard (belt + suspenders):
// even if Inngest somehow dispatched a stale event during a pause toggle race,
// the handler still short-circuits.

import { serve } from 'inngest/next';
import type { NextRequest } from 'next/server';
import { inngest } from '@/server/inngest/client';
import { allFunctions } from '@/server/inngest/functions';
import { getPausedSlugs } from '@/lib/agent-pause-guard';
import { bootOnce } from '@/server/init';

bootOnce();

// Cache one serve handler per unique paused-set. The set changes rarely (only
// on toggle), so this Map stays small in practice.
type ServeHandler = ReturnType<typeof serve>;
const handlerCache = new Map<string, ServeHandler>();

function getFunctionSlug(fn: unknown): string {
  // Inngest InngestFunction has `opts.id` (the createFunction id, e.g. "resume-parser-agent").
  // The full slug used by Inngest dev server is `<appId>-<fnId>`.
  const appId = inngest.id; // "agentic-operator-main"
  const f = fn as { opts?: { id?: string }; id?: ((prefix?: string) => string) };
  const fnId = f.opts?.id ?? (typeof f.id === 'function' ? f.id() : '');
  return fnId ? `${appId}-${fnId}` : '';
}

async function pickHandler(): Promise<ServeHandler> {
  const paused = await getPausedSlugs();
  const key = Array.from(paused).sort().join(',') || '<none>';
  let h = handlerCache.get(key);
  if (!h) {
    const live = allFunctions.filter((f) => {
      const slug = getFunctionSlug(f);
      return slug ? !paused.has(slug) : true;
    });
    if (paused.size > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[inngest] serve handler rebuilt · ${live.length}/${allFunctions.length} live · paused=[${Array.from(paused).join(',')}]`,
      );
    }
    h = serve({ client: inngest, functions: live });
    handlerCache.set(key, h);
  }
  return h;
}

/** Invalidate the serve-handler cache — called by the toggle route so the next
 *  /api/inngest request rebuilds with the new paused set immediately. */
export function invalidateHandlerCache(): void {
  handlerCache.clear();
}

type RouteContext = { params: Promise<Record<string, string | string[]>> };

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const h = await pickHandler();
  return h.GET(req, ctx);
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const h = await pickHandler();
  return h.POST(req, ctx);
}

export async function PUT(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const h = await pickHandler();
  return h.PUT(req, ctx);
}
