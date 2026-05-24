// Live Inngest function registry — single source of truth for
// "which agents actually have an Inngest function registered, and
//  is it a real handler or a stub-factory shell?"
//
// Replaces three hardcoded structures (deleted in later tasks):
//   - lib/agent-mapping.ts INNGEST_REAL_SHORTS
//   - lib/api/inngest-live-overlay.ts WSID_TO_INNGEST_SLUG
//   - app/api/inngest-admin/functions/route.ts REAL_ID_BY_SHORT
//
// Convention (single rule, no exception lists):
//   realness = 'real'    ⟺ fnId does NOT start with 'agent.'
//                           (i.e. explicit createFunction call from
//                            server/inngest/agents/*-agent.ts)
//   realness = 'shell'   ⟺ fnId starts with 'agent.'
//                           (stub-factory product, see stub-factory.ts:65)
//   realness = 'unbuilt' ⟺ AGENT_MAP entry has no matching Inngest fn
//
// Per spec 2026-05-24 §3.

import { listFunctions } from '@/lib/inngest-admin-client';
import { AGENT_MAP, type AgentMeta } from '@/lib/agent-mapping';
import { prisma } from '@/server/db';
import { __setCachedRegistrySnapshot } from './inngest-registry-cache';

export type Realness = 'real' | 'shell' | 'unbuilt';

export type LiveRegistryEntry = {
  short: string;
  fnId: string | null;
  slug: string | null;
  realness: Realness;
  /** True iff the agent is registered (real or shell) but currently paused
   *  (AgentConfig.enabled=false → serve handler drops it from Inngest).
   *  When paused, `realness` is set to 'shell' / 'real' as if it were live,
   *  and Fleet's PauseToggleButton can show the resume affordance. */
  paused: boolean;
  triggers: string[];
  inngestName: string | null;
};

const CACHE_TTL_MS = 5_000;
let cached: { ts: number; entries: LiveRegistryEntry[] } | null = null;

// Inngest app id — slugs come back as `<INNGEST_APP_PREFIX><fnId>`.
// Declared at module top so both the slug→fnId helper AND the paused-slug
// builder can reference it without TDZ.
const INNGEST_APP_PREFIX = 'agentic-operator-main-';

