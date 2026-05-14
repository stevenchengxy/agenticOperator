# Monitor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Monitor axis of Agentic Operator — a `/monitor` route tree that visualizes the runtime state of all workflow agents on a single graph, with drill-down pages for runs, agents, queue, and failures. Read-only. Claude-style UI scoped to the `/monitor` tree only.

**Architecture:**
- Frontend: Next.js 16 App Router page tree under `app/monitor/*`, components under `components/monitor/*`, with `<div data-style="claude">` wrapping at the layout level to scope a new OKLCH token group.
- Backend: 5 new aggregation API routes under `app/api/monitor/*` querying the existing Prisma SQLite DB (`data/ao.db`) — no new tables.
- Shared geometry: Extract the 18-node workflow coordinates from `components/workflow/WorkflowContent.tsx` into `lib/workflow-graph-meta.ts` so `/monitor`, `/monitor/runs/[id]`, and future Manage/Behavior pages all share the same SVG layout.
- Data: Token usage comes from `AgentActivity` rows where `type='tool'` (the actual write path via `server/llm/instrumented.ts`), not from `AgentEpisode` (table exists but is currently unwritten on main).

**Tech Stack:** Next.js 16.2 (App Router · Turbopack) · React 19.2 · Tailwind CSS v4 (OKLCH tokens in `app/globals.css`, `@theme inline`) · TypeScript 5 · Prisma + SQLite (`data/ao.db`) · Vitest (+ happy-dom env, see `vitest.config.ts`).

**Spec reference:** [docs/superpowers/specs/2026-05-14-monitor-design.md](../specs/2026-05-14-monitor-design.md)

**Branch:** Work directly on `main` (currently at `0e4e81d`, ahead of `origin/main` by 1 commit holding the spec). Each task ends with a commit. Push to `origin/main` after each task.

---

## File Structure (locked in before tasks)

### Files to create

| Path | Responsibility |
|---|---|
| `lib/workflow-graph-meta.ts` | Shared `NODES`, `EDGES`, `LANES` arrays (extracted from `WorkflowContent.tsx`). Single source of truth for workflow geometry. |
| `lib/monitor/types.ts` | TypeScript types shared by API + UI: `MonitorOverviewResponse`, `MonitorNodeAgg`, `MonitorEdgeAgg`, `MonitorRunDetail`, `MonitorAgentDetail`, `MonitorQueueBucket`, etc. |
| `lib/monitor/aggregations.ts` | Pure functions that take Prisma rows and produce the `Monitor*` aggregate types. Unit-testable. |
| `lib/monitor/filters.ts` | URL-state filter parsing/serializing. Used by both /monitor page (read) and the API routes (constraint construction). |
| `components/monitor/atoms.tsx` | `<ClaudeCard>`, `<ClaudeMetric>`, `<ClaudeBadge>`, `<ClaudeButton>`, `<ClaudeChip>`. Scoped via `[data-style="claude"]`. |
| `components/monitor/MonitorContent.tsx` | `/monitor` main page composition. |
| `components/monitor/MonitorGraph.tsx` | The 1620×560 SVG graph (reusable: takes nodes + edges + optional run-trail overlay). |
| `components/monitor/MonitorNode.tsx` | Single agent node with badges (running, hitl, queue) + status color + pulse ring. |
| `components/monitor/MonitorEdge.tsx` | Single edge with density animation. |
| `components/monitor/FilterChips.tsx` | Top filter bar (time / client / trigger / status / search). URL-synced. |
| `components/monitor/KpiStrip.tsx` | 5-cell KPI strip. Each cell click → applies corresponding filter. |
| `components/monitor/FailuresFeed.tsx` | Right-bottom vertical list (top 20 failures). |
| `components/monitor/HitlFeed.tsx` | Bottom-right vertical list (top 20 pending HITL). |
| `components/monitor/RecentRunsStrip.tsx` | Bottom-left horizontal cards (recent runs). |
| `components/monitor/MiniRunList.tsx` | Popover shown when clicking a node's running count badge. |
| `components/monitor/RunDetailContent.tsx` | `/monitor/runs/[id]` page composition. |
| `components/monitor/RunTrailGraph.tsx` | Variant of `MonitorGraph` that takes a `trail` and colors nodes accordingly. |
| `components/monitor/AgentDetailContent.tsx` | `/monitor/agents/[name]` page composition. |
| `components/monitor/TokenChart.tsx` | 24h hourly line chart (prompt vs completion). Hand-rolled SVG, ~80 lines, **no Recharts**. |
| `components/monitor/ErrorRateChart.tsx` | 24h hourly bar chart. Same approach as TokenChart. |
| `components/monitor/QueueContent.tsx` | `/monitor/queue` page (4 tabs: accepted / pending / rejected / dlq). |
| `components/monitor/FailureDetailContent.tsx` | `/monitor/failures/[runId]` page. |
| `app/monitor/layout.tsx` | Wraps children in `<div data-style="claude">`. |
| `app/monitor/page.tsx` | Thin `<Shell>` + `<MonitorContent>`. |
| `app/monitor/runs/[id]/page.tsx` | Thin shell. |
| `app/monitor/agents/[name]/page.tsx` | Thin shell. |
| `app/monitor/queue/page.tsx` | Thin shell. |
| `app/monitor/failures/[runId]/page.tsx` | Thin shell. |
| `app/api/monitor/overview/route.ts` | First-screen aggregation endpoint. |
| `app/api/monitor/overview/route.test.ts` | Vitest unit tests for the route. |
| `app/api/monitor/runs/[id]/route.ts` | Single-run aggregation. |
| `app/api/monitor/runs/[id]/route.test.ts` | |
| `app/api/monitor/agents/[name]/route.ts` | Single-agent aggregation. |
| `app/api/monitor/agents/[name]/route.test.ts` | |
| `app/api/monitor/queue/route.ts` | 4-bucket queue. |
| `app/api/monitor/queue/route.test.ts` | |
| `app/api/monitor/failures/[runId]/route.ts` | Single failure detail. |
| `app/api/monitor/failures/[runId]/route.test.ts` | |
| `lib/monitor/aggregations.test.ts` | Unit tests for pure aggregation functions. |
| `lib/workflow-graph-meta.test.ts` | Unit test that geometry is well-formed (every edge's `from`/`to` resolves to a node). |

### Files to modify

| Path | What changes |
|---|---|
| `app/globals.css` | Add `--c-claude-*` OKLCH tokens (light + dark) + `[data-style="claude"]` scoped rules (font stack, h1/h2 serif). |
| `components/workflow/WorkflowContent.tsx` | Replace inline `nodes` / `edges` arrays with import from `lib/workflow-graph-meta.ts`. |
| `components/shared/LeftNav.tsx` | Remove the "Runs" item; add "Monitor" item with icon `gauge`; count from `/api/monitor/overview` (active runs). |
| `components/shared/Ic.tsx` | Add `gauge` icon (and `dot` / `pulse` if not present). |
| `lib/i18n.tsx` | Add zh/en labels: `nav_monitor`, `m_active_runs`, `m_pending_hitl`, `m_failures`, `m_tokens`, `m_queue_lag`, `monitor_filter_time`, etc. |

---

## Notes on test discipline

- `vitest.config.ts` exists; tests live next to the file under test (`X.ts` → `X.test.ts`) using happy-dom env.
- API routes mock `prisma` with `vi.mock('@/server/db', ...)` — see `app/api/runs/route.test.ts` for the canonical pattern. Replicate.
- Pure functions in `lib/monitor/aggregations.ts` get straight unit tests.
- UI components: **no unit tests required** (no React Testing Library set up). Verification is `npm run build` (Next does typecheck + lint) + visual check at `http://localhost:3002/monitor`.
- Run a single test: `npx vitest run <pattern>`. Run all: `npx vitest run`. Watch mode: `npx vitest`.
- Each task ends with `npm run build` succeeding before commit.

---

## Chunk 1: Foundations + Main page (Tasks 0-4)

### Task 0: Verify data sources and document gaps

**Goal:** Before writing any new code, run a quick read-only audit of the local DB to confirm the data Monitor will consume actually exists. Surface any gap as a documented assumption rather than a runtime surprise later.

**Files:**
- Create: `docs/superpowers/notes/2026-05-14-monitor-data-audit.md` (audit findings)

- [ ] **Step 1: Start dev server in another terminal so APIs are warm**

Run (in a separate terminal, leave running):
```bash
npm run dev
```
Expected: server up at `http://localhost:3002`. Visit `/live` once to confirm.

- [ ] **Step 2: Probe existing endpoints and count rows in each relevant table**

Run:
```bash
curl -s 'http://localhost:3002/api/runs?limit=5' | head -c 400
echo
sqlite3 data/ao.db "SELECT COUNT(*) AS workflow_runs FROM WorkflowRun;
SELECT COUNT(*) AS activities, COUNT(DISTINCT type) AS distinct_types FROM AgentActivity;
SELECT type, COUNT(*) FROM AgentActivity GROUP BY type ORDER BY 2 DESC LIMIT 10;
SELECT COUNT(*) AS episodes FROM AgentEpisode;
SELECT COUNT(*) AS events FROM event_instances;
SELECT COUNT(*) AS dlq FROM DLQEntry;
SELECT COUNT(*) AS hitl FROM HumanTask WHERE status='pending';"
```
Expected: counts print. Note especially:
- `AgentActivity` row count > 0 and distinct types include `tool`, `agent_complete`, etc.
- `AgentEpisode` may be 0 — confirm what we already know.

- [ ] **Step 3: Inspect what's actually in `AgentActivity.metadata` for `type='tool'` rows**

Run:
```bash
sqlite3 data/ao.db "SELECT metadata FROM AgentActivity WHERE type='tool' AND metadata LIKE '%totalTokens%' LIMIT 3;"
```
Expected: JSON blobs with `promptTokens`, `completionTokens`, `totalTokens`, `model`, `durationMs`. If empty, the LLM telemetry hasn't fired yet on this DB — Monitor still ships, charts just render empty.

- [ ] **Step 4: Write the audit note**

Create `docs/superpowers/notes/2026-05-14-monitor-data-audit.md`:
```markdown
# Monitor data source audit — 2026-05-14

## Tables consulted
- WorkflowRun (count: X)
- AgentActivity (count: X · distinct types: [...])
- AgentEpisode (count: X)
- event_instances (count: X)
- DLQEntry (count: X)
- HumanTask pending (count: X)

## Token source decision
Tokens are written by `server/llm/instrumented.ts → withLlmTelemetry()`
into `AgentActivity` rows where `type='tool'`, with
`metadata = JSON.stringify({ model, durationMs, promptTokens, completionTokens, totalTokens })`.
Monitor will read this as the primary token source.

`AgentEpisode.tokenUsage` exists in the schema but is currently unwritten
on this branch. Monitor APIs will prefer AgentEpisode rows when present
(future-proof) and fall back to AgentActivity.metadata otherwise.

## Known gaps
- [list any tables that are 0-count or distinct-types missing what spec assumed]
- These don't block the implementation; Monitor renders empty states.
```

- [ ] **Step 5: Commit the audit**

```bash
git add docs/superpowers/notes/2026-05-14-monitor-data-audit.md
git commit -m "$(cat <<'EOF'
docs(monitor): pre-implementation data source audit

Verified the existing tables Monitor will consume. Recorded actual row
counts + the decision to use AgentActivity.metadata (type='tool') as the
primary token source — AgentEpisode exists in schema but is currently
unwritten on the main branch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: Extract shared workflow graph geometry

**Goal:** Move the 18 nodes + edges from `components/workflow/WorkflowContent.tsx` into `lib/workflow-graph-meta.ts` so Monitor pages can render the same graph without duplicating coordinates.

**Files:**
- Create: `lib/workflow-graph-meta.ts`
- Create: `lib/workflow-graph-meta.test.ts`
- Modify: `components/workflow/WorkflowContent.tsx` (replace inline arrays with imports)

- [ ] **Step 1: Write the failing test**

Create `lib/workflow-graph-meta.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { NODES, EDGES, nodeById, GRAPH_VIEWBOX } from './workflow-graph-meta';

describe('workflow-graph-meta', () => {
  it('viewBox matches the historical 1620x560 used by /workflow', () => {
    expect(GRAPH_VIEWBOX).toBe('0 0 1620 560');
  });

  it('all edge endpoints resolve to a real node', () => {
    const ids = new Set(NODES.map(n => n.id));
    for (const e of EDGES) {
      expect(ids.has(e.from), `edge ${e.from}->${e.to}: from missing`).toBe(true);
      expect(ids.has(e.to),   `edge ${e.from}->${e.to}: to missing`).toBe(true);
    }
  });

  it('every node has unique id, in-bounds x/y', () => {
    const seen = new Set<string>();
    for (const n of NODES) {
      expect(seen.has(n.id), `duplicate id ${n.id}`).toBe(false);
      seen.add(n.id);
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(1620);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(560);
    }
  });

  it('nodeById returns the node or undefined', () => {
    expect(nodeById('jd')?.title).toBeDefined();
    expect(nodeById('does-not-exist')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test, watch it fail**

Run: `npx vitest run lib/workflow-graph-meta.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `lib/workflow-graph-meta.ts`**

Open `components/workflow/WorkflowContent.tsx` lines 38-78 to copy the `nodes` and `edges` arrays verbatim. Then create `lib/workflow-graph-meta.ts`:

```typescript
import type { IcName } from '@/components/shared/Ic';

export type NodeKind = 'trigger' | 'agent' | 'branch' | 'hitl' | 'guard' | 'done';

export type WorkflowNode = {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  title: string;
  sub: string;
  icon: IcName;
};

export type WorkflowEdge = {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
};

// 1620×560 viewBox — match the historical /workflow layout exactly.
// Coordinates copied 1:1 from components/workflow/WorkflowContent.tsx
// (before extraction on 2026-05-14).
export const GRAPH_VIEWBOX = '0 0 1620 560' as const;
export const GRAPH_WIDTH = 1620 as const;
export const GRAPH_HEIGHT = 560 as const;

// NOTE: `title` and `sub` use Chinese copy. The /workflow page localized
// some via `t()`; /monitor will keep them hardcoded since these strings
// are mock-domain (agent names like ReqSync) — see CLAUDE.md note about
// hardcoded mock-domain copy.
export const NODES: WorkflowNode[] = [
  { id: 'trig',    kind: 'trigger', x: 20,   y: 240, title: '定时同步 / Webhook', sub: 'SCHEDULED_SYNC · 客户 RMS', icon: 'bolt' },
  { id: 'sync',    kind: 'agent',   x: 200,  y: 240, title: 'ReqSync',          sub: '需求同步 → REQUIREMENT_SYNCED', icon: 'db' },
  { id: 'analyze', kind: 'agent',   x: 380,  y: 240, title: 'ReqAnalyzer',      sub: '需求分析 → ANALYSIS_COMPLETED', icon: 'sparkle' },
  { id: 'clarify', kind: 'branch',  x: 560,  y: 240, title: '信息完整?',         sub: '缺失字段 / 冲突', icon: 'branch' },
  { id: 'ask',     kind: 'hitl',    x: 740,  y: 360, title: 'HSM 澄清',          sub: 'CLARIFICATION_RETRY', icon: 'user' },
  { id: 'jd',      kind: 'agent',   x: 740,  y: 140, title: 'JDGenerator',      sub: 'JD 生成 → JD_GENERATED', icon: 'sparkle' },
  { id: 'jdappr',  kind: 'hitl',    x: 920,  y: 140, title: 'HSM 审批 JD',       sub: 'JD_APPROVED / JD_REJECTED', icon: 'shield' },
  { id: 'publish', kind: 'agent',   x: 1100, y: 140, title: 'Publisher',        sub: '渠道发布 → CHANNEL_PUBLISHED', icon: 'plug' },
  { id: 'collect', kind: 'agent',   x: 1280, y: 140, title: 'ResumeCollector',  sub: 'RESUME_DOWNLOADED', icon: 'db' },
  { id: 'parse',   kind: 'agent',   x: 1280, y: 240, title: 'ResumeParser+DupeCheck', sub: 'RESUME_PROCESSED / LOCKED_CONFLICT', icon: 'cpu' },
  { id: 'match',   kind: 'branch',  x: 1100, y: 340, title: '人岗匹配',           sub: 'Matcher · 硬性 / 加分 / 负向', icon: 'branch' },
  { id: 'reject',  kind: 'done',    x: 1280, y: 420, title: '归档 · MATCH_FAILED', sub: '黑名单 / 硬性不符', icon: 'cross' },
  { id: 'itv',     kind: 'agent',   x: 920,  y: 340, title: 'AIInterviewer',    sub: 'AI 面试 → AI_INTERVIEW_COMPLETED', icon: 'sparkle' },
  { id: 'eval',    kind: 'agent',   x: 740,  y: 340, title: 'Evaluator',        sub: 'EVALUATION_PASSED / FAILED', icon: 'cpu' },
  { id: 'pkg',     kind: 'agent',   x: 560,  y: 340, title: 'PackageBuilder',   sub: 'PACKAGE_GENERATED · 简历+评估', icon: 'book' },
  { id: 'review',  kind: 'hitl',    x: 380,  y: 440, title: 'HSM 审核推荐包',     sub: 'PACKAGE_APPROVED · SLA 4h', icon: 'user' },
  { id: 'guard',   kind: 'guard',   x: 200,  y: 440, title: '合规 & 黑名单',      sub: 'PII / EEO / Blacklist', icon: 'shield' },
  { id: 'submit',  kind: 'agent',   x: 20,   y: 440, title: 'PortalSubmitter',  sub: 'APPLICATION_SUBMITTED', icon: 'mail' },
];

export const EDGES: WorkflowEdge[] = [
  { from: 'trig',    to: 'sync' },
  { from: 'sync',    to: 'analyze' },
  { from: 'analyze', to: 'clarify' },
  { from: 'clarify', to: 'jd',     label: 'OK' },
  { from: 'clarify', to: 'ask',    label: '缺失', dashed: true },
  { from: 'ask',     to: 'analyze', dashed: true },
  { from: 'jd',      to: 'jdappr' },
  { from: 'jdappr',  to: 'publish' },
  { from: 'publish', to: 'collect' },
  { from: 'collect', to: 'parse' },
  { from: 'parse',   to: 'match' },
  { from: 'match',   to: 'reject', label: '不符', dashed: true },
  { from: 'match',   to: 'itv',    label: '匹配' },
  { from: 'itv',     to: 'eval' },
  { from: 'eval',    to: 'pkg' },
  { from: 'pkg',     to: 'review' },
  { from: 'review',  to: 'guard' },
  { from: 'guard',   to: 'submit' },
];

const NODE_BY_ID = new Map(NODES.map(n => [n.id, n]));
export function nodeById(id: string): WorkflowNode | undefined {
  return NODE_BY_ID.get(id);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/workflow-graph-meta.test.ts`
Expected: 4 passing tests.

- [ ] **Step 5: Refactor `components/workflow/WorkflowContent.tsx` to import**

Open `components/workflow/WorkflowContent.tsx`. Delete the local `nodes` and `edges` arrays (lines ~38-78). Replace with:
```typescript
import { NODES, EDGES, type WorkflowNode } from '@/lib/workflow-graph-meta';
// Inside the component:
const nodes = NODES;
const edges = EDGES;
```
Keep the rest of the component unchanged. The local `NodeKind` and `NodeDef` types can be deleted — they're now in `workflow-graph-meta.ts`.

- [ ] **Step 6: Verify the build still passes and `/workflow` looks identical**

Run: `npm run build`
Expected: typecheck + lint clean, build successful.

Visit `http://localhost:3002/workflow` and compare against pre-refactor: nodes in the same positions, edges drawn the same. (Since the data is identical, it should be pixel-equal.)

- [ ] **Step 7: Commit**

```bash
git add lib/workflow-graph-meta.ts lib/workflow-graph-meta.test.ts components/workflow/WorkflowContent.tsx
git commit -m "$(cat <<'EOF'
refactor(workflow): extract graph geometry to lib/workflow-graph-meta

Move the 18 nodes + edges out of components/workflow/WorkflowContent.tsx
into a standalone module so the upcoming /monitor pages can render the
same workflow graph without duplicating coordinates. Single source of
truth for SVG layout.

- 4 vitest cases: edge endpoint resolution, node uniqueness, bounds
- /workflow visually unchanged (data import only)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Claude-style tokens + atoms

**Goal:** Add a scoped Claude-style OKLCH token group and reusable atoms (`<ClaudeCard>`, `<ClaudeMetric>`, `<ClaudeBadge>`, etc.). Wrap the `/monitor` tree via a layout that sets `data-style="claude"`. No other route is affected.

**Files:**
- Modify: `app/globals.css` (add tokens + scoped rules)
- Modify: `components/shared/Ic.tsx` (add `gauge` if missing)
- Create: `components/monitor/atoms.tsx`
- Create: `app/monitor/layout.tsx`
- Create: `app/monitor/page.tsx` (placeholder so layout renders something)
- Create: `components/monitor/MonitorContent.tsx` (stub returning "Monitor — coming soon")

- [ ] **Step 1: Add Claude tokens + scoped rules to `app/globals.css`**

Find the existing `:root { ... }` block (light theme). Right after it, append:
```css
:root {
  /* Claude-style scoped token group — only consumed under [data-style="claude"] */
  --c-claude-bg:        oklch(0.985 0.005 80);
  --c-claude-surface:   oklch(0.995 0.003 80);
  --c-claude-panel:     oklch(0.96  0.008 80);
  --c-claude-line:      oklch(0.88  0.008 75);
  --c-claude-ink-1:     oklch(0.22  0.01  80);
  --c-claude-ink-2:     oklch(0.4   0.01  80);
  --c-claude-ink-3:     oklch(0.55  0.01  80);
  --c-claude-ink-4:     oklch(0.7   0.01  80);
  --c-claude-accent:    oklch(0.67  0.14  35);
  --c-claude-accent-bg: oklch(0.94  0.05  35);
  --c-claude-ok:        oklch(0.7   0.13  145);
  --c-claude-warn:      oklch(0.78  0.12  80);
  --c-claude-err:       oklch(0.6   0.18  25);
}

[data-theme="dark"] {
  --c-claude-bg:        oklch(0.18  0.005 80);
  --c-claude-surface:   oklch(0.22  0.005 80);
  --c-claude-panel:     oklch(0.25  0.005 80);
  --c-claude-line:      oklch(0.32  0.005 80);
  --c-claude-ink-1:     oklch(0.92  0.005 80);
  --c-claude-ink-2:     oklch(0.75  0.005 80);
  --c-claude-ink-3:     oklch(0.6   0.005 80);
  --c-claude-ink-4:     oklch(0.45  0.005 80);
  --c-claude-accent:    oklch(0.72  0.15  35);
  --c-claude-accent-bg: oklch(0.3   0.08  35);
  --c-claude-ok:        oklch(0.7   0.13  145);
  --c-claude-warn:      oklch(0.75  0.12  80);
  --c-claude-err:       oklch(0.65  0.18  25);
}

/* Scope: any element marked data-style="claude" gets the calm palette,
   generous whitespace, serif headings. Existing routes never set this
   attribute so they keep the console aesthetic. */
[data-style="claude"] {
  background: var(--c-claude-bg);
  color: var(--c-claude-ink-1);
  font-family: ui-sans-serif, "SF Pro Text", "Inter", system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
}
[data-style="claude"] h1,
[data-style="claude"] h2 {
  font-family: ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif;
  letter-spacing: -0.01em;
  font-weight: 500;
}
```

Find the `@theme inline { ... }` block at the top of `globals.css`. Inside that block, append:
```css
  --color-claude-bg:        var(--c-claude-bg);
  --color-claude-surface:   var(--c-claude-surface);
  --color-claude-panel:     var(--c-claude-panel);
  --color-claude-line:      var(--c-claude-line);
  --color-claude-ink-1:     var(--c-claude-ink-1);
  --color-claude-ink-2:     var(--c-claude-ink-2);
  --color-claude-ink-3:     var(--c-claude-ink-3);
  --color-claude-ink-4:     var(--c-claude-ink-4);
  --color-claude-accent:    var(--c-claude-accent);
  --color-claude-accent-bg: var(--c-claude-accent-bg);
  --color-claude-ok:        var(--c-claude-ok);
  --color-claude-warn:      var(--c-claude-warn);
  --color-claude-err:       var(--c-claude-err);
```

This makes Tailwind utilities like `bg-claude-surface`, `text-claude-ink-1`, `border-claude-line` work.

- [ ] **Step 2: Add the `gauge` icon if missing**

Open `components/shared/Ic.tsx`. Search for `gauge`. If not present, add it to the `Ic` object (use a simple SVG path; pattern matches existing icons):
```tsx
gauge: () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
    <path d="M2 11a6 6 0 1 1 12 0" />
    <path d="M8 11l3-4" />
    <circle cx="8" cy="11" r="0.6" fill="currentColor" />
  </svg>
),
```
Same for `pulse` (used for node activity ring) if not present:
```tsx
pulse: () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
    <path d="M2 8h3l1.5-4 3 8 1.5-4H14" />
  </svg>
),
```

- [ ] **Step 3: Create `components/monitor/atoms.tsx`**

```tsx
"use client";
import React from "react";
import clsx from "clsx";

// Atoms scoped to [data-style="claude"] subtree.
//
// They look at the *currently inherited* Claude tokens via CSS vars, so
// they automatically follow dark mode via the [data-theme="dark"] block
// in globals.css. No theme-aware JS needed.

export function ClaudeCard({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        "rounded-[12px] border border-claude-line bg-claude-surface p-6",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function ClaudeMetric({
  label,
  value,
  hint,
  onClick,
  emphasis = "normal",
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  onClick?: () => void;
  emphasis?: "normal" | "ok" | "warn" | "err";
}) {
  const tone =
    emphasis === "ok" ? "text-claude-ok"
    : emphasis === "warn" ? "text-claude-warn"
    : emphasis === "err" ? "text-claude-err"
    : "text-claude-ink-1";
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "text-left rounded-[10px] px-5 py-4 transition-colors",
        onClick ? "cursor-pointer hover:bg-claude-panel" : "cursor-default",
      )}
    >
      <div className="text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 mb-1">{label}</div>
      <div className={clsx("text-[24px] font-medium tabular-nums leading-tight", tone)}>
        {value}
      </div>
      {hint != null && <div className="text-[12px] text-claude-ink-3 mt-1">{hint}</div>}
    </button>
  );
}

export function ClaudeBadge({
  children,
  tone = "neutral",
  size = "sm",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "ok" | "warn" | "err" | "accent";
  size?: "xs" | "sm";
}) {
  const toneCls =
    tone === "ok"     ? "bg-claude-ok/15 text-claude-ok"
    : tone === "warn" ? "bg-claude-warn/15 text-claude-warn"
    : tone === "err"  ? "bg-claude-err/15 text-claude-err"
    : tone === "accent" ? "bg-claude-accent-bg text-claude-accent"
    : "bg-claude-panel text-claude-ink-2";
  const sizeCls = size === "xs"
    ? "text-[10px] px-1.5 py-0.5"
    : "text-[11px] px-2 py-0.5";
  return (
    <span className={clsx("inline-flex items-center rounded-full font-medium tabular-nums", toneCls, sizeCls)}>
      {children}
    </span>
  );
}

export function ClaudeChip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition-colors",
        active
          ? "bg-claude-accent-bg text-claude-accent border-claude-accent/30"
          : "border-claude-line text-claude-ink-2 hover:bg-claude-panel",
      )}
    >
      {children}
    </button>
  );
}

