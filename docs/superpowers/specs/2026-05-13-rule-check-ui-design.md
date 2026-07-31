# Rule Check UI — Design

**Status:** brainstormed, awaiting plan
**Scope:** one self-contained feature — new `/rule-check` page that runs the existing 14-scenario test suite from the browser, persists each run to sqlite, and provides drill-down + dual-view + replay + side-by-side model compare for analyzing results.
**Source advices doc:** [docs/action_object_prompt/rule_check_advices.md](../../ontology/action_object_prompt/rule_check_advices.md) — 8 product requirements, of which this spec implements 6 in simplified form and explicitly drops 2 (see §1.2).

---

## 1. Goal & scope

### 1.1 Goal

Give recruitment-domain reviewers a UI to:
1. **Execute** the 14 matchResume rule-check scenarios end-to-end against neo4j-seeded fixtures, streaming progress as each scenario completes.
2. **View** results as a scenario × rule confusion matrix with click-to-drill-down case detail.
3. **Analyze** failures via a text+graph dual view that shows the inference chain (which graph data fed which rule, producing which verdict) and lets the user jump straight to the matching neo4j node in Neo4j Browser.
4. **Replay** any single scenario in place to validate fixes.
5. **Compare** the same scenario set across two LLM models side-by-side.

### 1.2 Advices doc coverage decisions

| Advice | Decision | Rationale |
|---|---|---|
| #1 Confusion matrix + business value anchors | **Partial.** Matrix yes (with 6-status→2-polarity bucketing). Business value anchors **dropped** — replaced with real metrics (avg LLM ms, output token totals, cap-hit count, parse-error count). No estimated $ / HR-hours numbers. | Fake "HR hours saved" / "missed candidate loss" numbers without real customer baselines is the "tech demo" failure mode the advices doc warned against. |
| #2 Drill-down on every cell | **Yes.** Cell click → right-side drawer with full case detail. |  |
| #3 Text + Graph dual view | **Yes**, with simplified graph: hand-laid-out static SVG over the 6 pre-fetched graph slots, no graph-layout library. | Slots are structurally fixed; dynamic layout adds dependency weight and contributes nothing visually. |
| #4 One-click to Neo4j Browser | **Yes**, via `?cmd=edit&arg=<cypher>` deep link. Env-gated; disabled with tooltip when `NEO4J_BROWSER_BASE` not configured. |  |
| #5 Inference chain | **Yes**, derived server-side from the runner's graph data + a small per-rule extractor registry. No LLM contract change. | Asking the LLM for structured evidence would blow the gateway's already-tight max_tokens budget. |
| #6 Replay button | **Yes**, per-scenario; upserts the existing run row in place. |  |
| #7 Three switchers (Client / Model / Version) | **Client + Model yes, Version diff no.** Side-by-side model compare via "Compare: [past run ▾]" picker — selects any prior `RuleCheckRun` for diff overlay. | Version diff requires a prompt-SHA versioning system + diff UI we don't need yet. Side-by-side compare delivers the headline analytical value (model swap = different matrix) without it. |
| #8 Dual-reader (Agent API) | **Yes** — the API routes are the dual-reader source. UI is a thin consumer of the same JSON another agent would read. |  |

### 1.3 Non-goals

- No prompt-editing UI. Prompt is still source-of-truth in `lib/rule-check/prompt.ts`.
- No new scenarios authoring UI. Scenarios live in `scripts/rule-check-test-suite/fixtures.ts`.
- No live neo4j subgraph traversal — the graph view renders ONLY the 6 slots the runner pre-fetches.
- No production gating / auth — this page is an internal eval surface.
- No automated CI integration — manual runs only for now.
- No version-diff matrix (deferred to a follow-up spec).
- No business-value estimator (deferred until real customer baselines exist).

---

## 2. Architecture & data flow

### 2.1 Request lifecycle

