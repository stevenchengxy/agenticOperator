# matchResume per-rule debug visibility + neo4j resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Augment `MatchResumeCheckResult` with `rule_results[]` (every rule, for debug), drop `RuleCheckInput.resume` (library fetches resume from neo4j via `candidate_id` as a new graph-context slot), and recompute `stats` from `rule_results` inside the runner instead of trusting the LLM.

**Architecture:** Five sequential TDD tasks scoped to `lib/rule-check/`. Bottom-up build order — types → graph-context → prompt → runner — so each commit compiles. The downstream `match-resume-agent.ts` is intentionally untouched; the `explanations` field stays populated as a derived view so the agent's reads continue to work.

**Tech Stack:** TypeScript 5, vitest 4 (happy-dom env, `globals: true`), Node ≥22 `fetch`, OpenAI Chat Completions tool-calling. Shared LLM gateway at `server/llm/gateway.ts → chatComplete`.

**Source spec:** `docs/superpowers/specs/2026-05-12-match-resume-per-rule-results-design.md`

**Branch:** `create-action-prompt`.

---

## File map

| Path | Status | Change |
|---|---|---|
| `lib/rule-check/types.ts` | MODIFIED (Task 1) | Add `RuleResult` type; add `rule_results: RuleResult[]` to `MatchResumeCheckResult`; mark `RuleCheckInput.resume` as `@deprecated` and optional |
| `lib/rule-check/index.ts` | MODIFIED (Task 1) | Re-export `RuleResult` |
| `lib/rule-check/graph-context.ts` | MODIFIED (Task 2) | Add `resume` slot via `listInstances("Resume", { candidate_id }).then(rows => rows[0] ?? null)` — sixth parallel fetch |
| `lib/rule-check/graph-context.test.ts` | MODIFIED (Task 2) | Update "five slots" → "six slots", `fetch_count=6`; add "resume slot null when no row" |
| `lib/rule-check/prompt.ts` | MODIFIED (Task 3) | Drop §2 resume rendering; add §3.2 resume slot under Graph context; rewrite §6 schema to emit `rule_results[]` (replacing `explanations[]` in LLM output) |
| `lib/rule-check/prompt.test.ts` | MODIFIED (Task 3) | Update GraphContext-section assertion to 6 slots; assert §6 says `rule_results`; add baseCtx.resume fixture |
| `lib/rule-check/runner.ts` | MODIFIED (Task 4) | Drop `projectResume(input.resume, ...)` call; replace `coerceExplanations` with `coerceRuleResults` + `deriveExplanations` + `statsFromResults`; strict 1:1 check on rule_results count; populate `rule_results` in result and in `failSafe` returns |
| `lib/rule-check/runner.test.ts` | MODIFIED (Task 4) | Rewrite all 7 mock LLM-response fixtures to emit `rule_results`; add 3 new tests (derivation, stats-recompute, count-mismatch) |

---

## Task 1: Add `RuleResult` type + `rule_results` field + deprecate `RuleCheckInput.resume`

**Files:**
- Modify: `lib/rule-check/types.ts`
- Modify: `lib/rule-check/index.ts`
- Modify: `lib/rule-check/runner.ts` (placeholder only — `rule_results: []` in the two return literals so the build stays green until Task 4 wires real data)

Mostly additive type changes — no test required. Verified via `tsc --noEmit` + `npm run build`.

- [ ] **Step 1: Edit `lib/rule-check/types.ts`**

Open `/Users/chenyang/projects/agenticOperator/lib/rule-check/types.ts`.

(A) Find the existing `RuleCheckInput` interface (looks like):

```ts
export interface RuleCheckInput {
  runtime_context: RuleCheckRuntimeContext;
  resume: Record<string, unknown>;
  job_requisition: Record<string, unknown> & { job_requisition_id: string };
  job_requisition_specification?: Record<string, unknown> | null;
  hsm_feedback?: Record<string, unknown> | null;
}
```

REPLACE the `resume:` line with:

```ts
  /** @deprecated Library now fetches resume from neo4j via candidate_id; this field is ignored. */
  resume?: Record<string, unknown>;
```

(B) Find the Phase 3 block (starts with `// ─── Phase 3: neo4j-aware matchResume check ───`). Inside that block, add a `RuleResult` type definition BEFORE the existing `RuleExplanation`:

```ts
export type RuleResult = {
  rule_id: string;
  rule_name: string;
  step_id: string;
  status: RuleStatus;
  /** Required when status ≠ 'pass' and ≠ 'not_triggered'. */
  reason?: string;
};
```

(C) Augment `MatchResumeCheckResult`. Find:

```ts
export type MatchResumeCheckResult = {
  decision: 'PASS' | 'FAIL' | 'REVIEW';
  stats: MatchResumeCheckStats;
  explanations: RuleExplanation[];
  audit: { ... };
};
```

Add a `rule_results` field BEFORE `explanations`:

```ts
export type MatchResumeCheckResult = {
  decision: 'PASS' | 'FAIL' | 'REVIEW';
  stats: MatchResumeCheckStats;
  /** Every evaluated rule's status, in Set + within-Set order. Use for debug; the runner derives `explanations` from this. */
  rule_results: RuleResult[];
  explanations: RuleExplanation[];
  audit: { ... };  // unchanged
};
```

