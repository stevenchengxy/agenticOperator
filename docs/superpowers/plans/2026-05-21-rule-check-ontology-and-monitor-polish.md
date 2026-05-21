# Rule Check ontology 实时化 + Monitor polish — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore DLQ tab on `/monitor`, inject RuleCheck node into workflow topology, switch Rule Check dashboard to real-time ontology data, rework audit detail drawer UI, and finish i18n cleanup.

**Architecture:** Six independent, sequentially-shipped UI / API changes against the existing Next.js 16.2 App Router codebase. No new infra; reuses `fetchAction(matchResume)` for Neo4j ontology, `AGENT_MAP` registry for RuleCheck node metadata, and existing `InngestDlqTab` / `DLQPanel` components.

**Tech Stack:** Next.js 16.2 (App Router · Turbopack) · React 19.2 · Tailwind v4.2 (OKLCH tokens, no tailwind.config.ts) · TypeScript 5 · vitest + happy-dom. Neo4j `:7688` via `lib/ontology-gen/fetch.ts`; Postgres via `prisma`.

**Source spec:** [docs/superpowers/specs/2026-05-21-rule-check-ontology-and-monitor-polish-design.md](../specs/2026-05-21-rule-check-ontology-and-monitor-polish-design.md)

**Commands you will run repeatedly:**
- `npm test -- <pattern>` — vitest run (no watch by default)
- `npm run build` — full Next.js typecheck + lint + build (slow; run before commit)
- `npm run lint` — fast lint only
- `npm run dev` — dev server on **:3002** (not 3000)

---

## File Structure

### Chunk 1 — α1 + α2 (Monitor DLQ tab + RuleCheck topology node)

- **Modify** [components/monitor/MonitorContent.tsx](../../components/monitor/MonitorContent.tsx) — add `?tab=runs|dlq` URL param + tab nav + conditional render of `<InngestDlqTab />`
- **Modify** [lib/workflow-graph-meta.ts](../../lib/workflow-graph-meta.ts) — inject RuleCheck node (`wsId: '10-5'`), shift columns 5-8 right by 150px, expand viewBox to 2350×800, add canonical-fallback edge resolver, register `MATCH_RULE_CHECK_*` label map, add `'10-5'` to `RPA_OWNED_WSIDS`
- **Modify** [lib/workflow-graph-meta.test.ts](../../lib/workflow-graph-meta.test.ts) — 23 → 24 node count, viewBox 2200 → 2350, deployment count 3 → 4
- **Modify** [lib/i18n.tsx](../../lib/i18n.tsx) — verify `monitor_tab_runs` exists (add if missing), use existing `monitor_tab_dlq`

### Chunk 2 — β1 + β2 (Ontology rules API + Dashboard real-time)

- **Create** `app/api/ontology/rules/route.ts` — `GET` handler wrapping `fetchRulesForMatchResume()`, `revalidate: 30`
- **Create** `app/api/ontology/rules/route.test.ts` — mocked ontology-source coverage
- **Modify** [components/rule-check/RuleCheckDashboardContent.tsx](../../components/rule-check/RuleCheckDashboardContent.tsx) — fetch ontology rules state + 30s polling, switch grid row source from `matrix.rules` to ontology full set, add dead-rule sort + badge, add coverage KPI, add fallback warn badge
- **Modify** [lib/i18n.tsx](../../lib/i18n.tsx) — add `rc_rule_dead`, `rc_kpi_coverage`, `rc_rules_fallback_warn`, `rc_rules_source_api`, `rc_rules_source_fallback`

### Chunk 3 — β3 + β4 (Drawer rework + i18n cleanup)

- **Modify** [components/rule-check/RuleCheckAuditDetailDrawer.tsx](../../components/rule-check/RuleCheckAuditDetailDrawer.tsx) — DecisionBanner serif redesign, 3-col KV grid, callout extraction for `failure_reasons` / `parse_error`, unified `<DrawerSection>` shell across 4 tabs, Replay button move
- **Modify** [lib/i18n.tsx](../../lib/i18n.tsx) — replace ~30-50 hardcoded Chinese strings with `rc_*` keys (zh + en)

---

## Chunk 1: Monitor DLQ tab + RuleCheck topology node

### Task 1.1: Restore DLQ tab on `/monitor`

**Files:**
- Modify: [components/monitor/MonitorContent.tsx](../../components/monitor/MonitorContent.tsx)
- Read: [components/monitor/InngestDlqTab.tsx](../../components/monitor/InngestDlqTab.tsx) (already exists, no edit)

- [ ] **Step 1: Add `?tab=runs|dlq` URL param + tab nav to `MonitorContent.tsx`**

Add near the existing `agentFilter` / `statusFilter` URL state reads (~line 50):

```ts
type TabId = "runs" | "dlq";
const tab: TabId = (sp.get("tab") === "dlq" ? "dlq" : "runs");
```

Add a setter helper near `setUrl`:

```ts
const setTab = (next: TabId) => setUrl((p) => {
  if (next === "runs") p.delete("tab");
  else p.set("tab", next);
});
```

In the render body, just before the existing filter chips / run table block, add a tab nav (use the same `border-b` underline pattern as `RuleCheckPageContent.tsx:53-71`):

```tsx
<div className="flex items-center gap-1 border-b border-line" style={{ padding: "0 32px" }}>
  {(["runs", "dlq"] as TabId[]).map((id) => (
    <button
      key={id}
      onClick={() => setTab(id)}
      className="transition-colors"
      style={{
        padding: "10px 14px",
        borderBottom: tab === id ? "1.5px solid var(--c-ink-1)" : "1.5px solid transparent",
        color: tab === id ? "var(--c-ink-1)" : "var(--c-ink-3)",
        fontWeight: tab === id ? 500 : 400,
        fontSize: 13,
        marginBottom: -1,
      }}
    >
      {t(id === "runs" ? "monitor_tab_runs" : "monitor_tab_dlq")}
    </button>
  ))}
</div>
```

