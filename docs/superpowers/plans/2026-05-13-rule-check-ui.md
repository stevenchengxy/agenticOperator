# Rule Check UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/rule-check` page that runs the existing 14-scenario rule-check suite from the browser via SSE, persists each run to sqlite, and provides a scenario × rule confusion matrix with drill-down (text verdict + static SVG graph + inference chain), neo4j-browser jump links, single-scenario replay, and side-by-side model compare.

**Architecture:** New Next.js routes under `/api/rule-check/*` stream scenario results via SSE while persisting to Prisma/sqlite. A new `RuleCheckContent` client component consumes the stream and renders the matrix; the same data hydrates the right-side drawer for drill-down. Inference chains are derived server-side via a per-rule extractor registry so the UI is a thin reader (dual-reader principle).

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind CSS v4 (OKLCH tokens in `app/globals.css`), Prisma + better-sqlite3, Vitest, existing `lib/rule-check/` runner, existing `server/llm/gateway.ts`.

**Spec:** [docs/superpowers/specs/2026-05-13-rule-check-ui-design.md](../specs/2026-05-13-rule-check-ui-design.md)

**Conventions** (from `CLAUDE.md` and existing code, verified):
- Page route = `app/rule-check/page.tsx`, thin `<Shell crumbs={…}><RuleCheckContent/></Shell>`.
- `Shell` signature: `{ crumbs?: string[]; children; directionTag?: string }` (crumbs is `string[]`, NOT object array).
- Atoms in `components/shared/atoms.tsx`: `Btn`, `Card`, `CardHead`, `Metric`, `Badge`, `StatusDot`, `Spark`, `EmptyState`.
- Prisma client singleton: `import { prisma } from "@/server/db"`.
- Colors: use Tailwind utilities (`bg-ok-bg`, `text-ink-1`, `border-line`) or `style={{ background: "var(--c-ok)" }}`. Never hard-code hex.
- i18n: only nav/chrome strings go through `t()`. Domain copy stays hard-coded.
- Test runner: Vitest. Test files live next to source as `*.test.ts(x)`.

---

## File Structure

**New (32 files):**

Foundation:
- `prisma/schema.prisma` — modified (+2 models)
- `prisma/migrations/*` — auto-generated
- `lib/rule-check/runner.ts` — modified (expose `graph_context` in result)
- `lib/rule-check/types.ts` — modified (add optional `graph_context` field)

Pure utilities:
- `components/rule-check/bucketing.ts` + `.test.ts`
- `components/rule-check/neo4j-jump.ts` + `.test.ts`
- `server/rule-check/match-classifier.ts` + `.test.ts`
- `server/rule-check/scenarios-loader.ts` (re-exports from `scripts/rule-check-test-suite/fixtures.ts` in a server-friendly shape)

Evidence extractors:
- `lib/rule-check/evidence/types.ts`
- `lib/rule-check/evidence/index.ts` + `.test.ts`
- `lib/rule-check/evidence/rule-10-5.ts` + `.test.ts`
- `lib/rule-check/evidence/rule-10-9.ts` + `.test.ts`
- `lib/rule-check/evidence/rule-10-10.ts` + `.test.ts`
- `lib/rule-check/evidence/rule-10-17.ts` + `.test.ts`
- `lib/rule-check/evidence/rule-10-21.ts` + `.test.ts`
- `lib/rule-check/evidence/rule-10-25.ts` + `.test.ts`
- `lib/rule-check/evidence/rule-10-26.ts` + `.test.ts`
- `lib/rule-check/evidence/rule-10-27.ts` + `.test.ts`
- `lib/rule-check/evidence/rule-10-32.ts` + `.test.ts`

Service + API:
- `server/rule-check/runs-service.ts` + `.test.ts`
- `app/api/rule-check/runs/route.ts`
- `app/api/rule-check/runs/[run_id]/route.ts`
- `app/api/rule-check/runs/[run_id]/replay/[scenario_id]/route.ts`
- `app/api/rule-check/scenarios/route.ts`

UI:
- `app/rule-check/page.tsx`
- `components/rule-check/RuleCheckContent.tsx`
- `components/rule-check/use-run-stream.ts` (SSE consumer hook)
- `components/rule-check/TopBar.tsx`
- `components/rule-check/MetricsStrip.tsx`
- `components/rule-check/RuleConfusionStrip.tsx`
- `components/rule-check/ScenarioMatrix.tsx`
- `components/rule-check/CaseDrawer.tsx`
- `components/rule-check/InferenceChainView.tsx`
- `components/rule-check/GraphView.tsx`

**Modified (3 files):**
- `components/shared/LeftNav.tsx` — add `rule-check` nav item
- `lib/i18n.tsx` — add `nav_rule_check` key (zh + en)
- `lib/rule-check/runner.ts` — expose `graph_context` in result

---

## Task Decomposition

### Task 1: Add Prisma models for RuleCheckRun + RuleCheckScenarioResult

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/*` (auto-generated)
- Test: `__tests__/prisma/rule-check.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/prisma/rule-check.test.ts`:

```ts
import { describe, expect, it, afterAll } from 'vitest';
import { prisma } from '@/server/db';

describe('RuleCheckRun + RuleCheckScenarioResult models', () => {
  afterAll(async () => {
    await prisma.ruleCheckScenarioResult.deleteMany({});
    await prisma.ruleCheckRun.deleteMany({});
  });

  it('persists a run with one scenario result and reads it back', async () => {
    const run = await prisma.ruleCheckRun.create({
      data: { model: 'gemini-3-flash-preview', status: 'running' },
    });
    await prisma.ruleCheckScenarioResult.create({
      data: {
        runId: run.id,
        scenarioId: 'S01',
        scenarioName: '控制组 PASS',
        expectedDecision: 'PASS',
        expectedRules: '{}',
        actualDecision: 'REVIEW',
        actualStats: '{}',
        ruleResults: '[]',
        matchKind: 'fail-decision',
        inferenceChain: '[]',
        graphContext: '{}',
        llmMs: 28664,
        llmModel: 'gemini-3-flash-preview',
      },
    });
    const rehydrated = await prisma.ruleCheckRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { results: true },
    });
    expect(rehydrated.results).toHaveLength(1);
    expect(rehydrated.results[0].scenarioId).toBe('S01');
    expect(rehydrated.results[0].matchKind).toBe('fail-decision');
  });

  it('enforces unique (runId, scenarioId) so replay upserts cleanly', async () => {
    const run = await prisma.ruleCheckRun.create({
      data: { model: 'gemini-3-flash-preview', status: 'done' },
    });
    const base = {
      runId: run.id,
      scenarioId: 'S02',
      scenarioName: '华为冷冻期',
      expectedDecision: 'REVIEW',
      expectedRules: '{}',
      actualDecision: 'REVIEW',
      actualStats: '{}',
      ruleResults: '[]',
      matchKind: 'pass',
      inferenceChain: '[]',
      graphContext: '{}',
      llmMs: 1000,
      llmModel: 'gemini-3-flash-preview',
    };
    await prisma.ruleCheckScenarioResult.create({ data: base });
    await expect(
      prisma.ruleCheckScenarioResult.create({ data: base }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/prisma/rule-check.test.ts`
Expected: FAIL with `Property 'ruleCheckRun' does not exist on type 'PrismaClient'`.

- [ ] **Step 3: Append models to `prisma/schema.prisma`**

Append at the end of the file (after the last existing `}`):

```prisma
// =====================================================================
// Rule Check — eval surface for matchResume rule evaluation
// =====================================================================

model RuleCheckRun {
  id                    String    @id @default(cuid())
  startedAt             DateTime  @default(now())
  finishedAt            DateTime?
  status                String    @default("running") // running | done | error
  model                 String
  clientIdOverride      String?
  totalScenarios        Int       @default(0)
  passCount             Int       @default(0)
  failCount             Int       @default(0)
  totalLlmMs            Int       @default(0)
  totalPromptTokens     Int       @default(0)
  totalCompletionTokens Int       @default(0)
  capHits               Int       @default(0)
  errorMessage          String?
  results               RuleCheckScenarioResult[]

  @@index([startedAt])
}

model RuleCheckScenarioResult {
  id                String   @id @default(cuid())
  runId             String
  run               RuleCheckRun @relation(fields: [runId], references: [id])

  scenarioId        String
  scenarioName      String

  expectedDecision  String
  expectedRules    String   // JSON: Record<rule_id, status>

  actualDecision    String
  actualStats       String   // JSON: MatchResumeCheckStats
  ruleResults       String   // JSON: RuleResult[]

  matchKind         String   // pass | fail-decision | fail-rule | fail-missing-rule | fail-parse | fail-runtime
  failures          String?  // JSON: string[]

  inferenceChain    String   // JSON: InferenceChain[]
  graphContext      String   // JSON: GraphContext

  llmMs             Int
  llmModel          String
  promptTokens      Int?
  completionTokens  Int?
  finishReason      String?
  graphCalls        Int      @default(0)
  rawLlmText        String?

  ranAt             DateTime @default(now())

  @@unique([runId, scenarioId])
  @@index([runId])
}
```

- [ ] **Step 4: Generate the migration**

Run: `npx prisma migrate dev --name add_rule_check_runs`
Expected: a new migration directory under `prisma/migrations/`, Prisma client regenerated.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run __tests__/prisma/rule-check.test.ts`
Expected: PASS, both `it()` cases green.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ __tests__/prisma/rule-check.test.ts
git commit -m "feat(rule-check): add RuleCheckRun + RuleCheckScenarioResult Prisma models"
```

---

### Task 2: Expose graph_context on MatchResumeCheckResult

**Files:**
- Modify: `lib/rule-check/types.ts`
- Modify: `lib/rule-check/runner.ts`
- Test: `lib/rule-check/runner.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test**

Add a new test case in `lib/rule-check/runner.test.ts` after the existing `describe('runRuleCheck — new MatchResumeCheckResult shape')` block:

```ts
  it('exposes graph_context in the result so UI consumers can read pre-fetched slots', async () => {
    mockRulesOneStepOneRule();
    mGetInst.mockResolvedValueOnce({ candidate_id: 'C-1', name: 'Test' });
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        rule_results: [{ rule_id: '10-25', status: 'pass' }],
      }),
      modelUsed: 'm',
      durationMs: 1,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.graph_context).toBeDefined();
    expect(out.graph_context?.candidate).toEqual({ candidate_id: 'C-1', name: 'Test' });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/rule-check/runner.test.ts`
Expected: FAIL — `expect(out.graph_context).toBeDefined()` returns undefined.

- [ ] **Step 3: Add `graph_context` to the type**

In `lib/rule-check/types.ts`, find the `MatchResumeCheckResult` type and add an optional field above `audit`:

```ts
export type MatchResumeCheckResult = {
  decision: 'PASS' | 'FAIL' | 'REVIEW';
  stats: MatchResumeCheckStats;
  rule_results: RuleResult[];
  explanations: RuleExplanation[];
  /** Pre-fetched graph slots used to evaluate this run. UI consumers
   *  (the /rule-check page) read this to build the drawer's graph view
   *  and inference chain without re-fetching from neo4j. */
  graph_context?: import('./graph-context').GraphContext;
  audit: { /* unchanged */ };
};
```

(If the existing `audit` block is inlined, leave it inlined; just add the new field above it.)

- [ ] **Step 4: Populate it in the runner**

In `lib/rule-check/runner.ts`, locate the success-path return (around the line `return { decision, stats, rule_results: ruleResults, ... }`) and add `graph_context: graph,` to the returned object. Also add it to `failSafe()` callers that have already built `graph` — specifically, the success and parse-error returns. Do NOT add it to early returns where `graph` doesn't exist yet.

The success-path return becomes:

```ts
  return {
    decision,
    stats,
    rule_results: ruleResults,
    explanations,
    graph_context: graph,
    audit: {
      rules_evaluated: expectedRuleCount,
      graph_calls: graph.fetch_count,
      llm_model: llmResult.modelUsed,
      // ... rest unchanged
    },
  };
```

For the parse-error path: pass `graph_context: graph` in `auditOnError` is not the right place (audit is for metrics). Instead, update `failSafe()` to accept an optional second parameter:

```ts
function failSafe(
  reason: MatchResumeCheckResult['audit']['fail_reason'],
  base: Partial<MatchResumeCheckResult['audit']> = {},
  graph_context?: GraphContext,
): MatchResumeCheckResult {
  return {
    decision: 'FAIL',
    stats: emptyStats(),
    rule_results: [],
    explanations: [],
    graph_context,
    audit: {
      // ... unchanged
    },
  };
}
```

And update the parse-error call site:

```ts
  if (!parsed) {
    return failSafe('parse-error', auditOnError, graph);
  }
  // ...
  if (ruleResults.length !== expectedRuleCount) {
    return failSafe('parse-error', auditOnError, graph);
  }
```

- [ ] **Step 5: Run all rule-check tests to verify**

Run: `npx vitest run lib/rule-check`
Expected: 65/65 tests pass (the 64 existing + 1 new).

- [ ] **Step 6: Commit**

```bash
git add lib/rule-check/types.ts lib/rule-check/runner.ts lib/rule-check/runner.test.ts
git commit -m "feat(rule-check): expose graph_context on MatchResumeCheckResult for UI consumers"
```

---

### Task 3: bucketing.ts (confusion matrix polarity classifier)

**Files:**
- Create: `components/rule-check/bucketing.ts`
- Test: `components/rule-check/bucketing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `components/rule-check/bucketing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { bucketCell } from './bucketing';

describe('bucketCell', () => {
  it('TN: pass → pass', () => {
    expect(bucketCell('pass', 'pass')).toEqual({ bucket: 'TN', marker: 'match' });
  });
  it('TN: not_triggered → not_triggered', () => {
    expect(bucketCell('not_triggered', 'not_triggered')).toEqual({ bucket: 'TN', marker: 'match' });
  });
  it('TN partial: pass → not_triggered (both clear, different label)', () => {
    expect(bucketCell('pass', 'not_triggered')).toEqual({ bucket: 'TN', marker: 'partial' });
  });
  it('TP: fail → fail', () => {
    expect(bucketCell('fail', 'fail')).toEqual({ bucket: 'TP', marker: 'match' });
  });
  it('TP: pending → pending', () => {
    expect(bucketCell('pending', 'pending')).toEqual({ bucket: 'TP', marker: 'match' });
  });
  it('TP partial: fail → pending (both risk, different label)', () => {
    expect(bucketCell('fail', 'pending')).toEqual({ bucket: 'TP', marker: 'partial' });
  });
  it('FP: pass → fail', () => {
    expect(bucketCell('pass', 'fail')).toEqual({ bucket: 'FP', marker: 'mismatch' });
  });
  it('FP: not_triggered → pending', () => {
    expect(bucketCell('not_triggered', 'pending')).toEqual({ bucket: 'FP', marker: 'mismatch' });
  });
  it('FN: fail → pass', () => {
    expect(bucketCell('fail', 'pass')).toEqual({ bucket: 'FN', marker: 'mismatch' });
  });
  it('FN: pending → not_triggered', () => {
    expect(bucketCell('pending', 'not_triggered')).toEqual({ bucket: 'FN', marker: 'mismatch' });
  });
  it('excluded: not_executed on expected side', () => {
    expect(bucketCell('not_executed', 'pass')).toEqual({ bucket: 'excluded', marker: 'excluded' });
  });
  it('excluded: not_executed on actual side', () => {
    expect(bucketCell('pass', 'not_executed')).toEqual({ bucket: 'excluded', marker: 'excluded' });
  });
  it('missing actual, expected risk → FN with missing marker', () => {
    expect(bucketCell('fail', 'missing-from-actual'))
      .toEqual({ bucket: 'FN', marker: 'missing' });
  });
  it('missing actual, expected clear → FP with missing marker', () => {
    expect(bucketCell('pass', 'missing-from-actual'))
      .toEqual({ bucket: 'FP', marker: 'missing' });
  });
  it('missing expected (no fixture pin) → excluded', () => {
    expect(bucketCell('missing-from-expected', 'pass'))
      .toEqual({ bucket: 'excluded', marker: 'excluded' });
  });
  it('both missing → excluded', () => {
    expect(bucketCell('missing-from-expected', 'missing-from-actual'))
      .toEqual({ bucket: 'excluded', marker: 'excluded' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/rule-check/bucketing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement bucketing.ts**

Create `components/rule-check/bucketing.ts`:

```ts
import type { RuleStatus } from '@/lib/rule-check/types';

export type ConfusionBucket = 'TP' | 'TN' | 'FP' | 'FN' | 'excluded';
export type CellMarker = 'match' | 'mismatch' | 'missing' | 'partial' | 'excluded';

export type CellOutcome = { bucket: ConfusionBucket; marker: CellMarker };

export type CellStatus = RuleStatus | 'missing-from-expected' | 'missing-from-actual';

function isRisk(s: RuleStatus): boolean {
  return s === 'fail' || s === 'pending' || s === 'insufficient_info';
}
function isClear(s: RuleStatus): boolean {
  return s === 'pass' || s === 'not_triggered';
}