- [ ] **Step 2: Update `lib/rule-check/index.ts`**

Open `/Users/chenyang/projects/agenticOperator/lib/rule-check/index.ts`. Add `RuleResult` to the existing type re-exports. The file should look like:

```ts
export { buildRuleCheckInput, runRuleCheck } from './runner';
export type {
  MatchResumeCheckResult,
  MatchResumeCheckStats,
  MatchResumeStepGroup,
  RuleCheckInput,
  RuleCheckRuntimeContext,
  RuleExplanation,
  RuleResult,
  RuleStatus,
  Severity,
} from './types';
```

(Add `RuleResult,` to the alphabetical list of type re-exports.)

- [ ] **Step 3: Add `rule_results: []` placeholder to `runner.ts` return literals**

Open `/Users/chenyang/projects/agenticOperator/lib/rule-check/runner.ts`. There are two object literals that build a `MatchResumeCheckResult`:

(A) Inside the `failSafe()` helper, find:

```ts
  return {
    decision: 'FAIL',
    stats: emptyStats(),
    explanations: [],
    audit: { ... },
  };
```

ADD `rule_results: []` between `stats` and `explanations`:

```ts
  return {
    decision: 'FAIL',
    stats: emptyStats(),
    rule_results: [],
    explanations: [],
    audit: { ... },
  };
```

(B) Inside the main `runRuleCheck()` success path, find the final `return { decision, stats, explanations, audit: {...} };` literal. ADD `rule_results: []` between `stats` and `explanations`:

```ts
  return {
    decision,
    stats,
    rule_results: [],
    explanations,
    audit: { ... },
  };
```

(These are temporary placeholders — Task 4 replaces them with real coerced data.)

- [ ] **Step 4: Verify tsc compiles cleanly**

```bash
npx tsc --noEmit 2>&1 | grep -E "lib/rule-check" || echo "no errors in lib/rule-check"
```

Expected: `no errors in lib/rule-check`. Pre-existing errors elsewhere (`server/em/publish.test.ts`) are out of scope.

- [ ] **Step 5: Run `npm test` to confirm runner tests still pass with the placeholder**

```bash
npx vitest run lib/rule-check/runner.test.ts
```

Expected: 8 passing — the existing tests assert `decision`, `stats`, `explanations`, `audit` shape, and don't depend on `rule_results` content yet (Task 4 will add tests that do).

- [ ] **Step 6: Commit**

```bash
git add lib/rule-check/types.ts lib/rule-check/index.ts lib/rule-check/runner.ts
git commit -m "$(cat <<'EOF'
feat(rule-check): add RuleResult type + rule_results field; deprecate RuleCheckInput.resume

Additive — RuleResult joins the Phase 3 type set, rule_results becomes a new
required field on MatchResumeCheckResult, and RuleCheckInput.resume gains
@deprecated + optional treatment. runner.ts gets a temporary rule_results: []
placeholder in its return literals so the build stays green; Task 4 wires real
coerced data.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: graph-context.ts — add `resume` slot

**Files:**
- Modify: `lib/rule-check/graph-context.ts`
- Modify: `lib/rule-check/graph-context.test.ts`

- [ ] **Step 1: Update the test fixtures and add failing tests**

Open `/Users/chenyang/projects/agenticOperator/lib/rule-check/graph-context.test.ts`.

(A) Find the test `'fetches all five slots in parallel'`. REPLACE its entire body so it asserts 6 slots:

```ts
  it('fetches all six slots in parallel', async () => {
    mGet.mockImplementation(async (label, _value) => {
      if (label === 'Candidate') return { candidate_id: 'C-1', name: '张三' };
      if (label === 'Job_Requisition') return { job_requisition_id: 'JR-1', title: 'BE' };
      return null;
    });
    mListInst.mockImplementation(async (label) => {
      if (label === 'Application') return [{ id: 'A-1' }];
      if (label === 'Blacklist') return [];
      if (label === 'Resume') return [{ resume_id: 'R-1', candidate_id: 'C-1', skills: ['java'] }];
      return [];
    });
    mListLinks.mockResolvedValueOnce([{ linkId: 'L-1', type: 'EMPLOYED_BY', toId: 'E-1' }]);

    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });

    expect(ctx.candidate).toEqual({ candidate_id: 'C-1', name: '张三' });
    expect(ctx.resume).toEqual({ resume_id: 'R-1', candidate_id: 'C-1', skills: ['java'] });
    expect(ctx.job_requisition).toEqual({ job_requisition_id: 'JR-1', title: 'BE' });
    expect(ctx.applications).toEqual([{ id: 'A-1' }]);
    expect(ctx.blacklist_hits).toEqual([]);
    expect(ctx.employment_links).toHaveLength(1);
    expect(ctx.fetch_count).toBe(6);
  });
