# Dynamic Monitor Infrastructure — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill 4 categories of "fake-dynamic" hardcodes on Fleet / Monitor / Events surfaces — replace them with runtime queries of live Inngest registry, live Allmeta-synced event catalog, and live env-var resolution. After this plan, Fleet's "实装 X/Y" reflects reality second-by-second, the Inngest server URL is always visible in the header, and a new event added to Allmeta Ontology appears on `/events` within one sync interval (or instantly via manual refresh).

**Architecture:** Additive. Three new modules (`lib/inngest-registry.ts`, `lib/hooks/useEventCatalog.ts`, `app/api/system/config/route.ts`) + two new UI components (`<InngestPill/>`, `<SystemConfigModal/>`) + one new event-sync trigger endpoint. Old hardcoded structures (`INNGEST_REAL_SHORTS`, `WSID_TO_INNGEST_SLUG`, `REAL_ID_BY_SHORT`, direct `EVENT_CATALOG` imports) deleted once their consumers switch to live sources. No schema changes; no migrations; each phase is its own PR-shaped commit.

**Tech Stack:** Next.js 16 App Router + React 19 · Prisma + SQLite (existing) · Inngest 4 + `lib/inngest-admin-client.ts` GraphQL queries · vitest · TypeScript 5 · Tailwind v4.

**Reference design doc:** [`docs/superpowers/specs/2026-05-24-dynamic-monitor-infrastructure-design.md`](../specs/2026-05-24-dynamic-monitor-infrastructure-design.md) (commit `a7d5859`). Section refs `§N` below point into that spec.

**Working policy** (project memory):
- Work on `main`, no worktree.
- Each commit uses `git commit -m "…" -- <files>` pathspec form.
- Each task ends with one commit. No batching commits.
- UI tasks: start `npm run dev`, click through the route before checking the step complete.
- Skip spec-document-reviewer / plan-document-reviewer subagents.

---

## File Structure

### New files (9)

| Path | Responsibility |
|---|---|
| `lib/inngest-registry.ts` | `fetchLiveRegistry()` + slug helpers — single source of truth for "is this agent registered with Inngest right now and is it real or shell" |
| `lib/inngest-registry.test.ts` | vitest |
| `lib/hooks/useEventCatalog.ts` | React hook — module-cached fetch of `/api/events`, replaces direct `EVENT_CATALOG` imports |
| `app/api/system/config/route.ts` | GET — snapshot of Inngest URL + source env + Allmeta sync state + RAAS config |
| `app/api/system/config/route.test.ts` | vitest |
| `app/api/em/sync/event-definitions/run-now/route.ts` | POST — trigger Neo4j event-definition sync on demand |
| `components/shared/InngestPill.tsx` | Always-visible top-of-page pill (health dot + URL host:port + fn count) |
| `components/shared/SystemConfigModal.tsx` | Detail modal — full URL + source env + fn count + 24h runs + Allmeta sync state + RAAS info |
| `components/events/AllmetaSyncStrip.tsx` | `/events` top strip — `🟢 28 events · 同步于 12 秒前 [手动刷新]` |

### Modified files (13)

| Path | Change |
|---|---|
| `lib/agent-mapping.ts` | Add `inngestId?` to `AgentMeta`; add it to 4 real-agent entries; delete `INNGEST_REAL_SHORTS` set; rewrite `isReal()` / `isShell()` / `deploymentKind()` to delegate to registry |
| `lib/inngest-url.ts` | Add `getInngestUrlWithSource()` returning `{ url, sourceEnv }` |
| `lib/api/inngest-live-overlay.ts` | Replace static `WSID_TO_INNGEST_SLUG` with registry-derived map populated at hook init |
| `app/api/agents/route.ts` | Enrich rows with live registry data; surface live fns not in AGENT_MAP |
| `app/api/agents/route.test.ts` | New assertion: realness count tracks mocked listFunctions output |
| `app/api/inngest-admin/functions/route.ts` | Drop `REAL_ID_BY_SHORT`; derive `MONITORED_FALLBACK` from registry |
| `components/fleet/FleetContent.tsx` | Insert `<InngestPill/>` in header; nothing else changes (liveCount already reads enriched data) |
| `components/fleet/AgentDetailContent.tsx` | `isReal` import removed; use `realness` prop from enriched `/api/agents` row |
| `components/monitor/MonitorContent.tsx` | Replace 4 hardcoded `if (short === "...")` with registry helper |
| `components/monitor/MonitorHeader.tsx` | Insert `<InngestPill/>` |
| `components/events/EventsContent.tsx` | Insert `<AllmetaSyncStrip/>` |
| `components/events/EventLogModal.tsx` | Switch from `EVENT_CATALOG` import to `useEventCatalog()` |
| `lib/events-catalog.ts` | Strengthen `@deprecated INTERNAL FALLBACK ONLY` JSDoc header |
| `lib/i18n.tsx` | Add 13 `config_*` + `allmeta_*` keys (zh + en) |

### Symbols deleted (3)

- `INNGEST_REAL_SHORTS` Set in `lib/agent-mapping.ts`
- `WSID_TO_INNGEST_SLUG` static `Record` in `lib/api/inngest-live-overlay.ts` (kept as hook-internal derived map)
- `REAL_ID_BY_SHORT` Record in `app/api/inngest-admin/functions/route.ts`

---

## Chunk 1 — Live Inngest registry (P0 + P1)

Builds the foundation that replaces 3 hardcoded structures. After this chunk, the "4/24" bug is dead.

### Task 1: Add `inngestId?` to `AgentMeta` + annotate 4 real agents

**Files:**
- Modify: `lib/agent-mapping.ts:14-31` (type), `:34-72` (4 lines in AGENT_MAP)

- [ ] **Step 1: Add `inngestId?` field to the `AgentMeta` type**

Insert after the existing `inngestName?` field:

```typescript
  /** Explicit Inngest function id; overrides convention-based matching
   *  in lib/inngest-registry.ts. Use when an agent's Inngest function id
   *  cannot be derived from `short` via the shell or kebab-case heuristic.
   *  Set ONLY for real agents whose file name differs from `kebab-${short}-agent`. */
  inngestId?: string;
```

- [ ] **Step 2: Annotate the 4 real agents** — find each line in `AGENT_MAP` and add the `inngestId` field:

```typescript
{ short: 'JDGenerator', ..., inngestName: 'Create JD Agent', inngestId: 'create-jd-agent' },
{ short: 'ResumeParser', ..., inngestName: 'Resume Parser Agent', inngestId: 'resume-parser-agent' },
{ short: 'Matcher', ..., inngestName: 'Match Resume Agent', inngestId: 'match-resume-agent' },
{ short: 'RuleCheck', ..., inngestName: 'Rule Check Agent', inngestId: 'rule-check-agent' },
```

- [ ] **Step 3: Confirm test still passes**

