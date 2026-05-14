# matchResume neo4j-aware rule check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `lib/rule-check/runRuleCheck()` so the LLM can read neo4j instance data via HTTP (`/api/v1/ontology/instances` + `/links`) when evaluating `matchResume` rules, enforce action_step (Set) order in the prompt, return a compact `{ decision, stats, explanations, audit }` result, and route LLM calls through the shared `server/llm/gateway.ts`.

**Architecture:** Build the new components (HTTP client → graph-context cache → tool-capable chatComplete → step-grouped rules → new types → new prompt composer) **alongside** the existing pipeline first, so each commit compiles and tests pass. Cut runner + match-resume-agent + event payloads over to the new shape in one atomic task at the end, then delete the dead code in a final cleanup task.

**Tech Stack:** TypeScript 5, vitest 4 (happy-dom env, `globals: true`), Node ≥22 `fetch` + `node:fs/promises`, OpenAI Chat Completions tool-calling API, Next.js 16 app.

**Source spec:** `docs/superpowers/specs/2026-05-12-match-resume-neo4j-rule-check-design.md`

**Branch:** `create-action-prompt` (already created from `steven`).

---

## File map

| Path | Status | Purpose |
|---|---|---|
| `lib/rule-check/instance-client.ts` | NEW (Task 1) | Typed HTTP client for `/instances/...` + `/links` |
| `lib/rule-check/graph-context.ts` | NEW (Task 2) | Pre-fetch bundle + per-invocation cache + tool dispatcher |
| `server/llm/gateway.ts` | MODIFIED (Task 3) | Add optional `tools` parameter + tool-call loop |
| `lib/rule-check/types.ts` | MODIFIED (Task 4) | Add `MatchResumeCheckResult` / `RuleStatus` / `RuleExplanation` / step-group types alongside old `RuleCheckVerdict` (removed in Task 9) |
| `lib/rule-check/ontology-source.ts` | MODIFIED (Task 5) | Add `steps[]` to `FetchRulesResult` (each carries order/name/condition/description + rules) |
| `lib/rule-check/prompt.ts` | MODIFIED (Task 6) | Add new `composeMatchResumePrompt` + `MATCH_RESUME_SYSTEM_PROMPT` alongside old (removed in Task 9) |
| `lib/rule-check/runner.ts` | MODIFIED (Task 7) | Cut runRuleCheck to new pipeline + new return shape |
| `server/inngest/agents/match-resume-agent.ts` | MODIFIED (Task 7) | Consume `MatchResumeCheckResult`; drop `resume_augmentation` use |
| `server/inngest/client.ts` | MODIFIED (Task 7) | Update `RuleCheckAuditMeta` / `RuleCheckFailedData` event payload types |
| `lib/rule-check/llm.ts` | DELETED (Task 9) | Replaced by `chatComplete` |
| `.env.example` | MODIFIED (Task 1) | Document `ONTOLOGY_API_BASE` + `ONTOLOGY_API_TOKEN` |
| Various tests | NEW / EXTENDED | Co-located `*.test.ts` per file |

---

## Task 1: instance-client.ts + env wiring

**Files:**
- Create: `lib/rule-check/instance-client.ts`
- Create: `lib/rule-check/instance-client.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add the env vars to `.env.example`**

Append the following to `.env.example` (create the file if it doesn't exist, but it should — search the repo root first):

```
# Ontology API (used by lib/rule-check/ for matchResume rule evaluation).
# Same endpoint that lib/ontology-gen/fetchAction hits.
ONTOLOGY_API_BASE=http://localhost:3500
ONTOLOGY_API_TOKEN=abc12345def
```

- [ ] **Step 2: Write failing tests**

Create `lib/rule-check/instance-client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInstance, listInstances, listLinks } from './instance-client';

describe('instance-client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.ONTOLOGY_API_BASE = 'http://localhost:3500';
    process.env.ONTOLOGY_API_TOKEN = 'test-token';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getInstance', () => {
    it('GETs /instances/{label}/{value}?domain=RAAS-v1 with Bearer auth', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ candidate_id: 'C-100023', name: '张三' }),
      });
      const out = await getInstance('Candidate', 'C-100023');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3500/api/v1/ontology/instances/Candidate/C-100023?domain=RAAS-v1',
        { headers: { Authorization: 'Bearer test-token' } },
      );
      expect(out).toEqual({ candidate_id: 'C-100023', name: '张三' });
    });

    it('returns null on 404', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not-found' });
      expect(await getInstance('Candidate', 'missing')).toBeNull();
    });

    it('throws on 401', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' });
      await expect(getInstance('Candidate', 'x')).rejects.toThrow(/401/);
    });

    it('throws on 502', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'neo4j-unavailable' });
      await expect(getInstance('Candidate', 'x')).rejects.toThrow(/502/);
    });
  });

  describe('listInstances', () => {
    it('GETs /instances/{label}?domain=RAAS-v1&<filters> and returns items array', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 'A-1' }, { id: 'A-2' }],
          nextCursor: null,
        }),
      });
      const out = await listInstances('Application', { candidate_id: 'C-100023' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3500/api/v1/ontology/instances/Application?domain=RAAS-v1&candidate_id=C-100023',
        { headers: { Authorization: 'Bearer test-token' } },
      );
      expect(out).toEqual([{ id: 'A-1' }, { id: 'A-2' }]);
    });

    it('URL-encodes filter values', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      });
      await listInstances('Application', { client: '腾讯' });
      const calledWith = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledWith).toContain('client=' + encodeURIComponent('腾讯'));
    });

    it('returns [] on 404', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not-found' });
      expect(await listInstances('Application', { candidate_id: 'x' })).toEqual([]);
    });
  });

  describe('listLinks', () => {
    it('GETs /links?domain=RAAS-v1&<filters> and returns items array', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { linkId: 'l1', type: 'EMPLOYED_BY', fromId: 'C-1', toId: 'E-1' },
          ],
        }),
      });
      const out = await listLinks({ from: 'C-1', type: 'EMPLOYED_BY' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3500/api/v1/ontology/links?domain=RAAS-v1&from=C-1&type=EMPLOYED_BY',
        { headers: { Authorization: 'Bearer test-token' } },
      );
      expect(out).toHaveLength(1);
    });
  });

  describe('config errors', () => {
    it('throws if ONTOLOGY_API_BASE is missing', async () => {
      delete process.env.ONTOLOGY_API_BASE;
      await expect(getInstance('Candidate', 'x')).rejects.toThrow(/ONTOLOGY_API_BASE/);
    });

    it('throws if ONTOLOGY_API_TOKEN is missing', async () => {
      delete process.env.ONTOLOGY_API_TOKEN;
      await expect(getInstance('Candidate', 'x')).rejects.toThrow(/ONTOLOGY_API_TOKEN/);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run lib/rule-check/instance-client.test.ts
```

Expected: FAIL — `getInstance` / `listInstances` / `listLinks` are not exported (the module doesn't exist yet).

- [ ] **Step 4: Implement `lib/rule-check/instance-client.ts`**

Create the file:

```ts
// HTTP client for the Ontology API's instance + link CRUD endpoints.
// Used by lib/rule-check/graph-context.ts (pre-fetch bundle + tool dispatcher).
//
// Env-driven config:
//   ONTOLOGY_API_BASE — e.g. "http://localhost:3500"
//   ONTOLOGY_API_TOKEN — bearer
//
// All endpoints scope to the RAAS-v1 domain (matches what fetchAction uses).

const DOMAIN = 'RAAS-v1';

function getConfig(): { base: string; token: string } {
  const base = process.env.ONTOLOGY_API_BASE;
  if (!base) {
    throw new Error('ONTOLOGY_API_BASE is not configured');
  }
  const token = process.env.ONTOLOGY_API_TOKEN;
  if (!token) {
    throw new Error('ONTOLOGY_API_TOKEN is not configured');
  }
  return { base, token };
}

function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function encodeFilters(filters: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(filters)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

/**
 * Fetch a single ontology instance by label + primary key.
 * Returns null on 404. Throws on 401 / 5xx / network errors.
 */
export async function getInstance(
  label: string,
  value: string,
): Promise<Record<string, unknown> | null> {
  const { base, token } = getConfig();
  const url = `${base}/api/v1/ontology/instances/${encodeURIComponent(
    label,
  )}/${encodeURIComponent(value)}?domain=${DOMAIN}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(
      `Ontology API getInstance(${label}, ${value}) -> ${res.status}. Body: ${body}`,
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * List ontology instances of a label, filtered by property equality.
 * Returns [] on 404. Throws on 401 / 5xx / network errors.
 */
export async function listInstances(
  label: string,
  filters: Record<string, string> = {},
): Promise<Array<Record<string, unknown>>> {
  const { base, token } = getConfig();
  const qs = encodeFilters(filters);
  const url =
    `${base}/api/v1/ontology/instances/${encodeURIComponent(label)}` +
    `?domain=${DOMAIN}${qs ? `&${qs}` : ''}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return [];
  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(
      `Ontology API listInstances(${label}) -> ${res.status}. Body: ${body}`,
    );
  }
  const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return Array.isArray(json.items) ? json.items : [];
}

/**
 * List ontology links. Filters are passed as query params (from / to / type).
 * Returns [] on 404.
 */
export async function listLinks(
  filters: { from?: string; to?: string; type?: string } = {},
): Promise<Array<Record<string, unknown>>> {
  const { base, token } = getConfig();
  const out: Record<string, string> = {};
  if (filters.from) out.from = filters.from;
  if (filters.to) out.to = filters.to;
  if (filters.type) out.type = filters.type;
  const qs = encodeFilters(out);
  const url =
    `${base}/api/v1/ontology/links` +
    `?domain=${DOMAIN}${qs ? `&${qs}` : ''}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return [];
  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(
      `Ontology API listLinks(${JSON.stringify(filters)}) -> ${res.status}. Body: ${body}`,
    );
  }
  const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return Array.isArray(json.items) ? json.items : [];
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run lib/rule-check/instance-client.test.ts
```

Expected: PASS — 9 cases.

- [ ] **Step 6: Commit**

```bash
git add lib/rule-check/instance-client.ts lib/rule-check/instance-client.test.ts .env.example
git commit -m "$(cat <<'EOF'
feat(rule-check): instance-client — typed HTTP wrapper for /instances and /links

Reads ONTOLOGY_API_BASE/ONTOLOGY_API_TOKEN; scopes every call to ?domain=RAAS-v1.
getInstance returns null on 404; listInstances/listLinks return []. All others
(401/5xx) throw.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: graph-context.ts (pre-fetch bundle + cache + tool dispatcher)

**Files:**
- Create: `lib/rule-check/graph-context.ts`
- Create: `lib/rule-check/graph-context.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/rule-check/graph-context.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./instance-client', () => ({
  getInstance: vi.fn(),
  listInstances: vi.fn(),
  listLinks: vi.fn(),
}));

import { getInstance, listInstances, listLinks } from './instance-client';
import { buildGraphContext, createDispatcher } from './graph-context';

const mGet = vi.mocked(getInstance);
const mListInst = vi.mocked(listInstances);
const mListLinks = vi.mocked(listLinks);

beforeEach(() => {
  mGet.mockReset();
  mListInst.mockReset();
  mListLinks.mockReset();
});

describe('buildGraphContext', () => {
  it('fetches all five slots in parallel', async () => {
    mGet.mockImplementation(async (label, _value) => {
      if (label === 'Candidate') return { candidate_id: 'C-1', name: '张三' };
      if (label === 'Job_Requisition') return { job_requisition_id: 'JR-1', title: 'BE' };
      return null;
    });
    mListInst.mockImplementation(async (label) => {
      if (label === 'Application') return [{ id: 'A-1' }];
      if (label === 'Blacklist') return [];
      return [];
    });
    mListLinks.mockResolvedValueOnce([{ linkId: 'L-1', type: 'EMPLOYED_BY', toId: 'E-1' }]);

    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });

    expect(ctx.candidate).toEqual({ candidate_id: 'C-1', name: '张三' });
    expect(ctx.job_requisition).toEqual({ job_requisition_id: 'JR-1', title: 'BE' });
    expect(ctx.applications).toEqual([{ id: 'A-1' }]);
    expect(ctx.blacklist_hits).toEqual([]);
    expect(ctx.employment_links).toHaveLength(1);
    expect(ctx.fetch_count).toBe(5);
  });

  it('records null slot when candidate is 404', async () => {
    mGet.mockImplementation(async (label) =>
      label === 'Candidate' ? null : { job_requisition_id: 'JR-1' },
    );
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    const ctx = await buildGraphContext({
      candidate_id: 'missing',
      job_requisition_id: 'JR-1',
    });
    expect(ctx.candidate).toBeNull();
    expect(ctx.job_requisition).not.toBeNull();
  });

  it('propagates 401 from getInstance (caller decides fail-safe)', async () => {
    mGet.mockImplementation(async () => {
      throw new Error('Ontology API getInstance(...) -> 401. Body: unauthorized');
    });
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    await expect(
      buildGraphContext({ candidate_id: 'C-1', job_requisition_id: 'JR-1' }),
    ).rejects.toThrow(/401/);
  });
});