```

(B) APPEND a new test as the LAST `it(...)` inside `describe('buildGraphContext', …)` block (before its closing `});`):

```ts
  it('resume slot is null when listInstances("Resume", ...) returns []', async () => {
    mGet.mockResolvedValue({ candidate_id: 'C-1' });
    mListInst.mockImplementation(async (label) => {
      if (label === 'Resume') return []; // no resume row for this candidate
      return [];
    });
    mListLinks.mockResolvedValue([]);

    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });
    expect(ctx.resume).toBeNull();
    expect(ctx.fetch_count).toBe(6); // still 6 fetches even when one returns null
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/rule-check/graph-context.test.ts
```

Expected: 2 failures — the "six slots" test fails because the current implementation doesn't have a `resume` slot; the new null-resume test fails for the same reason.

- [ ] **Step 3: Modify `lib/rule-check/graph-context.ts`**

Open `/Users/chenyang/projects/agenticOperator/lib/rule-check/graph-context.ts`.

(A) Add `resume` to the `GraphContext` interface. Find:

```ts
export interface GraphContext {
  candidate: Record<string, unknown> | null;
  job_requisition: Record<string, unknown> | null;
  applications: Array<Record<string, unknown>>;
  blacklist_hits: Array<Record<string, unknown>>;
  employment_links: Array<Record<string, unknown>>;
  /** Total HTTP calls made — accumulates across both the initial pre-fetch
   *  (5 calls) and any subsequent dispatcher calls. */
  fetch_count: number;
  _cache: Map<string, unknown>;
}
```

REPLACE with:

```ts
export interface GraphContext {
  candidate: Record<string, unknown> | null;
  /** First Resume row matched by listInstances('Resume', { candidate_id }); null when none. */
  resume: Record<string, unknown> | null;
  job_requisition: Record<string, unknown> | null;
  applications: Array<Record<string, unknown>>;
  blacklist_hits: Array<Record<string, unknown>>;
  employment_links: Array<Record<string, unknown>>;
  /** Total HTTP calls made — accumulates across both the initial pre-fetch
   *  (6 calls) and any subsequent dispatcher calls. */
  fetch_count: number;
  _cache: Map<string, unknown>;
}
```

(B) Inside `buildGraphContext`, ADD a new helper `tryListFirst` (place it next to `tryGet`, `tryList`, `tryLinks`):

```ts
  const tryListFirst = async (label: string, filters: Record<string, string>) => {
    counters.n += 1;
    const rows = await listInstances(label, filters);
    cache.set(listInstKey(label, filters), rows);
    return rows[0] ?? null;
  };
```

(C) Update the `Promise.all([...])` block. Find:

```ts
  const [candidate, job_requisition, applications, blacklist_hits, employment_links] =
    await Promise.all([
      tryGet('Candidate', args.candidate_id),
      tryGet('Job_Requisition', args.job_requisition_id),
      tryList('Application', { candidate_id: args.candidate_id }),
      tryList('Blacklist', { candidate_id: args.candidate_id }),
      tryLinks({ from: args.candidate_id, type: 'EMPLOYED_BY' }),
    ]);
```

REPLACE with (adds `resume` as the 2nd element):

```ts
  const [
    candidate,
    resume,
    job_requisition,
    applications,
    blacklist_hits,
    employment_links,
  ] = await Promise.all([
    tryGet('Candidate', args.candidate_id),
    tryListFirst('Resume', { candidate_id: args.candidate_id }),
    tryGet('Job_Requisition', args.job_requisition_id),
    tryList('Application', { candidate_id: args.candidate_id }),
    tryList('Blacklist', { candidate_id: args.candidate_id }),
    tryLinks({ from: args.candidate_id, type: 'EMPLOYED_BY' }),
  ]);
```

(D) Update the return statement. Find:

```ts
  return {
    candidate,
    job_requisition,
    applications,
    blacklist_hits,
    employment_links,
    fetch_count: counters.n,
    _cache: cache,
  };