```
[User]                                              [Browser]                              [Next.js API]
  │                                                     │                                       │
  │ open /rule-check ───────────────────────────────────▶ GET /api/rule-check/runs?latest=1 ────▶ Prisma: most-recent run + scenarios
  │                                                     │◀───────────────── { run, scenarios } ─│
  │                                                     │
  │ click "▶ Run All" ──────────────────────────────────▶ POST /api/rule-check/runs (SSE) ──────▶ create RuleCheckRun row (status=running)
  │                                                     │                                       │ for each scenario in order:
  │                                                     │◀── event: started { run_id } ────────│   runRuleCheck(input)
  │                                                     │                                       │   classify match_kind
  │                                                     │◀── event: result { scenario_id, … } ─│   upsert RuleCheckScenarioResult
  │                                                     │   (matrix row hydrates live)          │   push SSE event
  │                                                     │   …                                   │
  │                                                     │◀── event: done { summary } ──────────│ mark run done; close stream
  │                                                     │
  │ click cell S02/10-25 ──────────────────────────────▶ (no fetch — drawer reads from client state)
  │                                                     │
  │ click "↻ Replay this scenario" ────────────────────▶ POST /api/rule-check/runs/{id}/replay/{sid}
  │                                                     │◀────────────────────── { result } ───│   re-run one scenario; upsert row; return
  │                                                     │   (one cell + drawer update in place) │
  │                                                     │
  │ pick "Compare: <past_run> ▾" ──────────────────────▶ GET /api/rule-check/runs/{compare_id} ─▶ Prisma: full run + scenarios
  │                                                     │◀────────────────────── { run, … } ───│
  │                                                     │   (matrix splits into 2 stacked grids;│
  │                                                     │    differing cells get orange outline)│
```

The SSE stream runs scenarios serially. Per-scenario wall time is ~50s for Gemini-3-flash-preview today, and the gateway's variable max_tokens cap makes parallel execution riskier (concurrent requests under load compound clamping). The user is watching the matrix populate row-by-row anyway; the perceived latency is "first row in ~50s" not "12 min total".

If the client tab closes mid-stream, the server detects the dropped connection, marks the run `error` with `client-aborted`, and the partially-completed scenarios remain visible in history.

### 2.2 Persistence — Prisma schema additions

Two new models in `prisma/schema.prisma`:

```prisma
model RuleCheckRun {
  id                    String    @id @default(cuid())
  startedAt             DateTime  @default(now())
  finishedAt            DateTime?
  status                String    @default("running")  // running | done | error
  model                 String                          // e.g. "gemini-3-flash-preview"
  clientIdOverride      String?                         // e.g. "CLI_TENCENT_PCG" — null = use scenario's own
  totalScenarios        Int       @default(0)
  passCount             Int       @default(0)
  failCount             Int       @default(0)
  totalLlmMs            Int       @default(0)
  totalPromptTokens     Int       @default(0)
  totalCompletionTokens Int       @default(0)
  capHits               Int       @default(0)                 // count of scenarios with finish_reason=length
  errorMessage          String?                               // set when status=error
  results               RuleCheckScenarioResult[]

  @@index([startedAt])
}

model RuleCheckScenarioResult {
  id                String   @id @default(cuid())
  runId             String
  run               RuleCheckRun @relation(fields: [runId], references: [id])

  scenarioId        String   // "S01".."S14"
  scenarioName      String

  // Expected (from fixture):
  expectedDecision  String
  expectedRules     String   // JSON: Record<rule_id, status>

  // Actual (from runRuleCheck):
  actualDecision    String
  actualStats       String   // JSON: MatchResumeCheckStats
  ruleResults       String   // JSON: RuleResult[]

  // Comparison:
  matchKind         String   // pass | fail-decision | fail-rule | fail-missing-rule | fail-parse
  failures          String?  // JSON: array of mismatch descriptions

  // Drawer payload (so drill-down needs no extra fetch):
  inferenceChain    String   // JSON: per-rule InferenceChain[]
  graphContext      String   // JSON: { candidate, resume, jd, applications, blacklist_hits, employment_links }

  // Audit:
  llmMs             Int
  llmModel          String
  promptTokens      Int?
  completionTokens  Int?
  finishReason      String?  // "stop" | "length" | "tool_calls"
  graphCalls        Int      @default(0)
  rawLlmText        String?  // only populated when matchKind="fail-parse"

  ranAt             DateTime @default(now())

  @@unique([runId, scenarioId])
  @@index([runId])
}
```