describe('createDispatcher (tool-use loop dispatcher)', () => {
  it('returns pre-fetched candidate without re-calling fetch', async () => {
    mGet.mockResolvedValue({ candidate_id: 'C-1', name: '张三' });
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });
    const callCountBefore = mGet.mock.calls.length;

    const dispatch = createDispatcher(ctx);
    const out = await dispatch('get_instance', { label: 'Candidate', value: 'C-1' });
    expect(out).toEqual({ candidate_id: 'C-1', name: '张三' });
    expect(mGet.mock.calls.length).toBe(callCountBefore); // no extra fetch
  });

  it('calls instance-client on a cache miss', async () => {
    mGet.mockResolvedValueOnce({ candidate_id: 'C-1' }); // for buildGraphContext
    mGet.mockResolvedValueOnce({ job_requisition_id: 'JR-1' });
    mGet.mockResolvedValueOnce({ blacklist_id: 'B-99', candidate_id: 'C-1' }); // tool call
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });

    const dispatch = createDispatcher(ctx);
    const out = await dispatch('get_instance', { label: 'Blacklist', value: 'B-99' });
    expect(out).toEqual({ blacklist_id: 'B-99', candidate_id: 'C-1' });
  });

  it('dispatches list_instances + list_links and counts calls', async () => {
    mGet.mockResolvedValue(null);
    mListInst.mockResolvedValueOnce([]); // applications during build
    mListInst.mockResolvedValueOnce([]); // blacklist during build
    mListLinks.mockResolvedValueOnce([]); // employment during build
    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });

    mListInst.mockResolvedValueOnce([{ id: 'X' }]); // tool call
    mListLinks.mockResolvedValueOnce([{ linkId: 'L-1' }]); // tool call

    const dispatch = createDispatcher(ctx);
    expect(
      await dispatch('list_instances', { label: 'Foo', filters: { candidate_id: 'C-1' } }),
    ).toEqual([{ id: 'X' }]);
    expect(
      await dispatch('list_links', { from: 'C-1', type: 'RELATIVE_OF' }),
    ).toEqual([{ linkId: 'L-1' }]);
  });

  it('returns { error } when dispatched tool throws', async () => {
    mGet.mockResolvedValue(null);
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });

    mGet.mockRejectedValueOnce(new Error('Ontology API getInstance(Foo, x) -> 500. Body: boom'));
    const dispatch = createDispatcher(ctx);
    const out = await dispatch('get_instance', { label: 'Foo', value: 'x' });
    expect(out).toMatchObject({ error: expect.stringContaining('500') });
  });

  it('throws on unknown tool name', async () => {
    mGet.mockResolvedValue(null);
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });
    const dispatch = createDispatcher(ctx);
    await expect(dispatch('not_a_real_tool', {})).rejects.toThrow(/unknown tool/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/rule-check/graph-context.test.ts
```

Expected: FAIL — `buildGraphContext` / `createDispatcher` are not exported.

- [ ] **Step 3: Implement `lib/rule-check/graph-context.ts`**

Create the file:

```ts
// Pre-fetch bundle + in-memory cache + tool dispatcher.
//
// Called once at the start of runRuleCheck() to populate a "graph context"
// that the LLM can reference inline (candidate.name etc.). The same cache
// also backs the tool-use loop: when the LLM calls get_instance / list_instances
// / list_links, the dispatcher checks the cache first and only hits the API
// for a miss.

import { getInstance, listInstances, listLinks } from './instance-client';

export interface GraphContext {
  candidate: Record<string, unknown> | null;
  job_requisition: Record<string, unknown> | null;
  applications: Array<Record<string, unknown>>;
  blacklist_hits: Array<Record<string, unknown>>;
  employment_links: Array<Record<string, unknown>>;
  fetch_count: number;
  /** Internal cache; do not depend on its shape. */
  _cache: Map<string, unknown>;
}

export type ToolDispatcher = (name: string, args: unknown) => Promise<unknown>;

function instKey(label: string, value: string): string {
  return `inst:${label}:${value}`;
}

function listInstKey(label: string, filters: Record<string, string>): string {
  const sorted = Object.keys(filters).sort().map((k) => `${k}=${filters[k]}`).join('&');
  return `list-inst:${label}:${sorted}`;
}

function listLinksKey(filters: { from?: string; to?: string; type?: string }): string {
  return `list-links:from=${filters.from ?? ''}|to=${filters.to ?? ''}|type=${filters.type ?? ''}`;
}

export async function buildGraphContext(args: {
  candidate_id: string;
  job_requisition_id: string;
}): Promise<GraphContext> {
  const cache = new Map<string, unknown>();
  const counters = { n: 0 };

  const tryGet = async (label: string, value: string) => {
    counters.n += 1;
    const v = await getInstance(label, value);
    if (v) cache.set(instKey(label, value), v);
    return v;
  };
  const tryList = async (label: string, filters: Record<string, string>) => {
    counters.n += 1;
    const v = await listInstances(label, filters);
    cache.set(listInstKey(label, filters), v);
    return v;
  };
  const tryLinks = async (filters: { from?: string; to?: string; type?: string }) => {
    counters.n += 1;
    const v = await listLinks(filters);
    cache.set(listLinksKey(filters), v);
    return v;
  };

  const [candidate, job_requisition, applications, blacklist_hits, employment_links] =
    await Promise.all([
      tryGet('Candidate', args.candidate_id),
      tryGet('Job_Requisition', args.job_requisition_id),
      tryList('Application', { candidate_id: args.candidate_id }),
      tryList('Blacklist', { candidate_id: args.candidate_id }),
      tryLinks({ from: args.candidate_id, type: 'EMPLOYED_BY' }),
    ]);

  return {
    candidate,
    job_requisition,
    applications,
    blacklist_hits,
    employment_links,
    fetch_count: counters.n,
    _cache: cache,
  };
}

export function createDispatcher(ctx: GraphContext): ToolDispatcher {
  return async (name: string, args: unknown): Promise<unknown> => {
    try {
      if (name === 'get_instance') {
        const { label, value } = args as { label: string; value: string };
        const key = instKey(label, value);
        if (ctx._cache.has(key)) return ctx._cache.get(key);
        const v = await getInstance(label, value);
        if (v) ctx._cache.set(key, v);
        ctx.fetch_count += 1;
        return v;
      }
      if (name === 'list_instances') {
        const { label, filters = {} } = args as {
          label: string;
          filters?: Record<string, string>;
        };
        const key = listInstKey(label, filters);
        if (ctx._cache.has(key)) return ctx._cache.get(key);
        const v = await listInstances(label, filters);
        ctx._cache.set(key, v);
        ctx.fetch_count += 1;
        return v;
      }
      if (name === 'list_links') {
        const filters = args as { from?: string; to?: string; type?: string };
        const key = listLinksKey(filters);
        if (ctx._cache.has(key)) return ctx._cache.get(key);
        const v = await listLinks(filters);
        ctx._cache.set(key, v);
        ctx.fetch_count += 1;
        return v;
      }
      throw new Error(`unknown tool: ${name}`);
    } catch (err) {
      // Re-throw "unknown tool" so the loop can fail loudly; for HTTP errors
      // return an `{ error }` envelope so the LLM can record insufficient_info.
      if ((err as Error).message?.startsWith('unknown tool')) throw err;
      return { error: (err as Error).message };
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/rule-check/graph-context.test.ts
```

Expected: PASS — 7 cases.

- [ ] **Step 5: Commit**

```bash
git add lib/rule-check/graph-context.ts lib/rule-check/graph-context.test.ts
git commit -m "$(cat <<'EOF'
feat(rule-check): graph-context pre-fetch bundle + tool dispatcher

buildGraphContext fans out five parallel calls (candidate, JD, applications,
blacklist_hits, employment_links) and seeds a per-invocation cache. The
dispatcher returns cached values for the three tool names (get_instance /
list_instances / list_links) and falls through to the HTTP client on miss.
HTTP errors surface to the LLM as { error } envelopes so the model can mark
dependent rules insufficient_info.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add tool-use support to `server/llm/gateway.ts`

**Files:**
- Modify: `server/llm/gateway.ts`
- Create: `server/llm/gateway.test.ts` (or extend if exists)

- [ ] **Step 1: Write failing tests**

Create `server/llm/gateway.test.ts` (check if it already exists — if so, append the new `describe` blocks; otherwise create with the imports + setup below):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We mock the `openai` module to control the create() responses.
const createMock = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn(() => ({
    chat: { completions: { create: createMock } },
  })),
}));

import { chatComplete } from './gateway';

beforeEach(() => {
  process.env.AI_BASE_URL = 'http://gateway/v1';
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'test-model';
  createMock.mockReset();
});
afterEach(() => {
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
});

describe('chatComplete (existing single-turn behavior preserved)', () => {
  it('returns the assistant text for a tool-less call', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hello' } }],
      usage: { total_tokens: 10 },
    });
    const out = await chatComplete({ system: 'sys', user: 'u' });
    expect(out.text).toBe('hello');
    expect(out.modelUsed).toBe('test-model');
  });
});