```

REPLACE with:

```ts
  return {
    candidate,
    resume,
    job_requisition,
    applications,
    blacklist_hits,
    employment_links,
    fetch_count: counters.n,
    _cache: cache,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/rule-check/graph-context.test.ts
```

Expected: 9 passing (the two new/modified tests plus the 7 existing dispatcher tests).

- [ ] **Step 5: Commit**

```bash
git add lib/rule-check/graph-context.ts lib/rule-check/graph-context.test.ts
git commit -m "$(cat <<'EOF'
feat(rule-check): graph-context — add resume slot (6th parallel fetch)

buildGraphContext now also fans out listInstances('Resume', { candidate_id })
and exposes the first row (or null) on ctx.resume. The slot caches via the
same list-key as listInstances, so a tool-use list_instances call with the
same filter is a cache hit. fetch_count floor moves from 5 to 6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: prompt.ts — drop §2 resume, add §3.2 resume, rewrite §6 schema

**Files:**
- Modify: `lib/rule-check/prompt.ts`
- Modify: `lib/rule-check/prompt.test.ts`

- [ ] **Step 1: Update existing tests + add new ones**

Open `/Users/chenyang/projects/agenticOperator/lib/rule-check/prompt.test.ts`.

(A) Update the `baseCtx` fixture to include the new `resume` slot. Find:

```ts
const baseCtx: GraphContext = {
  candidate: { candidate_id: 'C-1', name: '张三' },
  job_requisition: { job_requisition_id: 'JR-1' },
  applications: [],
  blacklist_hits: [],
  employment_links: [],
  fetch_count: 5,
  _cache: new Map(),
};
```

REPLACE with:

```ts
const baseCtx: GraphContext = {
  candidate: { candidate_id: 'C-1', name: '张三' },
  resume: { resume_id: 'R-1', candidate_id: 'C-1', skills: ['java'] },
  job_requisition: { job_requisition_id: 'JR-1' },
  applications: [],
  blacklist_hits: [],
  employment_links: [],
  fetch_count: 6,
  _cache: new Map(),
};
```

(B) Update the test `'renders the GraphContext section with named slots'` to assert 6 subsections. REPLACE its body with:

```ts
  it('renders the GraphContext section with named slots', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('## 3. Graph context');
    expect(out).toContain('### 3.1 candidate');
    expect(out).toContain('### 3.2 resume');
    expect(out).toContain('### 3.3 job_requisition');
    expect(out).toContain('### 3.4 applications');
    expect(out).toContain('### 3.5 blacklist_hits');
    expect(out).toContain('### 3.6 employment_links');
  });
```

(C) Update the test `'emits null/[] for missing graph slots'` to also cover null resume. REPLACE its body with:

```ts
  it('emits null/[] for missing graph slots', () => {
    const empty: GraphContext = {
      ...baseCtx,
      candidate: null,
      resume: null,
      applications: [],
    };
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: empty,
      steps: baseSteps,
    });
    expect(out).toMatch(/### 3\.1 candidate[\s\S]+?null/);
    expect(out).toMatch(/### 3\.2 resume[\s\S]+?null/);
  });
```

(D) Update the test `'includes the new output schema with stats fields'` so it asserts `rule_results` is now in the schema (and `explanations` is NOT). REPLACE its body with:

```ts
  it('includes the new output schema with stats + rule_results fields', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    expect(out).toContain('"stats"');
    expect(out).toContain('"rule_results"');
    expect(out).toContain('insufficient_info');
    expect(out).toContain('not_triggered');
    expect(out).toContain('not_executed');
    // The LLM no longer emits explanations directly — it's derived in the runner.
    expect(out).not.toContain('"explanations"');
  });
```

(E) APPEND a new test as the last `it(...)` inside the `describe('composeMatchResumePrompt', …)` block:

```ts
  it('instructs the LLM to emit one rule_results entry per rule, in Set order', () => {
    const out = composeMatchResumePrompt({
      input: baseInput,
      graph: baseCtx,
      steps: baseSteps,
    });
    // Verbatim instruction text — verify both halves are present.
    expect(out).toContain('每条规则都必须有一条对应的');
    expect(out).toContain('rule_results');
    expect(out).toContain('按 Set 顺序、Set 内列出顺序输出');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run lib/rule-check/prompt.test.ts
```

Expected: 4 failures (the four modified tests + the new instruction-text test). The other prompt tests should still pass.

- [ ] **Step 3: Modify `lib/rule-check/prompt.ts`**

Open `/Users/chenyang/projects/agenticOperator/lib/rule-check/prompt.ts`.

(A) **Rewrite `renderGraphSection`.** Find:

```ts
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
```

REPLACE with (adds `resume` as `### 3.2`, renumbers the others):

```ts
function renderGraphSection(graph: GraphContext): string {
  return [
    '## 3. Graph context',
    '',
    '你可以通过下列对象引用 ontology 实例数据。**先用这些字段，不够再调 tool**。',
    '所有数据已经按 candidate_id / job_requisition_id 预拉取；缺的 slot 显示为 null 或 []，对应规则按 "信息不全" 处理。',
    '',
    renderGraphSlot('3.1 candidate', graph.candidate),
    renderGraphSlot('3.2 resume (候选人当前简历, 来自 neo4j Resume 节点)', graph.resume),
    renderGraphSlot('3.3 job_requisition', graph.job_requisition),
    renderGraphSlot('3.4 applications (历史投递, 全量)', graph.applications),
    renderGraphSlot('3.5 blacklist_hits (全量)', graph.blacklist_hits),
    renderGraphSlot('3.6 employment_links (含 Employer 节点解析)', graph.employment_links),
    '',
    '如需上面未列出的实体（亲属关系、合规文档等），通过 tool 调用 `get_instance` / `list_instances` / `list_links`。',
  ].join('\n');
}
```

(B) **Rewrite `renderInputsSectionV2` to drop the resume subsection.** Find:

```ts
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
```

REPLACE with (drops 2.2; renumbers):

```ts
function renderInputsSectionV2(input: RuleCheckInput): string {
  return [
    '## 2. Inputs',
    '',
    '### 2.1 runtime_context',
    '```json',
    JSON.stringify(input.runtime_context, null, 2),
    '```',
    '',
    '### 2.2 job_requisition',
    '```json',
    JSON.stringify(input.job_requisition, null, 2),
    '```',
    '',
    '### 2.3 job_requisition_specification',
    '```json',
    JSON.stringify(input.job_requisition_specification ?? null, null, 2),
    '```',
    '',
    '### 2.4 hsm_feedback',
    '```json',
    JSON.stringify(input.hsm_feedback ?? null, null, 2),
    '```',
    '',
    '（候选人简历 resume 已移入 §3.2 Graph context，由 neo4j Resume 节点提供。）',
  ].join('\n');
}
```

(C) **Rewrite `OUTPUT_SCHEMA_MATCH_RESUME`.** Find the existing `const OUTPUT_SCHEMA_MATCH_RESUME = ...` template literal. REPLACE it with:

```ts
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
  "rule_results": [
    {
      "rule_id": "<id>",
      "rule_name": "<name>",
      "step_id": "<step_id>",
      "status": "pass" | "fail" | "pending" | "insufficient_info" | "not_triggered" | "not_executed",
      "reason": "<reason — required when status ≠ pass and ≠ not_triggered>"
    }
  ]
}
\`\`\`

**关键规则：**
- 每条规则都必须有一条对应的 \`rule_results\` 条目，按 Set 顺序、Set 内列出顺序输出。
- \`reason\` 字段在 status ∈ {fail, pending, insufficient_info, not_executed} 时必填；status='pass' 或 'not_triggered' 时可填短说明也可省略。
- stats 各字段必须与 rule_results 中相应 status 的计数一致；任何不一致以 rule_results 为准（runner 会按 rule_results 重新计算 stats 和 decision）。`;
```

(D) **Update `SELF_CHECK_MATCH_RESUME`** to reflect the rule_results contract. Find the existing constant. REPLACE with:

```ts
const SELF_CHECK_MATCH_RESUME = `## 7. 自检
- [ ] 是否按 Set 顺序、Set 内列出顺序评估？
- [ ] 是否在 rule_results 中**为每一条规则**输出了一条条目？（数量必须与本提示中的规则总数完全一致）
- [ ] 是否在出现首个 fail 后将后续全部标 not_executed？
- [ ] 仅输出 JSON 对象本身，无 markdown 包裹？`;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run lib/rule-check/prompt.test.ts
```

Expected: all tests pass (the 8 existing/modified + 1 new = 9 total).

- [ ] **Step 5: Commit**

```bash
git add lib/rule-check/prompt.ts lib/rule-check/prompt.test.ts
git commit -m "$(cat <<'EOF'
feat(rule-check): prompt emits rule_results (per-rule debug); resume in §3.2