export function ClaudeButton({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}) {
  const v =
    variant === "primary"
      ? "bg-claude-accent text-white hover:opacity-90"
      : variant === "ghost"
      ? "text-claude-ink-2 hover:bg-claude-panel"
      : "border border-claude-line bg-claude-surface text-claude-ink-1 hover:bg-claude-panel";
  const s = size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3 py-1.5 text-[12.5px]";
  return (
    <button
      {...rest}
      className={clsx("rounded-[8px] inline-flex items-center gap-1.5 transition-colors", v, s, className)}
    />
  );
}

export function ClaudeSectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[14px] font-medium text-claude-ink-2 mb-3 mt-0">
      {children}
    </h2>
  );
}
```

- [ ] **Step 4: Create `app/monitor/layout.tsx`**

```tsx
import React from "react";

// Wrap the entire /monitor subtree so all child pages inherit the Claude
// token group. The data-style attribute is the only way our scoped CSS
// rules in globals.css activate.
export default function MonitorLayout({ children }: { children: React.ReactNode }) {
  return <div data-style="claude" className="min-h-full">{children}</div>;
}
```

- [ ] **Step 5: Create a placeholder `app/monitor/page.tsx` so the route renders**

```tsx
"use client";
import { Shell } from "@/components/shared/Shell";
import { MonitorContent } from "@/components/monitor/MonitorContent";

export default function MonitorPage() {
  return (
    <Shell crumbs={[{ label: "Monitor" }]} direction="">
      <MonitorContent />
    </Shell>
  );
}
```

- [ ] **Step 6: Create a stub `components/monitor/MonitorContent.tsx`**

```tsx
"use client";
import React from "react";
import { ClaudeCard, ClaudeMetric, ClaudeBadge, ClaudeButton, ClaudeSectionTitle } from "./atoms";

export function MonitorContent() {
  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      <h1 className="text-[28px] font-medium mb-2">Monitor</h1>
      <p className="text-claude-ink-3 mb-6">
        Runtime view of the workflow agents. Coming online — Task 3 wires the data.
      </p>
      <div className="grid grid-cols-5 gap-4 mb-6">
        <ClaudeMetric label="Active runs" value="—" />
        <ClaudeMetric label="Pending HITL" value="—" />
        <ClaudeMetric label="Failures" value="—" emphasis="err" />
        <ClaudeMetric label="Tokens" value="—" />
        <ClaudeMetric label="Queue p95" value="—" />
      </div>
      <ClaudeCard>
        <ClaudeSectionTitle>Atoms preview</ClaudeSectionTitle>
        <div className="flex gap-2 items-center">
          <ClaudeBadge tone="ok">healthy</ClaudeBadge>
          <ClaudeBadge tone="warn">degraded</ClaudeBadge>
          <ClaudeBadge tone="err">failing</ClaudeBadge>
          <ClaudeBadge tone="accent">pinned</ClaudeBadge>
          <ClaudeButton variant="primary">Primary</ClaudeButton>
          <ClaudeButton>Secondary</ClaudeButton>
          <ClaudeButton variant="ghost">Ghost</ClaudeButton>
        </div>
      </ClaudeCard>
    </div>
  );
}
```

- [ ] **Step 7: Run build + visual check**

Run: `npm run build`
Expected: clean.

Visit `http://localhost:3002/monitor` (light theme then dark via existing AppBar toggle):
- Page renders with the warm off-white background (light) or warm dark (dark)
- Atoms preview shows all three badge tones + three button variants with the coral accent
- Headings render in a serif face (compare against `/overview` which uses sans-serif H1s — visible delta confirms scoping works)

Visit `http://localhost:3002/overview`:
- Bear-witness check: page is **visually unchanged** vs. before this task. If anything looks different, the scoping leaked — revisit the `[data-style="claude"]` selectors.

- [ ] **Step 8: Commit**

```bash
git add app/globals.css components/shared/Ic.tsx components/monitor/atoms.tsx app/monitor/layout.tsx app/monitor/page.tsx components/monitor/MonitorContent.tsx
git commit -m "$(cat <<'EOF'
feat(monitor): Claude-style token group + atoms + /monitor scaffold

- New OKLCH token group (--c-claude-*) in app/globals.css with light +
  dark variants
- Tailwind utility binding via @theme inline so bg-claude-surface etc.
  work
- Scoped via [data-style="claude"] attribute selector — only takes effect
  inside the /monitor subtree, all existing routes are unaffected
- New atoms in components/monitor/atoms.tsx: ClaudeCard, ClaudeMetric,
  ClaudeBadge, ClaudeChip, ClaudeButton, ClaudeSectionTitle
- /monitor scaffold (layout + placeholder page) so the route renders and
  the styling can be eyeballed before Task 3 wires data

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `/api/monitor/overview` aggregation endpoint

**Goal:** Build the first-screen polling endpoint that returns aggregate state for all 18 nodes + system KPIs + 3 feeds (failures / HITL / recent runs). All data from existing tables, no new schema.

**Files:**
- Create: `lib/monitor/types.ts`
- Create: `lib/monitor/filters.ts`
- Create: `lib/monitor/aggregations.ts`
- Create: `lib/monitor/aggregations.test.ts`
- Create: `app/api/monitor/overview/route.ts`
- Create: `app/api/monitor/overview/route.test.ts`

- [ ] **Step 1: Define shared types in `lib/monitor/types.ts`**

```typescript
// Types shared between /api/monitor/* routes and components/monitor/*.
// Kept in lib/ (not server/) so client components can import safely.

export type MonitorFilter = {
  sinceMs: number;            // window length in ms; client passes via ?windowMs=
  since: string;              // resolved ISO timestamp (server computes from sinceMs)
  client?: string;
  triggerEvent?: string;
  status?: string;
};

export type NodeStatus = 'healthy' | 'degraded' | 'failing' | 'idle';

export type MonitorNodeAgg = {
  name: string;                                            // node id from workflow-graph-meta
  running: number;
  completedInWindow: number;
  failedInWindow: number;
  hitlPending: number;
  successRate1h: number;                                   // 0..1
  queueDepth: number;
  tokensInWindow: { prompt: number; completion: number; total: number };
  avgDurationMs: number;
  status: NodeStatus;
  pulse: boolean;
};

export type MonitorEdgeAgg = {
  from: string;
  to: string;
  eventName: string;
  countInWindow: number;
  lastEventAt: string | null;
};

export type MonitorKpi = {
  activeRuns: number;
  pendingHitl: number;
  failuresInWindow: number;
  tokensInWindow: number;
  queueDepth: number;
  queueLagP50Ms: number;
  queueLagP95Ms: number;
};

export type MonitorFailureRow = {
  runId: string;
  agent: string;
  eventName: string | null;
  narrative: string;
  severity: 'anomaly' | 'error';
  at: string;
  metadata?: Record<string, unknown>;
};

export type MonitorHitlRow = {
  taskId: string;
  runId: string;
  nodeId: string;
  title: string;
  createdAt: string;
  deadline: string | null;
};

export type MonitorRunRow = {
  id: string;
  triggerEvent: string;
  status: 'running' | 'completed' | 'failed' | 'suspended' | 'paused';
  startedAt: string;
  lastActivityAt: string;
  clientLabel: string | null;
};