Run: `npx vitest run lib/agent-mapping.test.ts`
Expected: PASS (existing test only checks for length, uniqueness, validity — new optional field doesn't break).

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(agent-mapping): add inngestId override for explicit slug binding" -- lib/agent-mapping.ts
```

---

### Task 2: Implement `lib/inngest-registry.ts`

**Files:**
- Create: `lib/inngest-registry.ts`
- Create: `lib/inngest-registry.test.ts`

- [ ] **Step 1: Write the failing test** at `lib/inngest-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock listFunctions before importing the SUT so the cached module sees the mock
const mockListFunctions = vi.fn();
vi.mock('@/lib/inngest-admin-client', () => ({
  listFunctions: () => mockListFunctions(),
}));

describe('fetchLiveRegistry', () => {
  beforeEach(() => {
    mockListFunctions.mockReset();
    vi.resetModules();
  });

  it('derives realness=real for non-agent. fnIds and realness=shell for agent. fnIds', async () => {
    mockListFunctions.mockResolvedValue([
      { id: 'create-jd-agent',       slug: 'agentic-operator-main-create-jd-agent',       name: 'Create JD Agent', triggers: [{ value: 'CLARIFICATION_READY' }] },
      { id: 'agent.reqsync',         slug: 'agentic-operator-main-agent.reqsync',         name: 'ReqSync',         triggers: [{ value: 'SCHEDULED_SYNC' }] },
    ]);
    const { fetchLiveRegistry } = await import('./inngest-registry');
    const entries = await fetchLiveRegistry({ force: true });
    const jd = entries.find(e => e.short === 'JDGenerator');
    expect(jd?.realness).toBe('real');
    expect(jd?.fnId).toBe('create-jd-agent');
    const req = entries.find(e => e.short === 'ReqSync');
    expect(req?.realness).toBe('shell');
  });

  it('marks AGENT_MAP entries with no matching live fn as unbuilt', async () => {
    mockListFunctions.mockResolvedValue([]); // nothing registered
    const { fetchLiveRegistry } = await import('./inngest-registry');
    const entries = await fetchLiveRegistry({ force: true });
    // ALL AGENT_MAP entries become unbuilt when Inngest returns empty
    expect(entries.every(e => e.realness === 'unbuilt')).toBe(true);
  });

  it('surfaces live fns that have no AGENT_MAP entry', async () => {
    mockListFunctions.mockResolvedValue([
      { id: 'mystery-new-agent', slug: 'agentic-operator-main-mystery-new-agent', name: 'Mystery', triggers: [{ value: 'X' }] },
    ]);
    const { fetchLiveRegistry } = await import('./inngest-registry');
    const entries = await fetchLiveRegistry({ force: true });
    const mystery = entries.find(e => e.fnId === 'mystery-new-agent');
    expect(mystery).toBeDefined();
    expect(mystery?.realness).toBe('real');
    expect(mystery?.short).toBe('mystery-new');
  });

  it('caches results for 5s; force=true bypasses cache', async () => {
    mockListFunctions.mockResolvedValue([]);
    const { fetchLiveRegistry } = await import('./inngest-registry');
    await fetchLiveRegistry({ force: true });
    await fetchLiveRegistry(); // hits cache
    await fetchLiveRegistry(); // hits cache
    expect(mockListFunctions).toHaveBeenCalledTimes(1);
    await fetchLiveRegistry({ force: true });
    expect(mockListFunctions).toHaveBeenCalledTimes(2);
  });

  it('returns empty-but-not-throwing when listFunctions throws', async () => {
    mockListFunctions.mockRejectedValue(new Error('inngest unreachable'));
    const { fetchLiveRegistry } = await import('./inngest-registry');
    const entries = await fetchLiveRegistry({ force: true });
    // AGENT_MAP entries still returned, all as unbuilt
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e.realness === 'unbuilt')).toBe(true);
  });

  it('uses inngestId override when present, ignoring conventions', async () => {
    mockListFunctions.mockResolvedValue([
      { id: 'match-resume-agent', slug: 'agentic-operator-main-match-resume-agent', name: 'Match Resume Agent', triggers: [] },
    ]);
    const { fetchLiveRegistry } = await import('./inngest-registry');
    const entries = await fetchLiveRegistry({ force: true });
    const matcher = entries.find(e => e.short === 'Matcher');
    expect(matcher?.fnId).toBe('match-resume-agent');
    expect(matcher?.realness).toBe('real');
  });
});