§2 Inputs no longer renders resume — it's moved to §3.2 Graph context
as a separate slot fed by buildGraphContext. §6 Output schema replaces
explanations[] with rule_results[]: LLM must emit one entry per evaluated
rule with full RuleStatus enum + optional reason. Stats are flagged as
authoritative-from-rule_results so the runner can recompute them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: runner.ts — coerce rule_results, derive explanations, recompute stats, strict 1:1

**Files:**
- Modify: `lib/rule-check/runner.ts`
- Modify: `lib/rule-check/runner.test.ts`

This task closes the build break opened by Task 1 (runner.ts hasn't been emitting `rule_results` since Task 1's type change).

- [ ] **Step 1: Rewrite the runner test fixtures and add new tests**

Open `/Users/chenyang/projects/agenticOperator/lib/rule-check/runner.test.ts`.

(A) Update `mockGraphEmpty` to also cover the new `Resume` listing. Find:

```ts
function mockGraphEmpty(): void {
  mGetInst.mockResolvedValue(null);
  mListInst.mockResolvedValue([]);
  mListLinks.mockResolvedValue([]);
}
```

It already covers all `listInstances` labels via the default return; no change needed. The `Resume` lookup will just return `[]` like any other list label — `ctx.resume` ends up null. Good.

(B) Add a helper near the existing `mockRulesOneStepOneRule` for a four-rule fixture used by the new "derivation" test:

```ts
function mockRulesFourRules(): void {
  const ruleShape = (id: string) => ({
    id,
    specificScenarioStage: '',
    businessLogicRuleName: `name-${id}`,
    applicableClient: '通用',
    applicableDepartment: 'N/A',
    submissionCriteria: 'sc',
    standardizedLogicRule: 'logic',
    relatedEntities: [],
    businessBackgroundReason: '',
    ruleSource: '',
    executor: 'Agent' as const,
    severity: 'terminal' as const,
  });
  const rules = ['10-1', '10-2', '10-3', '10-4'].map(ruleShape);
  mFetchRules.mockResolvedValue({
    rules,
    source: 'ontology-api',
    steps: [
      {
        step_id: '10::s1',
        order: 1,
        name: 'validateRedlineAndBlacklist',
        description: 'd',
        condition: 'c',
        rules,
      },
    ],
  });
}
```

(C) REPLACE every existing test that uses `explanations:` in the mock LLM response with one that uses `rule_results:` instead, and assert both `rule_results` and `explanations` in the output.

Replace test `'FAIL: folds to FAIL when stats.fail > 0'`:

```ts
  it('FAIL: folds to FAIL when stats.fail > 0', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        decision: 'FAIL',
        rule_results: [
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
    expect(out.stats.total).toBe(1);
    expect(out.rule_results).toHaveLength(1);
    expect(out.explanations).toHaveLength(1);
    expect(out.audit.rule_source).toBe('ontology-api');
    expect(out.audit.fail_reason).toBeUndefined();
  });
```

Replace test `'PASS: folds to PASS when no fail/pending/insufficient_info'`:

```ts
  it('PASS: folds to PASS when no fail/pending/insufficient_info', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        rule_results: [
          { rule_id: '10-25', rule_name: '华为荣耀', step_id: '10::s1', status: 'pass' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 50,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('PASS');
    expect(out.stats.pass).toBe(1);
    expect(out.rule_results).toHaveLength(1);
    expect(out.explanations).toHaveLength(0); // pass filtered out
  });
```

Replace test `'REVIEW: folds to REVIEW on pending'`:

```ts
  it('REVIEW: folds to REVIEW on pending', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        rule_results: [
          { rule_id: '10-25', rule_name: '华为荣耀', step_id: '10::s1', status: 'pending', reason: 'needs HSM' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 30,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('REVIEW');
    expect(out.stats.pending).toBe(1);
  });
```

Replace test `'fail-safe FAIL when LLM returns invalid JSON'`:

```ts
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
    expect(out.rule_results).toEqual([]);
    expect(out.explanations).toEqual([]);
  });
```

Replace test `'fail-safe FAIL when chatComplete rejects (gateway/network)'`:

```ts
  it('fail-safe FAIL when chatComplete rejects (gateway/network)', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockRejectedValueOnce(new Error('LLM gateway not configured'));
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.audit.fail_reason).toBe('llm-call-error');
    expect(out.rule_results).toEqual([]);
  });
```

Replace test `'fail-safe FAIL with ontology-graph-unavailable when getInstance throws 401'`:

```ts
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
    expect(out.rule_results).toEqual([]);
  });
```

Replace test `'threads tools to chatComplete'`:

```ts
  it('threads tools to chatComplete', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        rule_results: [
          { rule_id: '10-25', rule_name: '华为荣耀', step_id: '10::s1', status: 'pass' },
        ],
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
```

(D) APPEND three new tests INSIDE the `describe('runRuleCheck — new MatchResumeCheckResult shape', …)` block (before its closing `});`):

```ts
  it('derives explanations from rule_results — filters out pass + not_triggered', async () => {
    mockRulesFourRules();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        rule_results: [
          { rule_id: '10-1', rule_name: 'name-10-1', step_id: '10::s1', status: 'pass' },
          { rule_id: '10-2', rule_name: 'name-10-2', step_id: '10::s1', status: 'fail', reason: 'hit' },
          { rule_id: '10-3', rule_name: 'name-10-3', step_id: '10::s1', status: 'not_triggered' },
          { rule_id: '10-4', rule_name: 'name-10-4', step_id: '10::s1', status: 'pending', reason: 'review' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 1,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.rule_results).toHaveLength(4);
    expect(out.explanations).toHaveLength(2);
    expect(out.explanations.map((e) => e.status).sort()).toEqual(['fail', 'pending']);
    // FAIL fold wins
    expect(out.decision).toBe('FAIL');
  });

  it('recomputes stats from rule_results; ignores LLM-emitted stats', async () => {
    // Use a 4-rule fixture so we can supply 4 rule_results.
    mockRulesFourRules();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        decision: 'PASS',                          // LLM-emitted decision: WRONG
        stats: { total: 999, pass: 999, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 }, // bogus
        rule_results: [
          { rule_id: '10-1', rule_name: 'name-10-1', step_id: '10::s1', status: 'pass' },
          { rule_id: '10-2', rule_name: 'name-10-2', step_id: '10::s1', status: 'fail', reason: 'hit' },
          { rule_id: '10-3', rule_name: 'name-10-3', step_id: '10::s1', status: 'pass' },
          { rule_id: '10-4', rule_name: 'name-10-4', step_id: '10::s1', status: 'pass' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 1,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    // Runner recomputes regardless of LLM's bogus stats:
    expect(out.stats.total).toBe(4);
    expect(out.stats.pass).toBe(3);
    expect(out.stats.fail).toBe(1);
    // And decision flips from PASS (LLM) → FAIL (recomputed):
    expect(out.decision).toBe('FAIL');
  });

  it('parse-error fail-safe when rule_results count != filtered rule count', async () => {
    mockRulesOneStepOneRule();                     // expects 1 result
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({ rule_results: [] }), // LLM emits zero — mismatch
      modelUsed: 'm',
      durationMs: 1,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.audit.fail_reason).toBe('parse-error');
  });
```

- [ ] **Step 2: Run runner tests to verify they fail**

```bash
npx vitest run lib/rule-check/runner.test.ts
```

Expected: most of the 11 tests fail — the runner still emits `explanations` directly (not `rule_results`-derived). Some tests will fail because `out.rule_results` is missing entirely.

- [ ] **Step 3: Rewrite `lib/rule-check/runner.ts`**

Open `/Users/chenyang/projects/agenticOperator/lib/rule-check/runner.ts`.

(A) Update the type imports. Find:

```ts
import type {
  MatchResumeCheckResult,
  MatchResumeCheckStats,
  MatchResumeStepGroup,
  RuleCheckInput,
  RuleCheckRuntimeContext,
  RuleExplanation,
} from './types';
```

REPLACE with (add `RuleResult` + `RuleStatus`):

```ts
import type {
  MatchResumeCheckResult,
  MatchResumeCheckStats,
  MatchResumeStepGroup,
  RuleCheckInput,
  RuleCheckRuntimeContext,
  RuleExplanation,
  RuleResult,
  RuleStatus,
} from './types';
```

(B) Drop the `projectResume` import. Find:

```ts
import { projectResume } from './resume-projection';
```

DELETE that import line (resume now comes from graph context, not input).

(C) **Update `failSafe`** to include `rule_results: []`. Find:

```ts
function failSafe(
  reason: MatchResumeCheckResult['audit']['fail_reason'],
  base: Partial<MatchResumeCheckResult['audit']> = {},
): MatchResumeCheckResult {
  return {
    decision: 'FAIL',
    stats: emptyStats(),
    explanations: [],
    audit: {
      ...
    },
  };
}
```