export type MonitorOverviewResponse = {
  filter: MonitorFilter;
  kpi: MonitorKpi;
  nodes: MonitorNodeAgg[];
  edges: MonitorEdgeAgg[];
  failures: MonitorFailureRow[];
  hitl: MonitorHitlRow[];
  recentRuns: MonitorRunRow[];
};
```

- [ ] **Step 2: Filter parsing in `lib/monitor/filters.ts`**

```typescript
import type { MonitorFilter } from './types';

export const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes (spec §2.1)
const MIN_WINDOW_MS = 60 * 1000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function parseFilter(url: URL): MonitorFilter {
  const raw = Number(url.searchParams.get('windowMs') ?? DEFAULT_WINDOW_MS);
  const sinceMs = Number.isFinite(raw)
    ? Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, raw))
    : DEFAULT_WINDOW_MS;
  return {
    sinceMs,
    since: new Date(Date.now() - sinceMs).toISOString(),
    client: url.searchParams.get('client') ?? undefined,
    triggerEvent: url.searchParams.get('triggerEvent') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  };
}
```

- [ ] **Step 3: Write failing tests for aggregations**

Create `lib/monitor/aggregations.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  pickNodeStatus,
  sumTokensFromActivities,
  buildEdgeAggregates,
} from './aggregations';

describe('pickNodeStatus', () => {
  it('returns failing when error rate > 0.2', () => {
    expect(pickNodeStatus({ running: 0, completedInWindow: 10, failedInWindow: 3, queueDepth: 0 })).toBe('failing');
  });
  it('returns degraded when queue depth > 50 or error rate > 0.05', () => {
    expect(pickNodeStatus({ running: 5, completedInWindow: 100, failedInWindow: 6, queueDepth: 0 })).toBe('degraded');
    expect(pickNodeStatus({ running: 5, completedInWindow: 100, failedInWindow: 0, queueDepth: 60 })).toBe('degraded');
  });
  it('returns healthy when running > 0 and no signals trip', () => {
    expect(pickNodeStatus({ running: 3, completedInWindow: 50, failedInWindow: 1, queueDepth: 5 })).toBe('healthy');
  });
  it('returns idle when no running and no completions', () => {
    expect(pickNodeStatus({ running: 0, completedInWindow: 0, failedInWindow: 0, queueDepth: 0 })).toBe('idle');
  });
});

describe('sumTokensFromActivities', () => {
  it('parses promptTokens/completionTokens/totalTokens from AgentActivity.metadata json', () => {
    const rows = [
      { metadata: JSON.stringify({ promptTokens: 100, completionTokens: 30, totalTokens: 130 }) },
      { metadata: JSON.stringify({ promptTokens: 50, completionTokens: 10, totalTokens: 60 }) },
      { metadata: null },                              // ignored
      { metadata: '{ malformed' },                     // ignored, no throw
      { metadata: JSON.stringify({ note: 'no tokens here' }) }, // ignored
    ];
    const s = sumTokensFromActivities(rows as any);
    expect(s).toEqual({ prompt: 150, completion: 40, total: 190 });
  });
});

describe('buildEdgeAggregates', () => {
  it('counts events flowing from one agent name to the next event consumer', () => {
    // Two events between sync and analyze
    const eventInstances = [
      { name: 'REQUIREMENT_SYNCED', source: 'rpa.ReqSync', ts: new Date('2026-05-14T10:00:00Z'), status: 'accepted' },
      { name: 'REQUIREMENT_SYNCED', source: 'rpa.ReqSync', ts: new Date('2026-05-14T10:01:00Z'), status: 'accepted' },
      { name: 'ANALYSIS_COMPLETED', source: 'rpa.ReqAnalyzer', ts: new Date('2026-05-14T10:05:00Z'), status: 'accepted' },
    ];
    const edges = [
      { from: 'sync',    to: 'analyze', eventName: 'REQUIREMENT_SYNCED' },
      { from: 'analyze', to: 'clarify', eventName: 'ANALYSIS_COMPLETED' },
    ];
    const out = buildEdgeAggregates(edges, eventInstances as any);
    expect(out[0].countInWindow).toBe(2);
    expect(out[0].lastEventAt).toBe('2026-05-14T10:01:00.000Z');
    expect(out[1].countInWindow).toBe(1);
  });
});
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `npx vitest run lib/monitor/aggregations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `lib/monitor/aggregations.ts`**

```typescript
import type {
  MonitorNodeAgg,
  MonitorEdgeAgg,
  NodeStatus,
} from './types';

// ── pickNodeStatus ───────────────────────────────────────────────
// One signal wins. Order matters: explicit failure first, then
// degradation, then idle vs healthy.
export function pickNodeStatus(input: {
  running: number;
  completedInWindow: number;
  failedInWindow: number;
  queueDepth: number;
}): NodeStatus {
  const { running, completedInWindow, failedInWindow, queueDepth } = input;
  const totalAttempts = completedInWindow + failedInWindow;
  const errRate = totalAttempts > 0 ? failedInWindow / totalAttempts : 0;
  if (errRate > 0.2) return 'failing';
  if (queueDepth > 50 || errRate > 0.05) return 'degraded';
  if (running === 0 && totalAttempts === 0) return 'idle';
  return 'healthy';
}

// ── sumTokensFromActivities ─────────────────────────────────────
// AgentActivity rows with type='tool' carry token usage inside the
// metadata JSON via server/llm/instrumented.ts withLlmTelemetry().
// We tolerate every shape of broken metadata — never throw, just skip.
export function sumTokensFromActivities(
  rows: Array<{ metadata: string | null }>,
): { prompt: number; completion: number; total: number } {
  let prompt = 0, completion = 0, total = 0;
  for (const r of rows) {
    if (!r.metadata) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(r.metadata);
    } catch {
      continue;
    }
    const pt = numericOrZero(parsed.promptTokens);
    const ct = numericOrZero(parsed.completionTokens);
    const tt = numericOrZero(parsed.totalTokens);
    if (pt || ct || tt) {
      prompt += pt;
      completion += ct;
      total += tt || (pt + ct);
    }
  }
  return { prompt, completion, total };
}

function numericOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ── buildEdgeAggregates ─────────────────────────────────────────
// Edge volume = how many event_instances of the edge's eventName
// landed in the window. Computed by event name lookup, not by trying
// to reason about source agent identity (RAAS messages can be sourced
// from arbitrary publishers).
export function buildEdgeAggregates(
  edges: Array<{ from: string; to: string; eventName: string }>,
  eventInstances: Array<{ name: string; ts: Date; status: string }>,
): MonitorEdgeAgg[] {
  const byName = new Map<string, { count: number; lastAt: Date | null }>();
  for (const ev of eventInstances) {
    if (ev.status !== 'accepted') continue;
    const bucket = byName.get(ev.name) ?? { count: 0, lastAt: null };
    bucket.count += 1;
    if (!bucket.lastAt || ev.ts > bucket.lastAt) bucket.lastAt = ev.ts;
    byName.set(ev.name, bucket);
  }
  return edges.map((e) => {
    const b = byName.get(e.eventName);
    return {
      from: e.from,
      to: e.to,
      eventName: e.eventName,
      countInWindow: b?.count ?? 0,
      lastEventAt: b?.lastAt?.toISOString() ?? null,
    };
  });
}
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `npx vitest run lib/monitor/aggregations.test.ts`
Expected: 6 passing tests.

- [ ] **Step 7: Write the failing API route test**

Create `app/api/monitor/overview/route.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    workflowRun: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    agentActivity: { findMany: vi.fn(), groupBy: vi.fn() },
    humanTask: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    eventInstance: { findMany: vi.fn() },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

describe('GET /api/monitor/overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.workflowRun.findMany as any).mockResolvedValue([]);
    (prisma.workflowRun.count as any).mockResolvedValue(0);
    (prisma.workflowRun.groupBy as any).mockResolvedValue([]);
    (prisma.agentActivity.findMany as any).mockResolvedValue([]);
    (prisma.agentActivity.groupBy as any).mockResolvedValue([]);
    (prisma.humanTask.findMany as any).mockResolvedValue([]);
    (prisma.humanTask.count as any).mockResolvedValue(0);
    (prisma.humanTask.groupBy as any).mockResolvedValue([]);
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
  });

  it('returns the canonical shape with all sections, even when DB is empty', async () => {
    const res = await GET(new Request('http://x/api/monitor/overview'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.filter.sinceMs).toBeGreaterThan(0);
    expect(j.kpi).toMatchObject({
      activeRuns: 0,
      pendingHitl: 0,
      failuresInWindow: 0,
      tokensInWindow: 0,
      queueDepth: 0,
    });
    expect(Array.isArray(j.nodes)).toBe(true);
    expect(j.nodes.length).toBe(18); // matches workflow-graph-meta
    expect(Array.isArray(j.edges)).toBe(true);
    expect(j.edges.length).toBe(18); // matches workflow-graph-meta EDGES.length
    expect(Array.isArray(j.failures)).toBe(true);
    expect(Array.isArray(j.hitl)).toBe(true);
    expect(Array.isArray(j.recentRuns)).toBe(true);
  });

  it('honours ?windowMs= and reflects it in filter.sinceMs', async () => {
    const res = await GET(new Request('http://x/api/monitor/overview?windowMs=3600000'));
    const j = await res.json();
    expect(j.filter.sinceMs).toBe(3_600_000);
  });

  it('clamps absurd windowMs values to the safe range', async () => {
    const res = await GET(new Request('http://x/api/monitor/overview?windowMs=999999999999999'));
    const j = await res.json();
    expect(j.filter.sinceMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  it('500 when prisma blows up', async () => {
    (prisma.workflowRun.findMany as any).mockRejectedValue(new Error('db down'));
    const res = await GET(new Request('http://x/api/monitor/overview'));
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 8: Run the test, watch it fail**

Run: `npx vitest run app/api/monitor/overview/route.test.ts`
Expected: FAIL — route module not found.

- [ ] **Step 9: Implement `app/api/monitor/overview/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { NODES, EDGES } from '@/lib/workflow-graph-meta';
import { parseFilter } from '@/lib/monitor/filters';
import {
  pickNodeStatus,
  sumTokensFromActivities,
  buildEdgeAggregates,
} from '@/lib/monitor/aggregations';
import type {
  MonitorOverviewResponse,
  MonitorNodeAgg,
  MonitorFailureRow,
  MonitorHitlRow,
  MonitorRunRow,
  MonitorKpi,
} from '@/lib/monitor/types';

// ── /api/monitor/overview ────────────────────────────────────────
//
// The single endpoint that drives the /monitor main page. Returns ~30KB
// of aggregate JSON describing the entire workflow's current state, all
// 18 node aggregates, all 18 edge volumes, top-20 failures, top-20 HITL
// pending, top-12 recent runs.
//
// Polling: client polls every 4s. Endpoint internally caches at 1s TTL
// to coalesce burst polls under load (see CACHE constant).
//
// Tokens come from AgentActivity rows where type='tool' (the path
// server/llm/instrumented.ts withLlmTelemetry uses). AgentEpisode is
// not consulted on main — it's currently unwritten. When agents move
// in-process and start writing AgentEpisode, prefer it for accuracy.

const CACHE_TTL_MS = 1_000;
let cachedAt = 0;
let cachedKey = '';
let cachedBody: MonitorOverviewResponse | null = null;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filter = parseFilter(url);
  const cacheKey = JSON.stringify(filter);

  if (cachedBody && cacheKey === cachedKey && Date.now() - cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(cachedBody);
  }

  try {
    const since = new Date(filter.since);

    // 1) Run-level aggregates
    const [runsInWindow, activeRunsCount, recentRunRows] = await Promise.all([
      prisma.workflowRun.findMany({
        where: { startedAt: { gte: since } },
        select: { id: true, status: true, triggerEvent: true, triggerData: true, startedAt: true, lastActivityAt: true },
      }),
      prisma.workflowRun.count({ where: { status: 'running' } }),
      prisma.workflowRun.findMany({
        orderBy: { lastActivityAt: 'desc' },
        take: 12,
        select: { id: true, status: true, triggerEvent: true, triggerData: true, startedAt: true, lastActivityAt: true },
      }),
    ]);

    // 2) Activity-level rows (the meat — per-agent rollups derive from this)
    const activities = await prisma.agentActivity.findMany({
      where: { createdAt: { gte: since } },
      select: { agentName: true, type: true, metadata: true, createdAt: true, runId: true, narrative: true },
    });

    // 3) HITL pending
    const hitlPendingRows = await prisma.humanTask.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 200,                                         // enough to bucket per-node
      select: { id: true, runId: true, nodeId: true, title: true, createdAt: true, deadline: true },
    });

    // 4) Event instances (drives edge counts + queue lag)
    const eventInstances = await prisma.eventInstance.findMany({
      where: { ts: { gte: since } },
      select: { name: true, ts: true, status: true },
    });

    // ── KPI rollup ─────────────────────────────────────────────
    const failuresAll = activities.filter(a => a.type === 'agent_error' || a.type === 'anomaly');
    const tokensTotal = sumTokensFromActivities(activities.filter(a => a.type === 'tool'));

    const kpi: MonitorKpi = {
      activeRuns: activeRunsCount,
      pendingHitl: hitlPendingRows.length,
      failuresInWindow: failuresAll.length,
      tokensInWindow: tokensTotal.total,
      queueDepth: eventInstances.filter(e => e.status === 'accepted').length,
      queueLagP50Ms: 0,   // p50/p95 not yet implemented; placeholder so client renders.
      queueLagP95Ms: 0,
    };

    // ── Per-node aggregates ────────────────────────────────────
    // We key node aggregates by NODES[i].id, which equals the workflow
    // canvas short name (e.g. "jd"). AGENT_MAP.short uses the canonical
    // agent label (e.g. "JDGenerator"). Map by hand: NODES[i].title
    // happens to include the agent short OR a non-agent label like
    // "信息完整?". For NON-agent nodes (branches/HITL/done/trigger), the
    // aggregate is empty but the row still exists so the UI can render
    // 18 nodes regardless.

    const titleToActivity = new Map<string, typeof activities>();
    for (const a of activities) {
      const list = titleToActivity.get(a.agentName) ?? [];
      list.push(a);
      titleToActivity.set(a.agentName, list);
    }

    const tenSecAgo = new Date(Date.now() - 10_000);

    const nodes: MonitorNodeAgg[] = NODES.map(n => {
      // Match by node title (e.g. "JDGenerator"). Branch / hitl / done
      // nodes never match an agent name -> empty rows.
      const rows = titleToActivity.get(n.title) ?? [];
      const completedInWindow = rows.filter(r => r.type === 'agent_complete').length;
      const failedInWindow = rows.filter(r => r.type === 'agent_error' || r.type === 'anomaly').length;
      const tokens = sumTokensFromActivities(rows.filter(r => r.type === 'tool'));
      const running = rows.filter(r => r.type === 'agent_start').length - completedInWindow - failedInWindow;
      const queueDepth = 0; // populated when we track per-agent backlog (Phase 7 queue page)
      const hitlPending = hitlPendingRows.filter(h => h.nodeId === n.id || h.nodeId === n.title).length;
      const total = completedInWindow + failedInWindow;
      const successRate1h = total > 0 ? completedInWindow / total : 1;
      const pulse = rows.some(r => r.createdAt >= tenSecAgo);
      return {
        name: n.id,
        running: Math.max(0, running),
        completedInWindow,
        failedInWindow,
        hitlPending,
        successRate1h,
        queueDepth,
        tokensInWindow: tokens,
        avgDurationMs: 0,    // populated in a later pass; spec accepts placeholder
        status: pickNodeStatus({ running: Math.max(0, running), completedInWindow, failedInWindow, queueDepth }),
        pulse,
      };
    });

    // ── Edges (event volumes) ──────────────────────────────────
    // EDGES doesn't carry an eventName today — they used to be drawn just
    // as a layout aid. To compute volume we attach an eventName-per-edge
    // mapping inline here (small table). When EDGES grows an eventName
    // field, drop this lookup.
    const EDGE_EVENT: Record<string, string | null> = {
      'trig->sync':     'SCHEDULED_SYNC',
      'sync->analyze':  'REQUIREMENT_SYNCED',
      'analyze->clarify': 'ANALYSIS_COMPLETED',
      'clarify->jd':    'CLARIFICATION_READY',
      'clarify->ask':   'CLARIFICATION_INCOMPLETE',
      'ask->analyze':   'REQUIREMENT_LOGGED',
      'jd->jdappr':     'JD_GENERATED',
      'jdappr->publish': 'JD_APPROVED',
      'publish->collect': 'CHANNEL_PUBLISHED',
      'collect->parse': 'RESUME_DOWNLOADED',
      'parse->match':   'RESUME_PROCESSED',
      'match->reject':  'MATCH_FAILED',
      'match->itv':     'MATCH_PASSED_NEED_INTERVIEW',
      'itv->eval':      'AI_INTERVIEW_COMPLETED',
      'eval->pkg':      'EVALUATION_PASSED',
      'pkg->review':    'PACKAGE_GENERATED',
      'review->guard':  'PACKAGE_APPROVED',
      'guard->submit':  'APPLICATION_SUBMITTED',
    };
    const edgesWithEvent = EDGES.map(e => ({
      ...e,
      eventName: EDGE_EVENT[`${e.from}->${e.to}`] ?? '',
    }));
    const edges = buildEdgeAggregates(edgesWithEvent, eventInstances);

    // ── Failure feed ───────────────────────────────────────────
    const failures: MonitorFailureRow[] = failuresAll
      .slice(0, 20)
      .map(a => ({
        runId: a.runId ?? '',
        agent: a.agentName,
        eventName: null,
        narrative: a.narrative,
        severity: a.type === 'agent_error' ? 'error' : 'anomaly',
        at: a.createdAt.toISOString(),
        metadata: a.metadata ? safeParse(a.metadata) : undefined,
      }));

    // ── HITL feed ──────────────────────────────────────────────
    const hitl: MonitorHitlRow[] = hitlPendingRows.slice(0, 20).map(h => ({
      taskId: h.id,
      runId: h.runId,
      nodeId: h.nodeId,
      title: h.title,
      createdAt: h.createdAt.toISOString(),
      deadline: h.deadline?.toISOString() ?? null,
    }));

    // ── Recent runs ────────────────────────────────────────────
    const recentRuns: MonitorRunRow[] = recentRunRows.map(r => ({
      id: r.id,
      triggerEvent: r.triggerEvent,
      status: r.status as MonitorRunRow['status'],
      startedAt: r.startedAt.toISOString(),
      lastActivityAt: r.lastActivityAt.toISOString(),
      clientLabel: extractClientLabel(r.triggerData),
    }));

    const body: MonitorOverviewResponse = {
      filter,
      kpi,
      nodes,
      edges,
      failures,
      hitl,
      recentRuns,
    };

    cachedAt = Date.now();
    cachedKey = cacheKey;
    cachedBody = body;
    return NextResponse.json(body);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[/api/monitor/overview] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}