export async function fetchLiveRegistry(opts?: { force?: boolean }): Promise<LiveRegistryEntry[]> {
  if (!opts?.force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.entries;
  }

  let liveFns: Array<{ id: string; slug: string; name: string; triggers: Array<{ value: string }> }> = [];
  try {
    liveFns = (await listFunctions()) as typeof liveFns;
  } catch {
    // Inngest unreachable → empty live; AGENT_MAP entries become unbuilt.
    // We deliberately don't throw — callers want partial data over no UI.
  }

  // Paused agents: AgentConfig.enabled=false → our serve handler drops them
  // from Inngest registration so they never appear in listFunctions(). Without
  // this query, the UI would render them as "未上线" with no resume affordance.
  // We use the slug as key (AgentConfig.id == slug per agent-pause-guard.ts).
  let pausedSlugs = new Set<string>();
  try {
    const paused = await prisma.agentConfig.findMany({
      where: { enabled: false },
      select: { id: true },
    });
    pausedSlugs = new Set(paused.map((p) => p.id));
  } catch {
    // DB unreachable — treat as no pauses (live state is then the truth).
  }

  // Inngest GraphQL returns `id` as an opaque UUID (e.g. "4f6676…") — the
  // function id we care about is encoded in the slug as
  // `<INNGEST_APP_PREFIX>-<fnId>`. Extract it so candidate matching (see
  // candidateFnIds below) can join against AGENT_MAP.inngestId or the
  // stub-factory `agent.<short>` convention.
  const liveByFnId = new Map(liveFns.map((f) => [slugToFnId(f.slug), f]));

  const entries: LiveRegistryEntry[] = AGENT_MAP.map((a) => {
    const candidates = candidateFnIds(a);
    const hit = candidates.map((id) => liveByFnId.get(id)).find(Boolean);
    if (hit) {
      const fnId = slugToFnId(hit.slug);
      return {
        short: a.short,
        fnId,
        slug: hit.slug,
        realness: fnId.startsWith('agent.') ? ('shell' as const) : ('real' as const),
        paused: false,
        triggers: hit.triggers.map((t) => t.value),
        inngestName: hit.name,
      };
    }
    // Not live — check whether this agent is paused (registered then disabled).
    // Slug computation mirrors the stub-factory / explicit inngestId conventions
    // used by app/api/inngest-admin/functions/route.ts::buildMonitoredFallback.
    if ((a.triggersEvents ?? []).length > 0) {
      const candidateSlugs = candidates.map((id) => `${INNGEST_APP_PREFIX}${id}`);
      const pausedSlug = candidateSlugs.find((s) => pausedSlugs.has(s));
      if (pausedSlug) {
        const fnId = slugToFnId(pausedSlug);
        return {
          short: a.short,
          fnId,
          slug: pausedSlug,
          realness: fnId.startsWith('agent.') ? ('shell' as const) : ('real' as const),
          paused: true,
          triggers: a.triggersEvents,
          inngestName: a.inngestName ?? a.short,
        };
      }
    }
    return {
      short: a.short,
      fnId: null,
      slug: null,
      realness: 'unbuilt' as const,
      paused: false,
      triggers: [],
      inngestName: null,
    };
  });

  // Surface live fns not in AGENT_MAP so a brand-new Inngest function
  // shows up in /fleet without requiring AGENT_MAP to be edited first.
  const knownFnIds = new Set(entries.map((e) => e.fnId).filter(Boolean));
  for (const fn of liveFns) {
    const fnId = slugToFnId(fn.slug);
    if (knownFnIds.has(fnId)) continue;
    const short = fnId.replace(/^agent\./, '').replace(/-agent$/, '');
    entries.push({
      short,
      fnId,
      slug: fn.slug,
      realness: fnId.startsWith('agent.') ? 'shell' : 'real',
      paused: false,
      triggers: fn.triggers.map((t) => t.value),
      inngestName: fn.name,
    });
  }

  cached = { ts: Date.now(), entries };
  __setCachedRegistrySnapshot(entries);
  return entries;
}

// Inngest slugs come back as `<INNGEST_APP_PREFIX><fnId>`. The prefix is
// `agentic-operator-main-` for the default app id (see server/inngest/client.ts).
// Strip it so consumers join against `fnId` (matches AGENT_MAP.inngestId
// and the stub-factory `agent.<short>` convention).
//
// Edge cases:
//   - Paused ghost rows from /api/inngest-admin/functions have `id: "paused:<slug>"`;
//     since we key by slug here, ghost rows are also handled correctly.
//   - If a function's slug doesn't carry the prefix (test fixture / future
//     app rename), return the slug as-is — caller's candidate-id list will
//     simply miss and the entry surfaces as "not in AGENT_MAP".
function slugToFnId(slug: string): string {
  return slug.startsWith(INNGEST_APP_PREFIX) ? slug.slice(INNGEST_APP_PREFIX.length) : slug;
}

function candidateFnIds(a: AgentMeta): string[] {
  const out: string[] = [];
  if (a.inngestId) out.push(a.inngestId);
  // stub-factory convention
  out.push(`agent.${a.short.toLowerCase()}`);
  // common real-agent file → kebab id
  const kebab = a.short.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
  out.push(`${kebab}-agent`);
  return out;
}

export async function inngestSlugFromShort(short: string): Promise<string | null> {
  const entries = await fetchLiveRegistry();
  return entries.find((e) => e.short === short)?.slug ?? null;
}

export async function findBySlugOrShort(key: string): Promise<LiveRegistryEntry | undefined> {
  const entries = await fetchLiveRegistry();
  return entries.find((e) => e.slug === key || e.short === key);
}

export async function countByRealness(): Promise<{
  real: number;
  shell: number;
  unbuilt: number;
  total: number;
}> {
  const entries = await fetchLiveRegistry();
  return {
    real: entries.filter((e) => e.realness === 'real').length,
    shell: entries.filter((e) => e.realness === 'shell').length,
    unbuilt: entries.filter((e) => e.realness === 'unbuilt').length,
    total: entries.length,
  };
}

// Test-only — cache reset between vitest runs.
export function __resetRegistryCacheForTests(): void {
  cached = null;
}