REPLACE its return-object literal with:

```ts
  return {
    decision: 'FAIL',
    stats: emptyStats(),
    rule_results: [],
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
```

(D) **Replace `coerceExplanations` with `coerceRuleResults` + new helpers**. Find the existing `coerceExplanations` function and DELETE it. Insert these three new helpers in its place:

```ts
function coerceRuleResults(raw: unknown): RuleResult[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<RuleStatus>([
    'pass',
    'fail',
    'pending',
    'insufficient_info',
    'not_triggered',
    'not_executed',
  ]);
  const out: RuleResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.rule_id !== 'string' ||
      typeof r.rule_name !== 'string' ||
      typeof r.step_id !== 'string' ||
      typeof r.status !== 'string' ||
      !allowed.has(r.status as RuleStatus)
    ) {
      continue;
    }
    const status = r.status as RuleStatus;
    const reason = typeof r.reason === 'string' ? r.reason : undefined;
    const reasonRequired = status !== 'pass' && status !== 'not_triggered';
    if (reasonRequired && !reason) continue; // schema violation — drop
    out.push({
      rule_id: r.rule_id,
      rule_name: r.rule_name,
      step_id: r.step_id,
      status,
      reason,
    });
  }
  return out;
}

function deriveExplanations(rule_results: RuleResult[]): RuleExplanation[] {
  return rule_results
    .filter((r) => r.status !== 'pass' && r.status !== 'not_triggered')
    .map((r) => ({
      rule_id: r.rule_id,
      rule_name: r.rule_name,
      step_id: r.step_id,
      status: r.status as RuleExplanation['status'],
      reason: r.reason ?? '',
    }));
}

function statsFromResults(results: RuleResult[]): MatchResumeCheckStats {
  const s = emptyStats();
  s.total = results.length;
  for (const r of results) {
    if (r.status === 'pass') s.pass++;
    else if (r.status === 'fail') s.fail++;
    else if (r.status === 'pending') s.pending++;
    else if (r.status === 'insufficient_info') s.insufficient_info++;
    else if (r.status === 'not_triggered') s.not_triggered++;
    else if (r.status === 'not_executed') s.not_executed++;
  }
  return s;
}
```

(E) **Update `parseLlmJson`** to reflect the new shape. Find:

```ts
function parseLlmJson(
  text: string,
): { decision: string; stats?: unknown; explanations?: unknown } | null {
```

REPLACE with:

```ts
function parseLlmJson(
  text: string,
): { decision?: unknown; stats?: unknown; rule_results?: unknown } | null {
```

(The cast on the return statement inside should already be `as ...`; update its type assertion to match the new signature.)

The full function should look like:

```ts
function parseLlmJson(
  text: string,
): { decision?: unknown; stats?: unknown; rule_results?: unknown } | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as { decision?: unknown; stats?: unknown; rule_results?: unknown };
  } catch {
    return null;
  }
}
```

(F) **Update `runRuleCheck`** to drop the projectResume call and use the new coerce/derive pipeline. Find the body sections:

```ts
  // Project resume (existing partial-projection logic).
  const projectedResume = isPartialResumeEnabled()
    ? projectResume(input.resume, filtered)
    : input.resume;

  const userPrompt = composeMatchResumePrompt({
    input: { ...input, resume: projectedResume },
    graph,
    steps: filteredSteps,
  });
```

REPLACE with:

```ts
  // resume now lives in graph.resume; the prompt no longer reads input.resume.
  const userPrompt = composeMatchResumePrompt({
    input,
    graph,
    steps: filteredSteps,
  });
```

Find the post-LLM section:

```ts
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
    audit: { ... },
  };
```

REPLACE with:

```ts
  const parsed = parseLlmJson(llmResult.text);
  const expectedRuleCount = filteredSteps.reduce(
    (sum, s) => sum + s.rules.length,
    0,
  );
  const auditOnError = {
    rules_evaluated: filtered.length,
    graph_calls: graph.fetch_count,
    llm_model: llmResult.modelUsed,
    llm_duration_ms: llmResult.durationMs,
    llm_round_trips: llmResult.toolUseIterations,
    llm_prompt_tokens: llmResult.usage?.promptTokens,
    llm_completion_tokens: llmResult.usage?.completionTokens,
    rule_source: sourceResult.source,
  };
  if (!parsed) {
    return failSafe('parse-error', auditOnError);
  }

  const ruleResults = coerceRuleResults(parsed.rule_results);
  // Strict 1:1: LLM must emit one rule_results entry per filtered rule.
  if (ruleResults.length !== expectedRuleCount) {
    return failSafe('parse-error', auditOnError);
  }

  const stats = statsFromResults(ruleResults);
  const explanations = deriveExplanations(ruleResults);
  const decision = foldDecision(stats);

  return {
    decision,
    stats,
    rule_results: ruleResults,
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
```