Then wrap the existing run-list body in a `{tab === "runs" && (…)}` conditional and add the DLQ tab body in a sibling block:

```tsx
{tab === "dlq" && (
  <div style={{ padding: "20px 32px" }}>
    <InngestDlqTab />
  </div>
)}
```

Import at top: `import { InngestDlqTab } from "./InngestDlqTab";` and `const { t } = useApp();` (if not already destructured — verify).

- [ ] **Step 2: Verify `monitor_tab_runs` exists in `lib/i18n.tsx`**

Run: `grep -n 'monitor_tab_runs\|monitor_tab_dlq' lib/i18n.tsx`
Expected: both keys exist in both `zh` and `en` dictionaries.

If `monitor_tab_runs` is missing, add it next to `monitor_tab_dlq`:
- zh: `monitor_tab_runs: "Runs",`
- en: `monitor_tab_runs: "Runs",`

- [ ] **Step 3: Lint + typecheck**

Run: `npm run lint && npm run build`
Expected: no errors. (Build is slow — ~30-90s.)

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev` (port 3002)
Open: http://localhost:3002/monitor
Expected:
- Two tabs visible: `Runs` (default) / `DLQ`
- Clicking `DLQ` switches URL to `/monitor?tab=dlq` and renders DLQ list (or empty-state if no DLQ entries)
- Browser back/forward preserves tab state

- [ ] **Step 5: Commit**

```bash
git add components/monitor/MonitorContent.tsx lib/i18n.tsx
git commit -m "feat(monitor): restore DLQ tab next to Runs (?tab=dlq)"
```

---

### Task 1.2: Add RuleCheck node — graph-meta scaffolding

**Files:**
- Modify: [lib/workflow-graph-meta.ts](../../lib/workflow-graph-meta.ts)
- Test: [lib/workflow-graph-meta.test.ts](../../lib/workflow-graph-meta.test.ts)

- [ ] **Step 1: Update the failing test first (TDD)**

Edit [lib/workflow-graph-meta.test.ts](../../lib/workflow-graph-meta.test.ts):

```ts
// Change line 6-8:
it('viewBox is 2350x800 (8-column tree with RuleCheck injected)', () => {
  expect(GRAPH_VIEWBOX).toBe('0 0 2350 800');
  expect(GRAPH_WIDTH).toBe(2350);
  expect(GRAPH_HEIGHT).toBe(800);
});

// Change "23 nodes" assertion to "24 nodes" with note:
it('has 24 nodes (22 canonical + ruleCheck synthetic + trig)', () => {
  expect(NODES).toHaveLength(24);
  expect(nodeById('ruleCheck')?.wsId).toBe('10-5');
});

// Change "deployed nodes are exactly the 3 RPA-owned wsIds":
it('deployed nodes are 4 RPA-owned wsIds (incl. RuleCheck)', () => {
  const deployed = NODES.filter(n => n.deployment === 'deployed');
  expect(deployed).toHaveLength(4);
  const wsIds = deployed.map(n => n.wsId).sort();
  expect(wsIds).toEqual(['10', '10-5', '4', '9-1']);
});
```

Add a new test:

```ts
it('ruleCheck has both PASSED and FAILED outbound edges', () => {
  const out = EDGES.filter(e => e.from === 'ruleCheck');
  const events = out.map(e => e.eventName).sort();
  expect(events).toContain('MATCH_RULE_CHECK_PASSED');
  expect(events).toContain('MATCH_RULE_CHECK_FAILED');
  // FAILED is exceptional → dashed
  const failedEdge = out.find(e => e.eventName === 'MATCH_RULE_CHECK_FAILED');
  expect(failedEdge?.dashed).toBe(true);
});