Migration: `npx prisma migrate dev --name add_rule_check_runs`.

### 2.3 Module layout

```
app/rule-check/
  page.tsx                              # thin: <Shell crumbs={…}><RuleCheckContent/></Shell>

app/api/rule-check/
  runs/route.ts                         # POST (SSE) + GET (list)
  runs/[run_id]/route.ts                # GET
  runs/[run_id]/replay/[scenario_id]/route.ts  # POST
  scenarios/route.ts                    # GET

components/rule-check/
  RuleCheckContent.tsx                  # page-level state + SSE consumer
  TopBar.tsx                            # Run / Replay-failed / Export buttons + Model / Client / Run / Compare selects
  MetricsStrip.tsx                      # real-number summary
  RuleConfusionStrip.tsx                # per-rule TP/TN/FP/FN bars; click → matrix column filter
  ScenarioMatrix.tsx                    # rows × cols grid; reused for compare-mode (stacked twice)
  CaseDrawer.tsx                        # right-side drawer (60% width)
  GraphView.tsx                         # ~200-line static SVG over 6 slots
  InferenceChainView.tsx                # renders InferenceStep[] as numbered list
  bucketing.ts                          # (expected, actual) → "TP" | "TN" | "FP" | "FN" | "excluded" | "missing"
  match-classifier.ts                   # scenario → match_kind; extracted from scripts/run-rule-check-test-suite.ts

lib/rule-check/evidence/
  index.ts                              # buildInferenceChain(graph, rule, ruleResult) registry dispatcher + fallback
  rule-10-25.ts                         # 华为冷冻期 extractor
  rule-10-26.ts                         # OPPO/小米 冷冻期 extractor
  rule-10-17.ts                         # 高风险回流 extractor
  rule-10-9.ts                          # 空窗期 > 3月 extractor
  rule-10-10.ts                         # 空窗期 > 1年 extractor
  rule-10-21.ts                         # 年龄超限 extractor
  rule-10-27.ts                         # 亲属回避 extractor
  rule-10-32.ts                         # 岗位冷冻期 extractor
  rule-10-5.ts                          # 学历硬性要求 extractor

server/rule-check/
  runs-service.ts                       # create run, stream scenarios, upsert results, mark done/error
  match-classifier.ts                   # imported by both scripts/ and the API route
```

---

## 3. API contracts

### 3.1 `POST /api/rule-check/runs` (SSE)

**Request body:**
```ts
{
  model?: string;           // e.g. "gemini-3-flash-preview" — defaults to env AI_MODEL
  client_id_override?: string; // e.g. "CLI_TENCENT_PCG" — defaults to scenario's own
  scenarios?: string[];     // ["S01","S03"] — defaults to all 14
}
```

**Response:** `Content-Type: text/event-stream`. Events (one `data:` line each, newline-terminated):