function extractClientLabel(triggerData: string | null): string | null {
  if (!triggerData) return null;
  try {
    const parsed = JSON.parse(triggerData);
    return typeof parsed.client === 'string' ? parsed.client : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 10: Run the API tests, verify they pass**

Run: `npx vitest run app/api/monitor/overview/route.test.ts`
Expected: 4 passing tests.

- [ ] **Step 11: Smoke-test against the real DB**

Visit `http://localhost:3002/api/monitor/overview` in a browser (or curl):
```bash
curl -s 'http://localhost:3002/api/monitor/overview' | python3 -m json.tool | head -50
```
Expected: 200, well-formed JSON, 18 nodes + 18 edges, possibly empty feeds.

- [ ] **Step 12: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: all green (existing tests + new ones).

- [ ] **Step 13: Build check**

Run: `npm run build`
Expected: clean.

- [ ] **Step 14: Commit**

```bash
git add lib/monitor/ app/api/monitor/overview/
git commit -m "$(cat <<'EOF'
feat(monitor): GET /api/monitor/overview aggregation endpoint

First-screen polling endpoint that drives the /monitor main page.
Returns ~30KB of aggregate JSON: 18 node aggregates, 18 edge volumes,
top-20 failures, top-20 HITL pending, top-12 recent runs.

- lib/monitor/types.ts        canonical response types
- lib/monitor/filters.ts      URL → MonitorFilter with safe defaults
                              (5min window, clamps to 1min..7d)
- lib/monitor/aggregations.ts pure: pickNodeStatus,
                              sumTokensFromActivities,
                              buildEdgeAggregates (6 vitest cases)
- app/api/monitor/overview/   route.ts with 1s in-memory cache, 500 on
                              prisma failure, gracefully empty when DB
                              has no rows (4 vitest cases)

Tokens read from AgentActivity rows where type='tool', metadata JSON
{ promptTokens, completionTokens, totalTokens } — the path the existing
withLlmTelemetry() helper writes. AgentEpisode unused on this branch
(see audit note from Task 0).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `/monitor` main page — graph + KPI + filters + feeds

**Goal:** Build the actual `/monitor` page consuming `/api/monitor/overview`. Renders the 18-node graph with per-node aggregates, the KPI strip, the filter chips, and the three bottom feeds.

**Files:**
- Modify: `components/monitor/MonitorContent.tsx` (replace stub with real page)
- Create: `components/monitor/MonitorGraph.tsx`
- Create: `components/monitor/MonitorNode.tsx`
- Create: `components/monitor/MonitorEdge.tsx`
- Create: `components/monitor/FilterChips.tsx`
- Create: `components/monitor/KpiStrip.tsx`
- Create: `components/monitor/FailuresFeed.tsx`
- Create: `components/monitor/HitlFeed.tsx`
- Create: `components/monitor/RecentRunsStrip.tsx`
- Create: `components/monitor/MiniRunList.tsx`
- Create: `lib/monitor/usePoll.ts` (small polling hook)

This task has many files — split into 7 sub-steps. Build bottom-up: small atoms first, MonitorContent last.

- [ ] **Step 1: Create polling hook `lib/monitor/usePoll.ts`**

```typescript
"use client";
import { useEffect, useRef, useState } from 'react';

// usePoll<T>(url, intervalMs)
// - First request fires immediately on mount.
// - Subsequent requests fire every intervalMs.
// - Errors are stored in state and visible in `error`; previous data is
//   kept so the UI doesn't flash to "nothing".
// - Unmount cancels the next tick.
export function usePoll<T>(url: string, intervalMs = 4_000): {
  data: T | null;
  error: string | null;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const tick = async () => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!cancelled.current) {
        setData(json);
        setError(null);
      }
    } catch (e) {
      if (!cancelled.current) setError((e as Error).message);
    }
  };

  useEffect(() => {
    cancelled.current = false;
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled.current = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, intervalMs]);

  return { data, error, refresh: tick };
}
```

- [ ] **Step 2: Create node + edge SVG components**

`components/monitor/MonitorNode.tsx`:
```tsx
"use client";
import React from "react";
import clsx from "clsx";
import type { WorkflowNode } from "@/lib/workflow-graph-meta";
import type { MonitorNodeAgg, NodeStatus } from "@/lib/monitor/types";

const STATUS_FILL: Record<NodeStatus, string> = {
  idle:     "var(--c-claude-panel)",
  healthy:  "var(--c-claude-surface)",
  degraded: "color-mix(in oklch, var(--c-claude-warn) 18%, var(--c-claude-surface))",
  failing:  "color-mix(in oklch, var(--c-claude-err) 22%, var(--c-claude-surface))",
};
const STATUS_STROKE: Record<NodeStatus, string> = {
  idle:     "var(--c-claude-line)",
  healthy:  "var(--c-claude-line)",
  degraded: "var(--c-claude-warn)",
  failing:  "var(--c-claude-err)",
};

const NODE_W = 154;
const NODE_H = 64;

type Props = {
  node: WorkflowNode;
  agg?: MonitorNodeAgg;
  onClick?: () => void;
  onRunningClick?: () => void;
};

export function MonitorNode({ node, agg, onClick, onRunningClick }: Props) {
  const status = agg?.status ?? "idle";
  const running = agg?.running ?? 0;
  const hitl = agg?.hitlPending ?? 0;
  const queue = agg?.queueDepth ?? 0;
  return (
    <g
      transform={`translate(${node.x - NODE_W / 2}, ${node.y - NODE_H / 2})`}
      onClick={onClick}
      className={clsx(onClick && "cursor-pointer", agg?.pulse && "monitor-pulse")}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={10}
        fill={STATUS_FILL[status]}
        stroke={STATUS_STROKE[status]}
        strokeWidth={status === "idle" || status === "healthy" ? 1 : 1.5}
      />
      <text x={10} y={20} fontSize={12.5} fontWeight={500} fill="var(--c-claude-ink-1)">
        {node.title}
      </text>
      {/* Aggregate badges, only rendered when meaningful */}
      <g transform="translate(10, 38)">
        {running > 0 && (
          <g
            onClick={(e) => { e.stopPropagation(); onRunningClick?.(); }}
            className={clsx(onRunningClick && "cursor-pointer")}
          >
            <rect width={36} height={18} rx={9} fill="var(--c-claude-accent-bg)" />
            <text x={18} y={13} fontSize={11} textAnchor="middle" fill="var(--c-claude-accent)" fontWeight={500}>
              {running} ▶
            </text>
          </g>
        )}
        {hitl > 0 && (
          <g transform={`translate(${running > 0 ? 42 : 0}, 0)`}>
            <rect width={32} height={18} rx={9} fill="color-mix(in oklch, var(--c-claude-warn) 22%, transparent)" />
            <text x={16} y={13} fontSize={11} textAnchor="middle" fill="var(--c-claude-warn)" fontWeight={500}>
              {hitl} ⏸
            </text>
          </g>
        )}
        {queue > 0 && (
          <g transform={`translate(${(running > 0 ? 42 : 0) + (hitl > 0 ? 36 : 0)}, 0)`}>
            <rect width={36} height={18} rx={9} fill="var(--c-claude-panel)" />
            <text x={18} y={13} fontSize={11} textAnchor="middle" fill="var(--c-claude-ink-2)" fontWeight={500}>
              Q {queue}
            </text>
          </g>
        )}
      </g>
    </g>
  );
}
```

Add the pulse animation to `app/globals.css` under the Claude-style block:
```css
@keyframes monitorPulse {
  0%, 100% { filter: drop-shadow(0 0 0 transparent); }
  50%      { filter: drop-shadow(0 0 4px var(--c-claude-accent)); }
}
[data-style="claude"] .monitor-pulse { animation: monitorPulse 2s ease-in-out infinite; }
```

`components/monitor/MonitorEdge.tsx`:
```tsx
"use client";
import React from "react";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-graph-meta";
import type { MonitorEdgeAgg } from "@/lib/monitor/types";

type Props = {
  edge: WorkflowEdge;
  fromNode: WorkflowNode;
  toNode: WorkflowNode;
  agg?: MonitorEdgeAgg;
};

const NODE_W = 154;
const NODE_H = 64;

function endpoint(n: WorkflowNode) {
  return { x: n.x, y: n.y };
}

export function MonitorEdge({ edge, fromNode, toNode, agg }: Props) {
  const f = endpoint(fromNode);
  const t = endpoint(toNode);
  // Simple straight line; dash + label match the original /workflow look.
  // Density: stroke-width grows with countInWindow.
  const count = agg?.countInWindow ?? 0;
  const strokeWidth = count >= 100 ? 2.2 : count >= 10 ? 1.6 : 1;
  const stroke = "var(--c-claude-line)";

  const mid = { x: (f.x + t.x) / 2, y: (f.y + t.y) / 2 };

  return (
    <g>
      <line
        x1={f.x} y1={f.y} x2={t.x} y2={t.y}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={edge.dashed ? "5 4" : undefined}
      />
      {/* Density animation: a small dot travels along the edge if count>0 */}
      {count > 0 && (
        <circle r={3} fill="var(--c-claude-accent)">
          <animateMotion
            dur={`${Math.max(2, 8 - Math.log10(count))}s`}
            repeatCount="indefinite"
            path={`M${f.x},${f.y} L${t.x},${t.y}`}
          />
        </circle>
      )}
      {edge.label && (
        <text
          x={mid.x}
          y={mid.y - 6}
          fontSize={10.5}
          fill="var(--c-claude-ink-3)"
          textAnchor="middle"
        >
          {edge.label}
        </text>
      )}
    </g>
  );
}
```

- [ ] **Step 3: Create the graph composer `components/monitor/MonitorGraph.tsx`**

```tsx
"use client";
import React from "react";
import {
  GRAPH_VIEWBOX,
  GRAPH_WIDTH,
  GRAPH_HEIGHT,
  NODES,
  EDGES,
  nodeById,
} from "@/lib/workflow-graph-meta";
import type {
  MonitorNodeAgg,
  MonitorEdgeAgg,
} from "@/lib/monitor/types";
import { MonitorNode } from "./MonitorNode";
import { MonitorEdge } from "./MonitorEdge";

type Props = {
  nodeAggs?: MonitorNodeAgg[];
  edgeAggs?: MonitorEdgeAgg[];
  onNodeClick?: (nodeId: string) => void;
  onRunningClick?: (nodeId: string) => void;
};

export function MonitorGraph({ nodeAggs, edgeAggs, onNodeClick, onRunningClick }: Props) {
  const aggByName = new Map((nodeAggs ?? []).map(a => [a.name, a]));
  const edgeAggByKey = new Map((edgeAggs ?? []).map(e => [`${e.from}->${e.to}`, e]));

  return (
    <div className="w-full overflow-auto rounded-[12px] border border-claude-line bg-claude-surface">
      <svg
        viewBox={GRAPH_VIEWBOX}
        width="100%"
        height={GRAPH_HEIGHT}
        preserveAspectRatio="xMidYMid meet"
        style={{ minWidth: GRAPH_WIDTH }}
      >
        {/* Edges drawn first so nodes overlay them */}
        {EDGES.map((e, i) => {
          const from = nodeById(e.from);
          const to   = nodeById(e.to);
          if (!from || !to) return null;
          return (
            <MonitorEdge
              key={i}
              edge={e}
              fromNode={from}
              toNode={to}
              agg={edgeAggByKey.get(`${e.from}->${e.to}`)}
            />
          );
        })}
        {NODES.map(n => (
          <MonitorNode
            key={n.id}
            node={n}
            agg={aggByName.get(n.id)}
            onClick={onNodeClick ? () => onNodeClick(n.id) : undefined}
            onRunningClick={onRunningClick ? () => onRunningClick(n.id) : undefined}
          />
        ))}
      </svg>
    </div>
  );
}
```

- [ ] **Step 4: KPI strip + filter chips**

`components/monitor/KpiStrip.tsx`:
```tsx
"use client";
import React from "react";
import { ClaudeMetric } from "./atoms";
import type { MonitorKpi } from "@/lib/monitor/types";

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function KpiStrip({
  kpi,
  onApplyStatusFilter,
  onApplyHitlFilter,
}: {
  kpi: MonitorKpi | null;
  onApplyStatusFilter: (s: 'failed') => void;
  onApplyHitlFilter: () => void;
}) {
  return (
    <div className="grid grid-cols-5 gap-3">
      <ClaudeMetric label="Active runs" value={kpi ? fmt(kpi.activeRuns) : "—"} />
      <ClaudeMetric
        label="Pending HITL"
        value={kpi ? fmt(kpi.pendingHitl) : "—"}
        emphasis={kpi && kpi.pendingHitl > 0 ? "warn" : "normal"}
        onClick={kpi && kpi.pendingHitl > 0 ? onApplyHitlFilter : undefined}
      />
      <ClaudeMetric
        label="Failures (window)"
        value={kpi ? fmt(kpi.failuresInWindow) : "—"}
        emphasis={kpi && kpi.failuresInWindow > 0 ? "err" : "normal"}
        onClick={kpi && kpi.failuresInWindow > 0 ? () => onApplyStatusFilter('failed') : undefined}
      />
      <ClaudeMetric label="Tokens (window)" value={kpi ? fmt(kpi.tokensInWindow) : "—"} />
      <ClaudeMetric label="Queue p95" value={kpi ? `${kpi.queueLagP95Ms}ms` : "—"} />
    </div>
  );
}
```

`components/monitor/FilterChips.tsx`:
```tsx
"use client";
import React from "react";
import { ClaudeChip } from "./atoms";

const WINDOW_OPTIONS: Array<{ id: string; ms: number; label: string }> = [
  { id: '5m',  ms: 5 * 60 * 1000,                label: '5min' },
  { id: '1h',  ms: 60 * 60 * 1000,               label: '1h' },
  { id: '24h', ms: 24 * 60 * 60 * 1000,          label: '24h' },
  { id: '7d',  ms: 7 * 24 * 60 * 60 * 1000,      label: '7d' },
];