it('resumeParser → ruleCheck edge exists (replacing direct → matcher)', () => {
  const direct = EDGES.find(e => e.from === 'resumeParser' && e.to === 'matcher');
  expect(direct).toBeUndefined(); // no longer direct
  const viaRC = EDGES.find(e => e.from === 'resumeParser' && e.to === 'ruleCheck');
  expect(viaRC?.eventName).toBe('RESUME_PROCESSED');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- workflow-graph-meta`
Expected: 6 failures (viewBox / 23 vs 24 / 3 vs 4 deployed / 2 new edge tests / resumeParser edge no longer direct).

- [ ] **Step 3: Update `lib/workflow-graph-meta.ts` — viewBox + RPA set**

```ts
// Line 64 — expand RPA set:
const RPA_OWNED_WSIDS = new Set(['4', '9-1', '10', '10-5']);

// Lines 103-105 — bump viewBox to 2350:
export const GRAPH_VIEWBOX = '0 0 2350 800' as const;
export const GRAPH_WIDTH = 2350 as const;
export const GRAPH_HEIGHT = 800 as const;
```

- [ ] **Step 4: Insert RuleCheck node + shift columns 5-8 right by 150px**

Replace the NODE_LAYOUT entries in [lib/workflow-graph-meta.ts](../../lib/workflow-graph-meta.ts) Col 4 onward:

```ts
  // ── Col 4: RESUME PROCESSING ─────────────────────────────────────────────
  { id: 'resumeCollector',  wsId: '8',     x: 920,  y: 240, kind: 'hitl',    icon: 'db'       },
  { id: 'resumeParser',     wsId: '9-1',   x: 920,  y: 400, kind: 'agent',   icon: 'cpu'      },
  { id: 'resumeFixer',      wsId: '9-2',   x: 920,  y: 560, kind: 'hitl',    icon: 'user'     },

  // ── Col 4.5: RULE CHECK (AO-owned, not in canonical JSON) ────────────────
  { id: 'ruleCheck',        wsId: '10-5',  x: 1070, y: 400, kind: 'agent',   icon: 'shield'   },

  // ── Col 5: MATCHING ──────────────────────────────────────────────────────
  { id: 'matcher',          wsId: '10',    x: 1370, y: 400, kind: 'agent',   icon: 'sparkle'  },

  // ── Col 6: INTERVIEW & EVAL ──────────────────────────────────────────────
  { id: 'interviewInviter', wsId: '11-1',  x: 1670, y: 240, kind: 'agent',   icon: 'mail'     },
  { id: 'aiInterviewer',    wsId: '11-2',  x: 1670, y: 400, kind: 'hitl',    icon: 'sparkle'  },
  { id: 'evaluator',        wsId: '12',    x: 1670, y: 560, kind: 'agent',   icon: 'cpu'      },

  // ── Col 7: PACKAGE ───────────────────────────────────────────────────────
  { id: 'resumeRefiner',    wsId: '13',    x: 1970, y: 160, kind: 'agent',   icon: 'sparkle'  },
  { id: 'packageBuilder',   wsId: '14-1',  x: 1970, y: 320, kind: 'agent',   icon: 'book'     },
  { id: 'packageFiller',    wsId: '14-2',  x: 1970, y: 480, kind: 'hitl',    icon: 'user'     },
  { id: 'packageReviewer',  wsId: '15',    x: 1970, y: 640, kind: 'hitl',    icon: 'shield'   },

  // ── Col 8: SUBMIT ────────────────────────────────────────────────────────
  { id: 'portalSubmitter',  wsId: '16',    x: 2230, y: 400, kind: 'agent',   icon: 'mail'     },
```

- [ ] **Step 5: Register RuleCheck in TITLE_BY_WSID**

In the `TITLE_BY_WSID` block (~lines 173-197), add after `'9-2': 'ResumeFixer',`:

```ts
  '10-5':  'RuleCheck',
```

- [ ] **Step 6: Add canonical-fallback edge resolver**

Replace the inner of `buildEdges()` so it derives triggers/emits from `AGENT_MAP` when `CANONICAL_BY_WSID` has no entry.

Add import at top of file (after existing imports):
```ts
import { AGENT_MAP } from './agent-mapping';
```

Refactor `buildEdges` (~lines 250-300). Replace the body with:

```ts
function getEdgeMeta(layout: NodeLayout): { triggers: string[]; emits: string[] } {
  const canon = CANONICAL_BY_WSID.get(layout.wsId);
  if (canon) return { triggers: canon.trigger, emits: canon.triggered_event };
  // AO-owned synthetic node (e.g. RuleCheck wsId 10-5) — fall back to AGENT_MAP registry.
  const agentMeta = AGENT_MAP.find((a) => a.wsId === layout.wsId);
  if (agentMeta) {
    return { triggers: agentMeta.triggersEvents, emits: agentMeta.emitsEvents };
  }
  return { triggers: [], emits: [] };
}

function buildEdges(): WorkflowEdge[] {
  const edges: WorkflowEdge[] = [];

  // Build a map: eventName → list of node ids that consume it
  const CONSUMER_BY_EVENT: Map<string, string[]> = new Map();
  for (const layout of NODE_LAYOUT) {
    if (layout.wsId === 'trig') continue;
    const { triggers } = getEdgeMeta(layout);
    for (const ev of triggers) {
      if (!CONSUMER_BY_EVENT.has(ev)) CONSUMER_BY_EVENT.set(ev, []);
      CONSUMER_BY_EVENT.get(ev)!.push(layout.id);
    }
  }

  // Synthetic trigger node → nodes subscribed to SCHEDULED_SYNC
  const externalTriggerEvents = ['SCHEDULED_SYNC'];
  for (const ev of externalTriggerEvents) {
    for (const consumerId of CONSUMER_BY_EVENT.get(ev) ?? []) {
      edges.push({ from: 'trig', to: consumerId, eventName: ev, dashed: false });
    }
  }

  // For each emitting node, find consumers of its emitted events
  for (const layout of NODE_LAYOUT) {
    if (layout.wsId === 'trig') continue;
    const { emits } = getEdgeMeta(layout);
    for (const emittedEvent of emits) {
      const consumers = CONSUMER_BY_EVENT.get(emittedEvent) ?? [];
      for (const consumerId of consumers) {
        const dashed = isExceptionalEvent(emittedEvent);
        edges.push({
          from: layout.id,
          to: consumerId,
          eventName: emittedEvent,
          dashed,
          label: EDGE_LABEL_MAP[emittedEvent],
        });
      }
    }
  }

  return edges;
}
```

Also update `computeTerminalEvents()` (lines 316-331) to use `getEdgeMeta`:

```ts
function computeTerminalEvents(): Set<string> {
  const allEmits = new Set<string>();
  const consumed = new Set<string>();
  for (const layout of NODE_LAYOUT) {
    if (layout.wsId === 'trig') continue;
    const { triggers, emits } = getEdgeMeta(layout);
    for (const ev of emits) allEmits.add(ev);
    for (const ev of triggers) consumed.add(ev);
  }
  const terminal = new Set<string>();
  for (const ev of allEmits) {
    if (!consumed.has(ev)) terminal.add(ev);
  }
  return terminal;
}
```

- [ ] **Step 7: Add edge labels for MATCH_RULE_CHECK_***

In `EDGE_LABEL_MAP` (~lines 225-236), insert:

```ts
  'MATCH_RULE_CHECK_PASSED':     '规则通过',
  'MATCH_RULE_CHECK_FAILED':     '规则拦截',
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- workflow-graph-meta`
Expected: all green. If `Matcher` triggers assertion still complains, double-check that [lib/agent-mapping.ts:51](../../lib/agent-mapping.ts) has `triggersEvents: ['MATCH_RULE_CHECK_PASSED']` (it does per current code) so resumeParser→matcher edge naturally disappears.

- [ ] **Step 9: Lint + build**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 10: Visual smoke test**

Run: `npm run dev`
Open: http://localhost:3002/workflow
Expected:
- RuleCheck node sits at x≈1070 between ResumeParser and Matcher
- Solid edge `resumeParser → ruleCheck` labeled with `RESUME_PROCESSED`
- Solid edge `ruleCheck → matcher` labeled `规则通过`
- Dashed edge from `ruleCheck` (no consumer for `MATCH_RULE_CHECK_FAILED` → terminal) — may not render visible "to" target if dashed-to-terminal not drawn, that's OK as long as the test passes
- Header count `已注册 / 蓝图` updates to include RuleCheck
- Right-most node `portalSubmitter` is still inside the viewBox

- [ ] **Step 11: Commit**

```bash
git add lib/workflow-graph-meta.ts lib/workflow-graph-meta.test.ts
git commit -m "feat(workflow): inject RuleCheck node into topology graph"
```

---

### Task 1.3: Verify `workflow-meta.test.ts` still passes

**Files:**
- Test: [lib/workflow-meta.test.ts](../../lib/workflow-meta.test.ts)

- [ ] **Step 1: Run the sibling test**

Run: `npm test -- workflow-meta`
Expected: all green. If it asserts node count or canonical structure, those should be unaffected because we did NOT edit `workflow-canonical.json` — only `workflow-graph-meta.ts`.

- [ ] **Step 2: If it fails, fix the assertion**

Most likely cause: a test that counts `AGENT_MAP` entries vs canonical nodes. RuleCheck is in AGENT_MAP but not canonical — that asymmetry is intentional. If a test enforces 1:1, relax to "all canonical wsIds exist in AGENT_MAP" without the reverse.

- [ ] **Step 3: Commit if you had to fix anything**

```bash
git add lib/workflow-meta.test.ts
git commit -m "test(workflow-meta): allow AO-only agents (RuleCheck) in registry"
```

---

## Chunk 2: Ontology rules API + Dashboard real-time

### Task 2.1: New `GET /api/ontology/rules` route + test

**Files:**
- Create: `app/api/ontology/rules/route.ts`
- Create: `app/api/ontology/rules/route.test.ts`

- [ ] **Step 1: Write failing test first**

Create `app/api/ontology/rules/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the underlying fetcher BEFORE importing the route handler.
vi.mock('@/lib/rule-check/ontology-source', () => ({
  fetchRulesForMatchResume: vi.fn(),
}));

import { fetchRulesForMatchResume } from '@/lib/rule-check/ontology-source';
import { GET } from './route';

const mockFetch = vi.mocked(fetchRulesForMatchResume);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('GET /api/ontology/rules', () => {
  it('returns rules from ontology-api on success', async () => {
    mockFetch.mockResolvedValue({
      rules: [{ id: 'R-001', name: 'rule one' } as any],
      source: 'ontology-api',
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.rules).toHaveLength(1);
    expect(body.source).toBe('ontology-api');
    expect(body.fetched_at).toEqual(expect.any(String));
  });

  it('returns json-fallback source when ontology API unavailable', async () => {
    mockFetch.mockResolvedValue({
      rules: [{ id: 'R-002', name: 'rule two' } as any],
      source: 'json-fallback',
      api_error: 'ECONNREFUSED',
    });
    const res = await GET();
    const body = await res.json();
    expect(body.source).toBe('json-fallback');
    expect(body.api_error).toBe('ECONNREFUSED');
  });

  it('forwards drift report when present', async () => {
    mockFetch.mockResolvedValue({
      rules: [],
      source: 'ontology-api',
      drift: { only_in_api: ['R-X'], only_in_json: [] },
    });
    const res = await GET();
    const body = await res.json();
    expect(body.drift).toEqual({ only_in_api: ['R-X'], only_in_json: [] });
  });

  it('500 + ok:false when fetcher throws', async () => {
    mockFetch.mockRejectedValue(new Error('boom'));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('boom');
  });
});
```

- [ ] **Step 2: Run the test — expect MODULE NOT FOUND**

Run: `npm test -- app/api/ontology/rules/route.test`
Expected: fail with "Cannot find module './route'"

- [ ] **Step 3: Create the route handler**

Create `app/api/ontology/rules/route.ts`:

```ts
// GET /api/ontology/rules
//
// Lists ALL matchResume rules — used by the Rule Check Dashboard hero
// grid to show the ontology full set (including Dead Rules that never
// fire in any audit window). Wraps fetchRulesForMatchResume which
// already handles the ontology-api → JSON fallback flow.

import { NextResponse } from 'next/server';
import { fetchRulesForMatchResume } from '@/lib/rule-check/ontology-source';

export const revalidate = 30; // 30s server-side ISR

export async function GET(): Promise<Response> {
  try {
    const result = await fetchRulesForMatchResume();
    return NextResponse.json({
      ok: true,
      rules: result.rules,
      source: result.source,
      fetched_at: new Date().toISOString(),
      ...(result.drift ? { drift: result.drift } : {}),
      ...(result.api_error ? { api_error: result.api_error } : {}),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- app/api/ontology/rules/route.test`
Expected: 4 tests green.

- [ ] **Step 5: Lint + typecheck**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 6: Live smoke test (Neo4j optional)**

Run: `npm run dev`
```bash
curl -s http://localhost:3002/api/ontology/rules | head -100
```
Expected: JSON with `ok: true`, `rules: [...]`, `source: 'ontology-api'` if Neo4j running and `ONTOLOGY_API_BASE` set, else `'json-fallback'`.

- [ ] **Step 7: Commit**

```bash
git add app/api/ontology/rules/route.ts app/api/ontology/rules/route.test.ts
git commit -m "feat(api): GET /api/ontology/rules — list all matchResume rules"
```

---

### Task 2.2: Dashboard switches grid row source to ontology full set

**Files:**
- Modify: [components/rule-check/RuleCheckDashboardContent.tsx](../../components/rule-check/RuleCheckDashboardContent.tsx)
- Modify: [lib/i18n.tsx](../../lib/i18n.tsx)

- [ ] **Step 1: Add i18n keys**

In [lib/i18n.tsx](../../lib/i18n.tsx) `zh` dictionary, add (next to existing `rc_*` keys):

```ts
    rc_rule_dead: "未触发",
    rc_kpi_coverage: "规则覆盖率",
    rc_rules_fallback_warn: "Ontology API 不可达 · 使用本地 JSON",
    rc_rules_source_api: "ontology-api 实时",
    rc_rules_source_fallback: "JSON fallback",
```

In `en` dictionary:

```ts
    rc_rule_dead: "never fired",
    rc_kpi_coverage: "rule coverage",
    rc_rules_fallback_warn: "Ontology API unreachable · using local JSON",
    rc_rules_source_api: "live ontology-api",
    rc_rules_source_fallback: "JSON fallback",
```

- [ ] **Step 2: Wire ontology fetch into Dashboard**

Edit [components/rule-check/RuleCheckDashboardContent.tsx](../../components/rule-check/RuleCheckDashboardContent.tsx).

Add a new type at the top (after existing types around line 65):

```ts
type OntologyRulesResponse = {
  ok: true;
  rules: Array<{ id: string; name?: string; severity?: string; applicableDepartment?: string }>;
  source: "ontology-api" | "json-fallback";
  fetched_at: string;
  api_error?: string;
};
```

Add state inside `RuleCheckDashboardContent` (next to existing `stats`/`audits`/`matrix`/`details` state):

```ts
const [ontology, setOntology] = React.useState<OntologyRulesResponse | null>(null);
```

Add fetch + polling effect alongside the other effect (line 77 area):

```ts
React.useEffect(() => {
  let cancel = false;
  async function load() {
    try {
      const r = await fetchJson<OntologyRulesResponse>("/api/ontology/rules");
      if (!cancel) setOntology(r);
    } catch {
      if (!cancel) setOntology(null);
    }
  }
  load();
  const timer = setInterval(load, 30_000); // 30s polling
  return () => { cancel = true; clearInterval(timer); };
}, []);
```

- [ ] **Step 3: Switch grid row source from matrix.rules to ontology.rules**

Refactor the `grid` `useMemo` (line 117). Replace its body with:

```ts
const grid = React.useMemo(() => {
  if (!audits || !matrix || !ontology) return null;

  // Build per-rule audit counts from matrix for the badge data
  const matrixByRuleId = new Map(matrix.rules.map((r) => [r.rule_id, r]));

  // Rows = ontology full set (including dead rules)
  const rows: MatrixRule[] = ontology.rules.map((or) => {
    const m = matrixByRuleId.get(or.id);
    return {
      rule_id: or.id,
      rule_name: m?.rule_name ?? or.name ?? or.id,
      total: m?.total ?? 0,
      pass: m?.pass ?? 0,
      fail: m?.fail ?? 0,
      not_applicable: m?.not_applicable ?? 0,
    };
  });

  // Sort: by fail desc, then by total desc, dead rules sink to bottom
  rows.sort((a, b) => {
    const aDead = a.total === 0 ? 1 : 0;
    const bDead = b.total === 0 ? 1 : 0;
    if (aDead !== bDead) return aDead - bDead;
    if (a.fail !== b.fail) return b.fail - a.fail;
    return b.total - a.total;
  });

  const cellByRuleAudit = new Map<string, Map<string, string>>();
  for (const a of audits) {
    const d = details[a.audit_id];
    if (!d || d === "error") continue;
    for (const f of d.flags) {
      if (!cellByRuleAudit.has(f.rule_id)) cellByRuleAudit.set(f.rule_id, new Map());
      cellByRuleAudit.get(f.rule_id)!.set(a.audit_id, f.result);
    }
  }
  return { rules: rows, cells: cellByRuleAudit };
}, [audits, matrix, ontology, details]);
```

- [ ] **Step 4: Add coverage KPI**

In the KPI strip (line 156-162), add a 6th `<Kpi>` between the existing 5:

```tsx
{ontology && matrix ? (
  <Kpi
    label={t("rc_kpi_coverage")}
    value={`${Math.round((matrix.rules.length / Math.max(1, ontology.rules.length)) * 100)}%`}
    sub={`${matrix.rules.length}/${ontology.rules.length}`}
  />
) : (
  <Kpi label={t("rc_kpi_coverage")} value="—" />
)}
```

Make sure `useApp` is imported at top: `import { useApp } from "@/lib/i18n";` and `const { t } = useApp();` near the start of the component.

- [ ] **Step 5: Add fallback warn badge above the KPI strip**

Just before the KPI strip block:

```tsx
{ontology?.source === "json-fallback" && (
  <div
    className="border border-line rounded inline-flex items-center gap-2"
    style={{
      padding: "6px 10px",
      background: "var(--c-warn-bg)",
      color: "oklch(0.45 0.14 75)",
      fontSize: 12,
      alignSelf: "flex-start",
    }}
    title={ontology.api_error}
  >
    <span>⚠</span>
    <span>{t("rc_rules_fallback_warn")}</span>
  </div>
)}
```

- [ ] **Step 6: Add Dead Rule badge in the grid row left-side**

In `RuleAuditGrid` (line 249), modify the rule link inside the row map (line 305-315) to append a badge when `r.total === 0`:

```tsx
<Link
  href={`/rule-check?view=audits&ruleId=${encodeURIComponent(r.rule_id)}`}
  className="flex items-baseline gap-2 truncate hover:bg-panel transition-colors rounded"
  style={{ padding: "2px 6px", textDecoration: "none", opacity: r.total === 0 ? 0.55 : 1 }}
  title={r.rule_name}
>
  <code className="text-ink-1 tabular-nums" style={{ fontFamily: "var(--f-mono)", fontSize: 11, minWidth: 48 }}>
    {r.rule_id}
  </code>
  <span className="text-ink-2 truncate" style={{ fontSize: 11.5 }}>{r.rule_name}</span>
  {r.total === 0 && (
    <span className="tabular-nums" style={{ fontSize: 9.5, color: "var(--c-ink-4)", marginLeft: "auto", letterSpacing: "0.05em" }}>
      {/* Pass `t` in via props if needed; for simplicity inline a constant zh label or import useApp here */}
    </span>
  )}
</Link>
```

Note: `RuleAuditGrid` is a sub-component currently doesn't take `t`. The simplest path is to inline a Chinese-only constant for v1 (will get cleaned up in Chunk 3 i18n pass), OR pass `t` as a prop. **Choose: pass `t` as a prop** to avoid leaving Chinese hardcoded.

Refactor: change `RuleAuditGrid` signature to `function RuleAuditGrid({ grid, audits, t }: ...)` and add `t: (k: string) => string` to its type. Pass `t` from the parent. Use `t("rc_rule_dead")` as the badge text.

- [ ] **Step 7: Run unit tests + lint**

Run: `npm test -- rule-check`
Expected: existing tests still pass (no new tests for dashboard — UI logic, validated by manual smoke).

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 8: Manual smoke test**

Run: `npm run dev`
Open: http://localhost:3002/rule-check?view=dashboard
Expected:
- Grid shows all ontology rules including ones with 0 audits (greyed out + `未触发` label)
- KPI strip has 6 cards including `规则覆盖率 X%`
- If `ONTOLOGY_API_BASE` unset: warn badge `⚠ Ontology API 不可达 · 使用本地 JSON` visible above KPI
- Switch lang to en: all labels translated

- [ ] **Step 9: Commit**

```bash
git add components/rule-check/RuleCheckDashboardContent.tsx lib/i18n.tsx
git commit -m "feat(rule-check): dashboard grid sourced from ontology full set + dead-rule badges"
```

---

## Chunk 3: Drawer UI rework + i18n cleanup

### Task 3.1: Drawer UI rework — DecisionBanner + DetailHeader + DrawerSection

**Files:**
- Modify: [components/rule-check/RuleCheckAuditDetailDrawer.tsx](../../components/rule-check/RuleCheckAuditDetailDrawer.tsx)

- [ ] **Step 1: Extract `<DrawerSection>` shell at the top of the file**

Add right after the imports / type declarations (before the main `RuleCheckAuditDetailDrawer` function):

```tsx
const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

function DrawerSection({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="flex items-baseline gap-2.5">
          <h3
            className="m-0 text-ink-1"
            style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 500, letterSpacing: "-0.005em" }}
          >
            {title}
          </h3>
          {hint && <span className="text-ink-3" style={{ fontSize: 11.5 }}>{hint}</span>}
        </div>
        {action}
      </div>
      <div className="border border-line rounded" style={{ background: "var(--c-surface)", padding: "12px 14px" }}>
        {children}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Replace `DecisionBanner` body with serif + softer styling**

Find the existing `DecisionBanner` function (line ~296). Replace its return JSX with:

```tsx
return (
  <div
    className="border-b border-line flex items-center gap-5"
    style={{
      padding: "20px 22px",
      background: bgColor,
      borderLeft: `4px solid ${borderColor}`,
    }}
  >
    <div
      className="tabular-nums"
      style={{
        fontFamily: SERIF,
        fontSize: 36,
        fontWeight: 500,
        color: borderColor,
        minWidth: 120,
        lineHeight: 1,
        letterSpacing: "-0.02em",
      }}
    >
      {detail.decision}
    </div>
    <div className="flex-1 min-w-0">
      <div className="text-ink-1" style={{ fontSize: 14, lineHeight: 1.55 }}>
        {summary}
      </div>
      <div className="text-ink-3 mono text-[11px] mt-2 truncate">
        {detail.candidate_id?.slice(0, 8)} · {detail.job_requisition_id?.split("-").pop() || "?"}
        {detail.client_name ? ` · ${detail.client_name}` : ""}
        {detail.business_group ? ` × ${detail.business_group}` : ""}
      </div>
    </div>
    {/* Replay moved into the drawer header toolbar — see Step 3 */}
  </div>
);
```

Then remove the `<Btn …>🔁 Replay</Btn>` inside `DecisionBanner` JSX. **Remove the `onReplay` / `isReplaying` props from the function signature, since the button moves to the header in Step 3.**

- [ ] **Step 3: Move Replay button into the top toolbar**

In the main `RuleCheckAuditDetailDrawer` return (line 88+), find the header `<div className="border-b border-line flex items-center gap-3" …>` block (~line 99-118). Inject the Replay button between `<Neo4jLinkBtn …/>` and `<Btn size="sm" onClick={onClose}>`:

```tsx
<Btn
  size="sm"
  onClick={onReplay}
  disabled={isReplaying}
  title={t("rc_replay_title")}
>
  {isReplaying ? t("rc_replay_running") : `🔁 ${t("rc_replay")}`}
</Btn>
```

Update the call site of `<DetailHeader … onReplay isReplaying />` (~line 147-151) to drop those two props since `DecisionBanner` no longer needs them. Adjust `DetailHeader` signature accordingly.

- [ ] **Step 4: Reshape `DetailHeader` KV grid: 4-col → 3-col + bigger gutters**

In `DetailHeader` (~line 200+), change:

```ts
gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
gap: "8px 18px",
padding: "12px 18px",
```

to:

```ts
gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
gap: "16px 28px",
padding: "18px 22px",
```

In `Kv` (~line 363) component, change label style to uppercase 10.5px tracking:

```tsx
<div className="min-w-0">
  <div
    className="text-ink-3"
    style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500 }}
  >
    {label}
  </div>
  <div className="text-ink-1 flex items-center gap-2 truncate" style={{ marginTop: 6, fontSize: 13 }}>
    {children}
  </div>
</div>
```

- [ ] **Step 5: Extract `failure_reasons` / `parse_error` into callouts (outside the grid)**

Find the block at the end of `DetailHeader` (~line 268-289) that renders `failure_reasons` and `parse_error` inside `col-span-4`. Move those out of the grid div entirely and render them as siblings after the grid `</div>`. Use this pattern:

```tsx
{detail.failure_reasons.length > 0 && (
  <div
    className="border-b border-line"
    style={{
      padding: "12px 22px",
      borderLeft: "3px solid var(--c-err)",
      background: "var(--c-err-bg)",
      display: "flex",
      gap: 10,
      alignItems: "flex-start",
    }}
  >
    <Ic.alert />
    <div className="min-w-0 flex-1">
      <div className="hint" style={{ color: "var(--c-err)" }}>{t("rc_failure_reasons_label")}</div>
      <div className="mono text-[12px] text-err" style={{ marginTop: 4, lineHeight: 1.5 }}>
        {detail.failure_reasons.join("、")}
      </div>
    </div>
  </div>
)}

{detail.parse_error && (
  <div
    className="border-b border-line"
    style={{
      padding: "12px 22px",
      borderLeft: "3px solid var(--c-warn)",
      background: "var(--c-warn-bg)",
      display: "flex",
      gap: 10,
      alignItems: "flex-start",
    }}
  >
    <Ic.alert />
    <div className="min-w-0 flex-1">
      <div className="hint" style={{ color: "oklch(0.45 0.14 75)" }}>{t("rc_parse_error_label")}</div>
      <div className="mono text-[11px]" style={{ color: "oklch(0.45 0.14 75)", marginTop: 4, lineHeight: 1.5 }}>
        {detail.parse_error}
      </div>
    </div>
  </div>
)}
```

(Both `rc_failure_reasons_label` and `rc_parse_error_label` get added in Task 3.2.)

- [ ] **Step 6: Tab bar — match `RuleCheckPageContent` style**

Find `TabBtn` (~line 374). Change:

```ts
borderBottom: active ? "2px solid var(--c-accent)" : "2px solid transparent",
fontWeight: active ? 600 : 400,
```

to:

```ts
borderBottom: active ? "1.5px solid var(--c-ink-1)" : "1.5px solid transparent",
fontWeight: active ? 500 : 400,
color: active ? "var(--c-ink-1)" : "var(--c-ink-3)",
fontSize: 13,
```

And `padding: "10px 0 9px"` → `padding: "12px 0 10px"`.

- [ ] **Step 7: Run lint + build**

Run: `npm run lint && npm run build`
Expected: clean. (No unit tests for this drawer; visual changes verified manually.)

- [ ] **Step 8: Visual smoke test**

Run: `npm run dev`
Open: http://localhost:3002/rule-check?view=audits
Click any audit row.
Expected:
- DecisionBanner: serif 36px `PASS`/`FAIL`, 14px summary, no button inside the banner
- Top toolbar: `🔗 Neo4j` + `🔁 Replay` + `关闭 (Esc)` in a row
- KV grid: 3 columns, more breathing room
- If FAIL: red callout below the KV grid with `failure_reasons`
- Tab bar: 1.5px underline matching the page header's layer tab style

Compare visually to the screenshot in the source spec (it should look "less dashboardy, more focused").

- [ ] **Step 9: Commit**

```bash
git add components/rule-check/RuleCheckAuditDetailDrawer.tsx
git commit -m "feat(rule-check): drawer UI rework — serif banner, 3-col grid, callouts"
```

---

### Task 3.2: i18n cleanup — drop hardcoded Chinese in drawer

**Files:**
- Modify: [components/rule-check/RuleCheckAuditDetailDrawer.tsx](../../components/rule-check/RuleCheckAuditDetailDrawer.tsx)
- Modify: [lib/i18n.tsx](../../lib/i18n.tsx)

- [ ] **Step 1: Grep for remaining Chinese in drawer**

Run: `grep -nE "[一-龥]" components/rule-check/RuleCheckAuditDetailDrawer.tsx`
Expected: a list of ~20-40 line:column hits (excluding comments).

- [ ] **Step 2: Add the new i18n keys to `lib/i18n.tsx`**

In the `zh` dictionary, append (next to other `rc_*` keys):

```ts
    rc_replay: "Replay",
    rc_replay_title: "重新发送此 audit 的源事件,等候新的 audit",
    rc_replay_running: "重跑中…",
    rc_failure_reasons_label: "失败原因",
    rc_parse_error_label: "解析错误",
    rc_decision_summary_pass: "所有底线规则放行(评估 {evaluated}/{total} 条)。下一步:发 MATCH_RULE_CHECK_PASSED 事件 → matchResume 调 RoboHire /match-resume",
    rc_decision_summary_fail: "底线规则触发 FAIL → 中止流程,跳过 matchResume。命中:{reasons}",
    rc_decision_summary_llm_parse_err: "(LLM 解析失败)",
    rc_cell_unloaded: "未加载",
    rc_filtered_section_title: "本次未应用的规则",
    rc_filtered_executor: "executor 不为 Agent",
    rc_filtered_client: "client 不匹配",
    rc_filtered_department: "department 不匹配",
    rc_filtered_other: "其他",
    rc_show_more: "点击展开",
    rc_show_less: "收起",
    rc_section_user_prompt: "User Prompt",
    rc_section_rule_flags: "规则标记",
    rc_section_llm_response: "LLM 响应",
    rc_section_instances: "实例数据",
```

In the `en` dictionary (matching keys), add:

```ts
    rc_replay: "Replay",
    rc_replay_title: "Re-publish the source event for this audit and wait for a fresh result",
    rc_replay_running: "Replaying…",
    rc_failure_reasons_label: "Failure reasons",
    rc_parse_error_label: "Parse error",
    rc_decision_summary_pass: "All gating rules passed ({evaluated}/{total} evaluated). Next: emit MATCH_RULE_CHECK_PASSED → matchResume calls RoboHire /match-resume",
    rc_decision_summary_fail: "Gating rule FAIL → flow aborted, matchResume skipped. Triggered by: {reasons}",
    rc_decision_summary_llm_parse_err: "(LLM parse failure)",
    rc_cell_unloaded: "not loaded",
    rc_filtered_section_title: "Rules excluded this run",
    rc_filtered_executor: "executor is not Agent",
    rc_filtered_client: "client mismatch",
    rc_filtered_department: "department mismatch",
    rc_filtered_other: "other",
    rc_show_more: "expand",
    rc_show_less: "collapse",
    rc_section_user_prompt: "User Prompt",
    rc_section_rule_flags: "Rule Flags",
    rc_section_llm_response: "LLM Response",
    rc_section_instances: "Instance Data",
```

- [ ] **Step 3: Replace `buildDecisionSummary` to use template + t**

Find `buildDecisionSummary` (~line 352). Replace with a version that takes `t` as parameter:

```ts
function buildDecisionSummary(
  detail: RuleCheckAuditDetail,
  t: (k: string) => string,
): string {
  if (detail.decision === "PASS") {
    return t("rc_decision_summary_pass")
      .replace("{evaluated}", String(detail.rules_evaluated))
      .replace("{total}", String(detail.rules_total_in_ontology));
  }
  const reasons = detail.failure_reasons.length
    ? detail.failure_reasons.join("、")
    : t("rc_decision_summary_llm_parse_err");
  return t("rc_decision_summary_fail").replace("{reasons}", reasons);
}
```

Update the call site (~line 210):
```ts
const summary = buildDecisionSummary(detail, t);
```

Make sure `t` is in scope at that call site — `DetailHeader` will need it from a prop or its parent.

- [ ] **Step 4: Replace remaining Chinese literals**

Walk through the grep output from Step 1. For each:
- KV labels (`decision`, `client × bg × studio`, `model · latency`, `tokens (in/out)`, `candidate_id`, `job_requisition_id`, `rules_evaluated`, `trace_id`) — most should already be hardcoded English/code-like labels. If any are Chinese, route through `rc_kv_<name>` keys (add to both zh and en dictionaries).
- Tooltips on Replay/Neo4j/Close — verify all go through `t(...)`.
- Inside tabs (Prompt/Rules/Response/Instances bodies):
  - Section titles → use the new `rc_section_*` keys
  - Any inline `点击展开` / `收起` → use `rc_show_more` / `rc_show_less`
  - `未加载` cell tooltips → `t("rc_cell_unloaded")`

For section titles inside the new `<DrawerSection>` shells, pass them via the `title` prop.

- [ ] **Step 5: Final grep — verify clean**

Run: `grep -nE "[一-龥]" components/rule-check/RuleCheckAuditDetailDrawer.tsx | grep -v "^.*//"`
Expected: ZERO hits OUTSIDE of comments. (Comment-only hits are fine.)

If hits remain, fix them by routing through `t(...)` or extracting to a new `rc_*` key.

- [ ] **Step 6: Lint + build**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 7: Bilingual smoke test**

Run: `npm run dev`
Open: http://localhost:3002/rule-check?view=audits
- Open any audit → no Chinese in JSX (only the data values, which intentionally stay in their source language)
- Switch language to `en` via the AppBar toggle → drawer UI text all in English
- Switch back to `zh` → all text returns to Chinese
- Spot check PASS and FAIL audits both → summary template substitutions work in both languages

- [ ] **Step 8: Commit**

```bash
git add components/rule-check/RuleCheckAuditDetailDrawer.tsx lib/i18n.tsx
git commit -m "feat(rule-check): drawer i18n — drop hardcoded Chinese, add rc_* keys"
```

---

## Final Verification

After all three chunks are committed:

- [ ] **Final 1: Run full vitest suite**

Run: `npm test`
Expected: all green.

- [ ] **Final 2: Run full build (typecheck + lint)**

Run: `npm run build`
Expected: clean.

- [ ] **Final 3: Manual E2E walkthrough**

Run: `npm run dev`

Walk through every change end-to-end:

1. `/monitor` — default Runs tab; switch to `DLQ`; URL is `?tab=dlq`; refresh preserves; click DLQ row → run detail drawer; close drawer → tab state preserved.
2. `/workflow` — RuleCheck node visible between ResumeParser and Matcher; edges labeled; portalSubmitter still in viewBox; deployment summary shows 4 deployed.
3. `/rule-check?view=dashboard` — full ontology rule list visible, dead rules greyed + badged; coverage KPI displayed; if `ONTOLOGY_API_BASE` unset, warn badge present.
4. `/rule-check?view=audits` — drawer opens with new visual design; toolbar has Neo4j + Replay + Close; KV grid 3-col; failure_reasons in callout; tabs use the new underline style.
5. Toggle `lang=en` — every label in 1-4 translates; no Chinese leaks in JSX (only data values intentionally stay).

- [ ] **Final 4: Confirm clean working tree**

Run: `git status`
Expected: clean (or only pre-existing unrelated changes like `lib/partner-pg/*` from the open user session).

- [ ] **Final 5: Skip independent reviewer; surface to user for review**

Tell the user: "All three chunks committed. Walk through the E2E checklist above and let me know if anything regresses or feels off — happy to iterate."

---

## Notes for the implementer

- **DRY**: The `<DrawerSection>` shell in Chunk 3 is intentionally shared. If you find yourself copy-pasting its styles into individual tabs, stop and refactor.
- **YAGNI**: Do NOT add a new `/api/ontology/rules` filter system in this plan. The endpoint returns the full set; client does any slicing it needs.
- **No new abstractions**: The graph-meta edge-resolver refactor (Task 1.2 Step 6) introduces ONE helper (`getEdgeMeta`) because two call sites need it. Don't proliferate further.
- **Commit cadence**: Six commits expected, one per task (1.1, 1.2, 1.3 optional, 2.1, 2.2, 3.1, 3.2). Don't squash; the user wants a clean trail per spec phase.
- **TDD scope**: True TDD applies to Tasks 1.2 (graph-meta) and 2.1 (route handler). Tasks 1.1 / 2.2 / 3.1 / 3.2 are UI changes verified manually — the project intentionally has no UI test suite. Don't manufacture brittle snapshot tests.
- **OKLCH tokens only**: Never write hex colors. Use `var(--c-*)` or Tailwind utilities. The dark theme reads the same variable names and auto-flips.
- **i18n**: Every new visible string MUST land in both `zh` AND `en` dictionaries simultaneously. The lint step will not catch missing keys; manual lang-toggle is the only check.
