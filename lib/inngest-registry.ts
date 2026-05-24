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
import { __setCachedRegistrySnapshot } from './inngest-registry-cache';

export type Realness = 'real' | 'shell' | 'unbuilt';

export type LiveRegistryEntry = {
  short: string;
  fnId: string | null;
  slug: string | null;
  realness: Realness;
  triggers: string[];
  inngestName: string | null;
};

const CACHE_TTL_MS = 5_000;
let cached: { ts: number; entries: LiveRegistryEntry[] } | null = null;

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

  const liveByFnId = new Map(liveFns.map((f) => [f.id, f]));

  const entries: LiveRegistryEntry[] = AGENT_MAP.map((a) => {
    const candidates = candidateFnIds(a);
    const hit = candidates.map((id) => liveByFnId.get(id)).find(Boolean);
    if (!hit) {
      return {
        short: a.short,
        fnId: null,
        slug: null,
        realness: 'unbuilt' as const,
        triggers: [],
        inngestName: null,
      };
    }
    return {
      short: a.short,
      fnId: hit.id,
      slug: hit.slug,
      realness: hit.id.startsWith('agent.') ? ('shell' as const) : ('real' as const),
      triggers: hit.triggers.map((t) => t.value),
      inngestName: hit.name,
    };
  });

  // Surface live fns not in AGENT_MAP so a brand-new Inngest function
  // shows up in /fleet without requiring AGENT_MAP to be edited first.
  const knownFnIds = new Set(entries.map((e) => e.fnId).filter(Boolean));
  for (const fn of liveFns) {
    if (knownFnIds.has(fn.id)) continue;
    const short = fn.id.replace(/^agent\./, '').replace(/-agent$/, '');
    entries.push({
      short,
      fnId: fn.id,
      slug: fn.slug,
      realness: fn.id.startsWith('agent.') ? 'shell' : 'real',
      triggers: fn.triggers.map((t) => t.value),
      inngestName: fn.name,
    });
  }

  cached = { ts: Date.now(), entries };
  __setCachedRegistrySnapshot(entries);
  return entries;
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