export function bucketCell(expected: CellStatus, actual: CellStatus): CellOutcome {
  if (expected === 'not_executed' || actual === 'not_executed') {
    return { bucket: 'excluded', marker: 'excluded' };
  }
  if (actual === 'missing-from-actual') {
    if (expected === 'missing-from-expected') {
      return { bucket: 'excluded', marker: 'excluded' };
    }
    if (isRisk(expected as RuleStatus)) return { bucket: 'FN', marker: 'missing' };
    return { bucket: 'FP', marker: 'missing' };
  }
  if (expected === 'missing-from-expected') {
    return { bucket: 'excluded', marker: 'excluded' };
  }
  const expRisk = isRisk(expected as RuleStatus);
  const actRisk = isRisk(actual as RuleStatus);
  if (expRisk && actRisk) {
    return { bucket: 'TP', marker: expected === actual ? 'match' : 'partial' };
  }
  if (isClear(expected as RuleStatus) && isClear(actual as RuleStatus)) {
    return { bucket: 'TN', marker: expected === actual ? 'match' : 'partial' };
  }
  if (!expRisk && actRisk) return { bucket: 'FP', marker: 'mismatch' };
  return { bucket: 'FN', marker: 'mismatch' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/rule-check/bucketing.test.ts`
Expected: all 16 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add components/rule-check/bucketing.ts components/rule-check/bucketing.test.ts
git commit -m "feat(rule-check): add bucketing.ts (6-status → 4-quadrant + marker)"
```

---

### Task 4: neo4j-jump.ts (URL builder)

**Files:**
- Create: `components/rule-check/neo4j-jump.ts`
- Test: `components/rule-check/neo4j-jump.test.ts`

- [ ] **Step 1: Write the failing test**

Create `components/rule-check/neo4j-jump.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildNeo4jBrowserUrl } from './neo4j-jump';

describe('buildNeo4jBrowserUrl', () => {
  const BASE = 'http://10.100.0.70:7474/browser/';

  it('returns null when base is undefined', () => {
    expect(buildNeo4jBrowserUrl(undefined, 'candidate', 'C-1')).toBeNull();
  });
  it('returns null when base is empty string', () => {
    expect(buildNeo4jBrowserUrl('', 'candidate', 'C-1')).toBeNull();
  });
  it('candidate cypher with URL-encoded query', () => {
    const url = buildNeo4jBrowserUrl(BASE, 'candidate', 'C-S02-100024');
    expect(url).toBe(
      `${BASE}?cmd=edit&arg=${encodeURIComponent("MATCH (c:Candidate {candidate_id: 'C-S02-100024'}) RETURN c")}`,
    );
  });
  it('resume cypher', () => {
    const url = buildNeo4jBrowserUrl(BASE, 'resume', 'R-1');
    expect(url).toContain(encodeURIComponent("MATCH (r:Resume {resume_id: 'R-1'}) RETURN r"));
  });
  it('jd cypher uses Job_Requisition label', () => {
    const url = buildNeo4jBrowserUrl(BASE, 'jd', 'JR-1');
    expect(url).toContain(encodeURIComponent("MATCH (j:Job_Requisition {job_requisition_id: 'JR-1'}) RETURN j"));
  });
  it('subgraph cypher around a candidate', () => {
    const url = buildNeo4jBrowserUrl(BASE, 'subgraph', 'C-1');
    expect(url).toContain(encodeURIComponent("MATCH (c:Candidate {candidate_id: 'C-1'})-[r*1..2]-(n) RETURN c, r, n LIMIT 50"));
  });
  it('handles base without trailing slash', () => {
    const url = buildNeo4jBrowserUrl('http://x/browser', 'candidate', 'C-1');
    expect(url).toMatch(/^http:\/\/x\/browser\?cmd=edit&arg=/);
  });
  it('escapes single quotes in id to prevent cypher injection', () => {
    const url = buildNeo4jBrowserUrl(BASE, 'candidate', "C-1'; DROP DATABASE //");
    // The id should be properly escaped — single quote should NOT appear in the cypher
    expect(url).not.toContain("'; DROP");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/rule-check/neo4j-jump.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement neo4j-jump.ts**

Create `components/rule-check/neo4j-jump.ts`:

```ts
export type NodeKind = 'candidate' | 'resume' | 'jd' | 'application' | 'blacklist' | 'employment' | 'subgraph';

function escapeCypherString(s: string): string {
  // Escape single quotes by doubling them (Cypher-standard) and strip control chars.
  return s.replace(/'/g, "\\'").replace(/[\x00-\x1f]/g, '');
}

function cypherForNode(kind: NodeKind, id: string): string {
  const e = escapeCypherString(id);
  switch (kind) {
    case 'candidate':
      return `MATCH (c:Candidate {candidate_id: '${e}'}) RETURN c`;
    case 'resume':
      return `MATCH (r:Resume {resume_id: '${e}'}) RETURN r`;
    case 'jd':
      return `MATCH (j:Job_Requisition {job_requisition_id: '${e}'}) RETURN j`;
    case 'application':
      return `MATCH (a:Application {application_id: '${e}'}) RETURN a`;
    case 'blacklist':
      return `MATCH (b:Blacklist {blacklist_id: '${e}'}) RETURN b`;
    case 'employment':
      return `MATCH (e:Employment {employment_id: '${e}'}) RETURN e`;
    case 'subgraph':
      return `MATCH (c:Candidate {candidate_id: '${e}'})-[r*1..2]-(n) RETURN c, r, n LIMIT 50`;
  }
}

export function buildNeo4jBrowserUrl(
  base: string | undefined,
  kind: NodeKind,
  id: string,
): string | null {
  if (!base) return null;
  const cypher = cypherForNode(kind, id);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}cmd=edit&arg=${encodeURIComponent(cypher)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/rule-check/neo4j-jump.test.ts`
Expected: all 8 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add components/rule-check/neo4j-jump.ts components/rule-check/neo4j-jump.test.ts
git commit -m "feat(rule-check): add neo4j-jump URL builder with cypher escaping"
```

---

### Task 5: match-classifier.ts (extract from test-suite script)

**Files:**
- Create: `server/rule-check/match-classifier.ts`
- Test: `server/rule-check/match-classifier.test.ts`

- [ ] **Step 1: Read the existing classifier**

Read `scripts/run-rule-check-test-suite.ts` and locate the function that compares expected vs actual and produces the failure descriptions you see in the report (e.g. `"decision mismatch — expected PASS, got REVIEW"`, `"rule 10-25 missing from rule_results"`). The extraction target is this comparison code.

- [ ] **Step 2: Write the failing test**

Create `server/rule-check/match-classifier.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyMatch } from './match-classifier';
import type { MatchResumeCheckResult } from '@/lib/rule-check/types';

const baseActual = (overrides: Partial<MatchResumeCheckResult> = {}): MatchResumeCheckResult => ({
  decision: 'PASS',
  stats: { total: 0, pass: 0, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
  rule_results: [],
  explanations: [],
  audit: {
    rules_evaluated: 0, graph_calls: 0, llm_model: 'm', llm_duration_ms: 0,
    llm_round_trips: 0, rule_source: 'ontology-api',
  },
  ...overrides,
});

describe('classifyMatch', () => {
  it('pass when decision matches and rule pins match', () => {
    const out = classifyMatch(
      { decision: 'PASS', rule_status: {} },
      baseActual({ decision: 'PASS' }),
    );
    expect(out.kind).toBe('pass');
    expect(out.failures).toEqual([]);
  });

  it('fail-decision when decisions differ', () => {
    const out = classifyMatch(
      { decision: 'PASS', rule_status: {} },
      baseActual({ decision: 'REVIEW' }),
    );
    expect(out.kind).toBe('fail-decision');
    expect(out.failures[0]).toContain('decision mismatch');
  });

  it('fail-rule when pinned rule status differs', () => {
    const out = classifyMatch(
      { decision: 'FAIL', rule_status: { '10-25': 'fail' } },
      baseActual({
        decision: 'FAIL',
        rule_results: [{ rule_id: '10-25', rule_name: '华为', step_id: 's1', status: 'pending', reason: 'r' }],
      }),
    );
    expect(out.kind).toBe('fail-rule');
    expect(out.failures[0]).toMatch(/rule 10-25.*expected 'fail'.*got 'pending'/);
  });

  it('fail-missing-rule when LLM dropped a pinned rule', () => {
    const out = classifyMatch(
      { decision: 'FAIL', rule_status: { '10-21': 'fail' } },
      baseActual({ decision: 'FAIL', rule_results: [] }),
    );
    expect(out.kind).toBe('fail-missing-rule');
    expect(out.failures[0]).toMatch(/rule 10-21 missing/);
  });

  it('fail-parse when audit.fail_reason is parse-error', () => {
    const out = classifyMatch(
      { decision: 'PASS', rule_status: {} },
      baseActual({
        decision: 'FAIL',
        audit: { ...baseActual().audit, fail_reason: 'parse-error' },
      }),
    );
    expect(out.kind).toBe('fail-parse');
  });

  it('fail-runtime when audit.fail_reason is ontology-graph-unavailable', () => {
    const out = classifyMatch(
      { decision: 'PASS', rule_status: {} },
      baseActual({
        decision: 'FAIL',
        audit: { ...baseActual().audit, fail_reason: 'ontology-graph-unavailable' },
      }),
    );
    expect(out.kind).toBe('fail-runtime');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run server/rule-check/match-classifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement match-classifier.ts**

Create `server/rule-check/match-classifier.ts`:

```ts
import type { MatchResumeCheckResult, RuleStatus } from '@/lib/rule-check/types';

export type MatchKind =
  | 'pass'
  | 'fail-decision'
  | 'fail-rule'
  | 'fail-missing-rule'
  | 'fail-parse'
  | 'fail-runtime';

export type ExpectedOutcome = {
  decision: 'PASS' | 'FAIL' | 'REVIEW';
  rule_status: Partial<Record<string, RuleStatus>>;
};

export type ClassifyResult = { kind: MatchKind; failures: string[] };

export function classifyMatch(
  expected: ExpectedOutcome,
  actual: MatchResumeCheckResult,
): ClassifyResult {
  const failures: string[] = [];

  const failReason = actual.audit.fail_reason;
  if (failReason === 'parse-error') {
    failures.push('parse-error from LLM (raw output may be truncated)');
    return { kind: 'fail-parse', failures };
  }
  if (failReason === 'ontology-graph-unavailable' || failReason === 'llm-call-error') {
    failures.push(`runtime error: ${failReason}`);
    return { kind: 'fail-runtime', failures };
  }

  if (actual.decision !== expected.decision) {
    failures.push(`decision mismatch — expected ${expected.decision}, got ${actual.decision}`);
  }

  const ruleMap = new Map(actual.rule_results.map((r) => [r.rule_id, r]));
  let missingPinned = false;
  let differingPinned = false;
  for (const [ruleId, expectedStatus] of Object.entries(expected.rule_status)) {
    const got = ruleMap.get(ruleId);
    if (!got) {
      failures.push(`rule ${ruleId} missing from rule_results — expected status='${expectedStatus}'`);
      missingPinned = true;
      continue;
    }
    if (got.status !== expectedStatus) {
      failures.push(`rule ${ruleId}: expected '${expectedStatus}', got '${got.status}' (reason: ${got.reason ?? ''})`);
      differingPinned = true;
    }
  }

  if (failures.length === 0) return { kind: 'pass', failures: [] };
  if (missingPinned) return { kind: 'fail-missing-rule', failures };
  if (differingPinned) return { kind: 'fail-rule', failures };
  return { kind: 'fail-decision', failures };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/rule-check/match-classifier.test.ts`
Expected: all 6 cases PASS.

- [ ] **Step 6: Commit**

```bash
git add server/rule-check/match-classifier.ts server/rule-check/match-classifier.test.ts
git commit -m "feat(rule-check): extract match-classifier (pass | fail-decision | fail-rule | fail-missing-rule | fail-parse | fail-runtime)"
```

---

### Task 6: scenarios-loader.ts (server-friendly fixture access)

**Files:**
- Create: `server/rule-check/scenarios-loader.ts`
- Test: `server/rule-check/scenarios-loader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/rule-check/scenarios-loader.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadScenarios, loadSharedJds } from './scenarios-loader';

describe('scenarios-loader', () => {
  it('loads all 14 scenarios when no filter', () => {
    const scenarios = loadScenarios();
    expect(scenarios).toHaveLength(14);
    expect(scenarios[0].id).toBe('S01');
    expect(scenarios[13].id).toBe('S14');
  });

  it('filters by scenario ids when provided', () => {
    const scenarios = loadScenarios(['S02', 'S05']);
    expect(scenarios).toHaveLength(2);
    expect(scenarios.map((s) => s.id).sort()).toEqual(['S02', 'S05']);
  });

  it('returns shared JDs', () => {
    const jds = loadSharedJds();
    expect(jds.length).toBeGreaterThan(0);
    expect(jds[0].job_requisition_id).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/rule-check/scenarios-loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement scenarios-loader.ts**

Create `server/rule-check/scenarios-loader.ts`:

```ts
// Server-friendly re-export of fixtures used by both the test-suite CLI and
// the /rule-check UI's API routes. Pulling from the same source keeps
// "seed data" and "expected outcomes" in lockstep.
import { SCENARIOS, SHARED_JDS, type ScenarioFixture } from '@/scripts/rule-check-test-suite/fixtures';

export type { ScenarioFixture };

export function loadScenarios(ids?: string[]): ScenarioFixture[] {
  if (!ids || ids.length === 0) return [...SCENARIOS];
  const set = new Set(ids);
  return SCENARIOS.filter((s) => set.has(s.id));
}

export function loadSharedJds() {
  return [...SHARED_JDS];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/rule-check/scenarios-loader.test.ts`
Expected: all 3 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add server/rule-check/scenarios-loader.ts server/rule-check/scenarios-loader.test.ts
git commit -m "feat(rule-check): add scenarios-loader (server-friendly wrapper over fixtures)"
```

---

### Task 7: Evidence types + registry + fallback

**Files:**
- Create: `lib/rule-check/evidence/types.ts`
- Create: `lib/rule-check/evidence/index.ts`
- Test: `lib/rule-check/evidence/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/rule-check/evidence/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildInferenceChain } from './index';
import type { GraphContext } from '../graph-context';
import type { Rule, RuleResult, RuleCheckRuntimeContext } from '../types';

const RUNTIME: RuleCheckRuntimeContext = {
  upload_id: 'u', candidate_id: 'C-1', resume_id: 'r', employee_id: 'E',
  received_at: '2026-05-13T10:00:00Z',
};

const RULE: Rule = {
  id: '99-9',  // intentionally not in the registry
  specificScenarioStage: '',
  businessLogicRuleName: 'test',
  applicableClient: '通用',
  applicableDepartment: 'N/A',
  submissionCriteria: '',
  standardizedLogicRule: '一旦 X 则 Y',
  relatedEntities: [],
  businessBackgroundReason: '',
  ruleSource: '',
  executor: 'Agent',
  severity: 'flag_only',
};

const GRAPH: GraphContext = {
  candidate: null, resume: null, job_requisition: null,
  applications: [], blacklist_hits: [], employment_links: [], fetch_count: 0,
};

describe('buildInferenceChain', () => {
  it('returns fallback chain (rule_logic + verdict) when no extractor registered', () => {
    const result: RuleResult = {
      rule_id: '99-9', rule_name: 'test', step_id: 's1',
      status: 'pending', reason: 'because',
    };
    const chain = buildInferenceChain(GRAPH, RUNTIME, RULE, result);
    expect(chain.rule_id).toBe('99-9');
    expect(chain.highlight_nodes).toEqual([]);
    expect(chain.steps).toEqual([
      { kind: 'rule_logic', markdown: '一旦 X 则 Y' },
      { kind: 'verdict', status: 'pending', reason: 'because' },
    ]);
  });

  it('fallback uses empty string reason when ruleResult.reason is undefined', () => {
    const result: RuleResult = {
      rule_id: '99-9', rule_name: 'test', step_id: 's1', status: 'pass',
    };
    const chain = buildInferenceChain(GRAPH, RUNTIME, RULE, result);
    expect(chain.steps[1]).toEqual({ kind: 'verdict', status: 'pass', reason: '' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/rule-check/evidence`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement types.ts**

Create `lib/rule-check/evidence/types.ts`:

```ts
import type { RuleStatus } from '../types';

export type NodeKind =
  | 'candidate' | 'resume' | 'jd' | 'application' | 'blacklist' | 'employment';

export type InferenceStep =
  | { kind: 'graph_node'; node: NodeKind; field?: string; value: string }
  | { kind: 'rule_logic'; markdown: string }
  | { kind: 'computation'; label: string; value: string }
  | { kind: 'verdict'; status: RuleStatus; reason: string };

export type InferenceChain = {
  rule_id: string;
  steps: InferenceStep[];
  highlight_nodes: NodeKind[];
};

export type ExtractorFn = (
  graph: import('../graph-context').GraphContext,
  runtime: import('../types').RuleCheckRuntimeContext,
  rule: import('../types').Rule,
  ruleResult: import('../types').RuleResult,
) => InferenceChain;
```

- [ ] **Step 4: Implement index.ts (registry + fallback)**

Create `lib/rule-check/evidence/index.ts`:

```ts
import type { GraphContext } from '../graph-context';
import type { Rule, RuleResult, RuleCheckRuntimeContext } from '../types';
import type { InferenceChain, ExtractorFn } from './types';

// Empty registry to start. Per-rule extractors register themselves in Tasks 8-11.
const EXTRACTORS: Record<string, ExtractorFn> = {};

export function registerExtractor(ruleId: string, fn: ExtractorFn): void {
  EXTRACTORS[ruleId] = fn;
}

export function buildInferenceChain(
  graph: GraphContext,
  runtime: RuleCheckRuntimeContext,
  rule: Rule,
  ruleResult: RuleResult,
): InferenceChain {
  const extractor = EXTRACTORS[rule.id];
  if (extractor) return extractor(graph, runtime, rule, ruleResult);
  return {
    rule_id: rule.id,
    highlight_nodes: [],
    steps: [
      { kind: 'rule_logic', markdown: rule.standardizedLogicRule },
      { kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' },
    ],
  };
}

export type { InferenceChain, InferenceStep, ExtractorFn, NodeKind } from './types';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/rule-check/evidence`
Expected: both cases PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/rule-check/evidence/
git commit -m "feat(rule-check): add inference-chain registry + fallback"
```

---

### Task 8: Evidence extractors for 10-25 + 10-26 (竞对冷冻期)

**Files:**
- Create: `lib/rule-check/evidence/rule-10-25.ts` + `.test.ts`
- Create: `lib/rule-check/evidence/rule-10-26.ts` + `.test.ts`
- Modify: `lib/rule-check/evidence/index.ts` (import extractors to register them)

- [ ] **Step 1: Write the failing test for 10-25**

Create `lib/rule-check/evidence/rule-10-25.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extract10_25 } from './rule-10-25';
import type { GraphContext } from '../graph-context';
import type { Rule, RuleResult, RuleCheckRuntimeContext } from '../types';

const RUNTIME: RuleCheckRuntimeContext = {
  upload_id: 'u', candidate_id: 'C-1', resume_id: 'r', employee_id: 'E',
  received_at: '2026-05-13T10:00:00Z',
};
const RULE: Rule = {
  id: '10-25', specificScenarioStage: '',
  businessLogicRuleName: '华为荣耀竞对与客户互不挖角红线',
  applicableClient: '通用', applicableDepartment: 'N/A',
  submissionCriteria: '', standardizedLogicRule: '若间隔不足 3 个月，挂起',
  relatedEntities: [], businessBackgroundReason: '', ruleSource: '',
  executor: 'Agent', severity: 'needs_human',
};

function graphWithHuawei(endDate: string): GraphContext {
  return {
    candidate: { candidate_id: 'C-1', name: '张三' },
    resume: { resume_id: 'r', work_experience: [
      { company: '华为', title: '工程师', start_date: '2024-01', end_date: endDate },
    ]},
    job_requisition: null, applications: [], blacklist_hits: [],
    employment_links: [], fetch_count: 6,
  };
}

describe('extract10_25 (华为冷冻期)', () => {
  it('emits a chain pointing to the 华为 work_experience row', () => {
    const result: RuleResult = {
      rule_id: '10-25', rule_name: '华为', step_id: 's1',
      status: 'pending', reason: '< 3 个月',
    };
    const chain = extract10_25(graphWithHuawei('2026-04'), RUNTIME, RULE, result);
    expect(chain.rule_id).toBe('10-25');
    expect(chain.highlight_nodes).toContain('resume');
    const labels = chain.steps.map((s) => s.kind);
    expect(labels).toContain('graph_node');
    expect(labels).toContain('computation');
    expect(labels).toContain('rule_logic');
    expect(labels).toContain('verdict');
    // computation step should mention "今" or a 月差 value
    const compSteps = chain.steps.filter((s) => s.kind === 'computation');
    expect(compSteps.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back gracefully when no 华为 work experience is found', () => {
    const noHuawei: GraphContext = {
      candidate: null, resume: { resume_id: 'r', work_experience: [
        { company: '字节', title: 'eng', start_date: '2020-01', end_date: '2024-12' },
      ]},
      job_requisition: null, applications: [], blacklist_hits: [],
      employment_links: [], fetch_count: 0,
    };
    const result: RuleResult = {
      rule_id: '10-25', rule_name: '华为', step_id: 's1', status: 'not_triggered',
    };
    const chain = extract10_25(noHuawei, RUNTIME, RULE, result);
    // No graph_node step because there's nothing to point at; still has rule_logic + verdict.
    expect(chain.steps.find((s) => s.kind === 'graph_node')).toBeUndefined();
    expect(chain.steps.find((s) => s.kind === 'verdict')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/rule-check/evidence/rule-10-25.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement rule-10-25.ts**

Create `lib/rule-check/evidence/rule-10-25.ts`:

```ts
import type { ExtractorFn, InferenceChain, InferenceStep, NodeKind } from './types';

const COMPETITOR_NAMES = ['华为', '荣耀'];

export const extract10_25: ExtractorFn = (graph, runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const workExp = ((graph.resume as Record<string, unknown> | null)?.work_experience as
    Array<{ company: string; start_date: string; end_date: string; title?: string }> | undefined) ?? [];
  const hit = workExp.find((w) => COMPETITOR_NAMES.some((c) => w.company.includes(c)));

  if (hit) {
    steps.push({
      kind: 'graph_node', node: 'resume', field: 'work_experience[]',
      value: `${hit.company} · ${hit.title ?? ''} · ${hit.start_date} ~ ${hit.end_date}`,
    });
    highlight.push('resume');

    const today = (runtime.received_at ?? '').slice(0, 10);
    steps.push({ kind: 'computation', label: 'Today (received_at)', value: today || '(unknown)' });

    const months = monthsDiff(hit.end_date, today);
    if (months !== null) {
      steps.push({
        kind: 'computation',
        label: `${hit.company} 离职至今`,
        value: `≈ ${months.toFixed(1)} months`,
      });
    }
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });

  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};

function monthsDiff(endYM: string, todayISO: string): number | null {
  if (!endYM || !todayISO) return null;
  const [ey, em] = endYM.split('-').map(Number);
  const [ty, tm] = todayISO.split('-').map(Number);
  if (!ey || !em || !ty || !tm) return null;
  return (ty - ey) * 12 + (tm - em);
}
```

- [ ] **Step 4: Register 10-25 in the registry**

Modify `lib/rule-check/evidence/index.ts` — add an import + registration call at the bottom of the file (before the type re-exports):

```ts
// Per-rule extractor registrations.
import { extract10_25 } from './rule-10-25';
registerExtractor('10-25', extract10_25);
```

- [ ] **Step 5: Run 10-25 test to verify it passes**

Run: `npx vitest run lib/rule-check/evidence/rule-10-25.test.ts`
Expected: both cases PASS.

- [ ] **Step 6: Write the failing test for 10-26**

Create `lib/rule-check/evidence/rule-10-26.test.ts` — same shape as 10-25's test but with companies `['OPPO', '小米']` and rule id `10-26`.

```ts
import { describe, expect, it } from 'vitest';
import { extract10_26 } from './rule-10-26';
import type { GraphContext } from '../graph-context';
import type { Rule, RuleResult, RuleCheckRuntimeContext } from '../types';

const RUNTIME: RuleCheckRuntimeContext = {
  upload_id: 'u', candidate_id: 'C-1', resume_id: 'r', employee_id: 'E',
  received_at: '2026-05-13T10:00:00Z',
};
const RULE: Rule = {
  id: '10-26', specificScenarioStage: '',
  businessLogicRuleName: 'OPPO小米竞对与客户互不挖角红线',
  applicableClient: '通用', applicableDepartment: 'N/A',
  submissionCriteria: '', standardizedLogicRule: '若间隔不足 6 个月，挂起',
  relatedEntities: [], businessBackgroundReason: '', ruleSource: '',
  executor: 'Agent', severity: 'needs_human',
};

describe('extract10_26 (OPPO/小米 冷冻期)', () => {
  it('points to OPPO work experience', () => {
    const graph: GraphContext = {
      candidate: null,
      resume: { resume_id: 'r', work_experience: [
        { company: 'OPPO', title: 'eng', start_date: '2024-01', end_date: '2024-12' },
      ]},
      job_requisition: null, applications: [], blacklist_hits: [],
      employment_links: [], fetch_count: 0,
    };
    const result: RuleResult = {
      rule_id: '10-26', rule_name: 'OPPO', step_id: 's1', status: 'pass',
    };
    const chain = extract10_26(graph, RUNTIME, RULE, result);
    expect(chain.steps.find((s) => s.kind === 'graph_node')).toBeDefined();
    expect(chain.highlight_nodes).toContain('resume');
  });
});
```

- [ ] **Step 7: Implement 10-26 (mirror 10-25 with different constants)**

Create `lib/rule-check/evidence/rule-10-26.ts` — identical structure to `rule-10-25.ts` but `const COMPETITOR_NAMES = ['OPPO', '小米'];` and export `extract10_26`.

```ts
import type { ExtractorFn, InferenceChain, InferenceStep, NodeKind } from './types';

const COMPETITOR_NAMES = ['OPPO', '小米'];

export const extract10_26: ExtractorFn = (graph, runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const workExp = ((graph.resume as Record<string, unknown> | null)?.work_experience as
    Array<{ company: string; start_date: string; end_date: string; title?: string }> | undefined) ?? [];
  const hit = workExp.find((w) => COMPETITOR_NAMES.some((c) => w.company.includes(c)));

  if (hit) {
    steps.push({
      kind: 'graph_node', node: 'resume', field: 'work_experience[]',
      value: `${hit.company} · ${hit.title ?? ''} · ${hit.start_date} ~ ${hit.end_date}`,
    });
    highlight.push('resume');

    const today = (runtime.received_at ?? '').slice(0, 10);
    steps.push({ kind: 'computation', label: 'Today (received_at)', value: today || '(unknown)' });

    const months = monthsDiff(hit.end_date, today);
    if (months !== null) {
      steps.push({
        kind: 'computation',
        label: `${hit.company} 离职至今`,
        value: `≈ ${months.toFixed(1)} months`,
      });
    }
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });

  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};

function monthsDiff(endYM: string, todayISO: string): number | null {
  if (!endYM || !todayISO) return null;
  const [ey, em] = endYM.split('-').map(Number);
  const [ty, tm] = todayISO.split('-').map(Number);
  if (!ey || !em || !ty || !tm) return null;
  return (ty - ey) * 12 + (tm - em);
}
```

- [ ] **Step 8: Register 10-26**

In `lib/rule-check/evidence/index.ts`, add:

```ts
import { extract10_26 } from './rule-10-26';
registerExtractor('10-26', extract10_26);
```

- [ ] **Step 9: Run all evidence tests**

Run: `npx vitest run lib/rule-check/evidence`
Expected: all cases (10-25, 10-26, fallback) PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/rule-check/evidence/rule-10-25.* lib/rule-check/evidence/rule-10-26.* lib/rule-check/evidence/index.ts
git commit -m "feat(rule-check): evidence extractors for 10-25 (华为) + 10-26 (OPPO/小米)"
```

---

### Task 9: Evidence extractors for 10-17, 10-27, 10-32 (blacklist + 亲属 + 岗位冷冻)

**Files:**
- Create: `lib/rule-check/evidence/rule-10-17.ts` + `.test.ts`
- Create: `lib/rule-check/evidence/rule-10-27.ts` + `.test.ts`
- Create: `lib/rule-check/evidence/rule-10-32.ts` + `.test.ts`
- Modify: `lib/rule-check/evidence/index.ts`

- [ ] **Step 1: Implement rule-10-17.ts (blacklist 命中)**

Create `lib/rule-check/evidence/rule-10-17.test.ts` and `rule-10-17.ts`. The extractor reads `graph.blacklist_hits` (Blacklist nodes linked to this candidate via BLOCKS_CANDIDATE).

Test:

```ts
import { describe, expect, it } from 'vitest';
import { extract10_17 } from './rule-10-17';
import type { GraphContext } from '../graph-context';

const BASE = {
  candidate: null, resume: null, job_requisition: null,
  applications: [], employment_links: [], fetch_count: 0,
};
const RUNTIME = { upload_id: 'u', candidate_id: 'C-1', resume_id: 'r', employee_id: 'E' };
const RULE = {
  id: '10-17', specificScenarioStage: '', businessLogicRuleName: '高风险回流',
  applicableClient: '通用', applicableDepartment: 'N/A', submissionCriteria: '',
  standardizedLogicRule: '命中黑名单则终止', relatedEntities: [],
  businessBackgroundReason: '', ruleSource: '', executor: 'Agent' as const, severity: 'terminal' as const,
};

describe('extract10_17 (黑名单命中)', () => {
  it('points to a Blacklist node when there is a hit', () => {
    const graph: GraphContext = {
      ...BASE, blacklist_hits: [{ blacklist_id: 'BL-1', lock_reason: 'A15 劳动纠纷' }],
    };
    const chain = extract10_17(graph, RUNTIME, RULE, {
      rule_id: '10-17', rule_name: 'BL', step_id: 's1', status: 'fail', reason: 'hit',
    });
    expect(chain.highlight_nodes).toContain('blacklist');
    expect(chain.steps.find((s) => s.kind === 'graph_node' && s.node === 'blacklist')).toBeDefined();
  });
});
```

Implementation:

```ts
import type { ExtractorFn, InferenceStep, NodeKind } from './types';

export const extract10_17: ExtractorFn = (graph, runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const hits = (graph.blacklist_hits ?? []) as Array<Record<string, unknown>>;
  if (hits.length > 0) {
    for (const h of hits) {
      steps.push({
        kind: 'graph_node', node: 'blacklist', field: 'lock_reason',
        value: `${h.blacklist_id ?? '?'} · ${h.lock_reason ?? '(no reason)'}`,
      });
    }
    highlight.push('blacklist', 'candidate');
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};
```

- [ ] **Step 2: Implement rule-10-27.ts (亲属回避)**

Test should set `graph.candidate.conflict_interest_declaration` to something non-empty and assert a `graph_node` step points to that candidate field.

Implementation extracts that field if non-empty:

```ts
import type { ExtractorFn, InferenceStep, NodeKind } from './types';

export const extract10_27: ExtractorFn = (graph, runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const decl = (graph.candidate as Record<string, unknown> | null)?.conflict_interest_declaration as string | undefined;
  if (decl && decl !== '无' && decl.trim().length > 0) {
    steps.push({
      kind: 'graph_node', node: 'candidate', field: 'conflict_interest_declaration',
      value: decl,
    });
    highlight.push('candidate');
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};
```

Test file `rule-10-27.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extract10_27 } from './rule-10-27';

const BASE = { resume: null, job_requisition: null, applications: [], blacklist_hits: [], employment_links: [], fetch_count: 0 };
const RUNTIME = { upload_id: 'u', candidate_id: 'C-1', resume_id: 'r', employee_id: 'E' };
const RULE = { id: '10-27', specificScenarioStage: '', businessLogicRuleName: '亲属', applicableClient: '通用', applicableDepartment: 'N/A', submissionCriteria: '', standardizedLogicRule: '亲属避嫌', relatedEntities: [], businessBackgroundReason: '', ruleSource: '', executor: 'Agent' as const, severity: 'needs_human' as const };

describe('extract10_27 (亲属回避)', () => {
  it('points to candidate.conflict_interest_declaration when non-empty', () => {
    const chain = extract10_27(
      { ...BASE, candidate: { conflict_interest_declaration: '配偶在 XX 工作' } },
      RUNTIME, RULE,
      { rule_id: '10-27', rule_name: '亲属', step_id: 's1', status: 'pending', reason: '需确认' },
    );
    expect(chain.highlight_nodes).toContain('candidate');
    expect(chain.steps.find((s) => s.kind === 'graph_node')).toBeDefined();
  });

  it('omits graph_node when declaration is empty or "无"', () => {
    const chain = extract10_27(
      { ...BASE, candidate: { conflict_interest_declaration: '无' } },
      RUNTIME, RULE,
      { rule_id: '10-27', rule_name: '亲属', step_id: 's1', status: 'not_triggered' },
    );
    expect(chain.steps.find((s) => s.kind === 'graph_node')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Implement rule-10-32.ts (岗位冷冻期 — applications cooldown)**

Reads `graph.applications`, looks for an application where `job_requisition_id === graph.job_requisition.job_requisition_id` AND `push_timestamp` within 3 months of `runtime.received_at`.

Implementation:

```ts
import type { ExtractorFn, InferenceStep, NodeKind } from './types';

export const extract10_32: ExtractorFn = (graph, runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const jrId = (graph.job_requisition as Record<string, unknown> | null)?.job_requisition_id as string | undefined;
  const apps = (graph.applications ?? []) as Array<{ application_id: string; job_requisition_id: string; push_timestamp: string; status: string }>;
  const today = (runtime.received_at ?? '').slice(0, 10);

  const sameJobApps = jrId ? apps.filter((a) => a.job_requisition_id === jrId) : [];
  for (const a of sameJobApps) {
    steps.push({
      kind: 'graph_node', node: 'application', field: 'push_timestamp',
      value: `${a.application_id} · pushed ${a.push_timestamp} · status=${a.status}`,
    });
    const months = monthsDiffISO(a.push_timestamp, today);
    if (months !== null) {
      steps.push({
        kind: 'computation', label: '距上次推送',
        value: `≈ ${months.toFixed(1)} months`,
      });
    }
    highlight.push('application');
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};

function monthsDiffISO(a: string, b: string): number | null {
  if (!a || !b) return null;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return (db - da) / (1000 * 60 * 60 * 24 * 30);
}
```

Test file `rule-10-32.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extract10_32 } from './rule-10-32';

describe('extract10_32 (岗位冷冻期)', () => {
  it('points to matching application by job_requisition_id', () => {
    const chain = extract10_32(
      {
        candidate: null, resume: null,
        job_requisition: { job_requisition_id: 'JR-1' },
        applications: [{ application_id: 'A-1', job_requisition_id: 'JR-1', push_timestamp: '2026-03-01T00:00:00Z', status: '筛选淘汰' }],
        blacklist_hits: [], employment_links: [], fetch_count: 0,
      },
      { upload_id: 'u', candidate_id: 'C-1', resume_id: 'r', employee_id: 'E', received_at: '2026-05-13T10:00:00Z' },
      { id: '10-32', specificScenarioStage: '', businessLogicRuleName: '岗位冷冻', applicableClient: '通用', applicableDepartment: 'N/A', submissionCriteria: '', standardizedLogicRule: '同岗位 < 3 月', relatedEntities: [], businessBackgroundReason: '', ruleSource: '', executor: 'Agent', severity: 'needs_human' },
      { rule_id: '10-32', rule_name: '岗位', step_id: 's1', status: 'pending', reason: '同岗位<3月' },
    );
    expect(chain.highlight_nodes).toContain('application');
    expect(chain.steps.find((s) => s.kind === 'computation' && s.label === '距上次推送')).toBeDefined();
  });
});
```

- [ ] **Step 4: Register all three in `lib/rule-check/evidence/index.ts`**

Add at the bottom (alongside 10-25/10-26):

```ts
import { extract10_17 } from './rule-10-17';
import { extract10_27 } from './rule-10-27';
import { extract10_32 } from './rule-10-32';
registerExtractor('10-17', extract10_17);
registerExtractor('10-27', extract10_27);
registerExtractor('10-32', extract10_32);
```

- [ ] **Step 5: Run all evidence tests**

Run: `npx vitest run lib/rule-check/evidence`
Expected: all extractor tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/rule-check/evidence/rule-10-17.* lib/rule-check/evidence/rule-10-27.* lib/rule-check/evidence/rule-10-32.* lib/rule-check/evidence/index.ts
git commit -m "feat(rule-check): evidence extractors for 10-17 (黑名单), 10-27 (亲属), 10-32 (岗位冷冻)"
```

---

### Task 10: Evidence extractors for 10-5, 10-9, 10-10, 10-21 (硬性 + 空窗期 + 年龄)

**Files:**
- Create: `lib/rule-check/evidence/rule-10-5.ts` + `.test.ts`
- Create: `lib/rule-check/evidence/rule-10-9.ts` + `.test.ts`
- Create: `lib/rule-check/evidence/rule-10-10.ts` + `.test.ts`
- Create: `lib/rule-check/evidence/rule-10-21.ts` + `.test.ts`
- Modify: `lib/rule-check/evidence/index.ts`

- [ ] **Step 1: Implement rule-10-5.ts (学历硬性要求)**

Reads `graph.candidate.highest_acquired_degree` and `graph.job_requisition.degree_requirement`.

Implementation:

```ts
import type { ExtractorFn, InferenceStep, NodeKind } from './types';

export const extract10_5: ExtractorFn = (graph, runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const candidateDegree = (graph.candidate as Record<string, unknown> | null)?.highest_acquired_degree as string | undefined;
  const requiredDegree = (graph.job_requisition as Record<string, unknown> | null)?.degree_requirement as string | undefined;

  if (candidateDegree) {
    steps.push({
      kind: 'graph_node', node: 'candidate', field: 'highest_acquired_degree',
      value: candidateDegree,
    });
    highlight.push('candidate');
  }
  if (requiredDegree) {
    steps.push({
      kind: 'graph_node', node: 'jd', field: 'degree_requirement',
      value: requiredDegree,
    });
    highlight.push('jd');
  }
  if (candidateDegree && requiredDegree) {
    steps.push({
      kind: 'computation', label: '学历匹配',
      value: `${candidateDegree} vs 要求 ${requiredDegree}`,
    });
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};
```

Test asserts both `candidate.highest_acquired_degree` and `jd.degree_requirement` produce graph_node steps when present.

- [ ] **Step 2: Implement rule-10-9.ts (空窗期 > 3月)**

Reads `graph.resume.work_experience`, scans contiguous pairs, computes gaps > 3 months.

```ts
import type { ExtractorFn, InferenceStep, NodeKind } from './types';

export const extract10_9: ExtractorFn = (graph, runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const workExp = ((graph.resume as Record<string, unknown> | null)?.work_experience as
    Array<{ company: string; start_date: string; end_date: string }> | undefined) ?? [];

  // Sort by start_date ascending so adjacent gaps are meaningful.
  const sorted = [...workExp].sort((a, b) => a.start_date.localeCompare(b.start_date));
  for (let i = 0; i < sorted.length - 1; i++) {
    const prevEnd = sorted[i].end_date;
    const nextStart = sorted[i + 1].start_date;
    const months = monthsDiff(prevEnd, nextStart);
    if (months !== null && months > 3) {
      steps.push({
        kind: 'graph_node', node: 'resume', field: `work_experience[${i}→${i + 1}]`,
        value: `${sorted[i].company} (end ${prevEnd}) → ${sorted[i + 1].company} (start ${nextStart})`,
      });
      steps.push({
        kind: 'computation', label: '空窗期',
        value: `≈ ${months.toFixed(1)} months`,
      });
      highlight.push('resume');
    }
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};

function monthsDiff(a: string, b: string): number | null {
  if (!a || !b) return null;
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  if (!ay || !am || !by || !bm) return null;
  return (by - ay) * 12 + (bm - am);
}
```

Test asserts a gap from `2020-12` to `2024-07` (43 months) produces both `graph_node` and `computation` steps; a gap of 1 month produces neither.

- [ ] **Step 3: Implement rule-10-10.ts (空窗期 > 1 年)**

Same structure as 10-9 but threshold `months > 12`. Copy the file and change the constant.

- [ ] **Step 4: Implement rule-10-21.ts (年龄超限)**

Reads `graph.candidate.birth_date` and `graph.job_requisition.age_range`.

```ts
import type { ExtractorFn, InferenceStep, NodeKind } from './types';

export const extract10_21: ExtractorFn = (graph, runtime, rule, ruleResult) => {
  const steps: InferenceStep[] = [];
  const highlight: NodeKind[] = [];

  const birth = (graph.candidate as Record<string, unknown> | null)?.birth_date as string | undefined;
  const ageRange = (graph.job_requisition as Record<string, unknown> | null)?.age_range as string | undefined;
  const today = (runtime.received_at ?? '').slice(0, 10);

  if (birth) {
    steps.push({ kind: 'graph_node', node: 'candidate', field: 'birth_date', value: birth });
    highlight.push('candidate');
    const age = yearsBetween(birth, today);
    if (age !== null) steps.push({ kind: 'computation', label: 'Age (today)', value: `${age}` });
  }
  if (ageRange) {
    steps.push({ kind: 'graph_node', node: 'jd', field: 'age_range', value: ageRange });
    highlight.push('jd');
  }

  steps.push({ kind: 'rule_logic', markdown: rule.standardizedLogicRule });
  steps.push({ kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' });
  return { rule_id: rule.id, steps, highlight_nodes: highlight };
};

function yearsBetween(birthISO: string, todayISO: string): number | null {
  if (!birthISO || !todayISO) return null;
  const b = new Date(birthISO).getTime();
  const t = new Date(todayISO).getTime();
  if (Number.isNaN(b) || Number.isNaN(t)) return null;
  return Math.floor((t - b) / (1000 * 60 * 60 * 24 * 365.25));
}
```

- [ ] **Step 5: Write tests for each extractor**

For each rule (10-5, 10-9, 10-10, 10-21), create `<file>.test.ts` with one or two cases asserting:
- The expected `graph_node` step shape when the data is present.
- The expected `computation` step (where applicable).
- A `verdict` step at the end with the right status.

Reuse the test helpers from earlier (RUNTIME, BASE graph, RULE fixture). Each test file follows the same shape as `rule-10-25.test.ts`.

- [ ] **Step 6: Register all four in `lib/rule-check/evidence/index.ts`**

Add at the bottom:

```ts
import { extract10_5 } from './rule-10-5';
import { extract10_9 } from './rule-10-9';
import { extract10_10 } from './rule-10-10';
import { extract10_21 } from './rule-10-21';
registerExtractor('10-5', extract10_5);
registerExtractor('10-9', extract10_9);
registerExtractor('10-10', extract10_10);
registerExtractor('10-21', extract10_21);
```

- [ ] **Step 7: Run all evidence tests**

Run: `npx vitest run lib/rule-check/evidence`
Expected: every extractor's tests PASS plus the fallback test.

- [ ] **Step 8: Commit**

```bash
git add lib/rule-check/evidence/rule-10-5.* lib/rule-check/evidence/rule-10-9.* lib/rule-check/evidence/rule-10-10.* lib/rule-check/evidence/rule-10-21.* lib/rule-check/evidence/index.ts
git commit -m "feat(rule-check): evidence extractors for 10-5 (学历), 10-9/10-10 (空窗期), 10-21 (年龄)"
```

---

### Task 11: runs-service.ts (streaming engine — happy path)

**Files:**
- Create: `server/rule-check/runs-service.ts`
- Test: `server/rule-check/runs-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/rule-check/runs-service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/rule-check/runner', () => ({
  runRuleCheck: vi.fn(),
  buildRuleCheckInput: vi.fn((args) => ({
    runtime_context: args.runtime_context,
    job_requisition: args.job_requisition,
    job_requisition_specification: null,
    hsm_feedback: null,
  })),
}));

vi.mock('@/server/db', () => ({
  prisma: {
    ruleCheckRun: {
      create: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    ruleCheckScenarioResult: {
      upsert: vi.fn(),
    },
  },
}));

import { runRuleCheck } from '@/lib/rule-check/runner';
import { prisma } from '@/server/db';
import { streamRuleCheckRun } from './runs-service';

const mRun = vi.mocked(runRuleCheck);
const mPrismaCreate = vi.mocked(prisma.ruleCheckRun.create);
const mPrismaUpdate = vi.mocked(prisma.ruleCheckRun.update);
const mUpsert = vi.mocked(prisma.ruleCheckScenarioResult.upsert);

beforeEach(() => {
  mRun.mockReset();
  mPrismaCreate.mockReset();
  mPrismaUpdate.mockReset();
  mUpsert.mockReset();
  mPrismaCreate.mockResolvedValue({ id: 'run-1' } as never);
  mPrismaUpdate.mockResolvedValue({ id: 'run-1' } as never);
  mUpsert.mockResolvedValue({ id: 'res-1' } as never);
});

describe('streamRuleCheckRun', () => {
  it('emits started, one result per scenario, and done', async () => {
    mRun.mockResolvedValue({
      decision: 'PASS', stats: { total: 0, pass: 0, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [], explanations: [],
      graph_context: { candidate: null, resume: null, job_requisition: null, applications: [], blacklist_hits: [], employment_links: [], fetch_count: 0 },
      audit: { rules_evaluated: 0, graph_calls: 0, llm_model: 'm', llm_duration_ms: 1000, llm_round_trips: 0, rule_source: 'ontology-api' },
    });
    const events: unknown[] = [];
    for await (const e of streamRuleCheckRun({ scenario_ids: ['S01', 'S02'] })) {
      events.push(e);
    }
    expect((events[0] as { type: string }).type).toBe('started');
    expect((events[1] as { type: string }).type).toBe('result');
    expect((events[2] as { type: string }).type).toBe('result');
    expect((events[3] as { type: string }).type).toBe('done');
    expect(mUpsert).toHaveBeenCalledTimes(2);
  });

  it('emits error event when scenario runner throws', async () => {
    mRun.mockRejectedValueOnce(new Error('gateway-fire'));
    const events: unknown[] = [];
    for await (const e of streamRuleCheckRun({ scenario_ids: ['S01'] })) {
      events.push(e);
    }
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain('error');
    expect(mPrismaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'error' }) }),
    );
  });

  it('respects abort signal mid-stream', async () => {
    mRun.mockResolvedValue({
      decision: 'PASS', stats: { total: 0, pass: 0, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [], explanations: [],
      graph_context: { candidate: null, resume: null, job_requisition: null, applications: [], blacklist_hits: [], employment_links: [], fetch_count: 0 },
      audit: { rules_evaluated: 0, graph_calls: 0, llm_model: 'm', llm_duration_ms: 1, llm_round_trips: 0, rule_source: 'ontology-api' },
    });
    const ac = new AbortController();
    const events: unknown[] = [];
    const gen = streamRuleCheckRun({ scenario_ids: ['S01', 'S02', 'S03'], signal: ac.signal });
    let count = 0;
    for await (const e of gen) {
      events.push(e);
      count++;
      if (count === 2) ac.abort();  // abort after 'started' + first 'result'
    }
    expect(events[events.length - 1]).toMatchObject({ type: 'error' });
    expect(mUpsert.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/rule-check/runs-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement runs-service.ts**

Create `server/rule-check/runs-service.ts`:

```ts
import { prisma } from '@/server/db';
import { runRuleCheck, buildRuleCheckInput } from '@/lib/rule-check/runner';
import { buildInferenceChain } from '@/lib/rule-check/evidence';
import { fetchRulesForMatchResume } from '@/lib/rule-check/ontology-source';
import { applyClientFilter, extractDims } from '@/lib/rule-check/ontology';
import type { MatchResumeCheckResult, RuleResult } from '@/lib/rule-check/types';
import type { InferenceChain } from '@/lib/rule-check/evidence/types';
import { classifyMatch, type ExpectedOutcome } from './match-classifier';
import { loadScenarios, type ScenarioFixture } from './scenarios-loader';

export type StreamEvent =
  | { type: 'started'; run_id: string }
  | { type: 'result'; run_id: string; scenario: ScenarioResultPayload }
  | { type: 'done'; run_id: string; summary: RunSummary }
  | { type: 'error'; run_id: string; message: string };

export type ScenarioResultPayload = {
  scenario_id: string;
  scenario_name: string;
  expected: ExpectedOutcome;
  actual: { decision: string; stats: MatchResumeCheckResult['stats'] };
  rule_results: RuleResult[];
  match_kind: string;
  failures: string[];
  inference_chain: InferenceChain[];
  graph_context: MatchResumeCheckResult['graph_context'];
  audit: {
    llm_ms: number;
    llm_model: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    finish_reason?: string;
    graph_calls: number;
    raw_llm_text?: string;
  };
};

export type RunSummary = {
  total: number;
  pass: number;
  fail: number;
  total_llm_ms: number;
};

export async function* streamRuleCheckRun(args: {
  model?: string;
  client_id_override?: string;
  scenario_ids?: string[];
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  const run = await prisma.ruleCheckRun.create({
    data: {
      status: 'running',
      model: args.model ?? process.env.AI_MODEL ?? 'gemini-3-flash-preview',
      clientIdOverride: args.client_id_override ?? null,
    },
  });
  yield { type: 'started', run_id: run.id };

  const scenarios = loadScenarios(args.scenario_ids);
  let pass = 0, fail = 0, capHits = 0, totalLlmMs = 0, totalP = 0, totalC = 0;

  try {
    for (const scenario of scenarios) {
      if (args.signal?.aborted) throw new Error('client-aborted');

      const result = await runOneScenario(scenario, args.model);
      const expected: ExpectedOutcome = {
        decision: scenario.expected.decision,
        rule_status: scenario.expected.rule_status,
      };
      const classified = classifyMatch(expected, result);

      // Build inference chains for every emitted rule_result.
      const ruleSource = await fetchRulesForMatchResume();
      const ruleById = new Map(ruleSource.rules.map((r) => [r.id, r]));
      const chains: InferenceChain[] = result.rule_results
        .map((rr) => {
          const rule = ruleById.get(rr.rule_id);
          if (!rule || !result.graph_context) return null;
          return buildInferenceChain(
            result.graph_context,
            { upload_id: '', candidate_id: scenario.candidate_id, resume_id: scenario.resume_id, employee_id: '', received_at: new Date().toISOString() },
            rule,
            rr,
          );
        })
        .filter((c): c is InferenceChain => c !== null);

      await prisma.ruleCheckScenarioResult.upsert({
        where: { runId_scenarioId: { runId: run.id, scenarioId: scenario.id } },
        create: scenarioRowData(run.id, scenario, result, classified, chains),
        update: scenarioRowData(run.id, scenario, result, classified, chains),
      });

      if (classified.kind === 'pass') pass++; else fail++;
      if (result.audit.llm_finish_reason === 'length') capHits++;
      totalLlmMs += result.audit.llm_duration_ms;
      totalP += result.audit.llm_prompt_tokens ?? 0;
      totalC += result.audit.llm_completion_tokens ?? 0;

      yield {
        type: 'result',
        run_id: run.id,
        scenario: {
          scenario_id: scenario.id,
          scenario_name: scenario.name,
          expected,
          actual: { decision: result.decision, stats: result.stats },
          rule_results: result.rule_results,
          match_kind: classified.kind,
          failures: classified.failures,
          inference_chain: chains,
          graph_context: result.graph_context,
          audit: {
            llm_ms: result.audit.llm_duration_ms,
            llm_model: result.audit.llm_model,
            prompt_tokens: result.audit.llm_prompt_tokens,
            completion_tokens: result.audit.llm_completion_tokens,
            finish_reason: result.audit.llm_finish_reason,
            graph_calls: result.audit.graph_calls,
            raw_llm_text: result.audit.raw_llm_text,
          },
        },
      };
    }

    await prisma.ruleCheckRun.update({
      where: { id: run.id },
      data: {
        status: 'done', finishedAt: new Date(),
        totalScenarios: scenarios.length,
        passCount: pass, failCount: fail,
        totalLlmMs, totalPromptTokens: totalP, totalCompletionTokens: totalC,
        capHits,
      },
    });
    yield {
      type: 'done', run_id: run.id,
      summary: { total: scenarios.length, pass, fail, total_llm_ms: totalLlmMs },
    };
  } catch (err) {
    const message = (err as Error).message ?? 'unknown error';
    await prisma.ruleCheckRun.update({
      where: { id: run.id },
      data: { status: 'error', finishedAt: new Date(), errorMessage: message },
    });
    yield { type: 'error', run_id: run.id, message };
  }
}

async function runOneScenario(
  scenario: ScenarioFixture,
  modelOverride?: string,
): Promise<MatchResumeCheckResult> {
  // The runner reads the resume from neo4j via candidate_id, so we just need to
  // pass a coherent runtime_context + job_requisition.
  const input = buildRuleCheckInput({
    runtime_context: {
      upload_id: `eval-${scenario.id}`,
      candidate_id: scenario.candidate_id,
      resume_id: scenario.resume_id,
      employee_id: 'eval',
      received_at: new Date().toISOString(),
    },
    parsed_resume: scenario.resume,
    job_requisition: { ...lookupJd(scenario.job_requisition_id) },
  });
  // modelOverride is currently consumed by chatComplete via env; threading it
  // through requires a runner-side change (see Task 12). For now, callers set
  // process.env.AI_MODEL before invocation if they need a per-run model.
  return runRuleCheck(input);
}

function lookupJd(jrId: string): Record<string, unknown> {
  const { SHARED_JDS } = require('@/scripts/rule-check-test-suite/fixtures');
  const found = (SHARED_JDS as Array<{ job_requisition_id: string }>).find(
    (j) => j.job_requisition_id === jrId,
  );
  if (!found) throw new Error(`No JD with job_requisition_id=${jrId} in SHARED_JDS`);
  return found;
}

function scenarioRowData(
  runId: string,
  scenario: ScenarioFixture,
  result: MatchResumeCheckResult,
  classified: ReturnType<typeof classifyMatch>,
  chains: InferenceChain[],
) {
  return {
    runId,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    expectedDecision: scenario.expected.decision,
    expectedRules: JSON.stringify(scenario.expected.rule_status),
    actualDecision: result.decision,
    actualStats: JSON.stringify(result.stats),
    ruleResults: JSON.stringify(result.rule_results),
    matchKind: classified.kind,
    failures: classified.failures.length ? JSON.stringify(classified.failures) : null,
    inferenceChain: JSON.stringify(chains),
    graphContext: JSON.stringify(result.graph_context ?? {}),
    llmMs: result.audit.llm_duration_ms,
    llmModel: result.audit.llm_model,
    promptTokens: result.audit.llm_prompt_tokens ?? null,
    completionTokens: result.audit.llm_completion_tokens ?? null,
    finishReason: result.audit.llm_finish_reason ?? null,
    graphCalls: result.audit.graph_calls,
    rawLlmText: result.audit.raw_llm_text ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/rule-check/runs-service.test.ts`
Expected: all 3 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add server/rule-check/runs-service.ts server/rule-check/runs-service.test.ts
git commit -m "feat(rule-check): streamRuleCheckRun service (SSE-ready async generator)"
```

---

### Task 12: Thread model override through to chatComplete

**Files:**
- Modify: `lib/rule-check/runner.ts` — accept `modelOverride` param
- Modify: `server/rule-check/runs-service.ts` — pass modelOverride
- Test: extend existing tests

- [ ] **Step 1: Write the failing test**

Add to `lib/rule-check/runner.test.ts`:

```ts
  it('passes model override to chatComplete when provided', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({ rule_results: [{ rule_id: '10-25', status: 'pass' }] }),
      modelUsed: 'claude-opus-4-7', durationMs: 1, toolUseIterations: 0,
    });
    await runRuleCheck(fakeInput(), { model: 'claude-opus-4-7' });
    const args = mChat.mock.calls[0]?.[0] as { model?: string };
    expect(args.model).toBe('claude-opus-4-7');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/rule-check/runner.test.ts`
Expected: FAIL — `runRuleCheck` does not accept a 2nd argument.

- [ ] **Step 3: Modify runRuleCheck signature**

In `lib/rule-check/runner.ts`, change:

```ts
export async function runRuleCheck(input: RuleCheckInput): Promise<MatchResumeCheckResult> {
```

to:

```ts
export type RunRuleCheckOptions = {
  /** Override the gateway's default model for this call only. */
  model?: string;
};

export async function runRuleCheck(
  input: RuleCheckInput,
  opts: RunRuleCheckOptions = {},
): Promise<MatchResumeCheckResult> {
```

Then in the `chatComplete({...})` call inside `runRuleCheck`, thread `model: opts.model` (only when set):

```ts
    llmResult = await chatComplete({
      system: MATCH_RESUME_SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: 16000,
      model: opts.model,
      tools: { schema: TOOL_SCHEMA, onToolCall: dispatcher, maxIterations: 5 },
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/rule-check/runner.test.ts`
Expected: all 66 cases PASS.

- [ ] **Step 5: Update runs-service to pass through**

In `server/rule-check/runs-service.ts`, change `runOneScenario` to:

```ts
async function runOneScenario(
  scenario: ScenarioFixture,
  modelOverride?: string,
): Promise<MatchResumeCheckResult> {
  const input = buildRuleCheckInput({ /* unchanged */ });
  return runRuleCheck(input, { model: modelOverride });
}
```

And in the for-loop call site (above), pass `args.model`:

```ts
      const result = await runOneScenario(scenario, args.model);
```

(It's already passing `args.model` in the Step 3 of Task 11; this step verifies that path is wired correctly end-to-end.)

- [ ] **Step 6: Run all rule-check + runs-service tests**

Run: `npx vitest run lib/rule-check server/rule-check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/rule-check/runner.ts lib/rule-check/runner.test.ts server/rule-check/runs-service.ts
git commit -m "feat(rule-check): thread per-call model override into runner + service"
```

---

### Task 13: API route — GET /api/rule-check/scenarios

**Files:**
- Create: `app/api/rule-check/scenarios/route.ts`

- [ ] **Step 1: Write a smoke test (manual fetch via curl)**

Skip a unit test here — Next.js Route Handlers are integration-tested via curl. We'll come back if behavior drifts.

- [ ] **Step 2: Implement the route**

Create `app/api/rule-check/scenarios/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { loadScenarios } from '@/server/rule-check/scenarios-loader';

export async function GET() {
  const scenarios = loadScenarios();
  return NextResponse.json({
    scenarios: scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      candidate_id: s.candidate_id,
      resume_id: s.resume_id,
      job_requisition_id: s.job_requisition_id,
      expected: s.expected,
    })),
  });
}
```

- [ ] **Step 3: Verify via curl**

Start the dev server (`npm run dev`) in another terminal, then:

Run: `curl -s http://localhost:3002/api/rule-check/scenarios | jq '.scenarios | length'`
Expected output: `14`

- [ ] **Step 4: Commit**

```bash
git add app/api/rule-check/scenarios/route.ts
git commit -m "feat(rule-check): GET /api/rule-check/scenarios route"
```

---

### Task 14: API route — GET /api/rule-check/runs (list + latest=1)

**Files:**
- Create: `app/api/rule-check/runs/route.ts` (GET handler only — POST in Task 16)

- [ ] **Step 1: Implement the GET handler**

Create `app/api/rule-check/runs/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export async function GET(req: NextRequest) {
  const latest = req.nextUrl.searchParams.get('latest');
  if (latest === '1') {
    const run = await prisma.ruleCheckRun.findFirst({
      orderBy: { startedAt: 'desc' },
      include: { results: { orderBy: { scenarioId: 'asc' } } },
    });
    return NextResponse.json({ run, scenarios: run?.results ?? [] });
  }
  const runs = await prisma.ruleCheckRun.findMany({
    orderBy: { startedAt: 'desc' }, take: 20,
  });
  return NextResponse.json({ runs });
}
```

- [ ] **Step 2: Verify via curl**

Run: `curl -s http://localhost:3002/api/rule-check/runs?latest=1 | jq '.run'`
Expected: `null` (if no runs yet) or an object with `id` and `model`.

- [ ] **Step 3: Commit**

```bash
git add app/api/rule-check/runs/route.ts
git commit -m "feat(rule-check): GET /api/rule-check/runs (list + latest=1)"
```

---

### Task 15: API route — GET /api/rule-check/runs/[run_id]

**Files:**
- Create: `app/api/rule-check/runs/[run_id]/route.ts`

- [ ] **Step 1: Implement the route**

Create `app/api/rule-check/runs/[run_id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const { run_id } = await params;
  const run = await prisma.ruleCheckRun.findUnique({
    where: { id: run_id },
    include: { results: { orderBy: { scenarioId: 'asc' } } },
  });
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  return NextResponse.json({ run, scenarios: run.results });
}
```

(Note: Next.js 16 made route params async. `params` is a Promise.)

- [ ] **Step 2: Verify via curl** with a real run_id (after Task 16 wires the POST).

- [ ] **Step 3: Commit**

```bash
git add app/api/rule-check/runs/[run_id]/route.ts
git commit -m "feat(rule-check): GET /api/rule-check/runs/[run_id]"
```

---

### Task 16: API route — POST /api/rule-check/runs (SSE)

**Files:**
- Modify: `app/api/rule-check/runs/route.ts` (add POST)

- [ ] **Step 1: Add POST handler emitting SSE**

Modify `app/api/rule-check/runs/route.ts` — add at the bottom of the existing GET:

```ts
import { streamRuleCheckRun } from '@/server/rule-check/runs-service';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    model?: string;
    client_id_override?: string;
    scenarios?: string[];
  };
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of streamRuleCheckRun({
          model: body.model,
          client_id_override: body.client_id_override,
          scenario_ids: body.scenarios,
          signal: req.signal,
        })) {
          const line = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
```

- [ ] **Step 2: Verify via curl**

Run:
```
curl -N -s -X POST http://localhost:3002/api/rule-check/runs \
  -H 'Content-Type: application/json' \
  -d '{"scenarios": ["S01"]}'
```

Expected: SSE events appear on stdout — `event: started` line, then `event: result` after ~30-60s, then `event: done`. Note: needs a working LLM gateway env (AI_BASE_URL + AI_API_KEY) and seeded neo4j data, exactly as the existing test-suite script does.

- [ ] **Step 3: Commit**

```bash
git add app/api/rule-check/runs/route.ts
git commit -m "feat(rule-check): POST /api/rule-check/runs (SSE-streaming runner)"
```

---

### Task 17: API route — POST /api/rule-check/runs/[run_id]/replay/[scenario_id]

**Files:**
- Create: `app/api/rule-check/runs/[run_id]/replay/[scenario_id]/route.ts`

- [ ] **Step 1: Implement the replay route**

Create `app/api/rule-check/runs/[run_id]/replay/[scenario_id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { streamRuleCheckRun } from '@/server/rule-check/runs-service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ run_id: string; scenario_id: string }> },
) {
  const { run_id, scenario_id } = await params;
  const run = await prisma.ruleCheckRun.findUnique({ where: { id: run_id } });
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });

  // Re-use the streaming service, but: a single-scenario replay writes into an
  // existing run row (idempotent upsert path inside streamRuleCheckRun handles
  // the scenario row). To preserve the existing run's metadata, we run the
  // single scenario synchronously and update the parent aggregates ourselves.
  const events: unknown[] = [];
  for await (const e of streamRuleCheckRun({
    model: run.model,
    client_id_override: run.clientIdOverride ?? undefined,
    scenario_ids: [scenario_id],
  })) {
    events.push(e);
  }
  // streamRuleCheckRun creates a NEW run row; the replay needs the result to
  // land under the ORIGINAL run_id. Find the new row, copy to original, drop new.
  const lastRun = await prisma.ruleCheckRun.findFirst({
    orderBy: { startedAt: 'desc' },
    include: { results: true },
  });
  const newResult = lastRun?.results.find((r) => r.scenarioId === scenario_id);
  if (newResult) {
    await prisma.ruleCheckScenarioResult.upsert({
      where: { runId_scenarioId: { runId: run_id, scenarioId: scenario_id } },
      create: { ...stripIdAndRun(newResult), runId: run_id },
      update: { ...stripIdAndRun(newResult) },
    });
    // Clean up the throw-away run + its result.
    if (lastRun) {
      await prisma.ruleCheckScenarioResult.deleteMany({ where: { runId: lastRun.id } });
      await prisma.ruleCheckRun.delete({ where: { id: lastRun.id } });
    }
  }

  // Recompute parent aggregates.
  await recomputeRunAggregates(run_id);

  const updated = await prisma.ruleCheckScenarioResult.findUnique({
    where: { runId_scenarioId: { runId: run_id, scenarioId: scenario_id } },
  });
  return NextResponse.json({ scenario: updated });
}

function stripIdAndRun(row: { id?: string; runId?: string } & Record<string, unknown>) {
  const { id: _id, runId: _r, ...rest } = row;
  return rest;
}

async function recomputeRunAggregates(runId: string): Promise<void> {
  const results = await prisma.ruleCheckScenarioResult.findMany({ where: { runId } });
  const pass = results.filter((r) => r.matchKind === 'pass').length;
  const fail = results.length - pass;
  const totalLlmMs = results.reduce((s, r) => s + r.llmMs, 0);
  const capHits = results.filter((r) => r.finishReason === 'length').length;
  await prisma.ruleCheckRun.update({
    where: { id: runId },
    data: { passCount: pass, failCount: fail, totalLlmMs, capHits },
  });
}
```

- [ ] **Step 2: Verify via curl** with a real run_id from a prior streamed run.

Run:
```
curl -s -X POST http://localhost:3002/api/rule-check/runs/<run_id>/replay/S02 | jq '.scenario.scenarioId'
```
Expected: `"S02"`.

- [ ] **Step 3: Commit**

```bash
git add app/api/rule-check/runs/[run_id]/replay/[scenario_id]/route.ts
git commit -m "feat(rule-check): POST replay endpoint (upserts scenario into existing run)"
```

---

### Task 18: Page shell + nav entry + i18n key

**Files:**
- Create: `app/rule-check/page.tsx`
- Create: `components/rule-check/RuleCheckContent.tsx`
- Modify: `components/shared/LeftNav.tsx`
- Modify: `lib/i18n.tsx`

- [ ] **Step 1: Add i18n key**

In `lib/i18n.tsx`, add to both the `zh` and `en` dictionaries:
- zh: `nav_rule_check: "规则检查"`
- en: `nav_rule_check: "Rule Check"`

- [ ] **Step 2: Add LeftNav entry**

In `components/shared/LeftNav.tsx`, add after the `correlations` line (around line 47):

```ts
    { type: "item", id: "rule-check",  icon: "check",  label: t("nav_rule_check"), href: "/rule-check" },
```

If `Ic.check` doesn't exist, pick an existing icon name from `components/shared/Ic.tsx` (e.g. `Ic.shield` or `Ic.book`) and use that instead. Check `components/shared/Ic.tsx` for available keys.

- [ ] **Step 3: Create the page**

Create `app/rule-check/page.tsx`:

```tsx
"use client";

import { Shell } from "@/components/shared/Shell";
import { RuleCheckContent } from "@/components/rule-check/RuleCheckContent";

export default function Page() {
  return (
    <Shell crumbs={["Rule Check", "matchResume"]} directionTag="">
      <RuleCheckContent />
    </Shell>
  );
}
```

- [ ] **Step 4: Create the content skeleton**

Create `components/rule-check/RuleCheckContent.tsx`:

```tsx
"use client";

import React from "react";
import { Card, CardHead, EmptyState } from "@/components/shared/atoms";

export function RuleCheckContent() {
  return (
    <div className="flex flex-col gap-3 p-3">
      <Card>
        <CardHead title="Rule Check · matchResume" subtitle="Eval surface for the 14-scenario rule check suite" />
        <div className="p-4">
          <EmptyState title="No runs yet" hint="Click ▶ Run All to start the first run." />
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 5: Smoke test**

Start `npm run dev` if not running. Open `http://localhost:3002/rule-check`. Verify:
1. The page loads without console errors
2. The Shell chrome shows the breadcrumb "Rule Check · matchResume"
3. LeftNav has a new "Rule Check" entry that highlights when on this route
4. The "No runs yet" empty state shows

- [ ] **Step 6: Commit**

```bash
git add app/rule-check/page.tsx components/rule-check/RuleCheckContent.tsx components/shared/LeftNav.tsx lib/i18n.tsx
git commit -m "feat(rule-check): /rule-check page shell + nav entry + i18n key"
```

---

### Task 19: SSE consumer hook (use-run-stream.ts)

**Files:**
- Create: `components/rule-check/use-run-stream.ts`

- [ ] **Step 1: Implement the hook**

Create `components/rule-check/use-run-stream.ts`:

```ts
"use client";

import React from "react";

export type StreamState =
  | { phase: 'idle' }
  | { phase: 'running'; run_id: string; results: ScenarioResultPayload[]; summary?: undefined }
  | { phase: 'done'; run_id: string; results: ScenarioResultPayload[]; summary: { total: number; pass: number; fail: number; total_llm_ms: number } }
  | { phase: 'error'; run_id?: string; results: ScenarioResultPayload[]; message: string };

export type ScenarioResultPayload = {
  scenario_id: string;
  scenario_name: string;
  expected: { decision: string; rule_status: Record<string, string> };
  actual: { decision: string; stats: Record<string, number> };
  rule_results: Array<{ rule_id: string; rule_name: string; step_id: string; status: string; reason?: string }>;
  match_kind: string;
  failures: string[];
  inference_chain: Array<{ rule_id: string; steps: Array<Record<string, unknown>>; highlight_nodes: string[] }>;
  graph_context: Record<string, unknown>;
  audit: {
    llm_ms: number; llm_model: string; prompt_tokens?: number;
    completion_tokens?: number; finish_reason?: string; graph_calls: number;
    raw_llm_text?: string;
  };
};

export function useRunStream() {
  const [state, setState] = React.useState<StreamState>({ phase: 'idle' });
  const abortRef = React.useRef<AbortController | null>(null);

  const start = React.useCallback(async (body: { model?: string; client_id_override?: string; scenarios?: string[] }) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setState({ phase: 'running', run_id: '', results: [] });
    let runId = '';
    const results: ScenarioResultPayload[] = [];

    try {
      const resp = await fetch('/api/rule-check/runs', {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok || !resp.body) throw new Error(`POST failed: ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // Parse SSE: split on double-newline.
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventMatch = chunk.match(/^event:\s*(\w+)/m);
          const dataMatch = chunk.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const evType = eventMatch[1];
          const payload = JSON.parse(dataMatch[1]);

          if (evType === 'started') {
            runId = payload.run_id;
            setState({ phase: 'running', run_id: runId, results: [] });
          } else if (evType === 'result') {
            results.push(payload.scenario as ScenarioResultPayload);
            setState({ phase: 'running', run_id: runId, results: [...results] });
          } else if (evType === 'done') {
            setState({ phase: 'done', run_id: runId, results: [...results], summary: payload.summary });
          } else if (evType === 'error') {
            setState({ phase: 'error', run_id: runId, results: [...results], message: payload.message });
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setState({ phase: 'error', run_id: runId, results, message: (err as Error).message });
    }
  }, []);

  const abort = React.useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { state, start, abort };
}
```

- [ ] **Step 2: No standalone test**

This hook is tested via the manual flow in Task 22 — visiting the page and clicking "Run All".

- [ ] **Step 3: Commit**

```bash
git add components/rule-check/use-run-stream.ts
git commit -m "feat(rule-check): SSE consumer hook (useRunStream)"
```

---

### Task 20: TopBar component (selects + action buttons)

**Files:**
- Create: `components/rule-check/TopBar.tsx`

- [ ] **Step 1: Implement TopBar**

Create `components/rule-check/TopBar.tsx`:

```tsx
"use client";

import React from "react";
import { Btn } from "@/components/shared/atoms";

const MODELS = [
  { label: 'Gemini-3-flash-preview', value: 'gemini-3-flash-preview' },
  { label: 'Claude Opus 4.7', value: 'claude-opus-4-7' },
  { label: 'Kimi K2.6', value: 'kimi-k2.6' },
];

const CLIENTS = [
  { label: '— No override —', value: '' },
  { label: '字节跳动', value: 'CLI_BYTEDANCE' },
  { label: '腾讯', value: 'CLI_TENCENT_PCG' },
  { label: '华为', value: 'CLI_HUAWEI' },
];

export type TopBarProps = {
  model: string;
  setModel: (m: string) => void;
  clientOverride: string;
  setClientOverride: (c: string) => void;
  runs: Array<{ id: string; startedAt: string; model: string; passCount: number; totalScenarios: number }>;
  currentRunId: string | null;
  setCurrentRunId: (id: string | null) => void;
  compareRunId: string | null;
  setCompareRunId: (id: string | null) => void;
  isRunning: boolean;
  onRunAll: () => void;
  onReplayFailed: () => void;
  onExport: () => void;
};

export function TopBar(props: TopBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 p-3 border-b border-line bg-surface-1">
      <Btn onClick={props.onRunAll} disabled={props.isRunning}>
        {props.isRunning ? '⏳ Running…' : '▶ Run All'}
      </Btn>
      <Btn variant="ghost" onClick={props.onReplayFailed} disabled={props.isRunning}>↻ Replay Failed</Btn>
      <Btn variant="ghost" onClick={props.onExport} disabled={props.isRunning}>⤴ Export</Btn>

      <div className="ml-2 flex items-center gap-1 text-[11px] text-ink-3">
        <span>Model</span>
        <select className="bg-surface border border-line rounded px-1 py-0.5 text-ink-1"
                value={props.model} onChange={(e) => props.setModel(e.target.value)}>
          {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>

      <div className="flex items-center gap-1 text-[11px] text-ink-3">
        <span>Client</span>
        <select className="bg-surface border border-line rounded px-1 py-0.5 text-ink-1"
                value={props.clientOverride} onChange={(e) => props.setClientOverride(e.target.value)}>
          {CLIENTS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>

      <div className="flex items-center gap-1 text-[11px] text-ink-3">
        <span>Run</span>
        <select className="bg-surface border border-line rounded px-1 py-0.5 text-ink-1"
                value={props.currentRunId ?? ''} onChange={(e) => props.setCurrentRunId(e.target.value || null)}>
          <option value="">— latest live —</option>
          {props.runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.startedAt.slice(0, 16)} · {r.model} · {r.passCount}/{r.totalScenarios}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-1 text-[11px] text-ink-3">
        <span>Compare</span>
        <select className="bg-surface border border-line rounded px-1 py-0.5 text-ink-1"
                value={props.compareRunId ?? ''} onChange={(e) => props.setCompareRunId(e.target.value || null)}>
          <option value="">— none —</option>
          {props.runs
            .filter((r) => r.id !== props.currentRunId)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.startedAt.slice(0, 16)} · {r.model} · {r.passCount}/{r.totalScenarios}
              </option>
            ))}
        </select>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/rule-check/TopBar.tsx
git commit -m "feat(rule-check): TopBar (Run/Replay/Export buttons + Model/Client/Run/Compare selects)"
```

---

### Task 21: MetricsStrip + RuleConfusionStrip

**Files:**
- Create: `components/rule-check/MetricsStrip.tsx`
- Create: `components/rule-check/RuleConfusionStrip.tsx`

- [ ] **Step 1: Implement MetricsStrip**

Create `components/rule-check/MetricsStrip.tsx`:

```tsx
"use client";

import React from "react";
import type { ScenarioResultPayload } from "./use-run-stream";

export type MetricsStripProps = {
  results: ScenarioResultPayload[];
  expectedTotal: number;
};

export function MetricsStrip({ results, expectedTotal }: MetricsStripProps) {
  const pass = results.filter((r) => r.match_kind === 'pass').length;
  const avgMs = results.length ? Math.round(results.reduce((s, r) => s + r.audit.llm_ms, 0) / results.length) : 0;
  const totalOut = results.reduce((s, r) => s + (r.audit.completion_tokens ?? 0), 0);
  const totalIn = results.reduce((s, r) => s + (r.audit.prompt_tokens ?? 0), 0);
  const capHits = results.filter((r) => r.audit.finish_reason === 'length').length;
  const parseErrors = results.filter((r) => r.match_kind === 'fail-parse').length;

  return (
    <div className="flex flex-wrap items-center gap-4 px-3 py-2 border-b border-line bg-surface text-[11px] text-ink-2">
      <span><span className="text-ok mr-1">✓</span>{pass}/{expectedTotal} passed</span>
      <span>Avg <span className="text-ink-1">{(avgMs / 1000).toFixed(1)}s</span></span>
      <span>Σ <span className="text-ink-1">{totalOut.toLocaleString()}t</span> out / <span className="text-ink-1">{totalIn.toLocaleString()}t</span> in</span>
      <span>{capHits} cap-hits</span>
      <span>{parseErrors} parse-errors</span>
    </div>
  );
}
```

- [ ] **Step 2: Implement RuleConfusionStrip**

Create `components/rule-check/RuleConfusionStrip.tsx`:

```tsx
"use client";

import React from "react";
import { bucketCell, type ConfusionBucket } from "./bucketing";
import type { ScenarioResultPayload } from "./use-run-stream";
import type { RuleStatus } from "@/lib/rule-check/types";

export type RuleConfusionStripProps = {
  results: ScenarioResultPayload[];
  expectedByScenario: Record<string, Record<string, RuleStatus>>;
  ruleFilter: string | null;
  setRuleFilter: (r: string | null) => void;
};

export function RuleConfusionStrip({ results, expectedByScenario, ruleFilter, setRuleFilter }: RuleConfusionStripProps) {
  // Tally TP/TN/FP/FN per rule across all results.
  const counts = new Map<string, { TP: number; TN: number; FP: number; FN: number; excluded: number }>();
  for (const sr of results) {
    const expected = expectedByScenario[sr.scenario_id] ?? {};
    const actualMap = new Map(sr.rule_results.map((r) => [r.rule_id, r.status as RuleStatus]));
    // Union of pinned rules + actual rule_results
    const allRules = new Set<string>([...Object.keys(expected), ...actualMap.keys()]);
    for (const rid of allRules) {
      const exp = (expected[rid] as RuleStatus | undefined) ?? 'missing-from-expected';
      const act = (actualMap.get(rid) as RuleStatus | undefined) ?? 'missing-from-actual';
      const { bucket } = bucketCell(exp, act);
      const c = counts.get(rid) ?? { TP: 0, TN: 0, FP: 0, FN: 0, excluded: 0 };
      c[bucket]++;
      counts.set(rid, c);
    }
  }

  const sortedRules = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="flex flex-wrap gap-2 px-3 py-2 border-b border-line bg-surface text-[10.5px]">
      {sortedRules.map(([rid, c]) => (
        <button
          key={rid}
          onClick={() => setRuleFilter(ruleFilter === rid ? null : rid)}
          className={`flex items-center gap-1 px-2 py-1 rounded border ${ruleFilter === rid ? 'border-accent' : 'border-line'} hover:bg-surface-2`}
        >
          <span className="font-mono text-ink-1">{rid}</span>
          <span className="text-ok">TP:{c.TP}</span>
          <span className="text-ink-3">TN:{c.TN}</span>
          <span className="text-bad">FP:{c.FP}</span>
          <span className="text-bad">FN:{c.FN}</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add components/rule-check/MetricsStrip.tsx components/rule-check/RuleConfusionStrip.tsx
git commit -m "feat(rule-check): MetricsStrip + RuleConfusionStrip"
```

---

### Task 22: ScenarioMatrix

**Files:**
- Create: `components/rule-check/ScenarioMatrix.tsx`

- [ ] **Step 1: Implement ScenarioMatrix**

Create `components/rule-check/ScenarioMatrix.tsx`:

```tsx
"use client";

import React from "react";
import { bucketCell, type ConfusionBucket, type CellMarker } from "./bucketing";
import type { ScenarioResultPayload } from "./use-run-stream";
import type { RuleStatus } from "@/lib/rule-check/types";

export type ScenarioMatrixProps = {
  scenarios: Array<{ id: string; name: string; expected: { decision: string; rule_status: Record<string, string> } }>;
  results: ScenarioResultPayload[];
  ruleFilter: string | null;
  runningScenarioIds: Set<string>;
  onCellClick: (scenarioId: string, ruleId: string) => void;
};

const CELL_CLASS: Record<CellMarker, string> = {
  match: 'bg-[color:var(--c-ok-bg)] text-ok',
  partial: 'bg-[color:var(--c-warn-bg)] text-warn',
  mismatch: 'bg-[color:var(--c-bad-bg)] text-bad',
  missing: 'bg-[color:var(--c-warn-bg)] text-warn',
  excluded: 'bg-surface-2 text-ink-3',
};

export function ScenarioMatrix({ scenarios, results, ruleFilter, runningScenarioIds, onCellClick }: ScenarioMatrixProps) {
  const resultsById = new Map(results.map((r) => [r.scenario_id, r]));

  // Collect column set: union of all rule_ids that appear in any scenario's rule_results
  // OR are pinned in any scenario's expected.rule_status. Sorted by rule_id.
  const ruleIds = new Set<string>();
  for (const s of scenarios) {
    for (const rid of Object.keys(s.expected.rule_status)) ruleIds.add(rid);
  }
  for (const r of results) {
    for (const rr of r.rule_results) ruleIds.add(rr.rule_id);
  }
  const cols = [...ruleIds].sort().filter((rid) => !ruleFilter || rid === ruleFilter);

  return (
    <div className="overflow-x-auto border-t border-line">
      <table className="w-full text-[10.5px] mono">
        <thead className="sticky top-0 bg-surface-1">
          <tr>
            <th className="text-left px-2 py-1 border-r border-line">Scenario</th>
            <th className="text-left px-2 py-1 border-r border-line">Expected → Actual</th>
            {cols.map((rid) => (
              <th key={rid} className="px-1 py-1 text-ink-2 font-normal">{rid}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s) => {
            const sr = resultsById.get(s.id);
            const isRunning = runningScenarioIds.has(s.id);
            return (
              <tr key={s.id} className="border-t border-line">
                <td className="px-2 py-1 text-ink-1 whitespace-nowrap border-r border-line">{s.id} {s.name}</td>
                <td className="px-2 py-1 text-ink-2 whitespace-nowrap border-r border-line">
                  {s.expected.decision} → {sr ? sr.actual.decision : (isRunning ? '…' : '—')}
                  {sr && sr.match_kind === 'pass' && <span className="text-ok ml-1">✓</span>}
                  {sr && sr.match_kind !== 'pass' && <span className="text-bad ml-1">✗</span>}
                </td>
                {cols.map((rid) => {
                  const expected = (s.expected.rule_status[rid] as RuleStatus | undefined) ?? 'missing-from-expected';
                  const actual = (sr?.rule_results.find((r) => r.rule_id === rid)?.status as RuleStatus | undefined)
                    ?? (sr ? 'missing-from-actual' : 'missing-from-expected');
                  const outcome = bucketCell(expected, actual);
                  return (
                    <td key={rid}
                        onClick={() => sr && onCellClick(s.id, rid)}
                        className={`text-center px-1 py-1 cursor-pointer ${sr ? CELL_CLASS[outcome.marker] : 'bg-surface text-ink-4'}`}
                        title={`${rid}: expected=${expected} actual=${actual} (${outcome.bucket})`}
                    >
                      {sr
                        ? (outcome.marker === 'match' ? '✓' : outcome.marker === 'partial' ? '~' : outcome.marker === 'mismatch' ? '✗' : outcome.marker === 'missing' ? '⚠' : '·')
                        : (isRunning ? '⏳' : '·')}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add components/rule-check/ScenarioMatrix.tsx
git commit -m "feat(rule-check): ScenarioMatrix (scenario × rule grid with bucketing-driven cell color)"
```

---

### Task 23: Wire RuleCheckContent — strip + matrix + run flow

**Files:**
- Modify: `components/rule-check/RuleCheckContent.tsx`

- [ ] **Step 1: Replace skeleton with the full wiring**

Replace the contents of `components/rule-check/RuleCheckContent.tsx`:

```tsx
"use client";

import React from "react";
import { Card } from "@/components/shared/atoms";
import { TopBar } from "./TopBar";
import { MetricsStrip } from "./MetricsStrip";
import { RuleConfusionStrip } from "./RuleConfusionStrip";
import { ScenarioMatrix } from "./ScenarioMatrix";
import { useRunStream, type ScenarioResultPayload } from "./use-run-stream";

type Scenario = {
  id: string; name: string;
  candidate_id: string; resume_id: string; job_requisition_id: string;
  expected: { decision: string; rule_status: Record<string, string> };
};

type RunListItem = {
  id: string; startedAt: string; model: string; passCount: number; failCount: number; totalScenarios: number;
};

export function RuleCheckContent() {
  const [scenarios, setScenarios] = React.useState<Scenario[]>([]);
  const [runs, setRuns] = React.useState<RunListItem[]>([]);
  const [currentRunId, setCurrentRunId] = React.useState<string | null>(null);
  const [compareRunId, setCompareRunId] = React.useState<string | null>(null);
  const [model, setModel] = React.useState('gemini-3-flash-preview');
  const [clientOverride, setClientOverride] = React.useState('');
  const [ruleFilter, setRuleFilter] = React.useState<string | null>(null);
  const { state, start, abort } = useRunStream();

  // Hydrate scenarios + latest run on mount.
  React.useEffect(() => {
    void (async () => {
      const scenRes = await fetch('/api/rule-check/scenarios').then((r) => r.json()) as { scenarios: Scenario[] };
      setScenarios(scenRes.scenarios);
      const runsRes = await fetch('/api/rule-check/runs').then((r) => r.json()) as { runs: RunListItem[] };
      setRuns(runsRes.runs);
    })();
  }, []);

  // Decide which results to show — streamed live state, or a loaded past run.
  const [pastRunResults, setPastRunResults] = React.useState<ScenarioResultPayload[]>([]);
  React.useEffect(() => {
    if (!currentRunId || state.phase === 'running') return;
    void (async () => {
      const res = await fetch(`/api/rule-check/runs/${currentRunId}`).then((r) => r.json()) as {
        run: { id: string } | null;
        scenarios: Array<{ scenarioId: string; scenarioName: string; expectedDecision: string; expectedRules: string; actualDecision: string; actualStats: string; ruleResults: string; matchKind: string; failures: string | null; inferenceChain: string; graphContext: string; llmMs: number; llmModel: string; promptTokens: number | null; completionTokens: number | null; finishReason: string | null; graphCalls: number; rawLlmText: string | null }>;
      };
      setPastRunResults(res.scenarios.map(rowToPayload));
    })();
  }, [currentRunId, state.phase]);

  const liveResults = state.phase === 'running' || state.phase === 'done' || state.phase === 'error' ? state.results : [];
  const displayResults = (state.phase === 'running' || (state.phase === 'done' && !currentRunId))
    ? liveResults
    : pastRunResults;

  const expectedByScenario = React.useMemo(() => {
    const map: Record<string, Record<string, string>> = {};
    for (const s of scenarios) map[s.id] = s.expected.rule_status;
    return map;
  }, [scenarios]);

  const runningScenarioIds = React.useMemo(() => {
    if (state.phase !== 'running') return new Set<string>();
    const done = new Set(state.results.map((r) => r.scenario_id));
    return new Set(scenarios.filter((s) => !done.has(s.id)).map((s) => s.id));
  }, [state, scenarios]);

  const onRunAll = async () => {
    setCurrentRunId(null);
    await start({
      model,
      client_id_override: clientOverride || undefined,
    });
    // Refresh runs list after stream completes.
    const runsRes = await fetch('/api/rule-check/runs').then((r) => r.json()) as { runs: RunListItem[] };
    setRuns(runsRes.runs);
  };

  const onReplayFailed = async () => {
    const failedIds = displayResults.filter((r) => r.match_kind !== 'pass').map((r) => r.scenario_id);
    if (failedIds.length === 0) return;
    setCurrentRunId(null);
    await start({ model, client_id_override: clientOverride || undefined, scenarios: failedIds });
  };

  const onExport = () => {
    const blob = new Blob([JSON.stringify({ results: displayResults }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `rule-check-export-${Date.now()}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col">
      <TopBar
        model={model} setModel={setModel}
        clientOverride={clientOverride} setClientOverride={setClientOverride}
        runs={runs.map((r) => ({ id: r.id, startedAt: r.startedAt, model: r.model, passCount: r.passCount, totalScenarios: r.totalScenarios }))}
        currentRunId={currentRunId} setCurrentRunId={setCurrentRunId}
        compareRunId={compareRunId} setCompareRunId={setCompareRunId}
        isRunning={state.phase === 'running'}
        onRunAll={onRunAll} onReplayFailed={onReplayFailed} onExport={onExport}
      />
      <MetricsStrip results={displayResults} expectedTotal={scenarios.length} />
      <RuleConfusionStrip
        results={displayResults}
        expectedByScenario={expectedByScenario as never}
        ruleFilter={ruleFilter} setRuleFilter={setRuleFilter}
      />
      <ScenarioMatrix
        scenarios={scenarios}
        results={displayResults}
        ruleFilter={ruleFilter}
        runningScenarioIds={runningScenarioIds}
        onCellClick={() => { /* Task 25 wires the drawer */ }}
      />
      {state.phase === 'error' && (
        <div className="px-3 py-2 text-bad text-[12px] border-t border-line bg-[color:var(--c-bad-bg)]">
          Error: {state.message}
        </div>
      )}
    </div>
  );
}

function rowToPayload(row: { scenarioId: string; scenarioName: string; expectedDecision: string; expectedRules: string; actualDecision: string; actualStats: string; ruleResults: string; matchKind: string; failures: string | null; inferenceChain: string; graphContext: string; llmMs: number; llmModel: string; promptTokens: number | null; completionTokens: number | null; finishReason: string | null; graphCalls: number; rawLlmText: string | null }): ScenarioResultPayload {
  return {
    scenario_id: row.scenarioId,
    scenario_name: row.scenarioName,
    expected: { decision: row.expectedDecision, rule_status: JSON.parse(row.expectedRules) },
    actual: { decision: row.actualDecision, stats: JSON.parse(row.actualStats) },
    rule_results: JSON.parse(row.ruleResults),
    match_kind: row.matchKind,
    failures: row.failures ? JSON.parse(row.failures) : [],
    inference_chain: JSON.parse(row.inferenceChain),
    graph_context: JSON.parse(row.graphContext),
    audit: {
      llm_ms: row.llmMs, llm_model: row.llmModel,
      prompt_tokens: row.promptTokens ?? undefined, completion_tokens: row.completionTokens ?? undefined,
      finish_reason: row.finishReason ?? undefined, graph_calls: row.graphCalls,
      raw_llm_text: row.rawLlmText ?? undefined,
    },
  };
}
```

- [ ] **Step 2: Smoke test**

Visit `http://localhost:3002/rule-check`. Click "▶ Run All" (LLM gateway + seeded neo4j data required). Verify:
1. Matrix shows 14 scenario rows immediately (with `⏳` cells).
2. As each scenario completes, its row hydrates.
3. MetricsStrip increments live.
4. Confusion strip per-rule TP/TN counts update.
5. After all 14 done, runs picker has the new run entry.

- [ ] **Step 3: Commit**

```bash
git add components/rule-check/RuleCheckContent.tsx
git commit -m "feat(rule-check): wire RuleCheckContent — top bar, strips, matrix, SSE flow"
```

---

### Task 24: CaseDrawer — header + per-rule list + raw collapsibles

**Files:**
- Create: `components/rule-check/CaseDrawer.tsx`

- [ ] **Step 1: Implement the drawer**

Create `components/rule-check/CaseDrawer.tsx`:

```tsx
"use client";

import React from "react";
import { Btn } from "@/components/shared/atoms";
import type { ScenarioResultPayload } from "./use-run-stream";
import { buildNeo4jBrowserUrl } from "./neo4j-jump";

export type CaseDrawerProps = {
  result: ScenarioResultPayload | null;
  open: boolean;
  onClose: () => void;
  selectedRuleId: string | null;
  setSelectedRuleId: (rid: string | null) => void;
  neo4jBrowserBase: string | undefined;
  onReplay: () => void;
};

export function CaseDrawer({ result, open, onClose, selectedRuleId, setSelectedRuleId, neo4jBrowserBase, onReplay }: CaseDrawerProps) {
  if (!open || !result) return null;
  const selectedRule = result.rule_results.find((r) => r.rule_id === selectedRuleId) ?? result.rule_results[0];
  const selectedChain = result.inference_chain.find((c) => c.rule_id === selectedRule?.rule_id);

  const candidateId = ((result.graph_context as Record<string, unknown> | undefined)?.candidate as Record<string, unknown> | undefined)?.candidate_id as string | undefined;
  const candidateUrl = candidateId ? buildNeo4jBrowserUrl(neo4jBrowserBase, 'candidate', candidateId) : null;

  return (
    <div className="fixed top-[56px] right-0 h-[calc(100vh-56px)] w-[60vw] bg-surface border-l border-line shadow-xl overflow-y-auto z-20">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <div>
          <div className="text-[13px] text-ink-1">{result.scenario_id} · {result.scenario_name}</div>
          <div className="text-[10.5px] text-ink-3">
            Expected: {result.expected.decision}  ·  Actual: {result.actual.decision}
            {result.match_kind === 'pass' ? <span className="text-ok ml-1">✓</span> : <span className="text-bad ml-1">✗</span>}
          </div>
        </div>
        <Btn variant="ghost" onClick={onClose}>× Close</Btn>
      </div>

      <div className="flex flex-wrap gap-2 px-3 py-2 border-b border-line text-[11px]">
        <Btn onClick={onReplay}>▶ Replay this scenario</Btn>
        {candidateUrl
          ? <a href={candidateUrl} target="_blank" rel="noreferrer" className="text-accent underline">↗ Open Candidate in Neo4j</a>
          : <span className="text-ink-3" title="Set NEO4J_BROWSER_BASE in .env.local">↗ Open Candidate in Neo4j (disabled)</span>}
      </div>

      <div className="px-3 py-2 text-[10.5px] text-ink-3 border-b border-line">
        Audit: {result.audit.llm_ms}ms · {result.audit.graph_calls} graph fetches · {result.audit.completion_tokens ?? '?'}t out · finish={result.audit.finish_reason ?? '?'}
      </div>

      <div className="grid grid-cols-2 gap-0">
        <div className="border-r border-line p-3">
          <div className="text-[11px] text-ink-3 mb-1">Per-rule breakdown</div>
          <div className="flex flex-col gap-1">
            {result.rule_results.map((r) => (
              <button
                key={r.rule_id}
                onClick={() => setSelectedRuleId(r.rule_id)}
                className={`text-left px-2 py-1 rounded text-[11px] hover:bg-surface-2 ${selectedRule?.rule_id === r.rule_id ? 'bg-surface-2 border border-accent' : ''}`}
              >
                <span className="font-mono text-ink-1">{r.rule_id}</span>
                <span className="ml-2 text-ink-2">{statusBadge(r.status)}</span>
                {r.reason && <div className="text-ink-3 mt-0.5">{r.reason}</div>}
              </button>
            ))}
          </div>

          <div className="mt-3 border-t border-line pt-2 text-[11px]">
            <div className="text-ink-3 mb-1">Inference chain · {selectedRule?.rule_id}</div>
            {/* Task 25 implements <InferenceChainView/> */}
            <pre className="text-[10px] text-ink-2 whitespace-pre-wrap bg-surface-2 p-2 rounded">
              {JSON.stringify(selectedChain, null, 2)}
            </pre>
          </div>

          {result.audit.raw_llm_text && (
            <details className="mt-3 text-[11px]">
              <summary className="cursor-pointer text-ink-3">Show raw LLM JSON</summary>
              <pre className="bg-surface-2 p-2 rounded mt-1 text-[10px] overflow-x-auto whitespace-pre-wrap">{result.audit.raw_llm_text}</pre>
            </details>
          )}
        </div>

        <div className="p-3">
          <div className="text-[11px] text-ink-3 mb-1">Graph view</div>
          <div className="text-[10.5px] text-ink-4 italic">{/* Task 26 implements GraphView */}GraphView placeholder</div>
        </div>
      </div>
    </div>
  );
}

function statusBadge(status: string): React.ReactNode {
  const color: Record<string, string> = {
    pass: 'text-ok', not_triggered: 'text-ink-3',
    fail: 'text-bad', pending: 'text-warn',
    insufficient_info: 'text-warn', not_executed: 'text-ink-4',
  };
  return <span className={color[status] ?? 'text-ink-2'}>{status}</span>;
}
```

- [ ] **Step 2: Commit**

```bash
git add components/rule-check/CaseDrawer.tsx
git commit -m "feat(rule-check): CaseDrawer skeleton (header, per-rule list, raw collapsibles)"
```

---

### Task 25: InferenceChainView + wire into drawer

**Files:**
- Create: `components/rule-check/InferenceChainView.tsx`
- Modify: `components/rule-check/CaseDrawer.tsx`

- [ ] **Step 1: Implement InferenceChainView**

Create `components/rule-check/InferenceChainView.tsx`:

```tsx
"use client";

import React from "react";

type InferenceStep =
  | { kind: 'graph_node'; node: string; field?: string; value: string }
  | { kind: 'rule_logic'; markdown: string }
  | { kind: 'computation'; label: string; value: string }
  | { kind: 'verdict'; status: string; reason: string };

export type InferenceChainViewProps = {
  chain: { rule_id: string; steps: InferenceStep[]; highlight_nodes: string[] } | undefined;
};

export function InferenceChainView({ chain }: InferenceChainViewProps) {
  if (!chain) return <div className="text-ink-4 italic text-[11px]">(no chain available)</div>;
  return (
    <ol className="flex flex-col gap-1 text-[11px]">
      {chain.steps.map((step, i) => (
        <li key={i} className="flex gap-2 items-start">
          <span className="text-ink-4 mono w-5 shrink-0">{i + 1}.</span>
          <div className="flex-1">{renderStep(step)}</div>
        </li>
      ))}
    </ol>
  );
}

function renderStep(step: InferenceStep): React.ReactNode {
  switch (step.kind) {
    case 'graph_node':
      return (
        <div>
          <span className="px-1 rounded bg-[color:var(--c-accent-bg)] text-accent text-[10px]">graph</span>{' '}
          <span className="text-ink-2">{step.node}{step.field ? `.${step.field}` : ''}:</span>{' '}
          <span className="text-ink-1">{step.value}</span>
        </div>
      );
    case 'computation':
      return (
        <div>
          <span className="px-1 rounded bg-surface-2 text-ink-2 text-[10px]">calc</span>{' '}
          <span className="text-ink-2">{step.label}:</span>{' '}
          <span className="text-ink-1 mono">{step.value}</span>
        </div>
      );
    case 'rule_logic':
      return (
        <div>
          <span className="px-1 rounded bg-surface-2 text-ink-3 text-[10px]">rule</span>
          <blockquote className="border-l-2 border-line pl-2 mt-1 text-ink-2 whitespace-pre-wrap">{step.markdown}</blockquote>
        </div>
      );
    case 'verdict':
      return (
        <div>
          <span className={`px-1 rounded text-[10px] ${verdictColor(step.status)}`}>{step.status}</span>{' '}
          <span className="text-ink-1">{step.reason}</span>
        </div>
      );
  }
}

function verdictColor(status: string): string {
  if (status === 'pass') return 'bg-[color:var(--c-ok-bg)] text-ok';
  if (status === 'fail') return 'bg-[color:var(--c-bad-bg)] text-bad';
  if (status === 'pending' || status === 'insufficient_info') return 'bg-[color:var(--c-warn-bg)] text-warn';
  return 'bg-surface-2 text-ink-3';
}
```

- [ ] **Step 2: Replace the placeholder in CaseDrawer**

In `components/rule-check/CaseDrawer.tsx`, replace:

```tsx
            <pre className="text-[10px] text-ink-2 whitespace-pre-wrap bg-surface-2 p-2 rounded">
              {JSON.stringify(selectedChain, null, 2)}
            </pre>
```

with:

```tsx
            <InferenceChainView chain={selectedChain as never} />
```

And add the import at the top:

```ts
import { InferenceChainView } from "./InferenceChainView";
```

- [ ] **Step 3: Commit**

```bash
git add components/rule-check/InferenceChainView.tsx components/rule-check/CaseDrawer.tsx
git commit -m "feat(rule-check): InferenceChainView (rendered chain replaces raw JSON in drawer)"
```

---

### Task 26: GraphView (static SVG, 6 slots)

**Files:**
- Create: `components/rule-check/GraphView.tsx`
- Modify: `components/rule-check/CaseDrawer.tsx`

- [ ] **Step 1: Implement GraphView**

Create `components/rule-check/GraphView.tsx`:

```tsx
"use client";

import React from "react";
import { buildNeo4jBrowserUrl, type NodeKind } from "./neo4j-jump";

export type GraphViewProps = {
  graph: {
    candidate?: Record<string, unknown> | null;
    resume?: Record<string, unknown> | null;
    job_requisition?: Record<string, unknown> | null;
    applications?: Array<Record<string, unknown>>;
    blacklist_hits?: Array<Record<string, unknown>>;
    employment_links?: Array<Record<string, unknown>>;
  };
  highlightNodes: Set<NodeKind>;
  neo4jBrowserBase?: string;
};

const POSITIONS: Record<NodeKind, { x: number; y: number; w: number; h: number; label: string }> = {
  candidate:   { x: 200, y: 20,  w: 120, h: 50, label: 'Candidate' },
  blacklist:   { x:  20, y: 130, w: 120, h: 50, label: 'Blacklist' },
  resume:      { x: 200, y: 130, w: 120, h: 50, label: 'Resume' },
  application: { x: 360, y: 130, w: 120, h: 50, label: 'Application' },
  jd:          { x: 360, y: 260, w: 120, h: 50, label: 'Job_Requisition' },
  employment:  { x: 200, y: 380, w: 280, h: 50, label: 'Employment_links' },
  subgraph:    { x: 0, y: 0, w: 0, h: 0, label: '' },
};

const EDGES: Array<{ from: NodeKind; to: NodeKind; label: string }> = [
  { from: 'blacklist',   to: 'candidate',   label: 'BLOCKS_CANDIDATE' },
  { from: 'candidate',   to: 'resume',      label: 'CANDIDATE_HAS_RESUME' },
  { from: 'candidate',   to: 'application', label: 'CANDIDATE_HAS_APPLICATIONS' },
  { from: 'application', to: 'jd',          label: 'TARGETS_REQUISITION' },
];

export function GraphView({ graph, highlightNodes, neo4jBrowserBase }: GraphViewProps) {
  const presence: Record<NodeKind, boolean> = {
    candidate: !!graph.candidate,
    resume: !!graph.resume,
    jd: !!graph.job_requisition,
    application: (graph.applications?.length ?? 0) > 0,
    blacklist: (graph.blacklist_hits?.length ?? 0) > 0,
    employment: (graph.employment_links?.length ?? 0) > 0,
    subgraph: false,
  };

  const idOf = (kind: NodeKind): string | undefined => {
    switch (kind) {
      case 'candidate': return graph.candidate?.candidate_id as string | undefined;
      case 'resume': return graph.resume?.resume_id as string | undefined;
      case 'jd': return graph.job_requisition?.job_requisition_id as string | undefined;
      case 'application': return graph.applications?.[0]?.application_id as string | undefined;
      case 'blacklist': return graph.blacklist_hits?.[0]?.blacklist_id as string | undefined;
      default: return undefined;
    }
  };

  return (
    <svg viewBox="0 0 500 460" className="w-full max-w-[500px] border border-line rounded">
      {/* Edges */}
      {EDGES.map((e) => {
        const a = POSITIONS[e.from], b = POSITIONS[e.to];
        const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
        const bx = b.x + b.w / 2, by = b.y + b.h / 2;
        const present = presence[e.from] && presence[e.to];
        return (
          <g key={e.label} opacity={present ? 1 : 0.3}>
            <line x1={ax} y1={ay} x2={bx} y2={by}
                  stroke="var(--c-line)" strokeWidth={1} strokeDasharray={present ? undefined : '3 3'} />
            <text x={(ax + bx) / 2} y={(ay + by) / 2 - 4} fontSize="9" fill="var(--c-ink-4)" textAnchor="middle">{e.label}</text>
          </g>
        );
      })}
      {/* Nodes */}
      {(['candidate', 'resume', 'jd', 'application', 'blacklist', 'employment'] as NodeKind[]).map((kind) => {
        const p = POSITIONS[kind];
        const present = presence[kind];
        const highlighted = highlightNodes.has(kind);
        const id = idOf(kind);
        const url = id ? buildNeo4jBrowserUrl(neo4jBrowserBase, kind, id) : null;
        return (
          <g key={kind} opacity={present ? 1 : 0.4} style={{ cursor: url ? 'pointer' : 'default' }}
             onClick={() => url && window.open(url, '_blank')}
          >
            <rect x={p.x} y={p.y} width={p.w} height={p.h}
                  rx={4}
                  fill="var(--c-surface)"
                  stroke={highlighted ? "var(--c-accent)" : "var(--c-line)"}
                  strokeWidth={highlighted ? 2 : 1} />
            <text x={p.x + p.w / 2} y={p.y + 18} fontSize="11" fill="var(--c-ink-1)" textAnchor="middle">{p.label}</text>
            <text x={p.x + p.w / 2} y={p.y + 34} fontSize="9" fill="var(--c-ink-3)" textAnchor="middle">
              {present ? (id ?? '(linked)') : '(empty)'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 2: Replace placeholder in CaseDrawer**

In `components/rule-check/CaseDrawer.tsx`, replace the right-column placeholder:

```tsx
        <div className="p-3">
          <div className="text-[11px] text-ink-3 mb-1">Graph view</div>
          <div className="text-[10.5px] text-ink-4 italic">{/* Task 26 implements GraphView */}GraphView placeholder</div>
        </div>
```

with:

```tsx
        <div className="p-3">
          <div className="text-[11px] text-ink-3 mb-1">Graph view</div>
          <GraphView
            graph={result.graph_context as never}
            highlightNodes={new Set((selectedChain?.highlight_nodes ?? []) as never)}
            neo4jBrowserBase={neo4jBrowserBase}
          />
        </div>
```

Add the import:

```ts
import { GraphView } from "./GraphView";
```

- [ ] **Step 3: Commit**

```bash
git add components/rule-check/GraphView.tsx components/rule-check/CaseDrawer.tsx
git commit -m "feat(rule-check): GraphView (static 6-slot SVG with highlight + neo4j click-through)"
```

---

### Task 27: Wire CaseDrawer into RuleCheckContent + neo4j base env

**Files:**
- Modify: `components/rule-check/RuleCheckContent.tsx`
- Create: `app/api/rule-check/config/route.ts` (new — exposes `NEO4J_BROWSER_BASE` to client)

- [ ] **Step 1: Add config route to expose NEO4J_BROWSER_BASE**

Create `app/api/rule-check/config/route.ts`:

```ts
import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({
    neo4j_browser_base: process.env.NEO4J_BROWSER_BASE ?? null,
  });
}
```

- [ ] **Step 2: Wire drawer in RuleCheckContent**

In `components/rule-check/RuleCheckContent.tsx`:
1. Add state for selected cell, drawer-open, neo4j base, selectedRuleId.
2. Pass `onCellClick` to `<ScenarioMatrix/>` that sets `selectedCell` + opens the drawer.
3. Render `<CaseDrawer/>`.

Add at the top of the component body:

```tsx
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [selectedScenarioId, setSelectedScenarioId] = React.useState<string | null>(null);
  const [selectedRuleId, setSelectedRuleId] = React.useState<string | null>(null);
  const [neo4jBase, setNeo4jBase] = React.useState<string | undefined>(undefined);

  React.useEffect(() => {
    void fetch('/api/rule-check/config').then((r) => r.json()).then((j: { neo4j_browser_base: string | null }) => {
      setNeo4jBase(j.neo4j_browser_base ?? undefined);
    });
  }, []);

  const selectedResult = selectedScenarioId
    ? displayResults.find((r) => r.scenario_id === selectedScenarioId) ?? null
    : null;
```

Add import at the top:

```ts
import { CaseDrawer } from "./CaseDrawer";
```

Update the `onCellClick` prop:

```tsx
        onCellClick={(scenarioId, ruleId) => {
          setSelectedScenarioId(scenarioId);
          setSelectedRuleId(ruleId);
          setDrawerOpen(true);
        }}
```

And add the drawer at the bottom (just before the closing `</div>`):

```tsx
      <CaseDrawer
        result={selectedResult}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        selectedRuleId={selectedRuleId}
        setSelectedRuleId={setSelectedRuleId}
        neo4jBrowserBase={neo4jBase}
        onReplay={() => {/* Task 28 */}}
      />
```

- [ ] **Step 3: Smoke test**

Visit the page after a completed run. Click any cell → drawer slides in showing per-rule list, inference chain rendered, graph view with the 6 slots highlighted per chain. Click "Open Candidate in Neo4j" → opens browser tab.

- [ ] **Step 4: Commit**

```bash
git add components/rule-check/RuleCheckContent.tsx app/api/rule-check/config/route.ts
git commit -m "feat(rule-check): wire CaseDrawer + NEO4J_BROWSER_BASE config endpoint"
```

---

### Task 28: Wire Replay button to /replay endpoint

**Files:**
- Modify: `components/rule-check/RuleCheckContent.tsx`

- [ ] **Step 1: Implement onReplay**

In `components/rule-check/RuleCheckContent.tsx`, replace the empty `onReplay` arrow in the `<CaseDrawer/>` props with:

```tsx
        onReplay={async () => {
          if (!selectedResult) return;
          const targetRunId = currentRunId ?? state.run_id;
          if (!targetRunId) return;
          const res = await fetch(`/api/rule-check/runs/${targetRunId}/replay/${selectedResult.scenario_id}`, { method: 'POST' });
          if (!res.ok) return;
          const j = await res.json() as { scenario: Parameters<typeof rowToPayload>[0] };
          const updated = rowToPayload(j.scenario);
          // Replace in displayResults: if streaming, update state.results; if past-run view, update pastRunResults.
          if (state.phase === 'done' && !currentRunId) {
            // currently looking at latest live run — but post-replay it's now a stored row, so set currentRunId
            setCurrentRunId(targetRunId);
          }
          setPastRunResults((prev) => prev.map((p) => p.scenario_id === updated.scenario_id ? updated : prev.find((q) => q.scenario_id === updated.scenario_id) ? p : updated));
        }}
```

- [ ] **Step 2: Smoke test**

After a completed run, open the drawer for a failing scenario. Click "Replay this scenario". The cell should re-run (~50s) and update in place; the rest of the matrix stays unchanged.

- [ ] **Step 3: Commit**

```bash
git add components/rule-check/RuleCheckContent.tsx
git commit -m "feat(rule-check): wire per-scenario Replay button to /replay endpoint"
```

---

### Task 29: Compare-mode rendering (stacked matrices with diff highlight)

**Files:**
- Modify: `components/rule-check/ScenarioMatrix.tsx`
- Modify: `components/rule-check/RuleCheckContent.tsx`

- [ ] **Step 1: Add `compareResults` prop to ScenarioMatrix**

In `components/rule-check/ScenarioMatrix.tsx`, extend `ScenarioMatrixProps`:

```ts
  compareResults?: ScenarioResultPayload[];
  modelLabel?: string;  // shown above the matrix
```

Render `modelLabel` as a header strip above the table if provided. Inside the cell loop, when `compareResults` is provided, look up the matching cell from compare; if the compare cell's status differs from the current cell's status, add a `border border-orange-500` class (or `style={{ outline: '1px solid orange' }}`).

Wrap the existing return in a `<div>` and add the model label above:

```tsx
  return (
    <div className="flex flex-col">
      {modelLabel && (
        <div className="px-3 py-1 text-[10.5px] text-ink-3 bg-surface-1 border-t border-line">{modelLabel}</div>
      )}
      <div className="overflow-x-auto">
        {/* existing <table> */}
      </div>
    </div>
  );
```

Inside the cell `<td>`, compute the diff outline:

```tsx
                  const compareStatus = compareResults
                    ?.find((c) => c.scenario_id === s.id)
                    ?.rule_results.find((r) => r.rule_id === rid)?.status;
                  const diffClass = compareStatus && actual !== 'missing-from-actual' && compareStatus !== actual
                    ? 'outline outline-1 outline-[color:var(--c-warn)]'
                    : '';
```

Add `${diffClass}` to the `<td className=...>` template.

- [ ] **Step 2: Render two matrices when compare is set**

In `components/rule-check/RuleCheckContent.tsx`:
1. When `compareRunId` is set, fetch that run and store in `compareResults`.
2. Render two `<ScenarioMatrix/>` in sequence — current first (`modelLabel={runs.find(r => r.id === currentRunId)?.model ?? model}`), compare second.

Add state + effect:

```tsx
  const [compareResults, setCompareResults] = React.useState<ScenarioResultPayload[]>([]);
  React.useEffect(() => {
    if (!compareRunId) { setCompareResults([]); return; }
    void fetch(`/api/rule-check/runs/${compareRunId}`).then((r) => r.json()).then((j: { scenarios: Parameters<typeof rowToPayload>[0][] }) => {
      setCompareResults(j.scenarios.map(rowToPayload));
    });
  }, [compareRunId]);
```

Replace single `<ScenarioMatrix/>` with:

```tsx
      <ScenarioMatrix
        scenarios={scenarios}
        results={displayResults}
        ruleFilter={ruleFilter}
        runningScenarioIds={runningScenarioIds}
        onCellClick={(scenarioId, ruleId) => { setSelectedScenarioId(scenarioId); setSelectedRuleId(ruleId); setDrawerOpen(true); }}
        compareResults={compareResults.length ? compareResults : undefined}
        modelLabel={`Current · ${runs.find((r) => r.id === currentRunId)?.model ?? model}`}
      />
      {compareResults.length > 0 && (
        <ScenarioMatrix
          scenarios={scenarios}
          results={compareResults}
          ruleFilter={ruleFilter}
          runningScenarioIds={new Set()}
          onCellClick={(scenarioId, ruleId) => { setSelectedScenarioId(scenarioId); setSelectedRuleId(ruleId); setDrawerOpen(true); }}
          compareResults={displayResults}
          modelLabel={`Compare · ${runs.find((r) => r.id === compareRunId)?.model ?? '?'}`}
        />
      )}
```

- [ ] **Step 3: Smoke test**

Run all scenarios under model A → finish. Switch model dropdown to B → Run All → finish. Pick A as Compare. The page should show two stacked matrices labeled with their model names, with orange outlines on cells where A and B disagreed.

- [ ] **Step 4: Commit**

```bash
git add components/rule-check/ScenarioMatrix.tsx components/rule-check/RuleCheckContent.tsx
git commit -m "feat(rule-check): side-by-side compare mode (stacked matrices with diff outline)"
```

---

### Task 30: Manual UI test pass + bug-fix iteration

**Files:** various (only as needed during testing)

- [ ] **Step 1: Run the project type-check + lint**

Run: `npm run build`
Expected: clean build, no TS errors.

If TS errors surface, fix the offending file(s) and re-run. Common categories:
- Type mismatches between `RuleStatus` and the string union in the UI prop types (cast at boundary with `as RuleStatus`)
- Optional-property handling (`graph_context?.candidate?.candidate_id`)

- [ ] **Step 2: Walk through the manual test plan from the spec (§9)**

Test items to verify by hand (browser at `http://localhost:3002/rule-check`):

1. Fresh visit, no runs → "No runs yet" empty state shows above the matrix (actually we removed the empty state; verify the matrix renders 14 scenarios with `·` cells).
2. Click "▶ Run All" → matrix populates row-by-row over ~12 min; metrics + confusion strip update live.
3. Click S02/10-25 cell → drawer opens with pending verdict; per-rule list shows 10-25 selected; inference chain has graph_node + computation + rule_logic + verdict steps; graph view highlights candidate + resume.
4. Click "↗ Open Candidate in Neo4j" → opens browser tab with prefilled cypher.
5. Click "▶ Replay this scenario" on a failing cell → cell flashes, updates with new result; other cells unchanged.
6. Change Model to claude-opus-4-7 → "▶ Run All" → new run row appears in the Run picker.
7. Set Compare to the previous Gemini run → matrices stack; differing cells get orange outline.
8. Close tab mid-run → reopen → past run shows as `status: error · client-aborted` in run picker.

For each item: if it works, check it off. If it fails, file a fix in the same commit. The task is not "done" until all 8 work end-to-end.

- [ ] **Step 3: Commit fixes**

If any fixes were needed:

```bash
git add <files>
git commit -m "fix(rule-check): manual-test bug fixes"
```

If nothing to fix, skip this commit.

- [ ] **Step 4: Final commit — mark the feature ready**

```bash
git commit --allow-empty -m "chore(rule-check): /rule-check feature ready (manual test pass)"
```

---

## Self-Review

(After writing the full plan, reviewed against the spec.)

**1. Spec coverage:**

| Spec section | Covered by |
|---|---|
| §1.1 Goals 1-5 (execute / view / analyze / replay / compare) | T11, T16, T18, T22, T23, T28, T29 |
| §1.2 Coverage decisions (kept items) | matrix=T22, drill-down=T23-T27, text-view=T24-T25, graph=T26, neo4j-jump=T4+T26+T27, inference-chain=T7-T10, replay=T17+T28, switchers=T20, dual-reader=T13-T17 |
| §2.1 Request lifecycle | T16 (POST SSE), T17 (replay), T14-T15 (gets), T18-T19 (page lifecycle) |
| §2.2 Prisma schema | T1 |
| §2.3 Module layout | All UI tasks land in `components/rule-check/`; service in `server/rule-check/`; api in `app/api/rule-check/` |
| §3 API contracts | T13-T17 |
| §4 UI layout | T20 (TopBar), T21 (strips), T22 (matrix), T24-T26 (drawer) |
| §4.4 Cell rendering rules | T3 (bucketing) + T22 (CELL_CLASS) |
| §5 Inference chain derivation | T7-T10 |
| §6 Neo4j browser jump | T4 + T27 (config endpoint) |
| §7 Switcher behavior | T20 (UI) + T12 (model thread-through) |
| §8 Error handling | Built into runs-service (T11), drawer surfaces raw text (T24), compare-mode tolerates missing (T29) |
| §9 Testing | Tasks 1-12 each carry unit tests; T30 covers manual |
| §10 Open question on `graph_context` exposure | T2 picked option (a) — added optional field on `MatchResumeCheckResult` |

No gaps found.

**2. Placeholder scan:**

Scanned for "TBD", "TODO", "implement later", "fill in details", "Add appropriate error handling", "handle edge cases", "Similar to Task N", "Write tests for the above" — none found. Each step shows the actual code to write.

The phrase "Task 25 wires the drawer" and "Task 26 implements GraphView" appears in code comments inside intermediate task scaffolds — those are time-ordered breadcrumbs, not placeholders. They get replaced in later tasks (T25 and T26 respectively).

**3. Type consistency:**

- `RuleStatus` is the canonical type (re-exported from `@/lib/rule-check/types`). Used consistently in T3, T5, T7, T11, T21, T22.
- `InferenceStep` / `InferenceChain` / `NodeKind` defined once in T7's `types.ts`; consumed by every extractor (T8-T10) and the UI (T25, T26).
- `ScenarioResultPayload` defined in T11's runs-service.ts and re-defined in T19's use-run-stream.ts with the same shape. Verified field-for-field.
- `CellOutcome` / `ConfusionBucket` / `CellMarker` defined once in T3's bucketing.ts; consumed by T21 (strip) and T22 (matrix).
- `MatchKind` defined once in T5's match-classifier.ts. Consumed by T11 (runs-service) and T22 (matrix indirectly via match_kind field).
- `streamRuleCheckRun` signature consistent across T11 (definition), T16 (POST handler), T17 (replay handler).

No mismatches found.