(G) **Remove the now-orphaned `coerceStats` function** (it's no longer called — stats come from `statsFromResults`). Find:

```ts
function coerceStats(raw: unknown): MatchResumeCheckStats {
  ...
}
```

DELETE the entire function.

(H) **Remove the unused `isPartialResumeEnabled` helper** if it's no longer called. After the edits in (F), search the file with grep — if `isPartialResumeEnabled` is no longer referenced, DELETE its declaration:

```ts
function isPartialResumeEnabled(): boolean {
  return process.env.RULE_CHECK_PARTIAL_RESUME !== 'false';
}
```

(I) **Remove `MatchResumeStepGroup` from import if it's only used in the now-deleted line.** Search the file; if `MatchResumeStepGroup` is still used elsewhere (e.g. the filteredSteps construction), keep it. Otherwise drop it from the import.

Looking at the code: `MatchResumeStepGroup` is used in the type annotation of `filteredSteps`. Keep the import.

- [ ] **Step 4: Run runner tests to verify they pass**

```bash
npx vitest run lib/rule-check/runner.test.ts
```

Expected: 11 passing (7 modified existing + 3 new + 1 unchanged buildRuleCheckInput).

- [ ] **Step 5: Run the full test suite to verify no regressions**

```bash
npm test 2>&1 | tail -10
```

Expected: identical failure count to the pre-change baseline (same 5–6 pre-existing failing files in unrelated tests).

- [ ] **Step 6: Run the production build**

```bash
npm run build 2>&1 | tail -15
```

Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add lib/rule-check/runner.ts lib/rule-check/runner.test.ts
git commit -m "$(cat <<'EOF'
feat(rule-check): runner emits rule_results; stats recomputed; resume from graph

- Drop input-resume projection. Resume now lives in graph.resume (Task 2).
- Replace coerceExplanations + coerceStats with coerceRuleResults +
  statsFromResults + deriveExplanations. Stats are recomputed from
  rule_results; LLM-emitted stats and decision are ignored.
- Strict 1:1 check: rule_results.length must equal the total filtered rule
  count, else parse-error fail-safe.
- failSafe() returns rule_results: [] alongside explanations: [].
- New tests pin: derivation (pass/not_triggered filtered out of
  explanations), stats-recompute (LLM bogus stats overridden), and the
  strict-count parse-error fail-safe.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Final verification

**Files:** none modified by default.

- [ ] **Step 1: Run the full test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all `lib/rule-check/*.test.ts` pass; only pre-existing failures in unrelated files remain (`server/em/publish.test.ts`, `app/api/...`, `lib/agent-mapping.test.ts`).

- [ ] **Step 2: Run the production build**

```bash
npm run build 2>&1 | tail -15
```

Expected: success.

- [ ] **Step 3: Smoke-check the shape**

```bash
echo "--- types.ts (new exports) ---"
grep -n "export type RuleResult\|rule_results: RuleResult" /Users/chenyang/projects/agenticOperator/lib/rule-check/types.ts
echo "--- types.ts (deprecated) ---"
grep -n "@deprecated.*candidate_id" /Users/chenyang/projects/agenticOperator/lib/rule-check/types.ts
echo "--- graph-context.ts ---"
grep -n "resume:" /Users/chenyang/projects/agenticOperator/lib/rule-check/graph-context.ts
echo "--- runner.ts (new helpers, removed helpers) ---"
grep -n "function coerceRuleResults\|function deriveExplanations\|function statsFromResults" /Users/chenyang/projects/agenticOperator/lib/rule-check/runner.ts
grep -n "function coerceExplanations\|function coerceStats\|projectResume" /Users/chenyang/projects/agenticOperator/lib/rule-check/runner.ts || echo "(removed — none found)"
echo "--- prompt.ts (resume in §3, rule_results in §6) ---"
grep -n "3.2 resume\|rule_results" /Users/chenyang/projects/agenticOperator/lib/rule-check/prompt.ts | head -5
echo "--- match-resume-agent.ts unchanged (still reads explanations) ---"
grep -n "ruleCheck.explanations\|ruleCheck.stats\|ruleCheck.audit" /Users/chenyang/projects/agenticOperator/server/inngest/agents/match-resume-agent.ts | head -5
```

All "new" lines should produce hits; all "removed" lines should print "(removed — none found)" or empty. The agent grep should hit several lines confirming no change.

- [ ] **Step 4: No commit unless lint fixes were required.**

If `npm run build` flagged lint issues on a touched file, fix them and commit with:

```bash
git add lib/rule-check/
git commit -m "chore(rule-check): satisfy lint after per-rule shape change"
```

---

## Done criteria

- [ ] `runRuleCheck(input)` returns `MatchResumeCheckResult` with a populated `rule_results: RuleResult[]` field where `rule_results.length === audit.rules_evaluated`.
- [ ] `explanations[]` equals `rule_results.filter(r => r.status !== 'pass' && r.status !== 'not_triggered')` projected to the `RuleExplanation` shape.
- [ ] `stats` is recomputed from `rule_results`; LLM-emitted `stats` block is ignored.
- [ ] Strict 1:1 emission required: if `rule_results.length !== expectedRuleCount`, `audit.fail_reason === 'parse-error'`.
- [ ] Resume slot fetched from neo4j via `listInstances('Resume', { candidate_id })` first row; null when none.
- [ ] `RuleCheckInput.resume` is optional and tagged `@deprecated`.
- [ ] All `lib/rule-check/*.test.ts` cases pass.
- [ ] `npm run build` is green.
- [ ] `match-resume-agent.ts` and `server/inngest/client.ts` are NOT modified; their existing reads of `ruleCheck.explanations` / `ruleCheck.stats` / `ruleCheck.audit` still work.