describe('countByRealness', () => {
  beforeEach(() => { mockListFunctions.mockReset(); vi.resetModules(); });
  it('counts each realness bucket', async () => {
    mockListFunctions.mockResolvedValue([
      { id: 'create-jd-agent',     slug: 'a', name: 'a', triggers: [] },
      { id: 'resume-parser-agent', slug: 'b', name: 'b', triggers: [] },
      { id: 'agent.reqsync',       slug: 'c', name: 'c', triggers: [] },
    ]);
    const { countByRealness } = await import('./inngest-registry');
    const c = await countByRealness();
    expect(c.real).toBe(2);
    expect(c.shell).toBe(1);
    expect(c.total).toBeGreaterThanOrEqual(c.real + c.shell);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run lib/inngest-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/inngest-registry.ts`**:

```typescript
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
```

- [ ] **Step 4: Run test, expect pass**

Run: `npx vitest run lib/inngest-registry.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(inngest-registry): live function registry replacing 3 hardcodes" -- lib/inngest-registry.ts lib/inngest-registry.test.ts
```

---

### Task 3: Enrich `/api/agents` with live registry; remove hardcoded `INNGEST_REAL_SHORTS`

**Files:**
- Modify: `app/api/agents/route.ts:30-66`
- Modify: `app/api/agents/route.test.ts`
- Modify: `lib/agent-mapping.ts:86-95` (delete `INNGEST_REAL_SHORTS` + rewrite `isReal/isShell/deploymentKind`)

⚠️ Many consumers call sync `isReal()`. We can't change them all to async at once. **Approach:** keep `isReal(short)` sync but make it a thin wrapper: return `true` iff `short` is in the most-recently-cached registry entry list. Add a top-of-app warmup: `app/layout.tsx` or `server/init.ts` calls `fetchLiveRegistry()` at boot. Worst case (cache empty) → returns false until first refresh; UI will re-fetch within 5s.

- [ ] **Step 1: Update `app/api/agents/route.test.ts`** — add a test that mocks `listFunctions` and asserts `realness` counts:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockListFunctions = vi.fn();
vi.mock('@/lib/inngest-admin-client', () => ({
  listFunctions: () => mockListFunctions(),
}));

vi.mock('@/server/clients/ws', () => ({
  wsClient: {
    fetchRuns: vi.fn().mockResolvedValue({ runs: [] }),
    fetchActivityFeed: vi.fn().mockResolvedValue({ items: [] }),
  },
}));

describe('GET /api/agents — realness from live registry', () => {
  beforeEach(async () => {
    mockListFunctions.mockReset();
    vi.resetModules();
    const reg = await import('@/lib/inngest-registry');
    reg.__resetRegistryCacheForTests();
  });

  it('returns real count == live real fns count (not hardcoded 4)', async () => {
    mockListFunctions.mockResolvedValue([
      { id: 'create-jd-agent',      slug: 'agentic-operator-main-create-jd-agent',      name: 'Create JD',     triggers: [] },
      { id: 'resume-parser-agent',  slug: 'agentic-operator-main-resume-parser-agent',  name: 'Resume Parser', triggers: [] },
      { id: 'agent.reqsync',        slug: 'agentic-operator-main-agent.reqsync',        name: 'ReqSync',       triggers: [] },
    ]);
    const { GET } = await import('./route');
    const r = await GET(new Request('http://x/api/agents'));
    const j = await r.json();
    const reals = j.agents.filter((a: { realness: string }) => a.realness === 'real');
    // 2 reals (jd + parser), NOT 4
    expect(reals).toHaveLength(2);
  });

  it('surfaces fns not in AGENT_MAP', async () => {
    mockListFunctions.mockResolvedValue([
      { id: 'brand-new-agent', slug: 'agentic-operator-main-brand-new-agent', name: 'New', triggers: [] },
    ]);
    const { GET } = await import('./route');
    const r = await GET(new Request('http://x/api/agents'));
    const j = await r.json();
    expect(j.agents.find((a: { short: string }) => a.short === 'brand-new')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run app/api/agents/route.test.ts`
Expected: FAIL — current route doesn't add `realness` to agent rows (still uses `isReal` static).

- [ ] **Step 3: Modify `app/api/agents/route.ts`** — add registry enrichment:

```typescript
import { NextResponse } from 'next/server';
import { AGENT_MAP } from '@/lib/agent-mapping';
import { displayKey } from '@/server/normalize/agents';
import { wsClient } from '@/server/clients/ws';
import { fetchLiveRegistry } from '@/lib/inngest-registry';
import type { AgentsResponse, AgentRow } from '@/lib/api/types';

export async function GET(_req: Request): Promise<Response> {
  const partial: ('ws' | 'em')[] = [];
  let activityByAgent: Record<string, any[]> = {};

  try {
    await wsClient.fetchRuns({
      limit: 1000,
      status: ['running', 'suspended', 'completed', 'failed'],
    });
  } catch {
    if (!partial.includes('ws')) partial.push('ws');
  }
  try {
    const feed = await wsClient.fetchActivityFeed({ limit: 1000 });
    activityByAgent = groupActivityByAgent(feed.items);
  } catch {
    if (!partial.includes('ws')) partial.push('ws');
  }

  const wsDown = partial.includes('ws');
  const registry = await fetchLiveRegistry();
  const regByShort = new Map(registry.map((r) => [r.short, r]));

  const agents: AgentRow[] = AGENT_MAP.map((a) => {
    const live = regByShort.get(a.short);
    const acts = activityByAgent[a.short] ?? [];
    return {
      short: a.short,
      wsId: a.wsId,
      displayName: displayKey(a.short),
      inngestName: live?.inngestName ?? a.inngestName ?? a.short,
      stage: a.stage,
      kind: a.kind,
      ownerTeam: a.ownerTeam,
      version: a.version,
      status: null,
      p50Ms: wsDown ? null : null,
      runs24h: 0,
      successRate: null,
      costYuan: 0,
      lastActivityAt: wsDown ? null : (acts[0]?.createdAt ?? null),
      spark: Array(16).fill(0),
      realness: live?.realness ?? 'unbuilt',
      slug: live?.slug ?? null,
    };
  });

  // Append live fns that weren't in AGENT_MAP — surface unknown agents.
  for (const r of registry) {
    if (AGENT_MAP.find((a) => a.short === r.short)) continue;
    agents.push({
      short: r.short,
      wsId: r.fnId ?? r.short,
      displayName: r.inngestName ?? r.short,
      inngestName: r.inngestName ?? r.short,
      stage: 'system',
      kind: 'auto',
      ownerTeam: '—',
      version: '—',
      status: null,
      p50Ms: null,
      runs24h: 0,
      successRate: null,
      costYuan: 0,
      lastActivityAt: null,
      spark: Array(16).fill(0),
      realness: r.realness,
      slug: r.slug,
    } as AgentRow);
  }

  const body: AgentsResponse = {
    agents,
    meta: {
      partial: partial.length ? partial : undefined,
      generatedAt: new Date().toISOString(),
    },
  };
  return NextResponse.json(body);
}

function groupActivityByAgent(items: any[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const it of items) {
    const k = (it.agentName as string) ?? 'unknown';
    (out[k] ||= []).push(it);
  }
  return out;
}
```

- [ ] **Step 4: Extend `AgentRow` type in `lib/api/types.ts`** to include `realness` and `slug`:

```typescript
// in AgentRow type definition, add:
  realness: 'real' | 'shell' | 'unbuilt';
  slug: string | null;
```

- [ ] **Step 5: Now rewrite `lib/agent-mapping.ts` realness fns** — delete `INNGEST_REAL_SHORTS` and rewrite the helpers:

Find lines 82-130 (the comment block + INNGEST_REAL_SHORTS + isReal + isShell + deploymentKind) and replace with:

```typescript
// Agent realness derivation has moved to lib/inngest-registry.ts (which
// queries Inngest live). These helpers stay for back-compat — they read
// the LAST cached registry result. First call returns false/unbuilt until
// fetchLiveRegistry() populates the cache; routine UI flow always reads
// /api/agents which forces the cache fill.

import { __getCachedRegistrySnapshotSync } from '@/lib/inngest-registry';

export function isReal(short: string): boolean {
  const snap = __getCachedRegistrySnapshotSync();
  return snap.find((e) => e.short === short)?.realness === 'real';
}

export function isShell(short: string): boolean {
  const snap = __getCachedRegistrySnapshotSync();
  return snap.find((e) => e.short === short)?.realness === 'shell';
}

export type DeploymentKind = 'real' | 'shell' | 'unbuilt';
export function deploymentKind(short: string): DeploymentKind {
  const snap = __getCachedRegistrySnapshotSync();
  return snap.find((e) => e.short === short)?.realness ?? 'unbuilt';
}
```

⚠️ **WARNING — circular import**: `lib/inngest-registry.ts` already imports `AGENT_MAP` from `lib/agent-mapping.ts`. Adding the reverse import here would create a cycle. To avoid this, **don't** import the registry directly. Instead, add a `setSnapshotSync()` writer in the registry that the registry calls on every `fetchLiveRegistry()`, and a `__getCachedRegistrySnapshotSync()` reader in a third tiny file `lib/inngest-registry-cache.ts` (no other imports):

Create `lib/inngest-registry-cache.ts`:

```typescript
// Tiny module — holds the last cached registry snapshot in module-scope
// so sync helpers in lib/agent-mapping.ts can read it without importing
// lib/inngest-registry.ts (which would cycle via AGENT_MAP).

import type { LiveRegistryEntry } from '@/lib/inngest-registry';

let snapshot: LiveRegistryEntry[] = [];

export function __getCachedRegistrySnapshotSync(): LiveRegistryEntry[] {
  return snapshot;
}

export function __setCachedRegistrySnapshot(entries: LiveRegistryEntry[]): void {
  snapshot = entries;
}
```

Update `lib/inngest-registry.ts` — at the end of `fetchLiveRegistry`, before `return entries`, add:

```typescript
import { __setCachedRegistrySnapshot } from './inngest-registry-cache';
// …
  cached = { ts: Date.now(), entries };
  __setCachedRegistrySnapshot(entries);
  return entries;
```

Update `lib/agent-mapping.ts` to import from the cache module instead:

```typescript
import { __getCachedRegistrySnapshotSync } from '@/lib/inngest-registry-cache';
```

- [ ] **Step 6: Add a warmup call in `app/layout.tsx`** so the first `/api/agents` SSR call has the cache populated:

Look at top of `app/layout.tsx` — it's a server component. Add an in-flight no-await call:

```typescript
import { fetchLiveRegistry } from '@/lib/inngest-registry';

// Fire-and-forget warm-up: hits Inngest the first time the layout renders
// so sync isReal()/isShell()/deploymentKind() consumers (Fleet, Monitor)
// already have a cached snapshot when their components mount.
void fetchLiveRegistry().catch(() => {});

export default function RootLayout(...) { ... }
```

- [ ] **Step 7: Hunt remaining `INNGEST_REAL_SHORTS` imports**

Run: `grep -rn "INNGEST_REAL_SHORTS" --include="*.ts" --include="*.tsx" .`

For each hit:
- `components/events/EventsContent.tsx:5` — already does `void INNGEST_REAL_SHORTS` (unused). Remove the import + the void line.

- [ ] **Step 8: Run all related tests**

Run: `npx vitest run lib/inngest-registry.test.ts lib/agent-mapping.test.ts app/api/agents/route.test.ts`
Expected: all PASS.

- [ ] **Step 9: Smoke-test**

Run: `npm run dev`
Then `curl http://localhost:3002/api/agents | jq '.agents | map(.realness) | group_by(.) | map({k:.[0], n:length})'`
Expected: a list grouping by `real`, `shell`, `unbuilt`. The `real` count should reflect actual Inngest function count (4 if all 4 real-agent files registered).

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(agents): realness derived from live Inngest registry" -- lib/inngest-registry.ts lib/inngest-registry-cache.ts lib/agent-mapping.ts app/api/agents/route.ts app/api/agents/route.test.ts lib/api/types.ts app/layout.tsx components/events/EventsContent.tsx
```

---

### Task 4: Drop static `WSID_TO_INNGEST_SLUG`; use registry-derived map

**Files:**
- Modify: `lib/api/inngest-live-overlay.ts`
- Modify: `components/monitor/MonitorContent.tsx:429-432` (4 hardcoded ifs)

- [ ] **Step 1: Read current `useInngestLiveOverlay` hook**

Run: `sed -n '60,120p' lib/api/inngest-live-overlay.ts`

(Confirm where `WSID_TO_INNGEST_SLUG` is read internally vs exported.)

- [ ] **Step 2: Inside `lib/api/inngest-live-overlay.ts`** — replace the top-of-file static map with a function that derives from `fetchLiveRegistry()` results at hook-mount time:

```typescript
'use client';

import { useEffect, useState } from 'react';
import { AGENT_MAP } from '@/lib/agent-mapping';

// Lazily populated at hook mount via /api/agents response (which already
// calls fetchLiveRegistry server-side). Falls back to AGENT_MAP-based
// inferred slugs if /api/agents is unreachable.
export let WSID_TO_INNGEST_SLUG: Record<string, string> = {};
export let INNGEST_SLUG_TO_WSID: Record<string, string> = {};

function rebuildSlugMaps(agents: Array<{ wsId: string; slug: string | null }>): void {
  WSID_TO_INNGEST_SLUG = {};
  INNGEST_SLUG_TO_WSID = {};
  for (const a of agents) {
    if (!a.slug) continue;
    WSID_TO_INNGEST_SLUG[a.wsId] = a.slug;
    INNGEST_SLUG_TO_WSID[a.slug] = a.wsId;
  }
}

// keep existing exports unchanged below this point …
```

Find the place inside `useInngestLiveOverlay` where data is fetched (typically a `useEffect` that polls `/api/inngest-admin/runs` or similar). After the fetch succeeds, call `rebuildSlugMaps(agents)` with the live data. If the hook doesn't already fetch `/api/agents`, add a parallel fetch at mount that calls `/api/agents` once to populate the maps.

- [ ] **Step 3: Replace `MonitorContent.tsx:429-432`**

Find these lines:

```typescript
if (short === "JDGenerator") return WSID_TO_INNGEST_SLUG["4"];
if (short === "ResumeParser") return WSID_TO_INNGEST_SLUG["9-1"];
if (short === "Matcher") return WSID_TO_INNGEST_SLUG["10"];
if (short === "RuleCheck") return WSID_TO_INNGEST_SLUG["10-5"];
```

Replace with a single lookup against the now-dynamic map:

```typescript
// Look up by short via AGENT_MAP → wsId → live slug
const meta = AGENT_MAP.find((a) => a.short === short);
return meta ? WSID_TO_INNGEST_SLUG[meta.wsId] ?? null : null;
```

(`AGENT_MAP` import already present at top of `MonitorContent.tsx`.)

- [ ] **Step 4: Run lint + build to catch import errors**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Smoke-test**

Open `/monitor`, click on a real agent (e.g. JDGenerator) — its detail view should still load Inngest data via the slug.
Open `/fleet` — each row should show its status without runtime errors.

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(monitor): dynamic WSID_TO_INNGEST_SLUG from live registry" -- lib/api/inngest-live-overlay.ts components/monitor/MonitorContent.tsx
```

---

### Task 5: Rewrite `/api/inngest-admin/functions` ghost-fallback from live registry

**Files:**
- Modify: `app/api/inngest-admin/functions/route.ts:18-49` (delete REAL_ID_BY_SHORT and the IIFE that builds MONITORED_FALLBACK)

- [ ] **Step 1: Read the full route handler**

Run: `cat app/api/inngest-admin/functions/route.ts`

- [ ] **Step 2: Replace the IIFE with a live-derived async fallback**

Delete the `REAL_ID_BY_SHORT` const + the `MONITORED_FALLBACK` IIFE. In the GET handler, when paused agents are detected (the original purpose of the fallback), look up the slug via `fetchLiveRegistry()`:

```typescript
import { NextResponse } from 'next/server';
import { listFunctions } from '@/lib/inngest-admin-client';
import { prisma } from '@/server/db';
import { fetchLiveRegistry } from '@/lib/inngest-registry';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [liveFns, pausedConfigs, registry] = await Promise.all([
      listFunctions().catch(() => [] as Array<{ id: string; slug: string; name: string; triggers: Array<{ type: string; value: string }> }>),
      prisma.agentConfig.findMany({ where: { paused: true } }).catch(() => []),
      fetchLiveRegistry(),
    ]);

    // Fall back to registry data for paused agents that disappeared from
    // Inngest registration (because our serve handler drops them when paused).
    const liveBySlug = new Map(liveFns.map((f) => [f.slug, f]));
    const ghostRows = pausedConfigs
      .filter((c) => c.functionSlug && !liveBySlug.has(c.functionSlug))
      .map((c) => {
        const reg = registry.find((r) => r.slug === c.functionSlug);
        return reg
          ? {
              id: reg.fnId ?? c.functionSlug,
              slug: c.functionSlug!,
              name: reg.inngestName ?? c.id,
              triggers: reg.triggers.map((value) => ({ type: 'EVENT', value })),
              paused: true,
            }
          : null;
      })
      .filter(Boolean);

    const all = [
      ...liveFns.map((f) => ({ ...f, paused: false })),
      ...ghostRows,
    ];
    return NextResponse.json({ functions: all });
  } catch (e) {
    return NextResponse.json(
      { error: 'inngest_unreachable', message: (e as Error).message },
      { status: 500 },
    );
  }
}
```

(Adjust to match the exact response shape the existing test expects — `grep -n "expect" app/api/inngest-admin/functions/route.test.ts`.)

- [ ] **Step 3: Run related tests**

Run: `npx vitest run app/api/inngest-admin/functions`
Expected: existing tests pass (or adjust assertions if the shape changed slightly).

- [ ] **Step 4: Smoke-test**

Open `/fleet`. Pause an agent via the row action. Refresh. Verify it still appears as "paused" (ghost-fallback path) rather than disappearing.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(inngest-admin): drop REAL_ID_BY_SHORT; derive paused ghosts from registry" -- app/api/inngest-admin/functions/route.ts
```

---

## Chunk 2 — Inngest server pill + system config modal (P2)

UI visibility for the Inngest server URL. Independent of Chunk 1 — can be developed in parallel.

### Task 6: Add `getInngestUrlWithSource()`

**Files:**
- Modify: `lib/inngest-url.ts`

- [ ] **Step 1: Refactor `getInngestUrl()` to share its precedence with a new fn**:

```typescript
const DEFAULT = "http://localhost:8288";

type Source = 'INNGEST_BASE_URL' | 'INNGEST_DEV' | 'INNGEST_LOCAL_URL' | 'INNGEST_ADMIN_URL' | 'default';

export function getInngestUrlWithSource(): { url: string; sourceEnv: Source } {
  if (process.env.INNGEST_BASE_URL) return { url: process.env.INNGEST_BASE_URL, sourceEnv: 'INNGEST_BASE_URL' };
  if (process.env.INNGEST_DEV)       return { url: process.env.INNGEST_DEV,       sourceEnv: 'INNGEST_DEV' };
  if (process.env.INNGEST_LOCAL_URL) return { url: process.env.INNGEST_LOCAL_URL, sourceEnv: 'INNGEST_LOCAL_URL' };
  if (process.env.INNGEST_ADMIN_URL) return { url: process.env.INNGEST_ADMIN_URL, sourceEnv: 'INNGEST_ADMIN_URL' };
  return { url: DEFAULT, sourceEnv: 'default' };
}

export function getInngestUrl(): string {
  return getInngestUrlWithSource().url;
}

export function getRaasInngestUrl(): string {
  return process.env.RAAS_INNGEST_URL ?? getInngestUrl();
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(inngest-url): add getInngestUrlWithSource for diagnostics UI" -- lib/inngest-url.ts
```

---

### Task 7: `GET /api/system/config`

**Files:**
- Create: `app/api/system/config/route.ts`
- Create: `app/api/system/config/route.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockListFunctions = vi.fn();
vi.mock('@/lib/inngest-admin-client', () => ({
  listFunctions: () => mockListFunctions(),
}));

vi.mock('@/server/db', () => ({
  prisma: {
    emSystemStatus: { findUnique: vi.fn().mockResolvedValue({ neo4jLastSyncAt: new Date('2026-05-25T10:00:00Z'), updatedAt: new Date(), state: 'healthy' }) },
    eventDefinition: { count: vi.fn().mockResolvedValue(28) },
    logEvent: { count: vi.fn().mockResolvedValue(1432) }, // for runs24h fallback
  },
}));

describe('GET /api/system/config', () => {
  beforeEach(() => {
    mockListFunctions.mockReset();
    vi.resetModules();
  });

  it('returns inngest.url + sourceEnv + counts', async () => {
    process.env.INNGEST_BASE_URL = 'http://test-host:8288';
    mockListFunctions.mockResolvedValue([
      { id: 'a', slug: 's-a', name: 'A', triggers: [] },
      { id: 'b', slug: 's-b', name: 'B', triggers: [] },
    ]);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.inngest.url).toBe('http://test-host:8288');
    expect(j.inngest.sourceEnv).toBe('INNGEST_BASE_URL');
    expect(j.inngest.registeredFunctionCount).toBe(2);
  });

  it('returns eventEngine.syncedEventCount + staleness', async () => {
    process.env.INNGEST_BASE_URL = 'http://x:8288';
    mockListFunctions.mockResolvedValue([]);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.eventEngine.syncedEventCount).toBe(28);
    expect(j.eventEngine.staleness).toMatch(/fresh|stale|never/);
  });

  it('returns staleness=never when lastSyncAt is null', async () => {
    process.env.INNGEST_BASE_URL = 'http://x:8288';
    const { prisma } = await import('@/server/db');
    (prisma.emSystemStatus.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    mockListFunctions.mockResolvedValue([]);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.eventEngine.staleness).toBe('never');
    expect(j.eventEngine.lastSyncAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run app/api/system/config/route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `app/api/system/config/route.ts`**:

```typescript
// GET /api/system/config — runtime configuration snapshot.
// Used by <InngestPill /> + <SystemConfigModal /> to show ops which
// Inngest server + Allmeta state + RaaS endpoints are currently wired.
//
// Per spec 2026-05-24 §4.1.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { getInngestUrlWithSource, getRaasInngestUrl } from '@/lib/inngest-url';
import { listFunctions } from '@/lib/inngest-admin-client';

export const dynamic = 'force-dynamic';

export type SystemConfigResponse = {
  inngest: {
    url: string;
    sourceEnv: 'INNGEST_BASE_URL' | 'INNGEST_DEV' | 'INNGEST_LOCAL_URL' | 'INNGEST_ADMIN_URL' | 'default';
    altEnvs: Record<string, string | null>;
    registeredFunctionCount: number;
    runsLast24h: number | null;
    healthy: boolean;
    lastProbeAt: string;
  };
  eventEngine: {
    lastSyncAt: string | null;
    syncedEventCount: number;
    staleSeconds: number | null;
    staleness: 'fresh' | 'stale' | 'never';
    lastError: string | null;
  };
  raas: {
    apiUrl: string | null;
    inngestUrl: string;
    inngestSharedWithLocal: boolean;
    apiHealthy: boolean | null;
  };
  generatedAt: string;
};

const STALENESS_THRESHOLD_MS = 5 * 60 * 1000;

export async function GET(): Promise<Response> {
  const probeStart = new Date();
  const { url: inngestUrl, sourceEnv } = getInngestUrlWithSource();

  const altEnvs: Record<string, string | null> = {
    INNGEST_BASE_URL: process.env.INNGEST_BASE_URL ?? null,
    INNGEST_DEV: process.env.INNGEST_DEV ?? null,
    INNGEST_LOCAL_URL: process.env.INNGEST_LOCAL_URL ?? null,
    INNGEST_ADMIN_URL: process.env.INNGEST_ADMIN_URL ?? null,
  };

  let fnCount = 0;
  let inngestHealthy = false;
  try {
    const fns = await listFunctions();
    fnCount = fns.length;
    inngestHealthy = true;
  } catch {
    inngestHealthy = false;
  }

  // runs24h — best effort from LogEvent (if the 2026-05-22 logging spec
  // is shipped) otherwise null. We don't hit Inngest GraphQL here to keep
  // this endpoint snappy.
  let runs24h: number | null = null;
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    runs24h = await prisma.logEvent.count({
      where: { ts: { gte: since }, category: 'agent_lifecycle' },
    });
  } catch {
    runs24h = null; // table doesn't exist yet or query failed
  }

  const status = await prisma.emSystemStatus.findUnique({ where: { id: 'singleton' } }).catch(() => null);
  const lastSyncAt = status?.neo4jLastSyncAt ?? null;
  const staleSeconds = lastSyncAt ? Math.floor((Date.now() - new Date(lastSyncAt).getTime()) / 1000) : null;
  const staleness: 'fresh' | 'stale' | 'never' = !lastSyncAt
    ? 'never'
    : Date.now() - new Date(lastSyncAt).getTime() < STALENESS_THRESHOLD_MS
      ? 'fresh'
      : 'stale';
  const syncedEventCount = await prisma.eventDefinition
    .count({ where: { source: 'neo4j' } })
    .catch(() => 0);

  const raasInngestUrl = getRaasInngestUrl();
  const body: SystemConfigResponse = {
    inngest: {
      url: inngestUrl,
      sourceEnv,
      altEnvs,
      registeredFunctionCount: fnCount,
      runsLast24h: runs24h,
      healthy: inngestHealthy,
      lastProbeAt: probeStart.toISOString(),
    },
    eventEngine: {
      lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
      syncedEventCount,
      staleSeconds,
      staleness,
      lastError: status?.neo4jLastError ?? null,
    },
    raas: {
      apiUrl: process.env.RAAS_API_BASE_URL ?? null,
      inngestUrl: raasInngestUrl,
      inngestSharedWithLocal: raasInngestUrl === inngestUrl,
      apiHealthy: null,
    },
    generatedAt: new Date().toISOString(),
  };
  return NextResponse.json(body);
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npx vitest run app/api/system/config/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(api): GET /api/system/config — runtime config snapshot" -- app/api/system/config/route.ts app/api/system/config/route.test.ts
```

---

### Task 8: Add i18n keys for config UI

**Files:**
- Modify: `lib/i18n.tsx`

- [ ] **Step 1: Find the existing `zh` block in `lib/i18n.tsx`** (near `nav_audit`). Add **after** the audit keys (or any sensible location in the zh block):

```typescript
    // ── System config pill / modal (spec 2026-05-24) ────────────
    config_inngest_label: "事件引擎",
    config_event_engine_label: "事件目录 (Allmeta Ontology)",
    config_raas_label: "RaaS 合作方",
    config_source_env: "来源环境变量",
    config_alt_envs: "备选环境变量",
    config_last_probe: "最近探测",
    config_last_sync: "上次同步",
    config_fn_count: "已注册函数",
    config_runs_24h: "24h 运行",
    config_manual_refresh: "手动刷新",
    config_url: "URL",
    config_shared_with_local: "复用 AO 引擎",
    allmeta_strip_fresh: "新鲜",
    allmeta_strip_stale: "已过期",
    allmeta_strip_never: "未同步",
```

And in the `en` block:

```typescript
    config_inngest_label: "Event Engine",
    config_event_engine_label: "Event Catalog (Allmeta Ontology)",
    config_raas_label: "RaaS Partner",
    config_source_env: "Source env var",
    config_alt_envs: "Alternate env vars",
    config_last_probe: "Last probe",
    config_last_sync: "Last sync",
    config_fn_count: "Registered fns",
    config_runs_24h: "Runs (24h)",
    config_manual_refresh: "Refresh now",
    config_url: "URL",
    config_shared_with_local: "Shared with AO",
    allmeta_strip_fresh: "fresh",
    allmeta_strip_stale: "stale",
    allmeta_strip_never: "never synced",
```

- [ ] **Step 2: Build to catch missing keys**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git commit -m "i18n: +14 config_* and allmeta_strip_* keys (zh + en)" -- lib/i18n.tsx
```

---

### Task 9: `<InngestPill />` component

**Files:**
- Create: `components/shared/InngestPill.tsx`

- [ ] **Step 1: Write the component**:

```typescript
"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { fetchJson } from "@/lib/api/client";
import type { SystemConfigResponse } from "@/app/api/system/config/route";
import { SystemConfigModal } from "./SystemConfigModal";

const POLL_MS = 5_000;

export function InngestPill() {
  const { t } = useApp();
  const [cfg, setCfg] = React.useState<SystemConfigResponse | null>(null);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const tick = () => {
      fetchJson<SystemConfigResponse>("/api/system/config")
        .then(setCfg)
        .catch(() => {/* keep previous */});
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const host = React.useMemo(() => {
    if (!cfg) return "—";
    try {
      const u = new URL(cfg.inngest.url);
      return u.host;
    } catch {
      return cfg.inngest.url;
    }
  }, [cfg]);

  const dotColor = cfg?.inngest.healthy ? "var(--c-ok)" : "var(--c-err)";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-line bg-surface hover:bg-bg-2 text-[11.5px] text-ink-2"
        title={cfg?.inngest.url ?? ""}
      >
        <span className="rounded-full" style={{ width: 7, height: 7, background: dotColor }} />
        <span className="mono">{host}</span>
        {cfg && (
          <span className="text-ink-3">
            · {cfg.inngest.registeredFunctionCount} fn
          </span>
        )}
      </button>
      {open && cfg && <SystemConfigModal cfg={cfg} onClose={() => setOpen(false)} />}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(shared): InngestPill — always-visible engine health pill" -- components/shared/InngestPill.tsx
```

---

### Task 10: `<SystemConfigModal />` component

**Files:**
- Create: `components/shared/SystemConfigModal.tsx`

- [ ] **Step 1: Write the component**:

```typescript
"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Badge, Btn } from "@/components/shared/atoms";
import type { SystemConfigResponse } from "@/app/api/system/config/route";

export function SystemConfigModal({
  cfg,
  onClose,
}: {
  cfg: SystemConfigResponse;
  onClose: () => void;
}) {
  const { t } = useApp();
  const [refreshing, setRefreshing] = React.useState(false);

  const refreshAllmeta = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/em/sync/event-definitions/run-now", { method: "POST" });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div
        className="fixed top-1/2 left-1/2 z-50 bg-surface border border-line rounded-lg p-6 overflow-auto"
        style={{ transform: "translate(-50%, -50%)", width: 520, maxHeight: "80vh" }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold">{t("nav_audit")} / 系统配置</h2>
          <button onClick={onClose} className="text-ink-3 hover:text-ink-1 text-[18px]">×</button>
        </div>

        {/* Inngest */}
        <Section title={t("config_inngest_label")}>
          <Field label={t("config_url")} value={cfg.inngest.url} mono />
          <Field label={t("config_source_env")} value={cfg.inngest.sourceEnv} mono />
          <Field
            label={t("config_alt_envs")}
            value={
              Object.entries(cfg.inngest.altEnvs)
                .filter(([k, v]) => v != null && k !== cfg.inngest.sourceEnv)
                .map(([k, v]) => `${k}=${v}`)
                .join("  ") || "—"
            }
            mono
          />
          <Field
            label="状态"
            valueNode={
              <Badge variant={cfg.inngest.healthy ? "ok" : "err"}>
                {cfg.inngest.healthy ? "healthy" : "unreachable"}
              </Badge>
            }
          />
          <Field label={t("config_fn_count")} value={String(cfg.inngest.registeredFunctionCount)} />
          <Field label={t("config_runs_24h")} value={cfg.inngest.runsLast24h?.toLocaleString() ?? "—"} />
          <Field label={t("config_last_probe")} value={new Date(cfg.inngest.lastProbeAt).toLocaleString()} />
        </Section>

        {/* Event Engine */}
        <Section title={t("config_event_engine_label")}>
          <Field
            label={t("config_last_sync")}
            value={cfg.eventEngine.lastSyncAt ? new Date(cfg.eventEngine.lastSyncAt).toLocaleString() : "—"}
          />
          <Field
            label="新鲜度"
            valueNode={
              <Badge
                variant={
                  cfg.eventEngine.staleness === "fresh" ? "ok" :
                  cfg.eventEngine.staleness === "stale" ? "warn" : "err"
                }
              >
                {cfg.eventEngine.staleness === "fresh" ? t("allmeta_strip_fresh") :
                 cfg.eventEngine.staleness === "stale" ? t("allmeta_strip_stale") :
                 t("allmeta_strip_never")}
              </Badge>
            }
          />
          <Field label="同步事件数" value={String(cfg.eventEngine.syncedEventCount)} />
          {cfg.eventEngine.lastError && (
            <Field label="最近错误" value={cfg.eventEngine.lastError} mono />
          )}
          <div className="mt-2">
            <Btn size="sm" onClick={refreshAllmeta} disabled={refreshing}>
              {refreshing ? "…" : t("config_manual_refresh")}
            </Btn>
          </div>
        </Section>

        {/* RaaS */}
        <Section title={t("config_raas_label")}>
          <Field label="API URL" value={cfg.raas.apiUrl ?? "—"} mono />
          <Field
            label="Inngest URL"
            value={cfg.raas.inngestSharedWithLocal ? t("config_shared_with_local") : cfg.raas.inngestUrl}
            mono={!cfg.raas.inngestSharedWithLocal}
          />
        </Section>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-[11px] text-ink-3 uppercase tracking-wide mb-2">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}
function Field({
  label,
  value,
  valueNode,
  mono,
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 text-[12px]">
      <span className="text-ink-3 w-[110px] shrink-0">{label}</span>
      {valueNode ?? (
        <span className={`text-ink-1 ${mono ? "mono break-all" : ""}`}>{value}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(shared): SystemConfigModal — detail panel for InngestPill" -- components/shared/SystemConfigModal.tsx
```

---

### Task 11: Insert `<InngestPill />` into Fleet + Monitor headers

**Files:**
- Modify: `components/fleet/FleetContent.tsx:265-279` (header right cluster)
- Modify: `components/monitor/MonitorHeader.tsx`

- [ ] **Step 1: Add import + insert in FleetContent header**

In FleetContent.tsx, find the header right-cluster (line ~265, where `<LiveIndicator />` and the deploy button live). Add:

```typescript
import { InngestPill } from "@/components/shared/InngestPill";

// in the JSX, alongside <LiveIndicator />:
<InngestPill />
<LiveIndicator lastRefresh={lastRefresh} />
```

- [ ] **Step 2: Same for MonitorHeader.tsx**

Run: `grep -n "LiveIndicator\|className=\"flex items-center" components/monitor/MonitorHeader.tsx | head -5`

Insert `<InngestPill />` next to whatever existing right-cluster element exists (usually before `LiveIndicator` or the time-window selector).

- [ ] **Step 3: Smoke-test**

Run: `npm run dev`
Open `/fleet` and `/monitor`. Verify the pill renders in both headers showing `🟢 <host>:8288 · N fn`. Click → modal opens with all sections populated.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(fleet,monitor): InngestPill in headers" -- components/fleet/FleetContent.tsx components/monitor/MonitorHeader.tsx
```

---

## Chunk 3 — Events from Allmeta + manual refresh (P3)

### Task 12: `POST /api/em/sync/event-definitions/run-now`

**Files:**
- Create: `app/api/em/sync/event-definitions/run-now/route.ts`

- [ ] **Step 1: Confirm the sync entry point export**

Run: `grep -n "export async function sync" server/em/sync/event-definition-sync.ts`
Expected: `export async function syncEventDefinitions()` (line ~105).

- [ ] **Step 2: Write the route**:

```typescript
// POST /api/em/sync/event-definitions/run-now
//
// Triggers the EventDefinition sync worker on-demand instead of waiting
// for NEO4J_SYNC_INTERVAL_MS. Used by [手动刷新] button on /events and
// SystemConfigModal.
//
// Per spec 2026-05-24 §5.2.

import { NextResponse } from 'next/server';
import { syncEventDefinitions } from '@/server/em/sync/event-definition-sync';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  try {
    const result = await syncEventDefinitions();
    return NextResponse.json({
      ok: true,
      result,
      finishedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 3: Smoke-test**

```bash
curl -X POST http://localhost:3002/api/em/sync/event-definitions/run-now | jq
```

Expected: `{ "ok": true, "result": { ... }, "finishedAt": "..." }` (or `{ ok: false, error: ... }` if Neo4j unreachable — both acceptable as long as the route returns).

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(api): POST /api/em/sync/event-definitions/run-now" -- app/api/em/sync/event-definitions/run-now/route.ts
```

---

### Task 13: `useEventCatalog()` hook

**Files:**
- Create: `lib/hooks/useEventCatalog.ts`

- [ ] **Step 1: Write the hook**:

```typescript
// React hook — fetches /api/events once and caches in module scope.
// All UI components that need event catalog data go through this hook
// instead of importing lib/events-catalog.ts directly.
//
// Per spec 2026-05-24 §5.1.

"use client";
import { useEffect, useState } from "react";
import type { EventsResponse, EventContract } from "@/lib/api/types";

const CACHE_TTL_MS = 30_000;
let cached: { ts: number; data: EventsResponse } | null = null;
const subscribers = new Set<(d: EventsResponse | null) => void>();

export type UseEventCatalogResult = {
  events: EventContract[];
  loading: boolean;
  lastSyncAt: string | null;
  staleness: "fresh" | "stale" | "never";
  refresh: () => Promise<void>;
};

function deriveStaleness(iso: string | null | undefined): "fresh" | "stale" | "never" {
  if (!iso) return "never";
  const age = Date.now() - new Date(iso).getTime();
  if (age < 5 * 60 * 1000) return "fresh";
  return "stale";
}

async function doFetch(): Promise<void> {
  try {
    const r = await fetch("/api/events");
    const d = (await r.json()) as EventsResponse;
    cached = { ts: Date.now(), data: d };
    subscribers.forEach((fn) => fn(d));
  } catch {
    // keep prior cached data
  }
}

export function useEventCatalog(): UseEventCatalogResult {
  const [data, setData] = useState<EventsResponse | null>(
    cached && Date.now() - cached.ts < CACHE_TTL_MS ? cached.data : null
  );

  useEffect(() => {
    subscribers.add(setData);
    if (!cached || Date.now() - cached.ts >= CACHE_TTL_MS) {
      void doFetch();
    }
    return () => {
      subscribers.delete(setData);
    };
  }, []);

  return {
    events: data?.events ?? [],
    loading: !data,
    lastSyncAt: data?.meta.lastNeo4jSyncAt ?? null,
    staleness: deriveStaleness(data?.meta.lastNeo4jSyncAt),
    refresh: doFetch,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(hooks): useEventCatalog — module-cached /api/events fetch" -- lib/hooks/useEventCatalog.ts
```

---

### Task 14: Switch `EventLogModal` from `EVENT_CATALOG` to `useEventCatalog`

**Files:**
- Modify: `components/events/EventLogModal.tsx:12, :76`

- [ ] **Step 1: Replace import and the hardcoded lookup**

Find line 12:
```typescript
import { EVENT_CATALOG, kindDot } from "@/lib/events-catalog";
```
Change to:
```typescript
import { kindDot } from "@/lib/events-catalog"; // helpers only — catalog is now live
import { useEventCatalog } from "@/lib/hooks/useEventCatalog";
```

Find line 76 (inside the component):
```typescript
const def = EVENT_CATALOG.find((e) => e.name === event.name);
```
Change to:
```typescript
const { events } = useEventCatalog();
const def = events.find((e) => e.name === event.name);
```

If `def` is undefined, add a fallback render (find the existing `def ?` ternary and adjust):

```typescript
{def ? (
  // existing render
) : (
  <div className="text-ink-3 text-[12px] p-3">
    该事件未在 Allmeta Ontology 中找到 (可能为运行时动态事件或已下架)
  </div>
)}
```

- [ ] **Step 2: Smoke-test**

Open `/events`, click any event row → modal opens, content renders (either definition or the "未找到" fallback).

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(events): EventLogModal reads live catalog via hook" -- components/events/EventLogModal.tsx
```

---

### Task 15: `<AllmetaSyncStrip />` on `/events`

**Files:**
- Create: `components/events/AllmetaSyncStrip.tsx`
- Modify: `components/events/EventsContent.tsx` (insert strip at top of content area)

- [ ] **Step 1: Write the strip**:

```typescript
"use client";
import React from "react";
import { Badge, Btn } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";
import { useEventCatalog } from "@/lib/hooks/useEventCatalog";

export function AllmetaSyncStrip() {
  const { t } = useApp();
  const { events, lastSyncAt, staleness, refresh } = useEventCatalog();
  const [refreshing, setRefreshing] = React.useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/em/sync/event-definitions/run-now", { method: "POST" });
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const ago = lastSyncAt
    ? formatAgo(new Date(lastSyncAt).getTime())
    : "—";

  const variant: "ok" | "warn" | "err" =
    staleness === "fresh" ? "ok" : staleness === "stale" ? "warn" : "err";
  const label =
    staleness === "fresh" ? t("allmeta_strip_fresh") :
    staleness === "stale" ? t("allmeta_strip_stale") : t("allmeta_strip_never");

  return (
    <div className="border-b border-line bg-surface flex items-center gap-3" style={{ padding: "10px 22px" }}>
      <Badge variant={variant}>{label}</Badge>
      <span className="text-[12px] text-ink-2">
        {t("config_event_engine_label")} · {events.length} events
      </span>
      <span className="text-[11.5px] text-ink-3 mono">
        {t("config_last_sync")}: {ago}
      </span>
      <div className="flex-1" />
      <Btn size="sm" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? "…" : t("config_manual_refresh")}
      </Btn>
    </div>
  );
}

function formatAgo(ms: number): string {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return `${diff}s 前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`;
  return `${Math.floor(diff / 86400)}d 前`;
}
```

- [ ] **Step 2: Insert strip into `EventsContent.tsx`** — at the top of the main content area (just inside the root `<div>`):

```typescript
import { AllmetaSyncStrip } from "./AllmetaSyncStrip";

// In the JSX, as the first child of the main return:
<AllmetaSyncStrip />
```

- [ ] **Step 3: Strengthen `EVENT_CATALOG` deprecated JSDoc** in `lib/events-catalog.ts`:

Update the existing `@deprecated` comment at the top:

```typescript
/**
 * @deprecated INTERNAL FALLBACK ONLY.
 * Do NOT import this outside `app/api/events/route.ts` cold-start path.
 * UI components must use `useEventCatalog()` hook or fetch `/api/events`.
 *
 * Why this still exists: when the Neo4j sync worker has never succeeded
 * since cold boot (typically off-VPN dev), `/api/events` serves these so
 * the UI doesn't blank out. The sync worker overwrites the response on
 * its first success.
 */
```

- [ ] **Step 4: Smoke-test**

Open `/events`. Verify strip shows at top: `🟢 fresh · 事件目录 (Allmeta Ontology) · N events · 上次同步: Xs 前  [手动刷新]`. Click refresh — staleness pill briefly reloads, count updates if backend changed.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(events): AllmetaSyncStrip + manual refresh on /events" -- components/events/AllmetaSyncStrip.tsx components/events/EventsContent.tsx lib/events-catalog.ts
```

---

### Task 16: DoD verification + final pass

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all PASS. Fix any regression before continuing.

- [ ] **Step 2: Run production build**

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 3: Manual DoD walkthrough** (spec §9)

Run `npm run dev`. Then for each acceptance criterion:

1. **真"4/24"**: Kill the inngest-cli process (`pkill inngest-cli`). Open `/fleet`. Wait 6s. SummaryChip 应显示 "实装 0 / 24"。重启 inngest-cli (`npm run inngest:dev &`)。5 秒内 Fleet 显示恢复真实数。
2. **新 agent 自动出现**: 在 `server/inngest/agents/` 加一个最小 `*-agent.ts` (一个 fn 监听一个事件), `inngest:dev` 自动 reload。**不**编辑 AGENT_MAP。打开 `/fleet`,新函数 5 秒内出现 (stage='system',ownerTeam='—')。
3. **Inngest URL 显示**: 验证 Fleet/Monitor 顶部 pill 显示当前 URL host:port。修改 `INNGEST_BASE_URL` 重启 dev server,显示更新。
4. **Inngest URL 详情**: 点 pill 打开 modal,看到来源 env var 名 + 备选 env vars + 健康 + 注册函数数 + 24h 运行数。
5. **Allmeta 事件实时**: 在 Allmeta Ontology 加一个新 EventDefinition。**不**改 `EVENT_CATALOG`。在 `/events` 页点 [手动刷新],5 秒内出现该事件。
6. **EventLogModal 不再硬编码**: 在某个 agent 里手动 emit 一个不在 Allmeta 的事件名,`/events/<event>/instances/<id>` 打开模态框时显示"该事件未在 Allmeta Ontology 中找到"而不是空白。
7. **零回归**: 老 `/live`、`/workflow`、`/triggers`、`/correlations` 全部正常打开,无 runtime error。

- [ ] **Step 4: Commit (only if any final cleanup needed)**

```bash
git commit -m "chore: post-implementation cleanup for dynamic monitor infra" -- <files-changed>
```

---

## Out of scope (separate plan if needed)

- Auto-importing brand-new Inngest functions into `AGENT_MAP` source file
- Allmeta UI write-back from AO
- RBAC scoping the SystemConfigModal (currently visible to all)
- Per-agent prometheus-style metric scrape endpoint
- Inngest dev server side cooperative pause (currently AO enforces pause at handler entry)

---

## Quick-reference: file paths cheat sheet

| Purpose | Path |
|---|---|
| Spec | `docs/superpowers/specs/2026-05-24-dynamic-monitor-infrastructure-design.md` |
| Live registry | `lib/inngest-registry.ts` |
| Registry cache (cycle-break) | `lib/inngest-registry-cache.ts` |
| URL resolver w/ source | `lib/inngest-url.ts` |
| System config API | `app/api/system/config/route.ts` |
| Manual Allmeta sync | `app/api/em/sync/event-definitions/run-now/route.ts` |
| Top-bar pill | `components/shared/InngestPill.tsx` |
| Detail modal | `components/shared/SystemConfigModal.tsx` |
| Allmeta strip | `components/events/AllmetaSyncStrip.tsx` |
| Catalog hook | `lib/hooks/useEventCatalog.ts` |