describe('chatComplete with tools', () => {
  it('drives one tool round then returns final text', async () => {
    createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'tc_1',
                type: 'function',
                function: { name: 'get_instance', arguments: '{"label":"Candidate","value":"C-1"}' },
              },
            ],
          },
        },
      ],
    });
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'final answer' } }],
    });

    const dispatcher = vi.fn().mockResolvedValueOnce({ candidate_id: 'C-1' });

    const out = await chatComplete({
      system: 'sys',
      user: 'u',
      tools: {
        schema: [
          {
            type: 'function',
            function: {
              name: 'get_instance',
              description: 'Fetch one instance.',
              parameters: {
                type: 'object',
                properties: { label: { type: 'string' }, value: { type: 'string' } },
                required: ['label', 'value'],
              },
            },
          },
        ],
        onToolCall: dispatcher,
      },
    });

    expect(out.text).toBe('final answer');
    expect(out.toolUseIterations).toBe(1);
    expect(dispatcher).toHaveBeenCalledWith('get_instance', {
      label: 'Candidate',
      value: 'C-1',
    });
    // Second create() call should have the tool result threaded in messages.
    const secondCall = createMock.mock.calls[1]?.[0] as { messages: unknown[] };
    expect(secondCall.messages.length).toBeGreaterThanOrEqual(4);
    const toolMsg = secondCall.messages.find(
      (m): m is { role: string; tool_call_id: string; content: string } =>
        typeof m === 'object' && m !== null && (m as { role: string }).role === 'tool',
    );
    expect(toolMsg?.tool_call_id).toBe('tc_1');
    expect(JSON.parse(toolMsg!.content)).toEqual({ candidate_id: 'C-1' });
  });

  it('throws when tool-use loop exceeds maxIterations', async () => {
    const toolCallResponse = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'tc_x',
                type: 'function',
                function: { name: 'get_instance', arguments: '{}' },
              },
            ],
          },
        },
      ],
    };
    // Always return a tool_call — loop should never converge.
    createMock.mockResolvedValue(toolCallResponse);
    const dispatcher = vi.fn().mockResolvedValue({});

    await expect(
      chatComplete({
        system: 'sys',
        user: 'u',
        tools: {
          schema: [
            {
              type: 'function',
              function: {
                name: 'get_instance',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
          onToolCall: dispatcher,
          maxIterations: 2,
        },
      }),
    ).rejects.toThrow(/tool-use loop exceeded/);
  });

  it('returns text without tool_calls if model emits content first', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'no tools needed' } }],
    });

    const out = await chatComplete({
      system: 'sys',
      user: 'u',
      tools: {
        schema: [
          {
            type: 'function',
            function: {
              name: 'get_instance',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        onToolCall: vi.fn(),
      },
    });
    expect(out.text).toBe('no tools needed');
    expect(out.toolUseIterations).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run server/llm/gateway.test.ts
```

Expected: FAIL — `chatComplete` doesn't accept a `tools` parameter, no `toolUseIterations` in result.

- [ ] **Step 3: Modify `server/llm/gateway.ts`**

Add the new types + parameter + loop. Apply this diff conceptually (keep existing imports/exports/comments, just extend the function):

Update `ChatCompleteResult` to add `toolUseIterations`:

```ts
export type ChatCompleteResult = {
  text: string;
  modelUsed: string;
  durationMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** Number of tool-call rounds before final text. 0 when no tools, or model
   *  emitted content on the first response. */
  toolUseIterations: number;
};
```

Add the tool-related types just before `chatComplete`:

```ts
export type ChatTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatToolDispatcher = (
  name: string,
  args: unknown,
) => Promise<unknown>;

export type ChatToolsOptions = {
  schema: ChatTool[];
  onToolCall: ChatToolDispatcher;
  /** Cap on tool-call rounds. Default 5. */
  maxIterations?: number;
};
```

Extend `chatComplete`'s `opts` signature with `tools?: ChatToolsOptions`. Rewrite the body so:
- If `tools` is undefined: today's single-shot path (just add `toolUseIterations: 0` to the result).
- If `tools` is set: enter a loop.

The full rewritten body (replace the existing single `client.chat.completions.create(...)` call):

```ts
export async function chatComplete(opts: {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  logger?: LoggerLike;
  toolName?: string;
  tools?: ChatToolsOptions;
}): Promise<ChatCompleteResult> {
  const cfg = pickGateway();
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  const modelUsed = opts.model || cfg.model;
  const toolLabel = opts.toolName ?? `LLM.${modelUsed}`;
  const started = Date.now();

  const messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  }> = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];

  const maxIterations = opts.tools?.maxIterations ?? 5;
  let iterations = 0;
  let text = '';
  let lastUsage:
    | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    | undefined;

  try {
    while (true) {
      const createArgs: Record<string, unknown> = {
        model: modelUsed,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 800,
        messages,
      };
      if (opts.tools) {
        createArgs.tools = opts.tools.schema;
        createArgs.tool_choice = 'auto';
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const completion = (await client.chat.completions.create(createArgs as any)) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: Array<{
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            }>;
          };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      lastUsage = completion.usage;
      const msg = completion.choices[0]?.message;
      const toolCalls = msg?.tool_calls ?? [];

      if (!opts.tools || toolCalls.length === 0) {
        text = (msg?.content ?? '').trim();
        break;
      }

      // Append the assistant message (with its tool_calls) to history.
      messages.push({
        role: 'assistant',
        content: msg?.content ?? null,
        tool_calls: toolCalls,
      });

      // Dispatch each tool call, append the tool result message.
      for (const call of toolCalls) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(call.function.arguments);
        } catch {
          parsed = {};
        }
        const result = await opts.tools.onToolCall(call.function.name, parsed);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result ?? null),
        });
      }

      iterations += 1;
      if (iterations >= maxIterations) {
        throw new Error(
          `tool-use loop exceeded ${maxIterations} iterations without final text`,
        );
      }
    }

    const durationMs = Date.now() - started;
    const usage = lastUsage
      ? {
          promptTokens: lastUsage.prompt_tokens,
          completionTokens: lastUsage.completion_tokens,
          totalTokens: lastUsage.total_tokens,
        }
      : undefined;
    if (opts.logger) {
      await opts.logger.tool(
        `${toolLabel} · ${usage?.totalTokens ?? '?'} tokens · ${durationMs}ms · ${iterations} tool rounds`,
        {
          model: modelUsed,
          durationMs,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          totalTokens: usage?.totalTokens,
          toolUseIterations: iterations,
          systemSummary: truncate(opts.system, 200),
          userSummary: truncate(opts.user, 400),
        },
      );
    }
    return { text, modelUsed, durationMs, usage, toolUseIterations: iterations };
  } catch (e) {
    const durationMs = Date.now() - started;
    if (opts.logger) {
      await opts.logger.anomaly(`${toolLabel} failed: ${(e as Error).message}`, {
        model: modelUsed,
        durationMs,
        error: (e as Error).message,
      });
    }
    throw e;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/llm/gateway.test.ts
```

Expected: PASS — 4 cases.

- [ ] **Step 5: Commit**

```bash
git add server/llm/gateway.ts server/llm/gateway.test.ts
git commit -m "$(cat <<'EOF'
feat(llm-gateway): tool-use loop on chatComplete

Optional tools={schema, onToolCall, maxIterations=5} parameter drives a
multi-turn loop. Each tool_calls round is dispatched via onToolCall and
appended as a tool-role message; loop exits on first content-only response
or throws past the iteration cap. Returns toolUseIterations in the result
for caller telemetry. Existing tool-less callers are unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: New types in `lib/rule-check/types.ts`

**Files:**
- Modify: `lib/rule-check/types.ts`
- Modify: `lib/rule-check/index.ts` (re-export new types)

- [ ] **Step 1: Add the new type exports to `lib/rule-check/types.ts`**

APPEND (do NOT remove old types — Task 9 deletes them) the following at the end of `lib/rule-check/types.ts`:

```ts
// ─── Phase 3: neo4j-aware matchResume check ──────────────────────────────

export type RuleStatus =
  | 'pass'
  | 'fail'
  | 'pending'
  | 'insufficient_info'
  | 'not_triggered'
  | 'not_executed';

export type RuleExplanation = {
  rule_id: string;
  rule_name: string;
  step_id: string;
  status: Exclude<RuleStatus, 'pass' | 'not_triggered'>;
  reason: string;
};

export type MatchResumeCheckStats = {
  total: number;
  pass: number;
  fail: number;
  pending: number;
  insufficient_info: number;
  not_triggered: number;
  not_executed: number;
};

export type MatchResumeCheckResult = {
  decision: 'PASS' | 'FAIL' | 'REVIEW';
  stats: MatchResumeCheckStats;
  explanations: RuleExplanation[];
  audit: {
    rules_evaluated: number;
    graph_calls: number;
    llm_model: string;
    llm_duration_ms: number;
    llm_round_trips: number;
    llm_prompt_tokens?: number;
    llm_completion_tokens?: number;
    rule_source: 'ontology-api' | 'json-fallback';
    fail_reason?:
      | 'llm-call-error'
      | 'ontology-graph-unavailable'
      | 'tool-use-loop-exceeded'
      | 'parse-error'
      | string;
  };
};

/** Action_step group used by prompt rendering (Set ordering). */
export interface MatchResumeStepGroup {
  step_id: string;
  order: number;
  name: string;
  description: string;
  condition: string;
  rules: Rule[];
}
```

- [ ] **Step 2: Update `lib/rule-check/index.ts` re-exports**

Replace the file content with (additive — keep old exports):

```ts
export { buildRuleCheckInput, runRuleCheck } from './runner';
export type {
  LlmRuleCheckOutput,
  RuleCheckInput,
  RuleCheckRuntimeContext,
  RuleCheckVerdict,
  RuleFlag,
  Severity,
  // new
  MatchResumeCheckResult,
  MatchResumeCheckStats,
  MatchResumeStepGroup,
  RuleExplanation,
  RuleStatus,
} from './types';
```

- [ ] **Step 3: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no NEW errors in `lib/rule-check/` (pre-existing errors in `server/em/publish.test.ts` are out of scope).

- [ ] **Step 4: Commit**

```bash
git add lib/rule-check/types.ts lib/rule-check/index.ts
git commit -m "$(cat <<'EOF'
feat(rule-check): add MatchResumeCheckResult and step-group types

Additive — old RuleCheckVerdict / RuleFlag stay until Task 9 cleanup.
New types: RuleStatus, RuleExplanation, MatchResumeCheckStats,
MatchResumeCheckResult, MatchResumeStepGroup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Extend `ontology-source.ts` to emit grouped steps

**Files:**
- Modify: `lib/rule-check/ontology-source.ts`
- Create: `lib/rule-check/ontology-source.test.ts` (or extend if exists)

- [ ] **Step 1: Add failing test for grouped-step emission**

Append to or create `lib/rule-check/ontology-source.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ontology-gen', () => ({
  fetchAction: vi.fn(),
  OntologyGenError: class extends Error {},
}));