```
event: started
data: {"run_id":"clkx..."}

event: result
data: {"run_id":"clkx...","scenario_id":"S01","scenario_name":"控制组 PASS",
       "expected":{"decision":"PASS","rule_status":{}},
       "actual":{"decision":"REVIEW","stats":{…}},
       "rule_results":[…],
       "match_kind":"fail-decision",
       "failures":["decision mismatch — expected PASS, got REVIEW"],
       "inference_chain":[{"rule_id":"10-7","steps":[…],"highlight_nodes":["resume"]}, …],
       "graph_context":{"candidate":{…}, "resume":{…}, …},
       "audit":{"llm_ms":28664,"prompt_tokens":2890,"completion_tokens":597,"finish_reason":"stop","graph_calls":6}}

event: done
data: {"run_id":"clkx...","summary":{"total":14,"pass":5,"fail":9,"total_ms":712340}}

event: error
data: {"run_id":"clkx...","message":"Ontology API unreachable"}
```

### 3.2 `GET /api/rule-check/runs`

Query params: `latest=1` (returns single most recent) or unset (returns list).

**Response shape (list mode):**
```ts
{
  runs: Array<{
    run_id: string;
    started_at: string;
    finished_at: string | null;
    status: 'running' | 'done' | 'error';
    model: string;
    client_id_override: string | null;
    total_scenarios: number;
    pass_count: number;
    fail_count: number;
  }>;
}
```

**Response shape (latest=1 mode):**
```ts
{
  run: RuleCheckRunRow | null;
  scenarios: RuleCheckScenarioResultRow[];  // all 14 if available
}
```

### 3.3 `GET /api/rule-check/runs/{run_id}`

Returns full run + all scenario rows. Used to hydrate the "Compare" view.

### 3.4 `POST /api/rule-check/runs/{run_id}/replay/{scenario_id}`

Re-runs a single scenario. Upserts the `RuleCheckScenarioResult` row (same `run_id` + `scenario_id` → unique key). Recomputes parent `RuleCheckRun`'s aggregates. Returns the new scenario row.

**No body.** Model + client override are taken from the existing run row.

### 3.5 `GET /api/rule-check/scenarios`

Returns the 14 fixture scenarios with their `expected` outcomes. Used by the matrix to render row headers + expected-status template before any run has happened. Reads from `scripts/rule-check-test-suite/fixtures.ts` (re-exported through a server-friendly entry point).

---

## 4. UI layout