export function FilterChips({
  windowMs,
  onWindowChange,
  status,
  onStatusChange,
  search,
  onSearchChange,
}: {
  windowMs: number;
  onWindowChange: (ms: number) => void;
  status?: string;
  onStatusChange: (s: string | undefined) => void;
  search: string;
  onSearchChange: (s: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11px] uppercase tracking-[0.08em] text-claude-ink-4">Time</span>
      {WINDOW_OPTIONS.map(opt => (
        <ClaudeChip
          key={opt.id}
          active={Math.abs(windowMs - opt.ms) < 1}
          onClick={() => onWindowChange(opt.ms)}
        >
          {opt.label}
        </ClaudeChip>
      ))}
      <span className="text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 ml-3">Status</span>
      <ClaudeChip active={!status} onClick={() => onStatusChange(undefined)}>All</ClaudeChip>
      <ClaudeChip active={status === 'running'} onClick={() => onStatusChange('running')}>Running</ClaudeChip>
      <ClaudeChip active={status === 'failed'} onClick={() => onStatusChange('failed')}>Failed</ClaudeChip>
      <ClaudeChip active={status === 'completed'} onClick={() => onStatusChange('completed')}>Completed</ClaudeChip>
      <div className="ml-auto">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="run / candidate / jd id…"
          className="rounded-full border border-claude-line bg-claude-surface px-3 py-1 text-[12.5px] w-[260px] focus:outline-none focus:ring-1 focus:ring-claude-accent"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Three feeds**

`components/monitor/FailuresFeed.tsx`:
```tsx
"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeSectionTitle, ClaudeBadge } from "./atoms";
import type { MonitorFailureRow } from "@/lib/monitor/types";

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

export function FailuresFeed({ rows }: { rows: MonitorFailureRow[] }) {
  return (
    <ClaudeCard className="h-full">
      <ClaudeSectionTitle>Failures</ClaudeSectionTitle>
      {rows.length === 0 ? (
        <div className="text-claude-ink-4 text-[12.5px]">No failures in window.</div>
      ) : (
        <ul className="flex flex-col divide-y divide-claude-line">
          {rows.map((r, i) => (
            <li key={i} className="py-2 first:pt-0 last:pb-0">
              <Link
                href={r.runId ? `/monitor/runs/${encodeURIComponent(r.runId)}` : '#'}
                className="flex items-start gap-2 text-[12.5px] no-underline hover:bg-claude-panel rounded px-1 py-1 -mx-1"
              >
                <ClaudeBadge tone={r.severity === 'error' ? 'err' : 'warn'} size="xs">
                  {r.severity}
                </ClaudeBadge>
                <span className="text-claude-ink-1 font-medium">{r.agent}</span>
                <span className="text-claude-ink-3 truncate">— {r.narrative}</span>
                <span className="ml-auto text-claude-ink-4 tabular-nums">{timeAgo(r.at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ClaudeCard>
  );
}
```

`components/monitor/HitlFeed.tsx`:
```tsx
"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeSectionTitle, ClaudeBadge } from "./atoms";
import type { MonitorHitlRow } from "@/lib/monitor/types";

export function HitlFeed({ rows }: { rows: MonitorHitlRow[] }) {
  return (
    <ClaudeCard className="h-full">
      <ClaudeSectionTitle>Pending HITL</ClaudeSectionTitle>
      {rows.length === 0 ? (
        <div className="text-claude-ink-4 text-[12.5px]">No tasks waiting.</div>
      ) : (
        <ul className="flex flex-col divide-y divide-claude-line">
          {rows.map((r) => (
            <li key={r.taskId} className="py-2 first:pt-0 last:pb-0">
              <Link
                href={`/inbox/${encodeURIComponent(r.taskId)}`}
                className="flex items-start gap-2 text-[12.5px] no-underline hover:bg-claude-panel rounded px-1 py-1 -mx-1"
              >
                <ClaudeBadge tone="warn" size="xs">{r.nodeId}</ClaudeBadge>
                <span className="text-claude-ink-1 truncate">{r.title}</span>
                {r.deadline && (
                  <span className="ml-auto text-claude-ink-4 tabular-nums">
                    due {new Date(r.deadline).toLocaleTimeString()}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ClaudeCard>
  );
}
```

`components/monitor/RecentRunsStrip.tsx`:
```tsx
"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeSectionTitle, ClaudeBadge } from "./atoms";
import type { MonitorRunRow } from "@/lib/monitor/types";

const STATUS_TONE = {
  running:   'accent',
  completed: 'ok',
  failed:    'err',
  suspended: 'warn',
  paused:    'warn',
} as const;

export function RecentRunsStrip({ rows }: { rows: MonitorRunRow[] }) {
  return (
    <ClaudeCard className="h-full">
      <ClaudeSectionTitle>Recent runs</ClaudeSectionTitle>
      <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
        {rows.length === 0 ? (
          <div className="text-claude-ink-4 text-[12.5px]">No runs.</div>
        ) : (
          rows.map((r) => (
            <Link
              key={r.id}
              href={`/monitor/runs/${encodeURIComponent(r.id)}`}
              className="flex-none w-[200px] rounded-[10px] border border-claude-line bg-claude-bg p-3 no-underline hover:bg-claude-panel"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-claude-ink-1 text-[12.5px] font-medium truncate">{r.triggerEvent}</span>
                <ClaudeBadge tone={STATUS_TONE[r.status] ?? 'neutral'} size="xs">{r.status}</ClaudeBadge>
              </div>
              <div className="text-claude-ink-3 text-[11.5px] truncate">{r.clientLabel ?? '—'}</div>
              <div className="text-claude-ink-4 text-[11px] mt-1 tabular-nums">{r.id.slice(0, 12)}…</div>
            </Link>
          ))
        )}
      </div>
    </ClaudeCard>
  );
}
```

- [ ] **Step 6: MiniRunList popover**

`components/monitor/MiniRunList.tsx`:
```tsx
"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeSectionTitle, ClaudeBadge } from "./atoms";
import type { MonitorRunRow } from "@/lib/monitor/types";

type Props = {
  agentTitle: string;
  rows: MonitorRunRow[];
  onClose: () => void;
};

export function MiniRunList({ agentTitle, rows, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 bg-black/10 flex items-start justify-center pt-24" onClick={onClose}>
      <ClaudeCard className="w-[420px] max-h-[60vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <ClaudeSectionTitle>{agentTitle} — active runs</ClaudeSectionTitle>
          <button onClick={onClose} className="text-claude-ink-3 hover:text-claude-ink-1 text-[14px]">×</button>
        </div>
        {rows.length === 0 ? (
          <div className="text-claude-ink-4 text-[12.5px]">No active runs.</div>
        ) : (
          <ul className="flex flex-col divide-y divide-claude-line">
            {rows.slice(0, 5).map(r => (
              <li key={r.id} className="py-2 first:pt-0">
                <Link href={`/monitor/runs/${encodeURIComponent(r.id)}`} className="block no-underline hover:bg-claude-panel rounded p-1 -mx-1">
                  <div className="flex items-center justify-between">
                    <span className="text-claude-ink-1 text-[12.5px] font-medium">{r.triggerEvent}</span>
                    <ClaudeBadge tone="accent" size="xs">running</ClaudeBadge>
                  </div>
                  <div className="text-claude-ink-3 text-[11.5px]">{r.clientLabel ?? '—'} · {r.id.slice(0, 8)}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </ClaudeCard>
    </div>
  );
}
```

- [ ] **Step 7: Compose everything in `components/monitor/MonitorContent.tsx`**

Replace the stub from Task 2 with:
```tsx
"use client";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePoll } from "@/lib/monitor/usePoll";
import { MonitorGraph } from "./MonitorGraph";
import { FilterChips } from "./FilterChips";
import { KpiStrip } from "./KpiStrip";
import { FailuresFeed } from "./FailuresFeed";
import { HitlFeed } from "./HitlFeed";
import { RecentRunsStrip } from "./RecentRunsStrip";
import { MiniRunList } from "./MiniRunList";
import type { MonitorOverviewResponse, MonitorRunRow } from "@/lib/monitor/types";

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

export function MonitorContent() {
  const router = useRouter();
  const sp = useSearchParams();

  // URL state
  const windowMs = Number(sp.get('windowMs') ?? DEFAULT_WINDOW_MS);
  const status = sp.get('status') ?? undefined;
  const [search, setSearch] = React.useState<string>(sp.get('q') ?? '');

  const updateUrl = React.useCallback((mut: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(sp.toString());
    mut(next);
    router.replace(`/monitor${next.toString() ? `?${next.toString()}` : ''}`);
  }, [router, sp]);

  // Build the API URL from filters
  const apiUrl = React.useMemo(() => {
    const p = new URLSearchParams();
    p.set('windowMs', String(windowMs));
    if (status) p.set('status', status);
    return `/api/monitor/overview?${p.toString()}`;
  }, [windowMs, status]);

  const { data, error } = usePoll<MonitorOverviewResponse>(apiUrl, 4_000);

  // Mini run list state (when a node's "running ▶" badge is clicked)
  const [miniAgent, setMiniAgent] = React.useState<string | null>(null);
  const miniRows: MonitorRunRow[] = React.useMemo(() => {
    if (!miniAgent || !data) return [];
    // Approximation: recentRuns isn't keyed by agent — fall back to
    // showing recentRuns global slice. A more precise per-agent endpoint
    // can replace this later.
    return data.recentRuns.filter(r => r.status === 'running').slice(0, 5);
  }, [miniAgent, data]);

  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-[28px] font-medium leading-tight">Monitor</h1>
          <p className="text-claude-ink-3 text-[13px] mt-1">
            Runtime state of all workflow agents.
            {error && <span className="text-claude-err"> · {error}</span>}
          </p>
        </div>
      </div>

      <div className="mb-4">
        <FilterChips
          windowMs={windowMs}
          onWindowChange={(ms) => updateUrl(p => p.set('windowMs', String(ms)))}
          status={status}
          onStatusChange={(s) => updateUrl(p => { s ? p.set('status', s) : p.delete('status'); })}
          search={search}
          onSearchChange={setSearch}
        />
      </div>

      <div className="mb-4">
        <KpiStrip
          kpi={data?.kpi ?? null}
          onApplyStatusFilter={(s) => updateUrl(p => p.set('status', s))}
          onApplyHitlFilter={() => router.push('/inbox')}
        />
      </div>

      <div className="mb-6">
        <MonitorGraph
          nodeAggs={data?.nodes}
          edgeAggs={data?.edges}
          onNodeClick={(id) => router.push(`/monitor/agents/${encodeURIComponent(id)}`)}
          onRunningClick={(id) => setMiniAgent(id)}
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <RecentRunsStrip rows={data?.recentRuns ?? []} />
        <FailuresFeed   rows={data?.failures ?? []} />
        <HitlFeed       rows={data?.hitl ?? []} />
      </div>

      {miniAgent && (
        <MiniRunList
          agentTitle={miniAgent}
          rows={miniRows}
          onClose={() => setMiniAgent(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 8: Build + visual check**

Run: `npm run build`
Expected: clean.

Visit `http://localhost:3002/monitor`:
- 18 nodes render in the same positions as `/workflow`
- KPI strip shows real numbers from the DB
- Filter chips work; clicking "1h" updates URL and triggers a re-fetch
- Failures / HITL / Recent runs feeds populate from DB (or show empty states if DB is empty)
- Toggle dark mode via the AppBar: everything follows
- Click on a node → `/monitor/agents/[id]` 404s (page doesn't exist yet — that's expected; we'll build it in Task 6)
- Click on a node's "5 ▶" badge (if any agent has runs) → MiniRunList popover shows

- [ ] **Step 9: Run all tests, commit**

Run: `npx vitest run`
Expected: clean.

```bash
git add app/globals.css components/monitor/ app/monitor/page.tsx lib/monitor/usePoll.ts
git commit -m "$(cat <<'EOF'
feat(monitor): /monitor main page — graph + KPI strip + feeds

Renders the 18-node workflow graph (shared geometry from
lib/workflow-graph-meta) with per-node aggregate badges, status colors,
and edge density animations. KPI strip cells are clickable filters.
Three bottom feeds (recent runs / failures / pending HITL) link to
deep routes. Node "running ▶" badge opens a MiniRunList popover.

New files:
- lib/monitor/usePoll.ts        4s polling hook with error retention
- components/monitor/MonitorGraph + MonitorNode + MonitorEdge
- components/monitor/KpiStrip + FilterChips
- components/monitor/FailuresFeed + HitlFeed + RecentRunsStrip
- components/monitor/MiniRunList

The /monitor/agents/[name] and /monitor/runs/[id] routes targeted by the
graph clicks come online in tasks 5-6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10: Push the chunk so far to origin**

```bash
git push origin main
```

---

## End of Chunk 1

Chunk 1 delivered:
- Verified data sources (Task 0)
- Shared workflow graph geometry extracted, tested (Task 1)
- Claude token group + atoms + scoped styling (Task 2)
- `/api/monitor/overview` aggregation API with 1s cache + tests (Task 3)
- `/monitor` main page with all UI elements (Task 4)

After Chunk 1 lands, `/monitor` is a functional read-only dashboard. Chunk 2 adds the four drill-down pages and finishes the LeftNav swap.

**Continue to Chunk 2 →**

## Chunk 2: Drill-down pages + LeftNav (Tasks 5-9)

### Task 5: `/monitor/runs/[id]` — Run detail with trail-colored graph

**Goal:** Build the single-run detail page. Reuses the same `MonitorGraph` from Task 4 but in "trail mode" — nodes the run touched are colored by result, nodes it didn't are greyed out, edges it traversed are bolder with timestamp labels.

**Files:**
- Create: `app/api/monitor/runs/[id]/route.ts`
- Create: `app/api/monitor/runs/[id]/route.test.ts`
- Create: `app/monitor/runs/[id]/page.tsx`
- Create: `components/monitor/RunDetailContent.tsx`
- Create: `components/monitor/RunTrailGraph.tsx`
- Modify: `components/monitor/MonitorGraph.tsx` (extract a shared base or accept a `trail` prop — see Step 1)
- Modify: `lib/monitor/types.ts` (add `MonitorRunDetail`)

- [ ] **Step 1: Decide on graph reuse strategy**

We have two options:
- (a) Add an optional `trail?: TrailMap` prop to `MonitorGraph` and let it switch modes internally.
- (b) Extract a `<WorkflowSvg>` low-level component that both `MonitorGraph` (aggregate mode) and a new `<RunTrailGraph>` (run mode) wrap.

Pick **(a)** — fewer files, less indirection, and the two modes share 90% of their layout logic.

Modify `components/monitor/MonitorGraph.tsx` to accept an optional `trail` prop:
```tsx
// Add to Props type:
trail?: Map<string, { result: 'success' | 'failure' | 'pending' | 'skipped'; current: boolean }>;
```
In the body, pass a `trailEntry` to each `<MonitorNode>` and let the node component honor it.

Then update `MonitorNode.tsx` to accept and react to `trailEntry`:
```tsx
// New prop on MonitorNode:
trailEntry?: { result: 'success' | 'failure' | 'pending' | 'skipped'; current: boolean };
```
Inside the body, when `trailEntry` is set, override the `status` color mapping:
```tsx
const TRAIL_FILL = {
  success: "color-mix(in oklch, var(--c-claude-ok) 22%, var(--c-claude-surface))",
  failure: "color-mix(in oklch, var(--c-claude-err) 22%, var(--c-claude-surface))",
  pending: "color-mix(in oklch, var(--c-claude-warn) 22%, var(--c-claude-surface))",
  skipped: "var(--c-claude-panel)",
};
const trailFill   = trailEntry ? TRAIL_FILL[trailEntry.result] : STATUS_FILL[status];
const trailStroke = trailEntry?.result === 'failure' ? "var(--c-claude-err)"
                  : trailEntry?.result === 'pending' ? "var(--c-claude-warn)"
                  : STATUS_STROKE[status];
const isTrailUntouched = !trailEntry; // when trail mode is on (controlled by caller)
// Apply opacity 0.3 to nodes whose trailEntry is missing, when the
// caller is in "trail mode". The caller signals that by passing trail.
```
We need a way to signal "trail mode on" to the node. Simplest: pass `isTrailMode: boolean` as a prop too. Update:
```tsx
// In MonitorGraph.tsx, derive isTrailMode = trail != null and pass it down.
```

This is the only modification needed to MonitorGraph + MonitorNode; the changes are additive (existing aggregate-mode behavior unchanged when `trail` is omitted).

- [ ] **Step 2: Add the response type**

Append to `lib/monitor/types.ts`:
```typescript
export type RunTrailStep = {
  nodeId: string;
  enteredAt: string;
  leftAt: string | null;
  result: 'success' | 'failure' | 'pending' | 'skipped';
  durationMs: number | null;
  stepCount: number;
  tokensUsed: number;
  relatedEpisodeId: string | null;
};

export type MonitorRunDetail = {
  run: {
    id: string;
    triggerEvent: string;
    triggerData: Record<string, unknown>;
    status: 'running' | 'completed' | 'failed' | 'suspended' | 'paused';
    startedAt: string;
    completedAt: string | null;
    lastActivityAt: string;
  };
  trail: RunTrailStep[];
  events: Array<{ name: string; ts: string; source: 'inbound' | 'outbound'; eventInstanceId: string | null }>;
  activity: Array<{ ts: string; agent: string; type: string; narrative: string; metadata?: Record<string, unknown> }>;
  tokensByAgent: Record<string, { prompt: number; completion: number; total: number; model: string | null }>;
  hitl: Array<{ taskId: string; status: string; title: string; createdAt: string; completedAt: string | null }>;
};
```

- [ ] **Step 3: Write failing API test**

Create `app/api/monitor/runs/[id]/route.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    workflowRun: { findUnique: vi.fn() },
    agentActivity: { findMany: vi.fn() },
    humanTask: { findMany: vi.fn() },
    eventInstance: { findMany: vi.fn() },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('GET /api/monitor/runs/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when run is not found', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue(null);
    const res = await GET(new Request('http://x/api/monitor/runs/missing'), ctx('missing'));
    expect(res.status).toBe(404);
  });

  it('returns 200 with full run detail when found', async () => {
    (prisma.workflowRun.findUnique as any).mockResolvedValue({
      id: 'r1',
      triggerEvent: 'REQUIREMENT_LOGGED',
      triggerData: '{}',
      status: 'running',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      lastActivityAt: new Date('2026-01-01T00:10:00Z'),
      completedAt: null,
    });
    (prisma.agentActivity.findMany as any).mockResolvedValue([
      { agentName: 'ReqSync', type: 'agent_complete', metadata: null, createdAt: new Date('2026-01-01T00:01:00Z'), narrative: 'done', runId: 'r1' },
    ]);
    (prisma.humanTask.findMany as any).mockResolvedValue([]);
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
    const res = await GET(new Request('http://x/api/monitor/runs/r1'), ctx('r1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.run.id).toBe('r1');
    expect(j.trail).toBeInstanceOf(Array);
    expect(j.activity).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Implement the route**

Create `app/api/monitor/runs/[id]/route.ts`:
```typescript
import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { NODES } from '@/lib/workflow-graph-meta';
import { sumTokensFromActivities } from '@/lib/monitor/aggregations';
import type { MonitorRunDetail, RunTrailStep } from '@/lib/monitor/types';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const run = await prisma.workflowRun.findUnique({ where: { id } });
    if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const [activities, hitlRows, eventRows] = await Promise.all([
      prisma.agentActivity.findMany({
        where: { runId: id },
        orderBy: { createdAt: 'asc' },
        select: { agentName: true, type: true, metadata: true, createdAt: true, narrative: true, runId: true },
      }),
      prisma.humanTask.findMany({
        where: { runId: id },
        select: { id: true, status: true, title: true, createdAt: true, completedAt: true },
      }),
      prisma.eventInstance.findMany({
        // No FK to run yet — fetch a generous slice scoped to the run's time window
        where: {
          ts: { gte: run.startedAt, lte: run.completedAt ?? new Date() },
        },
        orderBy: { ts: 'asc' },
        take: 200,
        select: { id: true, name: true, ts: true, source: true },
      }),
    ]);

    // ── Build trail ──────────────────────────────────────────────
    // For each NODES.title (e.g. "JDGenerator"), find the earliest
    // agent_start and the matching agent_complete / agent_error.
    const trail: RunTrailStep[] = [];
    for (const n of NODES) {
      const ofThis = activities.filter(a => a.agentName === n.title);
      if (ofThis.length === 0) continue;
      const start = ofThis.find(a => a.type === 'agent_start');
      const done  = ofThis.find(a => a.type === 'agent_complete');
      const fail  = ofThis.find(a => a.type === 'agent_error');
      const enteredAt = (start ?? ofThis[0]).createdAt;
      const leftAt    = (done ?? fail)?.createdAt ?? null;
      const result: RunTrailStep['result'] =
        fail ? 'failure' : done ? 'success' : 'pending';
      const tokens = sumTokensFromActivities(ofThis.filter(a => a.type === 'tool'));
      trail.push({
        nodeId: n.id,
        enteredAt: enteredAt.toISOString(),
        leftAt: leftAt?.toISOString() ?? null,
        result,
        durationMs: leftAt ? leftAt.getTime() - enteredAt.getTime() : null,
        stepCount: ofThis.length,
        tokensUsed: tokens.total,
        relatedEpisodeId: null,
      });
    }

    // ── tokensByAgent rollup ─────────────────────────────────────
    const tokensByAgent: MonitorRunDetail['tokensByAgent'] = {};
    for (const a of activities) {
      if (a.type !== 'tool') continue;
      const parsed = a.metadata ? safeParse(a.metadata) : {};
      const promptTokens     = numericOrZero(parsed?.promptTokens);
      const completionTokens = numericOrZero(parsed?.completionTokens);
      const totalTokens      = numericOrZero(parsed?.totalTokens) || (promptTokens + completionTokens);
      const model            = typeof parsed?.model === 'string' ? parsed.model : null;
      const k = a.agentName;
      const cur = tokensByAgent[k] ?? { prompt: 0, completion: 0, total: 0, model };
      cur.prompt += promptTokens;
      cur.completion += completionTokens;
      cur.total += totalTokens;
      if (!cur.model) cur.model = model;
      tokensByAgent[k] = cur;
    }

    const detail: MonitorRunDetail = {
      run: {
        id: run.id,
        triggerEvent: run.triggerEvent,
        triggerData: safeParse(run.triggerData ?? '{}') ?? {},
        status: run.status as MonitorRunDetail['run']['status'],
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        lastActivityAt: run.lastActivityAt.toISOString(),
      },
      trail,
      events: eventRows.map(e => ({
        name: e.name,
        ts: e.ts.toISOString(),
        source: 'inbound',         // refined when source labelling is more reliable
        eventInstanceId: e.id,
      })),
      activity: activities.map(a => ({
        ts: a.createdAt.toISOString(),
        agent: a.agentName,
        type: a.type,
        narrative: a.narrative,
        metadata: a.metadata ? safeParse(a.metadata) : undefined,
      })),
      tokensByAgent,
      hitl: hitlRows.map(h => ({
        taskId: h.id,
        status: h.status,
        title: h.title,
        createdAt: h.createdAt.toISOString(),
        completedAt: h.completedAt?.toISOString() ?? null,
      })),
    };
    return NextResponse.json(detail);
  } catch (e) {
    console.error('[/api/monitor/runs/[id]] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

function safeParse(s: string): Record<string, any> | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}
function numericOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
```

- [ ] **Step 5: Run API tests**

Run: `npx vitest run app/api/monitor/runs/`
Expected: 2 passing.

- [ ] **Step 6: Build `components/monitor/RunDetailContent.tsx`**

```tsx
"use client";
import React from "react";
import Link from "next/link";
import { usePoll } from "@/lib/monitor/usePoll";
import { MonitorGraph } from "./MonitorGraph";
import { ClaudeCard, ClaudeMetric, ClaudeBadge, ClaudeSectionTitle, ClaudeButton } from "./atoms";
import type { MonitorRunDetail } from "@/lib/monitor/types";

const STATUS_TONE = {
  running:   'accent',
  completed: 'ok',
  failed:    'err',
  suspended: 'warn',
  paused:    'warn',
} as const;

export function RunDetailContent({ runId }: { runId: string }) {
  const { data, error } = usePoll<MonitorRunDetail>(`/api/monitor/runs/${encodeURIComponent(runId)}`, 4_000);
  const [tab, setTab] = React.useState<'timeline' | 'events' | 'tokens' | 'hitl'>('timeline');

  if (error && !data) {
    return (
      <div className="p-6 max-w-[1620px] mx-auto">
        <p className="text-claude-err">Failed to load run: {error}</p>
        <Link href="/monitor" className="text-claude-accent">Back to Monitor</Link>
      </div>
    );
  }

  const trailMap = new Map(
    (data?.trail ?? []).map((t, i, arr) => {
      const current = data?.run.status === 'running' && i === arr.length - 1 && t.result === 'pending';
      return [t.nodeId, { result: t.result, current }];
    }),
  );

  const totalTokens = data
    ? Object.values(data.tokensByAgent).reduce((s, t) => s + t.total, 0)
    : 0;

  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      <div className="mb-4">
        <Link href="/monitor" className="text-claude-accent text-[12.5px] no-underline">← Monitor</Link>
      </div>
      <div className="mb-4">
        <h1 className="text-[24px] font-medium leading-tight">{data?.run.triggerEvent ?? '—'}</h1>
        <div className="flex items-center gap-2 mt-1 text-[12.5px] text-claude-ink-3">
          <code className="tabular-nums">{runId}</code>
          <span>·</span>
          {data && (
            <ClaudeBadge tone={STATUS_TONE[data.run.status] ?? 'neutral'}>
              {data.run.status}
            </ClaudeBadge>
          )}
          {data?.run.startedAt && (
            <>
              <span>·</span>
              <span>started {new Date(data.run.startedAt).toLocaleString()}</span>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-4">
        <ClaudeMetric label="Agents touched" value={data ? data.trail.length : '—'} />
        <ClaudeMetric label="Tokens used"    value={data ? totalTokens.toLocaleString() : '—'} />
        <ClaudeMetric
          label="Failures"
          value={data ? data.trail.filter(t => t.result === 'failure').length : '—'}
          emphasis={data && data.trail.some(t => t.result === 'failure') ? 'err' : 'normal'}
        />
        <ClaudeMetric label="HITL"           value={data ? data.hitl.length : '—'} />
      </div>

      <div className="mb-6">
        <MonitorGraph trail={trailMap} />
      </div>

      <div className="flex items-center gap-2 mb-3 border-b border-claude-line">
        {(['timeline', 'events', 'tokens', 'hitl'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              "px-3 py-2 text-[13px] " +
              (tab === t
                ? "text-claude-ink-1 border-b-2 border-claude-accent -mb-px"
                : "text-claude-ink-3 hover:text-claude-ink-1")
            }
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'timeline' && (
        <ClaudeCard>
          <ul className="flex flex-col divide-y divide-claude-line">
            {(data?.activity ?? []).map((a, i) => (
              <li key={i} className="py-2 first:pt-0 last:pb-0 text-[12.5px]">
                <span className="text-claude-ink-4 tabular-nums mr-2">{new Date(a.ts).toLocaleTimeString()}</span>
                <span className="text-claude-ink-1 font-medium">{a.agent}</span>
                <span className="text-claude-ink-3"> — {a.type}: {a.narrative}</span>
              </li>
            ))}
            {(!data || data.activity.length === 0) && (
              <li className="text-claude-ink-4">No activity yet.</li>
            )}
          </ul>
        </ClaudeCard>
      )}

      {tab === 'events' && (
        <ClaudeCard>
          <ul className="flex flex-col divide-y divide-claude-line">
            {(data?.events ?? []).map(e => (
              <li key={e.eventInstanceId ?? `${e.name}-${e.ts}`} className="py-2 text-[12.5px]">
                <span className="text-claude-ink-4 tabular-nums mr-2">{new Date(e.ts).toLocaleTimeString()}</span>
                <code className="text-claude-ink-1">{e.name}</code>
                <span className="text-claude-ink-4 ml-2">{e.source}</span>
              </li>
            ))}
            {(!data || data.events.length === 0) && (
              <li className="text-claude-ink-4">No events.</li>
            )}
          </ul>
        </ClaudeCard>
      )}

      {tab === 'tokens' && (
        <ClaudeCard>
          {Object.keys(data?.tokensByAgent ?? {}).length === 0 ? (
            <div className="text-claude-ink-4 text-[12.5px]">No token usage recorded.</div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead className="text-claude-ink-4">
                <tr>
                  <th className="text-left py-1">Agent</th>
                  <th className="text-right py-1">Prompt</th>
                  <th className="text-right py-1">Completion</th>
                  <th className="text-right py-1">Total</th>
                  <th className="text-left py-1 pl-3">Model</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data!.tokensByAgent).map(([agent, t]) => (
                  <tr key={agent} className="border-t border-claude-line">
                    <td className="py-1">{agent}</td>
                    <td className="py-1 text-right tabular-nums">{t.prompt.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums">{t.completion.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums font-medium">{t.total.toLocaleString()}</td>
                    <td className="py-1 pl-3 text-claude-ink-3">{t.model ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ClaudeCard>
      )}

      {tab === 'hitl' && (
        <ClaudeCard>
          {(data?.hitl ?? []).length === 0 ? (
            <div className="text-claude-ink-4 text-[12.5px]">No HITL tasks for this run.</div>
          ) : (
            <ul className="flex flex-col divide-y divide-claude-line">
              {data!.hitl.map(h => (
                <li key={h.taskId} className="py-2 text-[12.5px]">
                  <Link href={`/inbox/${encodeURIComponent(h.taskId)}`} className="text-claude-ink-1 no-underline hover:underline">
                    <ClaudeBadge tone={h.status === 'pending' ? 'warn' : 'ok'} size="xs">{h.status}</ClaudeBadge>
                    <span className="ml-2">{h.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </ClaudeCard>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Wire the route**

`app/monitor/runs/[id]/page.tsx`:
```tsx
"use client";
import React from "react";
import { useParams } from "next/navigation";
import { Shell } from "@/components/shared/Shell";
import { RunDetailContent } from "@/components/monitor/RunDetailContent";

export default function RunDetailPage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : String(params?.id ?? '');
  return (
    <Shell crumbs={[{ label: "Monitor", href: "/monitor" }, { label: "Run", value: id }]} direction="">
      <RunDetailContent runId={id} />
    </Shell>
  );
}
```

(If `Shell`'s crumb prop shape differs from what's used here, look at `app/live/page.tsx` for the canonical pattern and adapt.)

- [ ] **Step 8: Build + visual check + commit**

Run: `npm run build`
Expected: clean.

Visit `http://localhost:3002/monitor`, click a recent run card → lands on `/monitor/runs/<id>`. Verify:
- Header shows run id, status badge, started timestamp
- Graph renders with the run's trail nodes colored, untouched nodes greyed
- Tabs switch between timeline / events / tokens / hitl
- Token table renders when token data exists; empty state otherwise

```bash
git add app/api/monitor/runs lib/monitor/types.ts components/monitor/RunDetailContent.tsx components/monitor/MonitorGraph.tsx components/monitor/MonitorNode.tsx app/monitor/runs
git commit -m "feat(monitor): /monitor/runs/[id] run detail page with trail-colored graph

- New API: GET /api/monitor/runs/[id] returns run + trail + activity +
  events + tokensByAgent + hitl in a single response (2 vitest cases)
- New component: RunDetailContent — header + KPI strip + trail graph +
  4 tabs (timeline / events / tokens / hitl)
- MonitorGraph + MonitorNode accept an optional trail map and switch to
  trail-colored mode (touched nodes colored, untouched greyed)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `/monitor/agents/[name]` — Agent detail page

**Goal:** Per-agent detail page with episodes table, 24h token line chart, error rate chart, errors list, and read-only AgentConfig view.

**Files:**
- Create: `app/api/monitor/agents/[name]/route.ts`
- Create: `app/api/monitor/agents/[name]/route.test.ts`
- Create: `app/monitor/agents/[name]/page.tsx`
- Create: `components/monitor/AgentDetailContent.tsx`
- Create: `components/monitor/TokenChart.tsx`
- Create: `components/monitor/ErrorRateChart.tsx`
- Modify: `lib/monitor/types.ts` (add `MonitorAgentDetail`)

- [ ] **Step 1: Append types**

Add to `lib/monitor/types.ts`:
```typescript
export type MonitorAgentDetail = {
  name: string;
  title: string;
  config: {
    enabled: boolean;
    temperature: number | null;
    maxRetries: number | null;
    tier: string | null;
    maxOutputTokens: number | null;
    promptAppend: string | null;
  } | null;
  recentEpisodes: Array<{
    id: string;
    runId: string;
    clientId: string | null;
    durationMs: number;
    tokenUsage: { prompt: number; completion: number; total: number };
    modelUsed: string | null;
    judgeScore: number | null;
    createdAt: string;
  }>;
  tokenSpend: Array<{ bucket: string; prompt: number; completion: number; total: number }>;
  errorRate:  Array<{ bucket: string; total: number; failed: number }>;
  recentErrors: Array<{ runId: string; narrative: string; ts: string; metadata?: Record<string, unknown> }>;
};
```

- [ ] **Step 2: Write failing API test**

`app/api/monitor/agents/[name]/route.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    agentActivity: { findMany: vi.fn() },
    agentEpisode: { findMany: vi.fn() },
    agentConfig: { findUnique: vi.fn() },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

describe('GET /api/monitor/agents/[name]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.agentActivity.findMany as any).mockResolvedValue([]);
    (prisma.agentEpisode.findMany as any).mockResolvedValue([]);
    (prisma.agentConfig.findUnique as any).mockResolvedValue(null);
  });

  it('returns 404 when name is not a known node id', async () => {
    const res = await GET(new Request('http://x/api/monitor/agents/banana'), ctx('banana'));
    expect(res.status).toBe(404);
  });

  it('returns 200 with the canonical shape for a known node id', async () => {
    const res = await GET(new Request('http://x/api/monitor/agents/jd'), ctx('jd'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.name).toBe('jd');
    expect(j.title).toBe('JDGenerator');
    expect(Array.isArray(j.recentEpisodes)).toBe(true);
    expect(Array.isArray(j.tokenSpend)).toBe(true);
    expect(j.tokenSpend).toHaveLength(24); // 24 hourly buckets
  });
});
```

- [ ] **Step 3: Run the test, watch it fail**

Run: `npx vitest run app/api/monitor/agents/`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement the route**

`app/api/monitor/agents/[name]/route.ts`:
```typescript
import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { nodeById } from '@/lib/workflow-graph-meta';
import { sumTokensFromActivities } from '@/lib/monitor/aggregations';
import type { MonitorAgentDetail } from '@/lib/monitor/types';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await ctx.params;
  const node = nodeById(name);
  if (!node) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [activities, episodes, config] = await Promise.all([
      prisma.agentActivity.findMany({
        where: { agentName: node.title, createdAt: { gte: since24h } },
        orderBy: { createdAt: 'asc' },
        select: { type: true, metadata: true, createdAt: true, narrative: true, runId: true },
      }),
      // AgentEpisode is currently unwritten on this branch, but query
      // anyway — works the day agents start writing.
      prisma.agentEpisode.findMany({
        where: { agentName: node.title },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }).catch(() => []),
      prisma.agentConfig.findUnique({ where: { id: node.title } }).catch(() => null),
    ]);

    // ── 24h hourly token buckets ──────────────────────────────
    const tokenSpend = buildHourlyBuckets(since24h, (bucketStart, bucketEnd) => {
      const rows = activities.filter(a =>
        a.type === 'tool' &&
        a.createdAt >= bucketStart &&
        a.createdAt < bucketEnd
      );
      return sumTokensFromActivities(rows);
    });

    // ── 24h hourly error rate ─────────────────────────────────
    const errorRate = buildHourlyBuckets(since24h, (bucketStart, bucketEnd) => {
      const rows = activities.filter(a => a.createdAt >= bucketStart && a.createdAt < bucketEnd);
      return {
        total: rows.filter(r => r.type === 'agent_complete' || r.type === 'agent_error').length,
        failed: rows.filter(r => r.type === 'agent_error').length,
      };
    });

    // ── recent errors ─────────────────────────────────────────
    const recentErrors = activities
      .filter(a => a.type === 'agent_error' || a.type === 'anomaly')
      .slice(-20)
      .reverse()
      .map(a => ({
        runId: a.runId ?? '',
        narrative: a.narrative,
        ts: a.createdAt.toISOString(),
        metadata: a.metadata ? safeParse(a.metadata) : undefined,
      }));

    // ── recent episodes (mapped to API shape) ────────────────
    const recentEpisodes: MonitorAgentDetail['recentEpisodes'] = episodes.map((e: any) => ({
      id: e.id,
      runId: e.runId ?? '',
      clientId: e.clientId ?? null,
      durationMs: e.durationMs ?? 0,
      tokenUsage: safeParse(e.tokenUsage ?? 'null') ?? { prompt: 0, completion: 0, total: 0 },
      modelUsed: e.modelUsed ?? null,
      judgeScore: e.judgeScore ?? null,
      createdAt: (e.createdAt as Date).toISOString(),
    }));

    const detail: MonitorAgentDetail = {
      name: node.id,
      title: node.title,
      config: config
        ? {
            enabled: !!config.enabled,
            temperature: config.temperature ?? null,
            maxRetries: config.maxRetries ?? null,
            tier: config.tier ?? null,
            maxOutputTokens: config.maxOutputTokens ?? null,
            promptAppend: config.promptAppend ?? null,
          }
        : null,
      recentEpisodes,
      tokenSpend: tokenSpend.map(b => ({
        bucket: b.bucket,
        prompt: b.value.prompt,
        completion: b.value.completion,
        total: b.value.total,
      })),
      errorRate: errorRate.map(b => ({
        bucket: b.bucket,
        total: b.value.total,
        failed: b.value.failed,
      })),
      recentErrors,
    };
    return NextResponse.json(detail);
  } catch (e) {
    console.error('[/api/monitor/agents/[name]] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

function buildHourlyBuckets<T>(
  since: Date,
  compute: (bucketStart: Date, bucketEnd: Date) => T,
): Array<{ bucket: string; value: T }> {
  const buckets: Array<{ bucket: string; value: T }> = [];
  const HOUR = 60 * 60 * 1000;
  let start = new Date(Math.floor(since.getTime() / HOUR) * HOUR);
  const end = new Date();
  while (start < end && buckets.length < 24) {
    const next = new Date(start.getTime() + HOUR);
    buckets.push({ bucket: start.toISOString(), value: compute(start, next) });
    start = next;
  }
  // Pad to 24 buckets if window had fewer
  while (buckets.length < 24) {
    buckets.unshift({ bucket: new Date(buckets[0]?.bucket ?? Date.now()).toISOString(), value: compute(new Date(0), new Date(0)) });
  }
  return buckets;
}

function safeParse(s: string): Record<string, any> | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}
```

- [ ] **Step 5: Run API tests**

Run: `npx vitest run app/api/monitor/agents/`
Expected: 2 passing.

- [ ] **Step 6: Build the charts**

`components/monitor/TokenChart.tsx`:
```tsx
"use client";
import React from "react";
import type { MonitorAgentDetail } from "@/lib/monitor/types";

const W = 720;
const H = 180;
const PAD = { top: 20, right: 20, bottom: 28, left: 48 };

export function TokenChart({ data }: { data: MonitorAgentDetail['tokenSpend'] }) {
  const peak = Math.max(1, ...data.map(d => Math.max(d.prompt, d.completion)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const xStep = data.length > 1 ? innerW / (data.length - 1) : innerW;
  const xy = (i: number, v: number) => ({
    x: PAD.left + i * xStep,
    y: PAD.top + innerH * (1 - v / peak),
  });
  const promptPath     = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xy(i, d.prompt).x} ${xy(i, d.prompt).y}`).join(' ');
  const completionPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xy(i, d.completion).x} ${xy(i, d.completion).y}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* Axes */}
      <line x1={PAD.left} y1={PAD.top + innerH} x2={W - PAD.right} y2={PAD.top + innerH} stroke="var(--c-claude-line)" />
      <text x={PAD.left - 6} y={PAD.top + 6} fontSize={10} textAnchor="end" fill="var(--c-claude-ink-4)">{peak.toLocaleString()}</text>
      <text x={PAD.left - 6} y={PAD.top + innerH + 4} fontSize={10} textAnchor="end" fill="var(--c-claude-ink-4)">0</text>
      {/* Series */}
      <path d={promptPath}     stroke="var(--c-claude-accent)" fill="none" strokeWidth={1.5} />
      <path d={completionPath} stroke="var(--c-claude-ok)"      fill="none" strokeWidth={1.5} strokeDasharray="4 3" />
      {/* Legend */}
      <g transform={`translate(${PAD.left}, ${H - 10})`}>
        <circle r={3} cx={4} cy={-3} fill="var(--c-claude-accent)" />
        <text x={12} y={0} fontSize={10} fill="var(--c-claude-ink-3)">Prompt</text>
        <circle r={3} cx={70} cy={-3} fill="var(--c-claude-ok)" />
        <text x={78} y={0} fontSize={10} fill="var(--c-claude-ink-3)">Completion</text>
      </g>
    </svg>
  );
}
```

`components/monitor/ErrorRateChart.tsx`:
```tsx
"use client";
import React from "react";
import type { MonitorAgentDetail } from "@/lib/monitor/types";

const W = 720;
const H = 160;
const PAD = { top: 20, right: 20, bottom: 28, left: 48 };

export function ErrorRateChart({ data }: { data: MonitorAgentDetail['errorRate'] }) {
  const peak = Math.max(1, ...data.map(d => d.total));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const barW = (innerW / data.length) * 0.8;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <line x1={PAD.left} y1={PAD.top + innerH} x2={W - PAD.right} y2={PAD.top + innerH} stroke="var(--c-claude-line)" />
      {data.map((d, i) => {
        const totalH = innerH * (d.total / peak);
        const failedH = innerH * (d.failed / peak);
        const x = PAD.left + (i + 0.1) * (innerW / data.length);
        const yTotal = PAD.top + innerH - totalH;
        const yFailed = PAD.top + innerH - failedH;
        return (
          <g key={i}>
            <rect x={x} y={yTotal}  width={barW} height={totalH}  fill="var(--c-claude-panel)" />
            <rect x={x} y={yFailed} width={barW} height={failedH} fill="var(--c-claude-err)" />
          </g>
        );
      })}
      <text x={PAD.left - 6} y={PAD.top + 6}             fontSize={10} textAnchor="end" fill="var(--c-claude-ink-4)">{peak}</text>
      <text x={PAD.left - 6} y={PAD.top + innerH + 4}    fontSize={10} textAnchor="end" fill="var(--c-claude-ink-4)">0</text>
    </svg>
  );
}
```

- [ ] **Step 7: Compose `components/monitor/AgentDetailContent.tsx`**

```tsx
"use client";
import React from "react";
import Link from "next/link";
import { usePoll } from "@/lib/monitor/usePoll";
import { ClaudeCard, ClaudeMetric, ClaudeBadge, ClaudeSectionTitle } from "./atoms";
import { TokenChart } from "./TokenChart";
import { ErrorRateChart } from "./ErrorRateChart";
import type { MonitorAgentDetail } from "@/lib/monitor/types";

export function AgentDetailContent({ name }: { name: string }) {
  const { data, error } = usePoll<MonitorAgentDetail>(`/api/monitor/agents/${encodeURIComponent(name)}`, 10_000);
  const [tab, setTab] = React.useState<'episodes' | 'tokens' | 'errors' | 'config'>('episodes');

  if (error && !data) {
    return (
      <div className="p-6">
        <p className="text-claude-err">Failed to load agent: {error}</p>
        <Link href="/monitor" className="text-claude-accent">Back to Monitor</Link>
      </div>
    );
  }

  const tokensTotal = data ? data.tokenSpend.reduce((s, b) => s + b.total, 0) : 0;
  const errorsTotal = data ? data.errorRate.reduce((s, b) => s + b.failed, 0) : 0;
  const attemptsTotal = data ? data.errorRate.reduce((s, b) => s + b.total, 0) : 0;
  const successRate = attemptsTotal > 0 ? 1 - errorsTotal / attemptsTotal : 1;

  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      <div className="mb-4">
        <Link href="/monitor" className="text-claude-accent text-[12.5px] no-underline">← Monitor</Link>
      </div>
      <div className="mb-4">
        <h1 className="text-[24px] font-medium leading-tight">{data?.title ?? '—'}</h1>
        <div className="text-claude-ink-3 text-[12.5px] mt-1">{name}</div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <ClaudeMetric label="Tokens (24h)"   value={tokensTotal.toLocaleString()} />
        <ClaudeMetric label="Errors (24h)"   value={errorsTotal} emphasis={errorsTotal > 0 ? 'err' : 'normal'} />
        <ClaudeMetric label="Success rate"   value={`${(successRate * 100).toFixed(1)}%`} emphasis={successRate >= 0.95 ? 'ok' : 'warn'} />
      </div>

      <div className="flex items-center gap-2 mb-3 border-b border-claude-line">
        {(['episodes', 'tokens', 'errors', 'config'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              "px-3 py-2 text-[13px] " +
              (tab === t
                ? "text-claude-ink-1 border-b-2 border-claude-accent -mb-px"
                : "text-claude-ink-3 hover:text-claude-ink-1")
            }
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'episodes' && (
        <ClaudeCard>
          {(data?.recentEpisodes ?? []).length === 0 ? (
            <div className="text-claude-ink-4 text-[12.5px]">No episodes recorded for this agent. (AgentEpisode is currently unwritten on this branch.)</div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead className="text-claude-ink-4">
                <tr>
                  <th className="text-left py-1">Run</th>
                  <th className="text-left py-1">Client</th>
                  <th className="text-right py-1">Duration</th>
                  <th className="text-right py-1">Tokens</th>
                  <th className="text-right py-1">Score</th>
                  <th className="text-left py-1 pl-3">Model</th>
                  <th className="text-left py-1 pl-3">When</th>
                </tr>
              </thead>
              <tbody>
                {data!.recentEpisodes.map(e => (
                  <tr key={e.id} className="border-t border-claude-line">
                    <td className="py-1"><Link href={`/monitor/runs/${e.runId}`} className="text-claude-accent no-underline">{e.runId.slice(0, 8)}…</Link></td>
                    <td className="py-1">{e.clientId ?? '—'}</td>
                    <td className="py-1 text-right tabular-nums">{e.durationMs}ms</td>
                    <td className="py-1 text-right tabular-nums">{e.tokenUsage.total.toLocaleString()}</td>
                    <td className="py-1 text-right tabular-nums">{e.judgeScore?.toFixed(2) ?? '—'}</td>
                    <td className="py-1 pl-3 text-claude-ink-3">{e.modelUsed ?? '—'}</td>
                    <td className="py-1 pl-3 text-claude-ink-3 tabular-nums">{new Date(e.createdAt).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ClaudeCard>
      )}

      {tab === 'tokens' && (
        <ClaudeCard>
          <ClaudeSectionTitle>24h hourly token usage</ClaudeSectionTitle>
          {data && <TokenChart data={data.tokenSpend} />}
        </ClaudeCard>
      )}

      {tab === 'errors' && (
        <>
          <ClaudeCard className="mb-3">
            <ClaudeSectionTitle>24h hourly attempts vs failures</ClaudeSectionTitle>
            {data && <ErrorRateChart data={data.errorRate} />}
          </ClaudeCard>
          <ClaudeCard>
            <ClaudeSectionTitle>Recent errors</ClaudeSectionTitle>
            {(data?.recentErrors ?? []).length === 0 ? (
              <div className="text-claude-ink-4 text-[12.5px]">No errors in 24h.</div>
            ) : (
              <ul className="flex flex-col divide-y divide-claude-line">
                {data!.recentErrors.map((e, i) => (
                  <li key={i} className="py-2 text-[12.5px]">
                    <Link href={`/monitor/runs/${e.runId}`} className="text-claude-ink-1 no-underline hover:underline">
                      <ClaudeBadge tone="err" size="xs">error</ClaudeBadge>
                      <span className="ml-2 text-claude-ink-3">{e.narrative}</span>
                      <span className="ml-2 text-claude-ink-4 tabular-nums">{new Date(e.ts).toLocaleTimeString()}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </ClaudeCard>
        </>
      )}

      {tab === 'config' && (
        <ClaudeCard>
          {!data?.config ? (
            <div className="text-claude-ink-4 text-[12.5px]">No AgentConfig row for this agent.</div>
          ) : (
            <dl className="grid grid-cols-2 gap-y-2 text-[12.5px]">
              <dt className="text-claude-ink-4">Enabled</dt>
              <dd>{data.config.enabled ? 'Yes' : 'No'}</dd>
              <dt className="text-claude-ink-4">Temperature</dt>
              <dd className="tabular-nums">{data.config.temperature ?? '—'}</dd>
              <dt className="text-claude-ink-4">Max retries</dt>
              <dd className="tabular-nums">{data.config.maxRetries ?? '—'}</dd>
              <dt className="text-claude-ink-4">Tier</dt>
              <dd>{data.config.tier ?? '—'}</dd>
              <dt className="text-claude-ink-4">Max output tokens</dt>
              <dd className="tabular-nums">{data.config.maxOutputTokens ?? '—'}</dd>
              <dt className="text-claude-ink-4">Prompt append</dt>
              <dd className="whitespace-pre-wrap">{data.config.promptAppend ?? '—'}</dd>
            </dl>
          )}
          <div className="mt-4 text-claude-ink-4 text-[11px]">Read-only. Editing AgentConfig is part of the Manage axis (separate spec).</div>
        </ClaudeCard>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Wire the page**

`app/monitor/agents/[name]/page.tsx`:
```tsx
"use client";
import React from "react";
import { useParams } from "next/navigation";
import { Shell } from "@/components/shared/Shell";
import { AgentDetailContent } from "@/components/monitor/AgentDetailContent";

export default function AgentDetailPage() {
  const params = useParams();
  const name = typeof params?.name === 'string' ? params.name : String(params?.name ?? '');
  return (
    <Shell crumbs={[{ label: "Monitor", href: "/monitor" }, { label: "Agent", value: name }]} direction="">
      <AgentDetailContent name={name} />
    </Shell>
  );
}
```

- [ ] **Step 9: Build + visual check + commit**

Run: `npm run build` → clean.

Visit `http://localhost:3002/monitor/agents/jd`:
- Title shows "JDGenerator"
- KPI strip shows token/error/success rate
- Tabs render appropriate views; charts draw even with sparse data
- Click an episode row → navigates to that run's detail page

```bash
git add app/api/monitor/agents app/monitor/agents components/monitor/{AgentDetailContent,TokenChart,ErrorRateChart}.tsx lib/monitor/types.ts
git commit -m "feat(monitor): /monitor/agents/[name] agent detail page

- API: GET /api/monitor/agents/[name] returns config + recentEpisodes
  + 24h hourly token / errorRate buckets + recentErrors. AgentEpisode
  query gracefully handles the table being unwritten on main.
- UI: AgentDetailContent with 4 tabs (episodes / tokens / errors /
  config). Charts are hand-rolled SVG ~80 lines each, no Recharts.
- Config tab is read-only; edit affordance belongs to Manage axis.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `/monitor/queue` — 4-bucket event queue

**Goal:** Show event_instances grouped into 4 buckets (accepted / pending / rejected / dlq), each paginated.

**Files:**
- Create: `app/api/monitor/queue/route.ts`
- Create: `app/api/monitor/queue/route.test.ts`
- Create: `app/monitor/queue/page.tsx`
- Create: `components/monitor/QueueContent.tsx`
- Modify: `lib/monitor/types.ts` (add `MonitorQueueResponse`)

- [ ] **Step 1: Add types**

```typescript
export type MonitorQueueEventRow = {
  id: string;
  name: string;
  source: string;
  status: string;
  ts: string;
  payloadDigest?: string;
  rejectionReason?: string;
  schemaErrors?: unknown;
};

export type MonitorQueueDlqRow = {
  id: string;
  eventName: string;
  reason: string;
  retries: number;
  createdAt: string;
  resolvedAt: string | null;
};

export type MonitorQueueResponse = {
  bucket: 'accepted' | 'pending' | 'rejected' | 'dlq';
  total: number;
  offset: number;
  limit: number;
  rows: Array<MonitorQueueEventRow | MonitorQueueDlqRow>;
};
```

- [ ] **Step 2: Write failing test, run, watch fail**

Create `app/api/monitor/queue/route.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/server/db', () => ({
  prisma: {
    eventInstance: { findMany: vi.fn(), count: vi.fn() },
    dLQEntry:      { findMany: vi.fn(), count: vi.fn() },
  },
}));
import { GET } from './route';
import { prisma } from '@/server/db';

describe('GET /api/monitor/queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.eventInstance.findMany as any).mockResolvedValue([]);
    (prisma.eventInstance.count as any).mockResolvedValue(0);
    (prisma.dLQEntry.findMany as any).mockResolvedValue([]);
    (prisma.dLQEntry.count as any).mockResolvedValue(0);
  });

  it('defaults bucket=accepted, returns canonical shape', async () => {
    const res = await GET(new Request('http://x/api/monitor/queue'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.bucket).toBe('accepted');
    expect(j.offset).toBe(0);
    expect(j.limit).toBe(50);
    expect(Array.isArray(j.rows)).toBe(true);
  });

  it('?bucket=dlq queries DLQEntry, not EventInstance', async () => {
    (prisma.dLQEntry.findMany as any).mockResolvedValue([
      { id: 'd1', eventName: 'X', reason: 'no consumer', retries: 3, createdAt: new Date(), resolvedAt: null },
    ]);
    (prisma.dLQEntry.count as any).mockResolvedValue(1);
    const res = await GET(new Request('http://x/api/monitor/queue?bucket=dlq'));
    const j = await res.json();
    expect(j.bucket).toBe('dlq');
    expect(j.total).toBe(1);
    expect(j.rows[0].eventName).toBe('X');
  });

  it('rejects unknown bucket', async () => {
    const res = await GET(new Request('http://x/api/monitor/queue?bucket=banana'));
    expect(res.status).toBe(400);
  });
});
```

Run: `npx vitest run app/api/monitor/queue/` → FAIL.

- [ ] **Step 3: Implement the route**

`app/api/monitor/queue/route.ts`:
```typescript
import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import type { MonitorQueueResponse } from '@/lib/monitor/types';