import { fetchAction } from '@/lib/ontology-gen';
import { fetchRulesForMatchResume } from './ontology-source';

const mFetchAction = vi.mocked(fetchAction);

describe('fetchRulesForMatchResume — grouped steps', () => {
  it('emits steps[] with order, name, description, condition, rules', async () => {
    process.env.ONTOLOGY_API_BASE = 'http://localhost:3500';
    process.env.ONTOLOGY_API_TOKEN = 'tok';
    mFetchAction.mockResolvedValueOnce({
      actionSteps: [
        {
          id: '10::s2',
          name: 'matchHardRequirements',
          order: '2',
          description: 'desc 2',
          condition: 'cond 2',
          rules: [{ id: '10-5' }, { id: '10-21' }],
        },
        {
          id: '10::s1',
          name: 'validateRedlineAndBlacklist',
          order: '1',
          description: 'desc 1',
          condition: 'cond 1',
          rules: [{ id: '10-25' }],
        },
      ],
    } as unknown as Awaited<ReturnType<typeof fetchAction>>);

    const out = await fetchRulesForMatchResume();
    expect(out.steps).toBeDefined();
    expect(out.steps).toHaveLength(2);
    // Ordered by numeric order ascending
    expect(out.steps![0].name).toBe('validateRedlineAndBlacklist');
    expect(out.steps![1].name).toBe('matchHardRequirements');
    expect(out.steps![0].order).toBe(1);
    expect(out.steps![0].rules.map((r) => r.id)).toEqual(['10-25']);
    expect(out.steps![1].rules.map((r) => r.id)).toEqual(['10-5', '10-21']);
  });

  it('omits steps[] when falling back to JSON', async () => {
    delete process.env.ONTOLOGY_API_BASE; // forces fallback
    const out = await fetchRulesForMatchResume();
    expect(out.source).toBe('json-fallback');
    expect(out.steps).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/rule-check/ontology-source.test.ts
```

Expected: FAIL — `out.steps` is undefined on the success path.

- [ ] **Step 3: Modify `lib/rule-check/ontology-source.ts`**

In `FetchRulesResult`, add an optional `steps?:` field. In `fetchRulesForMatchResume`, when the API path succeeds, also build the grouped-steps array.

In types section of the file, change `FetchRulesResult` to:

```ts
export interface FetchRulesResult {
  rules: Rule[];
  source: 'ontology-api' | 'json-fallback';
  drift?: {
    only_in_api: string[];
    only_in_json: string[];
  };
  api_error?: string;
  /** Step-grouped view, only emitted on the ontology-api success path. */
  steps?: import('./types').MatchResumeStepGroup[];
}
```

(`MatchResumeStepGroup` is the type we added in Task 4.)

After the successful API path computes `apiRuleIds` and `rules`, insert before `return { rules, source: 'ontology-api', drift };`:

```ts
    const jsonIndexForSteps = jsonIndex;
    const steps: import('./types').MatchResumeStepGroup[] = [];
    for (const step of action.actionSteps ?? []) {
      const stepRules: Rule[] = [];
      for (const r of step.rules ?? []) {
        const meta = typeof r.id === 'string' ? jsonIndexForSteps.get(r.id) : undefined;
        if (meta) stepRules.push(meta);
      }
      if (stepRules.length === 0) continue;
      steps.push({
        step_id: typeof step.id === 'string' ? step.id : '',
        order: Number(step.order ?? '0'),
        name: typeof step.name === 'string' ? step.name : '',
        description: typeof step.description === 'string' ? step.description : '',
        condition: typeof step.condition === 'string' ? step.condition : '',
        rules: stepRules,
      });
    }
    steps.sort((a, b) => a.order - b.order);
```

And update the return statement to include `steps`:

```ts
    return { rules, source: 'ontology-api', drift, steps };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/rule-check/ontology-source.test.ts
```

Expected: PASS — 2 new cases plus any existing tests.

- [ ] **Step 5: Commit**

```bash
git add lib/rule-check/ontology-source.ts lib/rule-check/ontology-source.test.ts
git commit -m "$(cat <<'EOF'
feat(rule-check): ontology-source emits grouped steps (Set ordering)

FetchRulesResult.steps[] carries each action_step's id/order/name/
description/condition + rules in API order. Ordered numerically by order;
omitted on JSON fallback. Backs the Set-ordered prompt rendering in Task 6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: New `composeMatchResumePrompt` in `prompt.ts`

**Files:**
- Modify: `lib/rule-check/prompt.ts`
- Create: `lib/rule-check/prompt.test.ts` (or extend if exists)

- [ ] **Step 1: Write failing tests**

Create `lib/rule-check/prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { composeMatchResumePrompt, MATCH_RESUME_SYSTEM_PROMPT } from './prompt';
import type { GraphContext } from './graph-context';
import type { MatchResumeStepGroup, RuleCheckInput } from './types';

const baseInput: RuleCheckInput = {
  runtime_context: {
    upload_id: 'u',
    candidate_id: 'C-1',
    resume_id: 'r',
    employee_id: 'EMP',
  },
  resume: { name: '张三' },
  job_requisition: { job_requisition_id: 'JR-1' },
  job_requisition_specification: null,
  hsm_feedback: null,
};

const baseCtx: GraphContext = {
  candidate: { candidate_id: 'C-1', name: '张三' },
  job_requisition: { job_requisition_id: 'JR-1' },
  applications: [],
  blacklist_hits: [],
  employment_links: [],
  fetch_count: 5,
  _cache: new Map(),
};

const baseSteps: MatchResumeStepGroup[] = [
  {
    step_id: '10::s1',
    order: 1,
    name: 'validateRedlineAndBlacklist',
    description: 'desc 1',
    condition: 'cond 1',
    rules: [
      {
        id: '10-25',
        specificScenarioStage: '',
        businessLogicRuleName: '华为荣耀竞对',
        applicableClient: '通用',
        applicableDepartment: 'N/A',
        submissionCriteria: 'sc',
        standardizedLogicRule: 'logic',
        relatedEntities: [],
        businessBackgroundReason: '',
        ruleSource: '',
        executor: 'Agent',
        severity: 'terminal',
      },
    ],
  },
  {
    step_id: '10::s2',
    order: 2,
    name: 'matchHardRequirements',
    description: 'desc 2',
    condition: 'cond 2',
    rules: [
      {
        id: '10-5',
        specificScenarioStage: '',
        businessLogicRuleName: '硬性要求一票否决',
        applicableClient: '通用',
        applicableDepartment: 'N/A',
        submissionCriteria: 'N/A',
        standardizedLogicRule: 'logic',
        relatedEntities: [],
        businessBackgroundReason: '',
        ruleSource: '',
        executor: 'Agent',
        severity: 'terminal',
      },
    ],
  },
];

describe('composeMatchResumePrompt', () => {
  it('renders Set headers in order with explicit Set N markers', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('### 4.1 Set 1 — validateRedlineAndBlacklist');
    expect(out).toContain('### 4.2 Set 2 — matchHardRequirements');
    expect(out.indexOf('Set 1')).toBeLessThan(out.indexOf('Set 2'));
  });

  it('renders rules in input order, not re-sorted by id', () => {
    const reorderedSteps: MatchResumeStepGroup[] = [
      {
        ...baseSteps[0],
        rules: [
          {
            ...baseSteps[0].rules[0],
            id: '10-99',
            businessLogicRuleName: 'second',
          },
          {
            ...baseSteps[0].rules[0],
            id: '10-2',
            businessLogicRuleName: 'first by id',
          },
        ],
      },
    ];
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: reorderedSteps,
    });
    expect(out.indexOf('Rule 10-99')).toBeLessThan(out.indexOf('Rule 10-2'));
  });

  it('contains the strict-order + short-circuit constraint block', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('执行约束');
    expect(out).toContain('不得跳过 Set、不得乱序');
    expect(out).toContain('立即停止后续所有 rule 的评估');
    expect(out).toContain('not_executed');
  });

  it('renders the GraphContext section with named slots', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('## 3. Graph context');
    expect(out).toContain('### 3.1 candidate');
    expect(out).toContain('### 3.2 job_requisition');
    expect(out).toContain('### 3.3 applications');
    expect(out).toContain('### 3.4 blacklist_hits');
    expect(out).toContain('### 3.5 employment_links');
  });

  it('emits null/[] for missing graph slots', () => {
    const empty: GraphContext = {
      ...baseCtx,
      candidate: null,
      applications: [],
    };
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: empty,
      steps: baseSteps,
    });
    // candidate is null
    expect(out).toMatch(/### 3\.1 candidate[\s\S]+?null/);
  });

  it('includes the new output schema with stats fields', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('"stats"');
    expect(out).toContain('insufficient_info');
    expect(out).toContain('not_triggered');
    expect(out).toContain('not_executed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/rule-check/prompt.test.ts
```

Expected: FAIL — `composeMatchResumePrompt` is not exported (or `MATCH_RESUME_SYSTEM_PROMPT` missing).

- [ ] **Step 3: Add `composeMatchResumePrompt` to `lib/rule-check/prompt.ts`**

APPEND to `lib/rule-check/prompt.ts` (do NOT remove old composer — Task 9 deletes it). Add the imports at the top:

```ts
import type { GraphContext } from './graph-context';
import type { MatchResumeStepGroup, RuleCheckInput } from './types';
```

(Adjust if `RuleCheckInput` is already imported; merge into the existing import.)

Append the new exports at the bottom of the file:

```ts
const STRICT_ORDER_BLOCK = `> **执行约束（必须遵守，违反即视为输出无效）：**
> 1. Set 之间按 §4.1 → §4.2 → §4.3 → §4.4 顺序，**不得跳过 Set、不得乱序**。
> 2. 每个 Set 内的 rules 按列出顺序逐条评估，**不得调换、不得合并**。
> 3. 一旦任一 rule 的 status="fail"，**立即停止后续所有 rule 的评估**；后续 rule 全部标 status="not_executed"，reason="前序规则 <rule_id> 已 FAIL，本规则未执行"。
> 4. status="pending" / "insufficient_info" / "pass" 均**不**短路；后续规则继续。
> 5. 你必须在内部完成全部评估后，再统一输出 explanations[]。`;

const OUTPUT_SCHEMA_MATCH_RESUME = `## 6. Output schema

仅输出严格符合下列结构的 JSON，**不允许 markdown 代码块、不允许多余字段**：

\`\`\`json
{
  "decision": "PASS" | "FAIL" | "REVIEW",
  "stats": {
    "total": <int>,
    "pass": <int>,
    "fail": <int>,
    "pending": <int>,
    "insufficient_info": <int>,
    "not_triggered": <int>,
    "not_executed": <int>
  },
  "explanations": [
    {
      "rule_id": "<id>",
      "rule_name": "<name>",
      "step_id": "<step_id>",
      "status": "fail" | "pending" | "insufficient_info" | "not_executed",
      "reason": "<reasoning, 引用 graph context 或 input 原文>"
    }
  ]
}
\`\`\`

stats 各字段必须与你内部评估的 status 数量一致；总和等于 stats.total。
explanations[] **仅**包含 status ∈ {fail, pending, insufficient_info, not_executed} 的规则；pass / not_triggered 的规则只计入 stats、不出现在 explanations。`;

const DECISION_FOLD_BLOCK = `## 5. 决策结算

逐 rule 评估完后按下列规则汇总：
- 任一 rule status="fail" → \`decision="FAIL"\`
- 否则任一 rule status="pending" 或 "insufficient_info" → \`decision="REVIEW"\`
- 否则 → \`decision="PASS"\`

不要根据自己的判断重新归类 rule status，必须沿用上面的语义。`;

const SELF_CHECK_MATCH_RESUME = `## 7. 自检
- [ ] 是否按 Set 顺序、Set 内列出顺序评估？
- [ ] 是否在出现首个 fail 后将后续全部标 not_executed？
- [ ] stats 的各类计数是否与 explanations[] 一致？
- [ ] 仅输出 JSON 对象本身，无 markdown 包裹？`;

function renderGraphSlot(name: string, value: unknown): string {
  return [`### ${name}`, '```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

function renderGraphSection(graph: GraphContext): string {
  return [
    '## 3. Graph context',
    '',
    '你可以通过下列对象引用 ontology 实例数据。**先用这些字段，不够再调 tool**。',
    '所有数据已经按 candidate_id / job_requisition_id 预拉取；缺的 slot 显示为 null 或 []，对应规则按 "信息不全" 处理。',
    '',
    renderGraphSlot('3.1 candidate', graph.candidate),
    renderGraphSlot('3.2 job_requisition', graph.job_requisition),
    renderGraphSlot('3.3 applications (历史投递, 全量)', graph.applications),
    renderGraphSlot('3.4 blacklist_hits (全量)', graph.blacklist_hits),
    renderGraphSlot('3.5 employment_links (含 Employer 节点解析)', graph.employment_links),
    '',
    '如需上面未列出的实体（亲属关系、合规文档等），通过 tool 调用 `get_instance` / `list_instances` / `list_links`。',
  ].join('\n');
}

function renderRuleBlock(r: import('./types').Rule): string {
  return [
    `#### Rule ${r.id}: ${r.businessLogicRuleName}  [applicableClient=${r.applicableClient}, severity=${r.severity}]`,
    `- submissionCriteria: ${r.submissionCriteria || 'N/A'}`,
    `- logic: ${r.standardizedLogicRule}`,
  ].join('\n');
}

function renderStepBlock(s: MatchResumeStepGroup, index: number): string {
  const header = `### 4.${index + 1} Set ${s.order} — ${s.name}  [order=${s.order}]`;
  const meta = [
    `**进入条件**：${s.condition || '(无)'}`,
    `**Set 说明**：${s.description || '(无)'}`,
  ].join('\n');
  const ruleBlocks = s.rules.map(renderRuleBlock).join('\n\n');
  return [header, meta, ruleBlocks].join('\n\n');
}

function renderRulesSection(steps: MatchResumeStepGroup[]): string {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  return [
    '## 4. Rules to check — 严格按 Set 顺序、Set 内严格按列出顺序评估',
    '',
    STRICT_ORDER_BLOCK,
    '',
    ...sorted.map((s, i) => renderStepBlock(s, i)),
  ].join('\n\n');
}

function renderInputsSectionV2(input: RuleCheckInput): string {
  return [
    '## 2. Inputs',
    '',
    '### 2.1 runtime_context',
    '```json',
    JSON.stringify(input.runtime_context, null, 2),
    '```',
    '',
    '### 2.2 resume',
    '```json',
    JSON.stringify(input.resume, null, 2),
    '```',
    '',
    '### 2.3 job_requisition',
    '```json',
    JSON.stringify(input.job_requisition, null, 2),
    '```',
    '',
    '### 2.4 job_requisition_specification',
    '```json',
    JSON.stringify(input.job_requisition_specification ?? null, null, 2),
    '```',
    '',
    '### 2.5 hsm_feedback',
    '```json',
    JSON.stringify(input.hsm_feedback ?? null, null, 2),
    '```',
  ].join('\n');
}

export function composeMatchResumePrompt(args: {
  input: RuleCheckInput;
  graph: GraphContext;
  steps: MatchResumeStepGroup[];
}): string {
  const ROLE = `# matchResume Rule Check

## 1. 你的角色

你是一名 matchResume action 的规则评估员。基于给定的 INPUT、GRAPH_CONTEXT 和 RULES，按 Set 顺序逐条评估每条 rule 的 status，并按规则结算出最终 decision。

- **必须**严格按 Set 顺序、Set 内列出顺序评估。
- **不要**给候选人打匹配分数（评分由下游算法负责）。
- **不要**在 reason 中编造 INPUT 或 GRAPH_CONTEXT 中未提供的信息；缺字段一律标 \`insufficient_info\`。`;

  return [
    ROLE,
    renderInputsSectionV2(args.input),
    renderGraphSection(args.graph),
    renderRulesSection(args.steps),
    DECISION_FOLD_BLOCK,
    OUTPUT_SCHEMA_MATCH_RESUME,
    SELF_CHECK_MATCH_RESUME,
  ].join('\n\n');
}

export const MATCH_RESUME_SYSTEM_PROMPT = `你是一名 matchResume 规则评估员。

严格按照 user 消息中的 INPUT / GRAPH_CONTEXT / RULES 评估，输出严格符合 schema 的 JSON。

边界约束：
- 必须按 Set 顺序、Set 内列出顺序评估
- 一旦任一 rule status="fail"，后续全部标 not_executed
- 不要在 reason 里编造 INPUT/GRAPH_CONTEXT 未提供的信息；缺字段标 insufficient_info
- 必须输出合法 JSON，不要在 JSON 外加任何文本（包括 markdown code fence）`;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/rule-check/prompt.test.ts
```

Expected: PASS — 6 cases.

- [ ] **Step 5: Commit**

```bash
git add lib/rule-check/prompt.ts lib/rule-check/prompt.test.ts
git commit -m "$(cat <<'EOF'
feat(rule-check): composeMatchResumePrompt — Set-ordered rules + graph context

Renders rules under §4 grouped by action_step (Set) in numeric order with
the strict-order + short-circuit constraint block. Adds §3 GraphContext
slots (candidate, JD, applications, blacklist_hits, employment_links) plus
new §6 output schema with stats + explanations. Old composePrompt is
kept until Task 9 cleanup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Cut over `runner.ts`, `match-resume-agent.ts`, event payloads

**Files:**
- Modify: `lib/rule-check/runner.ts`
- Modify: `lib/rule-check/runner.test.ts`
- Modify: `server/inngest/agents/match-resume-agent.ts`
- Modify: `server/inngest/client.ts`

This task lands the cutover atomically. After this commit, `runRuleCheck()` returns `MatchResumeCheckResult`; the old `RuleCheckVerdict` consumers are migrated. `lib/rule-check/llm.ts` becomes unreferenced (deleted in Task 9).

- [ ] **Step 1: Replace `lib/rule-check/runner.test.ts` body**

Replace the entire content of `lib/rule-check/runner.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./instance-client', () => ({
  getInstance: vi.fn(),
  listInstances: vi.fn(),
  listLinks: vi.fn(),
}));
vi.mock('./ontology-source', () => ({
  fetchRulesForMatchResume: vi.fn(),
}));
vi.mock('@/server/llm/gateway', () => ({
  chatComplete: vi.fn(),
}));

import { getInstance, listInstances, listLinks } from './instance-client';
import { fetchRulesForMatchResume } from './ontology-source';
import { chatComplete } from '@/server/llm/gateway';
import { buildRuleCheckInput, runRuleCheck } from './runner';
import type { RuleCheckInput } from './types';

const mFetchRules = vi.mocked(fetchRulesForMatchResume);
const mChat = vi.mocked(chatComplete);
const mGetInst = vi.mocked(getInstance);
const mListInst = vi.mocked(listInstances);
const mListLinks = vi.mocked(listLinks);

beforeEach(() => {
  mFetchRules.mockReset();
  mChat.mockReset();
  mGetInst.mockReset();
  mListInst.mockReset();
  mListLinks.mockReset();
  process.env.ONTOLOGY_API_BASE = 'http://localhost:3500';
  process.env.ONTOLOGY_API_TOKEN = 'tok';
});
afterEach(() => {
  delete process.env.ONTOLOGY_API_BASE;
  delete process.env.ONTOLOGY_API_TOKEN;
});

function fakeInput(): RuleCheckInput {
  return {
    runtime_context: {
      upload_id: 'u',
      candidate_id: 'C-1',
      resume_id: 'r',
      employee_id: 'E',
    },
    resume: { name: '张三' },
    job_requisition: { job_requisition_id: 'JR-1', client_id: 'CLI_TENCENT_PCG' },
    job_requisition_specification: null,
    hsm_feedback: null,
  };
}

function mockGraphEmpty(): void {
  mGetInst.mockResolvedValue(null);
  mListInst.mockResolvedValue([]);
  mListLinks.mockResolvedValue([]);
}

function mockRulesOneStepOneRule(): void {
  mFetchRules.mockResolvedValue({
    rules: [
      {
        id: '10-25',
        specificScenarioStage: '',
        businessLogicRuleName: '华为荣耀',
        applicableClient: '通用',
        applicableDepartment: 'N/A',
        submissionCriteria: 'sc',
        standardizedLogicRule: 'logic',
        relatedEntities: [],
        businessBackgroundReason: '',
        ruleSource: '',
        executor: 'Agent',
        severity: 'terminal',
      },
    ],
    source: 'ontology-api',
    steps: [
      {
        step_id: '10::s1',
        order: 1,
        name: 'validateRedlineAndBlacklist',
        description: 'd',
        condition: 'c',
        rules: [
          {
            id: '10-25',
            specificScenarioStage: '',
            businessLogicRuleName: '华为荣耀',
            applicableClient: '通用',
            applicableDepartment: 'N/A',
            submissionCriteria: 'sc',
            standardizedLogicRule: 'logic',
            relatedEntities: [],
            businessBackgroundReason: '',
            ruleSource: '',
            executor: 'Agent',
            severity: 'terminal',
          },
        ],
      },
    ],
  });
}

describe('runRuleCheck — new MatchResumeCheckResult shape', () => {
  it('FAIL: folds to FAIL when stats.fail > 0', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        decision: 'FAIL',
        stats: { total: 1, pass: 0, fail: 1, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
        explanations: [
          { rule_id: '10-25', rule_name: '华为荣耀', step_id: '10::s1', status: 'fail', reason: 'hit' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 50,
      toolUseIterations: 0,
    });

    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.stats.fail).toBe(1);
    expect(out.explanations).toHaveLength(1);
    expect(out.audit.rule_source).toBe('ontology-api');
    expect(out.audit.fail_reason).toBeUndefined();
  });

  it('PASS: folds to PASS when no fail/pending/insufficient_info', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        decision: 'PASS',
        stats: { total: 1, pass: 1, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
        explanations: [],
      }),
      modelUsed: 'm',
      durationMs: 50,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('PASS');
  });

  it('REVIEW: folds to REVIEW on pending', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        decision: 'REVIEW',
        stats: { total: 1, pass: 0, fail: 0, pending: 1, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
        explanations: [
          { rule_id: '10-25', rule_name: '华为荣耀', step_id: '10::s1', status: 'pending', reason: 'needs HSM' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 30,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('REVIEW');
  });

  it('fail-safe FAIL when LLM returns invalid JSON', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: 'not json',
      modelUsed: 'm',
      durationMs: 5,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.audit.fail_reason).toBe('parse-error');
  });

  it('fail-safe FAIL when chatComplete rejects (gateway/network)', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockRejectedValueOnce(new Error('LLM gateway not configured'));
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.audit.fail_reason).toBe('llm-call-error');
  });

  it('fail-safe FAIL with ontology-graph-unavailable when getInstance throws 401', async () => {
    mockRulesOneStepOneRule();
    mGetInst.mockRejectedValueOnce(
      new Error('Ontology API getInstance(Candidate, C-1) -> 401. Body: unauthorized'),
    );
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.audit.fail_reason).toBe('ontology-graph-unavailable');
  });

  it('threads tools to chatComplete', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        decision: 'PASS',
        stats: { total: 1, pass: 1, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
        explanations: [],
      }),
      modelUsed: 'm',
      durationMs: 1,
      toolUseIterations: 1,
    });
    await runRuleCheck(fakeInput());
    const opts = mChat.mock.calls[0]?.[0] as {
      tools?: { schema: Array<{ function: { name: string } }> };
    };
    expect(opts.tools?.schema.map((t) => t.function.name).sort()).toEqual(
      ['get_instance', 'list_instances', 'list_links'].sort(),
    );
  });
});

describe('buildRuleCheckInput', () => {
  it('preserves the existing build helper', () => {
    const input = buildRuleCheckInput({
      runtime_context: {
        upload_id: 'u',
        candidate_id: 'c',
        resume_id: 'r',
        employee_id: 'e',
      },
      parsed_resume: { name: 'x' },
      job_requisition: { job_requisition_id: 'JR-x' },
    });
    expect(input.job_requisition.job_requisition_id).toBe('JR-x');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/rule-check/runner.test.ts
```

Expected: FAIL — `runRuleCheck` doesn't yet return the new shape; old import of `./llm` won't satisfy mocks of `@/server/llm/gateway`.

- [ ] **Step 3: Rewrite `lib/rule-check/runner.ts`**

Replace the entire content of `lib/rule-check/runner.ts` with:

```ts
// Rule check orchestrator — neo4j-aware matchResume evaluation.
//
//   buildRuleCheckInput()   -- 5-block input builder (unchanged)
//   runRuleCheck()          -- full pipeline:
//     dims → fetch rules → filter → build graph context →
//     compose prompt → chatComplete (with tools) → fold to MatchResumeCheckResult

import { applyClientFilter, extractDims } from './ontology';
import { fetchRulesForMatchResume } from './ontology-source';
import { buildGraphContext, createDispatcher } from './graph-context';
import {
  composeMatchResumePrompt,
  MATCH_RESUME_SYSTEM_PROMPT,
} from './prompt';
import { projectResume, fieldsProjected } from './resume-projection';
import type {
  MatchResumeCheckResult,
  MatchResumeCheckStats,
  MatchResumeStepGroup,
  RuleCheckInput,
  RuleCheckRuntimeContext,
  RuleExplanation,
} from './types';
import { chatComplete } from '@/server/llm/gateway';

const TOOL_SCHEMA = [
  {
    type: 'function' as const,
    function: {
      name: 'get_instance',
      description: 'Fetch one ontology instance by label + primary key value.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['label', 'value'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_instances',
      description: 'List instances of a label filtered by property equality.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          filters: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['label'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_links',
      description: 'List ontology links by from/to/type filters.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
  },
];

export interface BuildInputArgs {
  runtime_context: RuleCheckRuntimeContext;
  parsed_resume: Record<string, unknown> | null | undefined;
  job_requisition: Record<string, unknown>;
  job_requisition_specification?: Record<string, unknown> | null;
  hsm_feedback?: Record<string, unknown> | null;
}

export function buildRuleCheckInput(args: BuildInputArgs): RuleCheckInput {
  const jr = args.job_requisition;
  const jrid =
    typeof jr.job_requisition_id === 'string' && jr.job_requisition_id.trim()
      ? (jr.job_requisition_id as string)
      : '';
  return {
    runtime_context: args.runtime_context,
    resume: args.parsed_resume ?? {},
    job_requisition: { ...jr, job_requisition_id: jrid },
    job_requisition_specification: args.job_requisition_specification ?? null,
    hsm_feedback: args.hsm_feedback ?? null,
  };
}

function isPartialResumeEnabled(): boolean {
  return process.env.RULE_CHECK_PARTIAL_RESUME !== 'false';
}

function emptyStats(): MatchResumeCheckStats {
  return {
    total: 0,
    pass: 0,
    fail: 0,
    pending: 0,
    insufficient_info: 0,
    not_triggered: 0,
    not_executed: 0,
  };
}

function failSafe(
  reason: MatchResumeCheckResult['audit']['fail_reason'],
  base: Partial<MatchResumeCheckResult['audit']> = {},
): MatchResumeCheckResult {
  return {
    decision: 'FAIL',
    stats: emptyStats(),
    explanations: [],
    audit: {
      rules_evaluated: base.rules_evaluated ?? 0,
      graph_calls: base.graph_calls ?? 0,
      llm_model: base.llm_model ?? 'unknown',
      llm_duration_ms: base.llm_duration_ms ?? 0,
      llm_round_trips: base.llm_round_trips ?? 0,
      llm_prompt_tokens: base.llm_prompt_tokens,
      llm_completion_tokens: base.llm_completion_tokens,
      rule_source: base.rule_source ?? 'json-fallback',
      fail_reason: reason,
    },
  };
}

function parseLlmJson(
  text: string,
): { decision: string; stats?: unknown; explanations?: unknown } | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as { decision: string; stats?: unknown; explanations?: unknown };
  } catch {
    return null;
  }
}

function coerceStats(raw: unknown): MatchResumeCheckStats {
  const s = emptyStats();
  if (typeof raw !== 'object' || raw === null) return s;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(s) as (keyof MatchResumeCheckStats)[]) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) s[k] = v;
  }
  return s;
}

function coerceExplanations(raw: unknown): RuleExplanation[] {
  if (!Array.isArray(raw)) return [];
  const out: RuleExplanation[] = [];
  const allowed = new Set(['fail', 'pending', 'insufficient_info', 'not_executed']);
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.rule_id === 'string' &&
      typeof r.rule_name === 'string' &&
      typeof r.step_id === 'string' &&
      typeof r.status === 'string' &&
      allowed.has(r.status) &&
      typeof r.reason === 'string'
    ) {
      out.push({
        rule_id: r.rule_id,
        rule_name: r.rule_name,
        step_id: r.step_id,
        status: r.status as RuleExplanation['status'],
        reason: r.reason,
      });
    }
  }
  return out;
}

function foldDecision(stats: MatchResumeCheckStats): MatchResumeCheckResult['decision'] {
  if (stats.fail > 0) return 'FAIL';
  if (stats.pending > 0 || stats.insufficient_info > 0) return 'REVIEW';
  return 'PASS';
}

export async function runRuleCheck(
  input: RuleCheckInput,
): Promise<MatchResumeCheckResult> {
  const dims = extractDims(input.job_requisition);
  const sourceResult = await fetchRulesForMatchResume();
  const filtered = applyClientFilter(sourceResult.rules, dims);

  // Build the filtered Set groups by intersecting fetched steps with `filtered`.
  const filteredIds = new Set(filtered.map((r) => r.id));
  const filteredSteps: MatchResumeStepGroup[] = (sourceResult.steps ?? [])
    .map((s) => ({ ...s, rules: s.rules.filter((r) => filteredIds.has(r.id)) }))
    .filter((s) => s.rules.length > 0);

  // Pre-fetch graph context. Surface 401/502 as ontology-graph-unavailable.
  let graph;
  try {
    graph = await buildGraphContext({
      candidate_id: input.runtime_context.candidate_id,
      job_requisition_id:
        (input.job_requisition.job_requisition_id as string | undefined) ?? '',
    });
  } catch (err) {
    return failSafe('ontology-graph-unavailable', {
      rules_evaluated: filtered.length,
      rule_source: sourceResult.source,
    });
  }

  // Project resume (existing partial-projection logic).
  const projectedResume = isPartialResumeEnabled()
    ? projectResume(input.resume, filtered)
    : input.resume;
  // (we still call this to keep the audit field populated)
  void fieldsProjected(filtered);

  const userPrompt = composeMatchResumePrompt({
    input: { ...input, resume: projectedResume },
    graph,
    steps: filteredSteps,
  });

  const dispatcher = createDispatcher(graph);

  let llmResult;
  try {
    llmResult = await chatComplete({
      system: MATCH_RESUME_SYSTEM_PROMPT,
      user: userPrompt,
      tools: {
        schema: TOOL_SCHEMA,
        onToolCall: dispatcher,
        maxIterations: 5,
      },
    });
  } catch (err) {
    const msg = (err as Error).message ?? '';
    const reason: MatchResumeCheckResult['audit']['fail_reason'] = /tool-use loop/.test(msg)
      ? 'tool-use-loop-exceeded'
      : 'llm-call-error';
    return failSafe(reason, {
      rules_evaluated: filtered.length,
      graph_calls: graph.fetch_count,
      rule_source: sourceResult.source,
    });
  }

  const parsed = parseLlmJson(llmResult.text);
  if (!parsed) {
    return failSafe('parse-error', {
      rules_evaluated: filtered.length,
      graph_calls: graph.fetch_count,
      llm_model: llmResult.modelUsed,
      llm_duration_ms: llmResult.durationMs,
      llm_round_trips: llmResult.toolUseIterations,
      llm_prompt_tokens: llmResult.usage?.promptTokens,
      llm_completion_tokens: llmResult.usage?.completionTokens,
      rule_source: sourceResult.source,
    });
  }

  const stats = coerceStats(parsed.stats);
  const explanations = coerceExplanations(parsed.explanations);
  const decision = foldDecision(stats);

  return {
    decision,
    stats,
    explanations,
    audit: {
      rules_evaluated: filtered.length,
      graph_calls: graph.fetch_count,
      llm_model: llmResult.modelUsed,
      llm_duration_ms: llmResult.durationMs,
      llm_round_trips: llmResult.toolUseIterations,
      llm_prompt_tokens: llmResult.usage?.promptTokens,
      llm_completion_tokens: llmResult.usage?.completionTokens,
      rule_source: sourceResult.source,
    },
  };
}
```

- [ ] **Step 4: Run runner tests to verify they pass**

```bash
npx vitest run lib/rule-check/runner.test.ts
```

Expected: PASS — 8 cases.

- [ ] **Step 5: Update event payload types in `server/inngest/client.ts`**

Find the `RuleCheckAuditMeta`, `RuleCheckPassedData`, `RuleCheckFailedData` declarations. Replace them with:

```ts
export type RuleCheckAuditMeta = {
  rules_evaluated: number;
  graph_calls: number;
  client_id: string;
  business_group: string | null;
  studio: string | null;
  llm_model: string;
  llm_duration_ms: number;
  llm_round_trips: number;
  llm_prompt_tokens?: number;
  llm_completion_tokens?: number;
  rule_source: 'ontology-api' | 'json-fallback';
  fail_reason?: string;
};

export type RuleCheckPassedData = {
  upload_id: string;
  candidate_id?: string;
  resume_id?: string;
  job_requisition_id: string;
  client_id: string;
  audit: RuleCheckAuditMeta;
};

export type RuleCheckFailedData = {
  upload_id: string;
  candidate_id?: string;
  resume_id?: string;
  job_requisition_id: string;
  client_id: string;
  decision: 'FAIL' | 'REVIEW';
  failed_rules: Array<{
    rule_id: string;
    rule_name: string;
    step_id: string;
    status: 'fail' | 'pending' | 'insufficient_info' | 'not_executed';
    reason: string;
  }>;
  audit: RuleCheckAuditMeta;
};
```

(`hit_rules` field is renamed to `failed_rules` and the `severity` field is gone — explanations carry their own status.)

- [ ] **Step 6: Migrate `server/inngest/agents/match-resume-agent.ts`**

Replace the rule-check section (lines roughly 240-345 — find by searching for `runRuleCheck` invocation) with consumption of the new shape. The new section reads:

```ts
        const ruleCheckInput = buildRuleCheckInput({
          runtime_context: {
            upload_id: uploadId ?? '',
            candidate_id: candidateId ?? '',
            resume_id: dataResumeId,
            employee_id: employeeId,
            filename: dataFilename,
            received_at: dataReceivedAt,
            trace_id: traceId ?? null,
          },
          parsed_resume: parsedData ?? null,
          job_requisition: req as unknown as Record<string, unknown>,
        });
        const ruleCheck = await runRuleCheck(ruleCheckInput);
        logger.info(
          `[${AGENT_NAME}] rule-check · job_req=${jrid} decision=${ruleCheck.decision} ` +
            `stats=pass:${ruleCheck.stats.pass}/fail:${ruleCheck.stats.fail}/pending:${ruleCheck.stats.pending}/info:${ruleCheck.stats.insufficient_info} ` +
            `rules=${ruleCheck.audit.rules_evaluated} graph_calls=${ruleCheck.audit.graph_calls} ` +
            `model=${ruleCheck.audit.llm_model} latency_ms=${ruleCheck.audit.llm_duration_ms} ` +
            `tool_rounds=${ruleCheck.audit.llm_round_trips}` +
            (ruleCheck.audit.fail_reason ? ` fail_reason=${ruleCheck.audit.fail_reason}` : ''),
        );
        return ruleCheck;
      });

      const dims = extractDimsForAudit(req as unknown as Record<string, unknown>);
      const ruleCheckAuditMeta: RuleCheckAuditMeta = {
        rules_evaluated: ruleCheck.audit.rules_evaluated,
        graph_calls: ruleCheck.audit.graph_calls,
        client_id: dims.client_id,
        business_group: dims.business_group,
        studio: dims.studio,
        llm_model: ruleCheck.audit.llm_model,
        llm_duration_ms: ruleCheck.audit.llm_duration_ms,
        llm_round_trips: ruleCheck.audit.llm_round_trips,
        llm_prompt_tokens: ruleCheck.audit.llm_prompt_tokens,
        llm_completion_tokens: ruleCheck.audit.llm_completion_tokens,
        rule_source: ruleCheck.audit.rule_source,
        fail_reason: ruleCheck.audit.fail_reason,
      };

      const resumeIdForEvents = typeof data.resume_id === 'string' ? data.resume_id : undefined;

      if (ruleCheck.decision !== 'PASS') {
        const failedPayload: RuleCheckFailedData = {
          upload_id: uploadId ?? '',
          candidate_id: candidateId ?? undefined,
          resume_id: resumeIdForEvents,
          job_requisition_id: jrid,
          client_id: pickClientId(req),
          decision: ruleCheck.decision,
          failed_rules: ruleCheck.explanations.map((e) => ({
            rule_id: e.rule_id,
            rule_name: e.rule_name,
            step_id: e.step_id,
            status: e.status,
            reason: e.reason,
          })),
          audit: ruleCheckAuditMeta,
        };
        await step.sendEvent(`emit-rule-check-failed-${stepKey}`, {
          name: 'RULE_CHECK_FAILED',
          data: failedPayload,
        });
        const reasonSummary = ruleCheck.explanations
          .filter((e) => e.status === 'fail' || e.status === 'pending')
          .map((e) => `${e.rule_id}:${e.status}`)
          .join(',');
        logger.info(
          `[${AGENT_NAME}] ⛔ RULE_CHECK_FAILED · job_req=${jrid} ` +
            `decision=${ruleCheck.decision} reasons=${reasonSummary || '(none)'} — skip matchResume`,
        );
        summaries.push({
          job_requisition_id: jrid,
          ok: false,
          error: `rule-check-${ruleCheck.decision.toLowerCase()}: ${reasonSummary || ruleCheck.audit.fail_reason || ''}`,
        });
        continue;
      }

      const passedPayload: RuleCheckPassedData = {
        upload_id: uploadId ?? '',
        candidate_id: candidateId ?? undefined,
        resume_id: resumeIdForEvents,
        job_requisition_id: jrid,
        client_id: pickClientId(req),
        audit: ruleCheckAuditMeta,
      };
      await step.sendEvent(`emit-rule-check-passed-${stepKey}`, {
        name: 'RULE_CHECK_PASSED',
        data: passedPayload,
      });
      logger.info(
        `[${AGENT_NAME}] ✓ RULE_CHECK_PASSED · job_req=${jrid} — proceed to matchResume`,
      );

      } // end if (isRuleCheckEnabled())
```

ALSO at the top of the file, add this import line near the existing rule-check import:

```ts
import { extractDims as extractDimsForAudit } from '@/lib/rule-check/ontology';
```

REMOVE the block that used `pendingAugmentation` (lines that referenced `ruleCheck.resume_augmentation` and the `process.env.RULE_CHECK_AUGMENT_RESUME` switch). Find the section starting around "Kenny §3" and delete the augmentation usage. Specifically:

Delete:
```ts
      // Kenny §3:把 LLM 输出的 resume_augmentation markdown 段记下来,
      // 4a step 调 Robohire 时拼到 resume 顶部。env kill switch:
      // RULE_CHECK_AUGMENT_RESUME=false → 不注入(走原 resume,gate 仍生效)
      if (
        ruleCheck.resume_augmentation &&
        process.env.RULE_CHECK_AUGMENT_RESUME !== 'false'
      ) {
        pendingAugmentation = ruleCheck.resume_augmentation;
        logger.info(
          `[${AGENT_NAME}] augmentation ready · job_req=${jrid} ` +
            `chars=${pendingAugmentation.length}`,
        );
      }
```

And in the `match-${stepKey}` step that follows, replace `augmentedResumeText` usage so it just sends `resumeText` directly:

Delete the `augmentedResumeText` variable entirely; replace all of its usages downstream with `resumeText` directly. Then search the file for `pendingAugmentation` and `RULE_CHECK_AUGMENT_RESUME` and delete the dead declarations (the variable was only written under the Kenny §3 block you just removed).

- [ ] **Step 7: Run the full test suite**

```bash
npm test
```

Expected: existing tests still green; `lib/rule-check/` 8 new runner cases pass; pre-existing unrelated failures in `server/em/publish.test.ts`, `app/api/...` are unchanged.

- [ ] **Step 8: Run the production build**

```bash
npm run build
```

Expected: typecheck + lint succeed.

- [ ] **Step 9: Commit**

```bash
git add lib/rule-check/runner.ts lib/rule-check/runner.test.ts \
  server/inngest/agents/match-resume-agent.ts server/inngest/client.ts
git commit -m "$(cat <<'EOF'
feat(rule-check): cut runRuleCheck over to neo4j-aware pipeline

runRuleCheck now returns MatchResumeCheckResult { decision, stats,
explanations, audit }. Internal pipeline: dims → fetchRules (with grouped
steps) → applyClientFilter → buildGraphContext (5 parallel fetches) →
composeMatchResumePrompt → chatComplete with tool-use loop → fold to
PASS/REVIEW/FAIL. matchResumeAgent and inngest event payloads migrated
to the new shape; resume_augmentation pathway removed.

Fail-safe FAIL cases: parse-error, llm-call-error, ontology-graph-
unavailable, tool-use-loop-exceeded — each surfaces via audit.fail_reason.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Spot-check end-to-end (manual, optional)

**Files:** none modified.

- [ ] **Step 1: Start the ontology service + the dev server**

```bash
# Terminal 1
cd <ontology-studio-checkout> && npm run dev   # port 3500

# Terminal 2 — make sure env vars are exported to your shell:
export ONTOLOGY_API_BASE=http://localhost:3500
export ONTOLOGY_API_TOKEN=abc12345def
export AI_BASE_URL=<your-gateway>
export AI_API_KEY=<your-key>
```

- [ ] **Step 2: Invoke `runRuleCheck` via a one-shot script**

Use the existing `scripts/run-match-resume-prompt.ts` as a template; create a new `scripts/run-match-resume-rule-check.ts` (uncommitted; this step doesn't add it to the repo):

```ts
import { runRuleCheck } from '@/lib/rule-check';

async function main() {
  const out = await runRuleCheck({
    runtime_context: {
      upload_id: 'u_demo',
      candidate_id: 'C-100023',
      resume_id: 'r_demo',
      employee_id: 'EMP_001',
    },
    resume: { name: '张三' /* …structured parsed resume */ },
    job_requisition: { job_requisition_id: 'JR-2026-001', client_id: 'CLI_TENCENT_PCG' },
    job_requisition_specification: null,
    hsm_feedback: null,
  });
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Run: `npx tsx scripts/run-match-resume-rule-check.ts`

Verify the printed `MatchResumeCheckResult` matches expectations (decision + stats + explanations populated; audit shows non-zero `graph_calls`). This is a sanity check, not a gate — the unit tests already cover correctness.

- [ ] **Step 3: Skip the commit** — the script is a local dev helper.

---

## Task 9: Cleanup — delete old types, llm.ts, old composer

**Files:**
- Modify: `lib/rule-check/types.ts` (delete `RuleCheckVerdict`, `RuleFlag`, `LlmRuleCheckOutput`)
- Modify: `lib/rule-check/prompt.ts` (delete old `composePrompt`, `RULE_CHECK_SYSTEM_PROMPT`)
- Modify: `lib/rule-check/index.ts` (drop old re-exports)
- Modify: `lib/rule-check/yeyang-runner.ts` (delete the whole file — or leave if still referenced; check Task 9 prep below)
- Delete: `lib/rule-check/llm.ts`

- [ ] **Step 1: Search for any remaining consumers of the old surface**

```bash
grep -rn "RuleCheckVerdict\|RuleFlag\|LlmRuleCheckOutput\|runLlm\|composePrompt\|RULE_CHECK_SYSTEM_PROMPT\|yeyang-runner\|runRuleCheckYeyang\|resume_augmentation" \
  /Users/chenyang/projects/agenticOperator \
  --include="*.ts" --include="*.tsx" \
  | grep -v "/node_modules/\|/__tests__/\|/scripts/rule-check-poc/\|/docs/superpowers/"
```

Expected: matches only inside `lib/rule-check/` itself (files being cleaned up). If anything outside hits, address before deleting.

- [ ] **Step 2: Delete `lib/rule-check/llm.ts`**

```bash
git rm lib/rule-check/llm.ts
```

- [ ] **Step 3: Remove old types from `lib/rule-check/types.ts`**

Delete the `Severity`, `Rule`, `OntologyDims`, `ClassifiedRules`, `RuleFlag`, `LlmRuleCheckOutput`, `RuleCheckVerdict` declarations ONLY IF unused elsewhere. Per the grep above, `Severity`, `Rule`, `OntologyDims`, `ClassifiedRules` are still used by `ontology.ts` and `prompt.ts` (Set-rendering keeps `Rule`). Delete ONLY:

- `RuleFlag`
- `LlmRuleCheckOutput`
- `RuleCheckVerdict`

- [ ] **Step 4: Remove old prompt composer from `lib/rule-check/prompt.ts`**

Delete:
- The old `composePrompt(args)` exported function
- `RULE_CHECK_SYSTEM_PROMPT` export
- Any private helpers used only by it: `renderInputsSection` (the v1), `renderRulesSection` (the v1), `renderRuleGroup`, `renderSingleRule`, `severityToResult`, `severityToActionHint`, `SEVERITY_TAG`, `HEADER`, `ROLE_SECTION`, `DECISION_LOGIC_SECTION`, `OUTPUT_SCHEMA_SECTION`, `SELF_CHECK_SECTION`.

Keep:
- The new `composeMatchResumePrompt` + `MATCH_RESUME_SYSTEM_PROMPT` from Task 6.
- `renderInputsSectionV2`, `renderGraphSection`, `renderRulesSection`, `renderStepBlock`, `renderRuleBlock`, `renderGraphSlot`, `STRICT_ORDER_BLOCK`, `OUTPUT_SCHEMA_MATCH_RESUME`, `DECISION_FOLD_BLOCK`, `SELF_CHECK_MATCH_RESUME`.

- [ ] **Step 5: Delete `lib/rule-check/yeyang-runner.ts` and its test if present**

```bash
ls lib/rule-check/yeyang-runner.ts lib/rule-check/yeyang/* 2>/dev/null
```

If present and unused (the new `runner.ts` no longer imports it), remove:

```bash
git rm lib/rule-check/yeyang-runner.ts
# remove yeyang/ subdirectory if it exists
git rm -r lib/rule-check/yeyang 2>/dev/null || true
```

Also remove the `RULE_CHECK_PROMPT_SOURCE` env switch references (search for `RULE_CHECK_PROMPT_SOURCE` and clean up).

- [ ] **Step 6: Update `lib/rule-check/index.ts` to drop old exports**

Replace with:

```ts
export { buildRuleCheckInput, runRuleCheck } from './runner';
export type {
  MatchResumeCheckResult,
  MatchResumeCheckStats,
  MatchResumeStepGroup,
  RuleCheckInput,
  RuleCheckRuntimeContext,
  RuleExplanation,
  RuleStatus,
  Severity,
} from './types';
```

- [ ] **Step 7: Run tests + build**

```bash
npm test
npm run build
```

Expected: PASS — no regressions, no new TS errors.

- [ ] **Step 8: Commit**

```bash
git add -A lib/rule-check/
git commit -m "$(cat <<'EOF'
chore(rule-check): remove RuleCheckVerdict-era code

After the neo4j-aware cutover landed, the v1 surface is unused. Delete:
- lib/rule-check/llm.ts (replaced by chatComplete)
- old types: RuleFlag, LlmRuleCheckOutput, RuleCheckVerdict
- old prompt composer (composePrompt + RULE_CHECK_SYSTEM_PROMPT)
- yeyang-runner.ts + RULE_CHECK_PROMPT_SOURCE env switch

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Final verification (full test + build + smoke grep)

**Files:** none modified by default.

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: every test green except the pre-existing failures in `server/em/publish.test.ts`, `app/api/alerts/route.test.ts`, `app/api/runs/[id]/route.test.ts`, `app/api/human-tasks/route.test.ts` (these were already failing on `steven` and are out of scope for this branch).

- [ ] **Step 2: Run the production build**

```bash
npm run build
```

Expected: success.

- [ ] **Step 3: Smoke-check exports**

```bash
grep -n "export async function runRuleCheck\|export function buildRuleCheckInput" lib/rule-check/runner.ts
grep -n "export type MatchResumeCheckResult\|export type MatchResumeStepGroup\|export type RuleExplanation\|export type RuleStatus" lib/rule-check/types.ts
grep -n "export function composeMatchResumePrompt\|export const MATCH_RESUME_SYSTEM_PROMPT" lib/rule-check/prompt.ts
grep -n "export async function getInstance\|export async function listInstances\|export async function listLinks" lib/rule-check/instance-client.ts
grep -n "export async function buildGraphContext\|export function createDispatcher" lib/rule-check/graph-context.ts
grep -n "tools?: ChatToolsOptions\|toolUseIterations" server/llm/gateway.ts
```

Expected: all hits present.

- [ ] **Step 4: No commit needed** unless previous tasks left adjustments.

---

## Done criteria

- [ ] `runRuleCheck(input)` returns `MatchResumeCheckResult` and is the only public surface from `lib/rule-check/`.
- [ ] All vitest cases in `lib/rule-check/*.test.ts` and `server/llm/gateway.test.ts` pass.
- [ ] `npm run build` is green.
- [ ] `lib/rule-check/llm.ts` no longer exists; `chatComplete` is the LLM entry point.
- [ ] `server/inngest/agents/match-resume-agent.ts` consumes the new result shape; `resume_augmentation` pathway is removed.
- [ ] `server/inngest/client.ts` event payloads updated (`RuleCheckAuditMeta`, `RuleCheckFailedData`).
- [ ] Branch is ready for PR back to `steven`.