### 4.1 First-paint view

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Shell — breadcrumb: "Rule Check · matchResume"                              │
├────────────────────────────────────────────────────────────────────────────┤
│ TopBar:                                                                     │
│   [▶ Run All]  [↻ Replay Failed]  [⤴ Export Markdown]                       │
│   Model:  [Gemini-3-flash-preview ▾]                                        │
│   Client: [腾讯 ▾]                                                          │
│   Run:    [2026-05-13 17:50 · #abc123 ▾]                                    │
│   Compare:[— none — ▾]                                                      │
├────────────────────────────────────────────────────────────────────────────┤
│ MetricsStrip (real numbers only — no estimated $ / hours):                  │
│   ✓ 5/14 passed │ Avg 51.2s │ Σ 8,050t out / 40,460t in │ 0 cap-hits │ 0 parse-errors │
├────────────────────────────────────────────────────────────────────────────┤
│ RuleConfusionStrip:                                                         │
│   Per-rule TP/TN/FP/FN bars, click filters matrix column                    │
├────────────────────────────────────────────────────────────────────────────┤
│ ScenarioMatrix:                                                             │
│   rows = scenarios S01..S14                                                 │
│   cols = rules (union of all scenarios' filtered rule sets, ordered by ID)  │
│   cells = colored by bucketing.ts result (see §4.4)                         │
└────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Drawer (right-side, 60% width) on cell click

Header strip:
- Scenario name + run ID
- Expected decision + matching rule statuses
- Actual decision + matching rule statuses
- Audit one-liner: `57.9s · 6 graph fetches · 0 tool rounds · 574t · finish=stop`
- Buttons: `[▶ Replay this scenario] [↗ Open Candidate in Neo4j] [↗ Open Resume]`

Body — two columns:

**Left (Text view):**
- **Verdict** in business language — composed from the LLM's `reason` for the worst-status rule, e.g. "流程挂起 — 候选人最近一段华为工作经历离职日期 (2026-04) 距今不足 3 个月。"
- **Per-rule breakdown** — checklist of all rules in this scenario; each row shows `rule_id · status · short reason`. Selecting a row highlights the inference chain.
- **Inference chain** for the selected rule — numbered steps (see §5).
- **Rule markdown** — verbatim `standardizedLogicRule` from the rule source (advices doc #1's "rules as markdown not if-else").
- **[Show raw LLM JSON ▾]** and **[Show prompt ▾]** collapsible diagnostics.

**Right (Graph view):**
- 480×520 SVG canvas with 6 fixed-position slots (Candidate top, Resume / Applications / Blacklist lateral, JD bottom-right, Employment_links bottom strip).
- Nodes that the selected rule's inference chain references get a thick accent-color stroke.
- Each node clickable → opens that node in Neo4j Browser.

### 4.3 Compare mode (top bar "Compare:" set)

`ScenarioMatrix` renders twice, stacked vertically: current run on top labeled with its model name, comparison run below labeled with its model name. Cells where the two runs disagree get a 1px orange outline. Click on a cell in either matrix opens the drawer for *that* run (drawer header shows which model produced this result).

### 4.4 Cell rendering rules (`bucketing.ts`)

| Cell content | Color (CSS var) |
|---|---|
| Match (TP or TN), actual status in {`pass`, `not_triggered`} | `--c-ok-bg` light green |
| Match (TP), actual ∈ {`fail`, `pending`, `insufficient_info`, `not_executed`} | `--c-warn-bg` light yellow (correctly flagged risk) |
| Mismatch FP (false alarm: expected clear, got flagged) | `--c-bad-bg` light red |
| Mismatch FN (missed: expected flagged, got clear) | `--c-bad-bg` light red with `!` icon |
| Rule not in this scenario's filter | grey neutral |
| Rule expected but missing from `rule_results` | yellow with `⚠` (per-scenario fail-missing-rule) |
| In-flight (running) | pulsing skeleton |

Cell hover tooltip: `<expected> → <actual>  rule: <rule_name>`.

---

## 5. Inference chain derivation

A per-rule extractor registry in `lib/rule-check/evidence/index.ts`:

```ts
type InferenceStep =
  | { kind: 'graph_node'; node: NodeKind; field?: string; value: string }
  | { kind: 'rule_logic'; markdown: string }
  | { kind: 'computation'; label: string; value: string }
  | { kind: 'verdict'; status: RuleStatus; reason: string };

type NodeKind = 'candidate' | 'resume' | 'jd' | 'application' | 'blacklist' | 'employment';

type InferenceChain = {
  rule_id: string;
  steps: InferenceStep[];
  highlight_nodes: NodeKind[];   // for graph-view stroke highlighting
};

type ExtractorFn = (
  graph: GraphContext,
  runtime: RuleCheckRuntimeContext,
  rule: Rule,
  ruleResult: RuleResult,
) => InferenceChain;
```

**Coverage** — hand-write extractors for the 9 rules our 14 fixtures actually exercise (`10-5`, `10-9`, `10-10`, `10-17`, `10-21`, `10-25`, `10-26`, `10-27`, `10-32`).

**Fallback** (any rule without a registered extractor):
```
[
  { kind: 'rule_logic', markdown: rule.standardizedLogicRule },
  { kind: 'verdict', status: ruleResult.status, reason: ruleResult.reason ?? '' },
]
```

Built server-side and embedded in each `RuleCheckScenarioResult.inferenceChain` row, so the drawer needs no extra fetch and the JSON is the dual-reader source.

Example for rule 10-25 (华为冷冻期), scenario S02:

```jsonc
{
  "rule_id": "10-25",
  "highlight_nodes": ["candidate", "resume"],
  "steps": [
    { "kind": "graph_node", "node": "resume", "field": "work_experience[0]",
      "value": "华为, 软件工程师, 2024-01 ~ 2026-04" },
    { "kind": "computation", "label": "Today",
      "value": "2026-05-13 (from runtime_context.received_at)" },
    { "kind": "computation", "label": "离职至今",
      "value": "≈ 1 month" },
    { "kind": "rule_logic",
      "markdown": "若间隔不足 3 个月，系统立即挂起该候选人的匹配推荐流程…" },
    { "kind": "verdict", "status": "pending",
      "reason": "华为离职 < 3 月，需人工确认" }
  ]
}
```

---

## 6. Neo4j Browser jump

**Env var:** `NEO4J_BROWSER_BASE` — e.g. `http://10.100.0.70:7474/browser/`.

**URL format** (Neo4j Browser deep link):
```
{base}?cmd=edit&arg={URL-encoded Cypher}
```

The query pre-loads in the editor; user hits ⌘↵ to execute. We do **not** auto-execute (that would require the browser to be pre-authenticated and uses a different URL form that's brittle across versions).

**Cypher templates** (per node kind):

| Node kind | Cypher |
|---|---|
| Candidate | `MATCH (c:Candidate {candidate_id: '<id>'}) RETURN c` |
| Resume | `MATCH (r:Resume {resume_id: '<id>'}) RETURN r` |
| Job Requisition | `MATCH (j:Job_Requisition {job_requisition_id: '<id>'}) RETURN j` |
| Application | `MATCH (a:Application {application_id: '<id>'}) RETURN a` |
| Blacklist | `MATCH (b:Blacklist {blacklist_id: '<id>'}) RETURN b` |
| Subgraph (header button "Open subgraph") | `MATCH (c:Candidate {candidate_id: '<id>'})-[r*1..2]-(n) RETURN c, r, n LIMIT 50` |

When `NEO4J_BROWSER_BASE` is unset, buttons render disabled with tooltip "Set NEO4J_BROWSER_BASE in .env.local to enable Neo4j Browser links."

---

## 7. Switcher behavior

### 7.1 Model

Hardcoded list in `components/rule-check/TopBar.tsx`:
- `gemini-3-flash-preview` (default — matches current `AI_MODEL`)
- `claude-opus-4-7`
- `kimi-k2.6`

The selected value is passed as `model` to `chatComplete` via the SSE endpoint's request body. Gateway already supports per-call override (`opts.model` in `server/llm/gateway.ts`).

### 7.2 Client

Hardcoded list:
- `字节跳动` → `CLI_BYTEDANCE`
- `腾讯` → `CLI_TENCENT_PCG`
- `华为` → `CLI_HUAWEI`
- `通用 (no override)` → null

When set, the server passes `client_id_override` to a new helper that wraps `extractDims` to substitute `client_id`. Affects which rules survive `applyClientFilter`. Per-scenario JR still applies — `client_id_override` only overrides the dimension extraction step, not the JD itself.

### 7.3 Run picker

Dropdown of the past 20 runs, sorted by `startedAt` desc. Each row labeled `YYYY-MM-DD HH:MM · model · pass/total`. Selecting a non-current run loads it into the page (matrix replays from sqlite).

### 7.4 Compare picker

Same dropdown shape as Run picker, but selecting a value enables compare mode (§4.3). Selecting "— none —" clears compare mode.

---

## 8. Error handling

| Failure | Server behavior | UI |
|---|---|---|
| Ontology API 401/502 at graph-fetch time | runner returns `failSafe('ontology-graph-unavailable')`. Server still emits a `result` event with `match_kind="fail-runtime"`. | Cell renders red with `⚠`; drawer shows the audit `fail_reason`. |
| LLM gateway not configured | First scenario rejects; server marks run `error`, pushes `error` event, closes stream. | Banner "LLM gateway not configured — set AI_BASE_URL + AI_API_KEY". |
| LLM call timeout | runner returns `failSafe('llm-call-error')`. | Same as ontology unavail. |
| max_tokens cap clip (finish=length, parse-error) | scenario row: `match_kind="fail-parse"`, `rawLlmText` populated. | Cell red; drawer shows the truncated raw text + finish_reason. |
| Tab close mid-stream | Server detects on `request.signal.aborted`; marks run `error` with `client-aborted`; partial results stay in db. | History shows the run as "error · aborted at S07". |
| Replay against a run where the run row is gone | 404. | Toast "Run no longer exists." |

---

## 9. Testing

- **Server unit tests** (`server/rule-check/runs-service.test.ts`): mock `runRuleCheck`, verify the service streams `started` → N × `result` → `done`, upserts correctly, handles abort.
- **Bucketing unit tests** (`components/rule-check/bucketing.test.ts`): table-driven over the 6 expected × 6 actual matrix, plus "missing" / "not_executed" cases.
- **Match classifier unit tests** (`server/rule-check/match-classifier.test.ts`): cover all `match_kind` values (extract test cases from `scripts/run-rule-check-test-suite.ts`).
- **Inference extractor unit tests** (`lib/rule-check/evidence/*.test.ts`): per-rule, feed a known graph context, assert the chain has expected node + computation + verdict steps.
- **Manual UI test plan** (documented in the plan, not automated):
  1. Visit `/rule-check` with no runs → see "No runs yet, click ▶ Run All".
  2. Run all 14 → matrix populates row-by-row, metrics strip updates, takes ~12 min.
  3. Click S02/10-25 cell → drawer shows pending verdict, inference chain has 5 steps, graph view highlights candidate + resume nodes.
  4. Click "Open Candidate in Neo4j" → opens browser tab with pre-filled cypher.
  5. Click Replay on a failing cell → cell flashes, then updates with new result; one cell only changes.
  6. Switch Model to Claude Opus → run all → new run row.
  7. Set Compare: <previous Gemini run> → matrix stacks 2x; differing cells get orange outline.
  8. Close tab mid-run → re-open → past run shows as `error · aborted`.

No e2e tests (no test framework configured per `CLAUDE.md`).

---

## 10. Risks & open questions

- **Gateway max_tokens variance** (carried over from the prior phase). With compact output schema the average S01 output is ~597 tokens and most scenarios fit, but cap can still occasionally bite. Mitigation: the cell rendering for `fail-parse` makes this visible rather than hidden, and the drawer surfaces the raw text for diagnosis. No retry-on-length logic in scope.
- **Neo4j Browser deep-link format drift.** The `?cmd=edit&arg=…` form is documented for Neo4j 4+ Browser but is not part of a stable contract. If it breaks on the user's Neo4j version, fallback is to copy-cypher-to-clipboard (single-line implementation, defer until needed).
- **Client switcher coverage.** `CLI_HUAWEI` rules aren't in any seeded scenario today — selecting it will mostly produce empty matrices. Acceptable; the switcher is for demonstrating the mechanism, not for hitting real rules.
- **Inference chain coverage.** Rules without an extractor get the fallback rendering — still useful (rule markdown + verdict) but no graph highlight. Coverage can grow incrementally.
- **Side-by-side compare data volume.** Comparing two 14-scenario runs loads ~28 scenario rows into the page — each with `graphContext` JSON (~5KB) and `inferenceChain` JSON (~3KB). Total ~250KB hydration. Acceptable for an internal eval surface; if it grows, lazy-load drawer payload on click.
- **Runner return shape.** `runRuleCheck` currently does not return the pre-fetched `GraphContext`, but the API route needs it to build `inferenceChain` and to persist `graphContext` to the row. Implementation choice (plan-time): either (a) thread `GraphContext` into `MatchResumeCheckResult.audit` as a non-breaking addition, or (b) refactor `runRuleCheck` into two functions where the API route owns the graph fetch. Either way, the runner's existing test surface must not break.