const VALID_BUCKETS = ['accepted', 'pending', 'rejected', 'dlq'] as const;
type Bucket = typeof VALID_BUCKETS[number];

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const bucketParam = (url.searchParams.get('bucket') ?? 'accepted') as Bucket;
  if (!VALID_BUCKETS.includes(bucketParam)) {
    return NextResponse.json({ error: 'bad_bucket' }, { status: 400 });
  }
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));

  try {
    if (bucketParam === 'dlq') {
      const [rows, total] = await Promise.all([
        prisma.dLQEntry.findMany({
          orderBy: { createdAt: 'desc' },
          skip: offset, take: limit,
        }),
        prisma.dLQEntry.count(),
      ]);
      const body: MonitorQueueResponse = {
        bucket: 'dlq',
        total,
        offset, limit,
        rows: rows.map(r => ({
          id: r.id,
          eventName: r.eventName,
          reason: r.reason,
          retries: r.retries,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
        })),
      };
      return NextResponse.json(body);
    }

    // EventInstance status values per spec: accepted | rejected_schema |
    // rejected_filter | duplicate | meta_rejection | em_degraded
    const statusFilter = {
      accepted: 'accepted',
      pending:  'pending',       // no canonical "pending" yet — see note
      rejected: { in: ['rejected_schema', 'rejected_filter', 'duplicate', 'meta_rejection'] },
    }[bucketParam] as any;

    const [rows, total] = await Promise.all([
      prisma.eventInstance.findMany({
        where: { status: statusFilter },
        orderBy: { ts: 'desc' },
        skip: offset, take: limit,
      }),
      prisma.eventInstance.count({ where: { status: statusFilter } }),
    ]);

    const body: MonitorQueueResponse = {
      bucket: bucketParam,
      total,
      offset, limit,
      rows: rows.map(r => ({
        id: r.id,
        name: r.name,
        source: r.source,
        status: r.status,
        ts: r.ts.toISOString(),
        rejectionReason: r.rejectionReason ?? undefined,
        schemaErrors: r.schemaErrors ? safeParse(r.schemaErrors) : undefined,
      })),
    };
    return NextResponse.json(body);
  } catch (e) {
    console.error('[/api/monitor/queue] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}
```

Note on `pending`: EventInstance doesn't currently have a canonical "pending" status. v1 returns empty for that bucket; the day a status migration lands, update the filter map. The UI shows an empty state, which is correct.

- [ ] **Step 4: Run tests**

Run: `npx vitest run app/api/monitor/queue/` → 3 passing.

- [ ] **Step 5: Build the UI**

`components/monitor/QueueContent.tsx`:
```tsx
"use client";
import React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ClaudeCard, ClaudeChip, ClaudeSectionTitle, ClaudeBadge } from "./atoms";
import { usePoll } from "@/lib/monitor/usePoll";
import type { MonitorQueueResponse } from "@/lib/monitor/types";

const BUCKETS = ['accepted', 'pending', 'rejected', 'dlq'] as const;

export function QueueContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const bucket = (sp.get('bucket') ?? 'accepted') as (typeof BUCKETS)[number];
  const offset = Number(sp.get('offset') ?? 0);

  const { data } = usePoll<MonitorQueueResponse>(
    `/api/monitor/queue?bucket=${bucket}&offset=${offset}&limit=50`,
    8_000,
  );

  const setBucket = (b: string) =>
    router.replace(`/monitor/queue?bucket=${b}`);

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="mb-4">
        <Link href="/monitor" className="text-claude-accent text-[12.5px] no-underline">← Monitor</Link>
      </div>
      <h1 className="text-[24px] font-medium mb-4">Event queue</h1>
      <div className="flex items-center gap-2 mb-4">
        {BUCKETS.map(b => (
          <ClaudeChip key={b} active={bucket === b} onClick={() => setBucket(b)}>
            {b}{data && data.bucket === b ? ` (${data.total})` : ''}
          </ClaudeChip>
        ))}
      </div>
      <ClaudeCard>
        {!data ? (
          <div className="text-claude-ink-4 text-[12.5px]">Loading…</div>
        ) : data.rows.length === 0 ? (
          <div className="text-claude-ink-4 text-[12.5px]">No rows in this bucket.</div>
        ) : bucket === 'dlq' ? (
          <ul className="flex flex-col divide-y divide-claude-line">
            {(data.rows as any[]).map(r => (
              <li key={r.id} className="py-2 text-[12.5px] flex items-center gap-2">
                <ClaudeBadge tone="err" size="xs">DLQ</ClaudeBadge>
                <code className="text-claude-ink-1">{r.eventName}</code>
                <span className="text-claude-ink-3 truncate">{r.reason}</span>
                <span className="ml-auto text-claude-ink-4 tabular-nums">retry {r.retries}</span>
              </li>
            ))}
          </ul>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead className="text-claude-ink-4">
              <tr>
                <th className="text-left py-1">Event</th>
                <th className="text-left py-1">Source</th>
                <th className="text-left py-1">Status</th>
                <th className="text-left py-1">Rejection</th>
                <th className="text-right py-1">When</th>
              </tr>
            </thead>
            <tbody>
              {(data.rows as any[]).map(r => (
                <tr key={r.id} className="border-t border-claude-line">
                  <td className="py-1"><code className="text-claude-ink-1">{r.name}</code></td>
                  <td className="py-1 text-claude-ink-3">{r.source}</td>
                  <td className="py-1">
                    <ClaudeBadge tone={r.status === 'accepted' ? 'ok' : 'err'} size="xs">{r.status}</ClaudeBadge>
                  </td>
                  <td className="py-1 text-claude-ink-3 truncate">{r.rejectionReason ?? '—'}</td>
                  <td className="py-1 text-right text-claude-ink-4 tabular-nums">{new Date(r.ts).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ClaudeCard>
    </div>
  );
}
```

- [ ] **Step 6: Wire route**

`app/monitor/queue/page.tsx`:
```tsx
"use client";
import { Shell } from "@/components/shared/Shell";
import { QueueContent } from "@/components/monitor/QueueContent";

export default function MonitorQueuePage() {
  return (
    <Shell crumbs={[{ label: "Monitor", href: "/monitor" }, { label: "Queue" }]} direction="">
      <QueueContent />
    </Shell>
  );
}
```

- [ ] **Step 7: Build + commit**

Run: `npm run build` → clean.

Visit `/monitor/queue`: 4 chips, default `accepted`, table renders or empty state shows. Click `dlq` → URL updates, different table shape.

```bash
git add app/api/monitor/queue app/monitor/queue components/monitor/QueueContent.tsx lib/monitor/types.ts
git commit -m "feat(monitor): /monitor/queue 4-bucket event queue view

- API: GET /api/monitor/queue?bucket=accepted|pending|rejected|dlq
  with offset/limit pagination, 200 max. 3 vitest cases.
- UI: bucket chips + tabular list with status badges + DLQ-specific
  row shape

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `/monitor/failures/[runId]` — Single failure detail

**Goal:** A focused page showing one run's failure(s) — stack trace from `WorkflowStep.error`, retry attempts from `AgentActivity` rows, related events. Link back to the run.

**Files:**
- Create: `app/api/monitor/failures/[runId]/route.ts`
- Create: `app/api/monitor/failures/[runId]/route.test.ts`
- Create: `app/monitor/failures/[runId]/page.tsx`
- Create: `components/monitor/FailureDetailContent.tsx`

- [ ] **Step 1: Test + implement**

`app/api/monitor/failures/[runId]/route.ts`:
```typescript
import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await ctx.params;
  try {
    const [run, steps, retries, events] = await Promise.all([
      prisma.workflowRun.findUnique({ where: { id: runId } }),
      prisma.workflowStep.findMany({
        where: { runId, status: 'failed' },
        orderBy: { completedAt: 'desc' },
      }),
      prisma.agentActivity.findMany({
        where: { runId, type: { in: ['step.retrying', 'agent_error', 'anomaly'] } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.eventInstance.findMany({
        where: { causedByEventId: { not: null } /* loose proxy; refine if needed */ },
        take: 50,
      }).catch(() => []),
    ]);
    if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ run, steps, retries, events });
  } catch (e) {
    console.error('[/api/monitor/failures/[runId]] failed:', (e as Error).message);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
```

Test (`app/api/monitor/failures/[runId]/route.test.ts`): one happy path, one 404. Mirror the pattern used in `/api/monitor/runs/[id]/route.test.ts`. (Keep the test file ≤30 lines.)

- [ ] **Step 2: UI**

`components/monitor/FailureDetailContent.tsx`:
```tsx
"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeSectionTitle, ClaudeBadge } from "./atoms";

export function FailureDetailContent({ runId }: { runId: string }) {
  const [data, setData] = React.useState<any>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    fetch(`/api/monitor/failures/${encodeURIComponent(runId)}`)
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(setData)
      .catch(e => setError(String(e)));
  }, [runId]);
  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="mb-4">
        <Link href={`/monitor/runs/${runId}`} className="text-claude-accent text-[12.5px] no-underline">← Run {runId.slice(0, 8)}</Link>
      </div>
      <h1 className="text-[24px] font-medium mb-4">Failure detail</h1>
      {error && <p className="text-claude-err">{error}</p>}
      {data && (
        <>
          <ClaudeCard className="mb-3">
            <ClaudeSectionTitle>Failed steps</ClaudeSectionTitle>
            {data.steps.length === 0 ? (
              <div className="text-claude-ink-4 text-[12.5px]">No failed steps recorded.</div>
            ) : (
              <ul className="flex flex-col divide-y divide-claude-line">
                {data.steps.map((s: any) => (
                  <li key={s.id} className="py-2 text-[12.5px]">
                    <div className="flex items-center gap-2">
                      <ClaudeBadge tone="err" size="xs">{s.nodeId}</ClaudeBadge>
                      <span className="text-claude-ink-1 font-medium">{s.stepName}</span>
                    </div>
                    {s.error && (
                      <pre className="bg-claude-panel rounded p-2 mt-1 text-[11.5px] overflow-auto whitespace-pre-wrap">{s.error}</pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </ClaudeCard>
          <ClaudeCard>
            <ClaudeSectionTitle>Retry history</ClaudeSectionTitle>
            {data.retries.length === 0 ? (
              <div className="text-claude-ink-4 text-[12.5px]">No retry activity.</div>
            ) : (
              <ul className="text-[12.5px]">
                {data.retries.map((a: any) => (
                  <li key={a.id}>
                    <span className="text-claude-ink-4 tabular-nums mr-2">{new Date(a.createdAt).toLocaleTimeString()}</span>
                    <span className="text-claude-ink-1">{a.agentName}</span>
                    <span className="text-claude-ink-3 ml-1">{a.type}: {a.narrative}</span>
                  </li>
                ))}
              </ul>
            )}
          </ClaudeCard>
        </>
      )}
    </div>
  );
}
```

`app/monitor/failures/[runId]/page.tsx`:
```tsx
"use client";
import { useParams } from "next/navigation";
import { Shell } from "@/components/shared/Shell";
import { FailureDetailContent } from "@/components/monitor/FailureDetailContent";

export default function FailureDetailPage() {
  const params = useParams();
  const id = typeof params?.runId === 'string' ? params.runId : String(params?.runId ?? '');
  return (
    <Shell crumbs={[{ label: "Monitor", href: "/monitor" }, { label: "Failure" }]} direction="">
      <FailureDetailContent runId={id} />
    </Shell>
  );
}
```

- [ ] **Step 3: Build + test + commit**

Run: `npm run build` and `npx vitest run` → clean.

```bash
git add app/api/monitor/failures app/monitor/failures components/monitor/FailureDetailContent.tsx
git commit -m "feat(monitor): /monitor/failures/[runId] single failure detail page

- API: GET /api/monitor/failures/[runId] returns the run + failed
  WorkflowStep rows + retry-related AgentActivity rows
- UI: shows stack trace (WorkflowStep.error) + retry history list

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: LeftNav swap + i18n labels + final integration

**Goal:** Add "Monitor" item to LeftNav, remove "Runs" item; add i18n keys; run a final cross-page sanity pass.

**Files:**
- Modify: `components/shared/LeftNav.tsx`
- Modify: `lib/i18n.tsx`

- [ ] **Step 1: Add i18n keys**

In `lib/i18n.tsx`, add to both `zh` and `en` dictionaries:
- zh: `nav_monitor: "监控"`
- en: `nav_monitor: "Monitor"`

(If the dictionary has other monitor-relevant keys we touched in components — e.g. tab labels — and the components use them via `t()`, add those here. The current implementation hardcodes English in the new components for simplicity; refactor opportunistically if you prefer i18n consistency.)

- [ ] **Step 2: Modify LeftNav**

In `components/shared/LeftNav.tsx`:

Find the `items` array (around line 39). Replace the existing "Runs" item with the Monitor item:

Before:
```typescript
{ type: "item", id: "runs",       icon: "play",     label: t("nav_runs"),  count: "—", href: "/live" },
```

After:
```typescript
{ type: "item", id: "monitor",    icon: "gauge",    label: t("nav_monitor"), count: monitorCount, href: "/monitor" },
```

Also remove (or leave) the polling effect for `inboxCount` and add a parallel one for the Monitor active-run count:
```typescript
const [monitorCount, setMonitorCount] = React.useState<string>("—");

React.useEffect(() => {
  const tick = () => {
    fetch('/api/monitor/overview', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((j: { kpi: { activeRuns: number } }) =>
        setMonitorCount(j.kpi.activeRuns > 0 ? String(j.kpi.activeRuns) : ""))
      .catch(() => {/* keep "—" */});
  };
  tick();
  const id = setInterval(tick, 10_000);
  return () => clearInterval(id);
}, []);
```

Place the new Monitor item between `Overview` and `Inbox` (per spec §3.3).

- [ ] **Step 3: Verify `/live` is still reachable but absent from nav**

Visit `http://localhost:3002/live` directly — page should still render normally (legacy preserved).
Visit `/` (which redirects to `/fleet`) → LeftNav should now show Monitor between Overview and Inbox; no "Runs" item.

- [ ] **Step 4: Cross-page sanity pass**

Walk through:
1. `/monitor` → 18 nodes render, KPI strip shows numbers, filters work, click a recent run card → lands on `/monitor/runs/[id]`
2. `/monitor/runs/[id]` → trail-colored graph, tabs work, click a token row's run link → navigates correctly
3. `/monitor/agents/[name]` → tabs work, episodes link to run detail
4. `/monitor/queue` → 4 buckets, navigation works
5. `/monitor/failures/[runId]` (visit manually for a known failing run id) → renders
6. Dark mode toggle (AppBar) → all 5 pages follow theme
7. `/overview` → unchanged from baseline
8. `/workflow` → unchanged from baseline (graph still renders, this is the Task 1 invariant)

- [ ] **Step 5: Final build + run all tests**

Run:
```bash
npm run build
npx vitest run
```
Both expected clean.

- [ ] **Step 6: Commit + push**

```bash
git add components/shared/LeftNav.tsx lib/i18n.tsx
git commit -m "feat(monitor): swap LeftNav Runs item for Monitor + i18n labels

Removes the 'Runs' item (still reachable via /live for backward compat
during 3-month deprecation window) and adds 'Monitor' with a live
active-run count from /api/monitor/overview.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git push origin main
```

---

## End of plan

After Task 9 the Monitor axis is complete:

- `/monitor` — single-page workflow runtime view with noise reduction (aggregation-only nodes, default 5min window, severity-first rendering)
- `/monitor/runs/[id]` — single-run trail on the same graph + 4 tabs
- `/monitor/agents/[name]` — per-agent episodes, 24h token chart, error chart, config view
- `/monitor/queue` — 4-bucket event queue
- `/monitor/failures/[runId]` — failed-step detail
- LeftNav reflects the change
- Claude-style token group scoped to `/monitor` subtree only

**Manage axis** (restart / cancel / replay / edit config) is intentionally out of scope and gets its own spec + plan. The current Monitor pages purposely have no write affordances — config tab links to `/workflow` for editing, HITL items link to `/inbox` for resolution.

**Behavior axis** (Monitor Agent + Manager Agent) is also a separate spec + plan. The Monitor we built here is the data substrate those agents will read from when they get built.

## Known gaps left in v1

1. Per-node `avgDurationMs` is hardcoded to 0 (the rollup wasn't worth the extra pass for v1). Wire it into `/api/monitor/overview` when someone notices.
2. `queueLagP50Ms` / `queueLagP95Ms` are hardcoded to 0 — define what "queue lag" means in our event model first.
3. `recentRuns` filter on the MiniRunList isn't keyed by agent — it shows a global slice. Add a `?agent=` query when needed.
4. Edge `eventName` mapping in `overview/route.ts` is a hardcoded table; ideally move it into `lib/workflow-graph-meta.ts` alongside EDGES.
5. AgentEpisode-driven token data takes over only when agents start writing to that table. The migration is transparent on the consumer side (the route prefers AgentEpisode rows when present).
6. No "Play" mode for run trail animation — deferred to v2 per spec §12.

These are deliberate punts, all documented in the data-audit note from Task 0.
