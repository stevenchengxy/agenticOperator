// Shared pause guard for the 3 PRA agents.
//
// Inngest dev server has no native pause API, so we enforce pause at the AO
// SDK side: each agent calls `assertNotPaused(slug)` at the very top of its
// handler. If the agent's AgentConfig.enabled is `false` in our SQLite DB,
// the agent short-circuits with a no-op (logs and returns).
//
// Read path:
//   POST /api/inngest-admin/functions/{slug}/toggle  body { paused: true }
//   → upserts AgentConfig { agent_key: slug, enabled: false }
//   Next time the trigger event fires → agent runs but assertNotPaused throws
//   PausedError → we catch + log + return early in the agent handler.

import { prisma } from '@/server/db';

export class PausedError extends Error {
  constructor(public readonly slug: string) {
    super(`agent "${slug}" is paused — short-circuiting handler`);
    this.name = 'PausedError';
  }
}

const cache = new Map<string, { paused: boolean; loadedAt: number }>();
const TTL_MS = 5_000;

export async function isAgentPaused(slug: string): Promise<boolean> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.loadedAt < TTL_MS) {
    return hit.paused;
  }
  try {
    const cfg = await prisma.agentConfig.findUnique({
      where: { id: slug },
      select: { enabled: true },
    });
    const paused = cfg ? cfg.enabled === false : false;
    cache.set(slug, { paused, loadedAt: Date.now() });
    return paused;
  } catch (e) {
    // DB transiently unavailable (SQLite locked mid-write, etc.) — preserve
    // the last-known pause state instead of silently treating the agent as
    // active. The previous fail-open behavior caused paused agents to
    // briefly reappear as "deployed" every time the 5s cache expired and
    // a read happened to race a writer. If we've never read this slug,
    // fall through to NOT paused (don't block on first-ever query).
    console.warn(
      `[agent-pause-guard] isAgentPaused(${slug}) DB error; preserving last-known value: ${(e as Error).message}`,
    );
    return hit?.paused ?? false;
  }
}

export async function assertNotPaused(slug: string): Promise<void> {
  if (await isAgentPaused(slug)) {
    throw new PausedError(slug);
  }
}

/** Invalidate the pause cache for a specific slug — call from /toggle route so
 *  a resume takes effect immediately(otherwise next request short-circuits
 *  until the 5s TTL expires). */
export function invalidateAgentPauseCache(slug: string): void {
  cache.delete(slug);
  pausedSetCache = null;
}

// ─────────────────────────────────────────────────────────────
// Bulk: paused-slug set used by /api/inngest/route.ts to
// dynamically drop paused functions from the registered set.
// (When dropped, Inngest doesn't dispatch events to them at all —
//  this is "real pause" instead of the per-handler short-circuit.)
// ─────────────────────────────────────────────────────────────

let pausedSetCache: { set: Set<string>; loadedAt: number } | null = null;
const SET_TTL_MS = 3_000;

export async function getPausedSlugs(): Promise<Set<string>> {
  if (pausedSetCache && Date.now() - pausedSetCache.loadedAt < SET_TTL_MS) {
    return pausedSetCache.set;
  }
  try {
    const rows = await prisma.agentConfig.findMany({
      where: { enabled: false },
      select: { id: true },
    });
    const set = new Set(rows.map((r) => r.id));
    pausedSetCache = { set, loadedAt: Date.now() };
    return set;
  } catch (e) {
    // DB read failed — preserve the last-known paused set instead of
    // returning empty. Returning empty caused two visible bugs:
    //   1. Inngest serve handler rebuilt with all functions live → paused
    //      agent silently re-registered and got events again.
    //   2. /api/inngest-admin/functions reported paused agents as deployed
    //      → fleet UI flickered them back to "online" every cache cycle.
    // Falling back to last-known is strictly safer than fail-open.
    console.warn(
      `[agent-pause-guard] getPausedSlugs DB error; preserving last-known set: ${(e as Error).message}`,
    );
    return pausedSetCache?.set ?? new Set();
  }
}

/** Force re-load of the paused-set cache on next call. */
export function invalidatePausedSetCache(): void {
  pausedSetCache = null;
}
