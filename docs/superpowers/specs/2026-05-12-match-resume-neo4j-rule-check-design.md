---
title: matchResume rule check — neo4j-aware extension
date: 2026-05-12
branch: create-action-prompt (from steven)
status: approved
supersedes: 2026-05-09-generate-match-resume-prompt-design.md (lib/prompts/match-resume.ts is retired)
---

# matchResume rule check — neo4j-aware extension

## Goal

Extend the existing rule-check pipeline at `lib/rule-check/` so the LLM can evaluate `matchResume` rules that depend on **neo4j instance data** (candidates, prior applications, blacklist hits, employment history, links between them) — not just the resume + JD already in the input. The action's 4 Sets and their internal rule ordering must be enforced strictly in the prompt; the LLM may not reorder. Output collapses from a verbose per-rule listing to a compact `{ decision, stats, explanations }` shape that downstream `matchResumeAgent` can act on.

## Non-goals

- Direct Neo4j driver access. We only call the existing HTTP API at `/api/v1/ontology/instances/...` and `/api/v1/ontology/links`.
- Per-rule "data-needs" mapping table. The hybrid pre-fetch-bundle + tool-use fallback eliminates the need for one.
- Alternate prompt source (`yeyang-runner.ts`). Stays as-is; doesn't get the neo4j context. Address in follow-up if needed.
- Token-budget guard. We accept variable token counts when `applications` etc. return many rows.
- Migration of `lib/prompts/match-resume.ts` consumers. That module had only `scripts/run-match-resume-prompt.ts` (a dev helper). The script can be retired or repointed at the new entry as a follow-up.

## Module strategy

Decided during brainstorm: **extend `lib/rule-check/`**, not build a parallel module. Rationale:

- `lib/rule-check/runner.ts` already does fetch-rules → filter → project resume → compose prompt → LLM → fold-verdict. The new requirements (graph context, new output shape) are deltas on top of an existing flow, not a from-scratch build.
- `matchResumeAgent` already consumes `runRuleCheck()`. Keep that single integration point.
- `lib/prompts/match-resume.ts` (built earlier in this session as a prompt-only utility) is retired by this design — it was a parallel experiment.

## File map

```
lib/rule-check/
├── runner.ts                    ← MODIFIED: orchestrates graph-context stage + tool-use loop; new return type
├── prompt.ts                    ← MODIFIED: Set-ordered rules section + GRAPH_CONTEXT section + new output schema
├── types.ts                     ← MODIFIED: new MatchResumeCheckResult + stats categories; remove RuleCheckVerdict surface
├── ontology-source.ts           ← MODIFIED: also expose grouped steps (with order, name, condition, description, rules)
├── llm.ts                       ← DELETED: replaced by shared chatComplete in server/llm/gateway.ts
├── graph-context.ts             ← NEW: pre-fetch bundle + in-memory cache + tool dispatcher
└── instance-client.ts           ← NEW: typed HTTP client for /instances + /links (URL + token from env)

server/llm/gateway.ts             ← MODIFIED: add optional `tools` parameter (or sibling `chatCompleteWithTools`)

server/inngest/agents/match-resume-agent.ts  ← MODIFIED: consume new MatchResumeCheckResult shape (one caller migrated atomically)
```

`.env.local` (and `.env.example`):

```
ONTOLOGY_API_BASE=http://localhost:3500
ONTOLOGY_API_TOKEN=abc12345def
```

(The same env vars `ontology-source.ts` already reads for `fetchAction`.)

## Pipeline (after the change)

```
runRuleCheck(input: RuleCheckInput)
  ↓
  1. extractDims(input.job_requisition)            (unchanged)
  ↓
  2. fetchRulesForMatchResume()                    (extended: emit grouped steps too)
  ↓
  3. applyClientFilter(rules, dims)                (unchanged)
  ↓
  4. classifyRules(filtered)                       (still used for inline annotation)
  ↓
  5. buildGraphContext(runtime_context, dims)     ← NEW
       └─ fetch candidate, jd, applications, blacklist_hits, employment_links
       └─ keep results in cache keyed by ${label}:${value}
  ↓
  6. projectResume(...)                            (unchanged)
  ↓
  7. composePrompt(...)                            (rewritten Rules + GraphContext sections)
  ↓
  8. chatComplete-with-tools loop (≤5 iterations) ← NEW
       └─ each tool_call dispatched to graph-context cache → instance-client → cache → LLM
  ↓
  9. parse JSON, validate against schema
  ↓
 10. compute stats, fold to decision, return MatchResumeCheckResult
```

## Pre-fetch bundle

`graph-context.ts → buildGraphContext({ candidate_id, job_requisition_id, ... })` issues these HTTP calls in parallel, all carrying `Authorization: Bearer ${ONTOLOGY_API_TOKEN}` and `?domain=RAAS-v1` (the same domain `fetchAction` already uses for rule fetch — hardcoded for now, env override deferred):

| Slot | Endpoint | Behavior on 404 |
|---|---|---|
| `candidate` | `GET /api/v1/ontology/instances/Candidate/{candidate_id}` | slot = null |
| `job_requisition` | `GET /api/v1/ontology/instances/Job_Requisition/{job_requisition_id}` | slot = null |
| `applications` | `GET /api/v1/ontology/instances/Application?candidate_id={candidate_id}` | slot = [] |
| `blacklist_hits` | `GET /api/v1/ontology/instances/Blacklist?candidate_id={candidate_id}` | slot = [] |
| `employment_links` | `GET /api/v1/ontology/links?from={candidate_id}&type=EMPLOYED_BY` | slot = [] |

Lists are NOT capped (user decision). The LLM gets every row; we accept variable token counts.

Results held in an in-memory `Map<string, unknown>` keyed by `${label}:${value}` for list-endpoint hits (one entry per row) and `${label}:list:${query-hash}` for list aggregates. Tool-use loop checks the cache before issuing new HTTP calls. The map is **per `runRuleCheck` invocation** — not module-global — so concurrent invocations stay isolated.

## Tool-use loop

`server/llm/gateway.ts` gains a tools-capable variant. Simplest viable shape — add an optional `tools` param to `chatComplete()`:

```ts
chatComplete({
  system, user, model?, temperature?, maxTokens?, logger?, toolName?,
  tools?: {
    schema: OpenAI.Chat.ChatCompletionTool[];
    onToolCall: (name: string, args: unknown) => Promise<unknown>;
    maxIterations?: number; // default 5
  },
}): Promise<ChatCompleteResult>;
```

When `tools` is set, the function internally drives the request → tool_calls → tool messages → request loop until the model emits a non-tool response or `maxIterations` is hit. Each tool round logs its own AgentActivity row when a logger is threaded.

The three tools registered by `runner.ts`:

```ts
{
  type: "function",
  function: {
    name: "get_instance",
    description: "Fetch one ontology instance by label + primary key.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "e.g. Candidate, Job_Requisition, Blacklist" },
        value: { type: "string", description: "the instance's PK value" },
      },
      required: ["label", "value"],
    },
  },
}

{
  type: "function",
  function: {
    name: "list_instances",
    description: "List ontology instances filtered by property equality.",
    parameters: {
      type: "object",
      properties: {
        label:   { type: "string" },
        filters: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["label"],
    },
  },
}

{
  type: "function",
  function: {
    name: "list_links",
    description: "List ontology links by from/to/type filters.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string" },
        to:   { type: "string" },
        type: { type: "string" },
      },
    },
  },
}
```

`onToolCall(name, args)` dispatches to `graph-context.ts → cache.get(...) ?? instance-client.<method>(...)`. Cache writes happen on every successful fetch so repeated calls within a session are free. A failed fetch (4xx/5xx) returns `{ error: "..." }` to the LLM via the tool message — the model decides whether that data gap drives `insufficient_info`.

`maxIterations: 5` cap. Past the cap → fail-safe FAIL with `audit.fail_reason = "tool-use-loop-exceeded"`.

## Prompt structure

```
# Resume Pre-Screen Rule Check

## 1. 角色  (unchanged)

## 2. Inputs  (unchanged 5-block: runtime_context, resume, jd, spec, hsm_feedback)

## 3. Graph context (NEW)

你可以通过下列对象引用 ontology 实例数据。**先用这些字段，不够再调 tool**。
所有数据已经按 candidate_id / job_requisition_id 预拉取；缺的 slot 会显示为 null/[]，
对应规则按 "信息不全" 处理。

### 3.1 candidate
\`\`\`json
{ ...property bag... }   // 或 null
\`\`\`

### 3.2 job_requisition
\`\`\`json
{ ...property bag... }
\`\`\`

### 3.3 applications (历史投递, 全量)
\`\`\`json
[ {...}, {...} ]
\`\`\`

### 3.4 blacklist_hits (全量)
\`\`\`json
[ {...} ]
\`\`\`

### 3.5 employment_links (含 Employer 节点解析)
\`\`\`json
[ { "linkId":..., "type":"EMPLOYED_BY", "toId":..., "toInstance": {...} } ]
\`\`\`

如需上面未列出的实体（亲属关系、合规文档等），通过 tool 调用 get_instance / list_instances / list_links。

## 4. Rules to check — 严格按 Set 顺序、Set 内严格按列出顺序评估

> **执行约束（必须遵守，违反即视为输出无效）：**
> 1. Set 之间按 §4.1 → §4.2 → §4.3 → §4.4 顺序，**不得跳过 Set、不得乱序**。
> 2. 每个 Set 内的 rules 按列出顺序逐条评估，**不得调换、不得合并**。
> 3. 一旦任一 rule 的 status="fail"，**立即停止后续所有 rule 的评估**；
>    后续 rule 全部标 status="not_executed"，
>    reason="前序规则 <rule_id> 已 FAIL，本规则未执行"。
> 4. status="pending" / "insufficient_info" / "pass" 均**不**短路；后续规则继续。
> 5. 你必须在内部完成全部评估后，再统一输出 explanations[]。

### 4.1 Set 1 — validateRedlineAndBlacklist  [order=1]
**进入条件**：已收到简历处理完成事件，候选人记录已创建
**Set 说明**：执行红线检测和黑名单校验。检查候选人是否命中…

#### Rule 10-25: 华为荣耀竞对与客户互不挖角红线  [applicableClient=通用, severity=终止级]
- submissionCriteria: 候选人简历已完成解析，工作经历数据已结构化。
- logic: 系统在简历匹配环节，自动检索候选人工作经历…

#### Rule 10-26: OPPO小米竞对与客户互不挖角红线  [applicableClient=通用, severity=终止级]
- …

### 4.2 Set 2 — matchHardRequirements  [order=2]
…

### 4.3 Set 3 — evaluateBonusAndCheckReflux  [order=3]
…

### 4.4 Set 4 — generateMatchResult  [order=4]
…

## 5. 决策结算 (NEW)

逐 rule 评估完后按下列规则汇总：
- 任一 rule status="fail"  → decision="FAIL"
- 否则任一 rule status="pending" 或 "insufficient_info" → decision="REVIEW"
- 否则 → decision="PASS"

不要根据自己的判断重新归类 rule status，必须沿用上面的语义。

## 6. Output schema (NEW)
（见 §7 below）

## 7. 自检
- [ ] 是否按 Set 顺序、Set 内列出顺序评估？
- [ ] 是否在出现首个 fail 后将后续全部标 not_executed？
- [ ] stats 的各类计数是否与 explanations[] 一致？
- [ ] 仅输出 JSON 对象本身，无 markdown 包裹？
```

Rendering of section 4 (Rules) is driven by the grouped-step output from `ontology-source.ts` — Sets in `order` ascending, rules within each Set in the order they appeared in `action.actionSteps[i].rules`. No re-sorting by `id` (which the older prompt-builder did for stability — irrelevant here because the API authoritatively orders them).

## Output schema (LLM JSON)

```json
{
  "decision": "PASS" | "FAIL" | "REVIEW",
  "stats": {
    "total": 24,
    "pass": 18,
    "fail": 1,
    "pending": 1,
    "insufficient_info": 2,
    "not_triggered": 2,
    "not_executed": 0
  },
  "explanations": [
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "step_id": "10::validateRedlineAndBlacklist",
      "status": "fail",
      "reason": "candidate.work_experience[0]=华为, end_date=2026-04, 距 CURRENT_DATE 间隔 <3 月 — 落入 logic '间隔不足3个月即挂起' 分支 → 终止匹配"
    },
    {
      "rule_id": "10-32",
      "rule_name": "岗位冷冻期规则",
      "step_id": "10::evaluateBonusAndCheckReflux",
      "status": "not_executed",
      "reason": "前序规则 10-25 已 FAIL，本规则未执行"
    }
  ]
}
```

`explanations[]` includes every rule whose status is **not** `pass` and **not** `not_triggered` — i.e. fail, pending, insufficient_info, not_executed all get an entry. Pass and not_triggered are counted in `stats` but not enumerated (keeps the response compact for the common case where the bulk of rules pass).

## TypeScript public API

```ts
// lib/rule-check/types.ts

export type RuleStatus =
  | "pass"
  | "fail"
  | "pending"
  | "insufficient_info"
  | "not_triggered"
  | "not_executed";

export type RuleExplanation = {
  rule_id: string;
  rule_name: string;
  step_id: string;
  status: Exclude<RuleStatus, "pass" | "not_triggered">;
  reason: string;
};

export type MatchResumeCheckResult = {
  decision: "PASS" | "FAIL" | "REVIEW";
  stats: {
    total: number;
    pass: number;
    fail: number;
    pending: number;
    insufficient_info: number;
    not_triggered: number;
    not_executed: number;
  };
  explanations: RuleExplanation[];
  audit: {
    rules_evaluated: number;
    graph_calls: number;            // pre-fetch + tool-use HTTP calls combined
    llm_model: string;
    llm_duration_ms: number;
    llm_round_trips: number;        // 1 if no tool-use; 2+ if tools called
    llm_prompt_tokens?: number;
    llm_completion_tokens?: number;
    rule_source: "ontology-api" | "json-fallback";
    fail_reason?:
      | "llm-call-error"
      | "ontology-graph-unavailable"
      | "tool-use-loop-exceeded"
      | "parse-error"
      | string;
  };
};

export async function runRuleCheck(
  input: RuleCheckInput,
): Promise<MatchResumeCheckResult>;
```

The existing `RuleCheckVerdict` and `RuleFlag` types are deleted. The only caller (`server/inngest/agents/match-resume-agent.ts`) is migrated to the new shape in the same PR:
- `verdict.decision === "PASS"` → unchanged (still field name `decision`).
- Existing `failure_reasons` / `hit_flags` / `resume_augmentation` consumers in the agent are replaced with reads of `explanations[]` filtered by status. `resume_augmentation` is dropped — Robohire receives the resume verbatim (the prior "annotate resume" pathway was experimental and not load-bearing for FAIL/PASS outcomes).

## Error policy

| Condition | Behavior |
|---|---|
| Pre-fetch `candidate` / `job_requisition` 404 | slot = null; LLM marks dependent rules `insufficient_info` |
| Pre-fetch list slot 404 | slot = []; LLM proceeds |
| 401 unauthorized on ontology API | fail-safe FAIL, `audit.fail_reason = "ontology-graph-unavailable"` |
| 502 neo4j-unavailable | fail-safe FAIL, same reason |
| LLM gateway misconfigured | fail-safe FAIL, `audit.fail_reason = "llm-call-error"` (existing behavior, retained) |
| Tool-use loop exceeds 5 iterations | fail-safe FAIL, `audit.fail_reason = "tool-use-loop-exceeded"` |
| Final response not valid JSON | fail-safe FAIL, `audit.fail_reason = "parse-error"` |
| Stats counts don't sum to `stats.total` | log warning, accept as-is; LLM authoritative |

## Stats semantics

| stats key | Maps to which evaluation outcome |
|---|---|
| `pass` | rule applicable, action ∈ {通过, 加分, 跳过, 标记风险继续(when minor flag)} |
| `fail` | action = 终止匹配 |
| `pending` | action = 挂起待人工 (typically `pending_human_review`) |
| `insufficient_info` | judgment ∈ {待补充信息, 信息不足无法判断} |
| `not_triggered` | submissionCriteria 未成立 |
| `not_executed` | short-circuited by a prior FAIL in the same eval pass |
| (n/a) | `total` = sum of the six above |

The prompt's §6 OUTPUT-schema block reproduces this mapping in human terms so the LLM emits consistent labels.

## Tests (vitest)

`lib/rule-check/instance-client.test.ts` (new):
- `getInstance` 200 / 404 / 401 / 502 — assert URL, headers (`Authorization: Bearer …`, `?domain=…`), response parsing.
- `listInstances("Application", { candidate_id })` → asserts query-string assembly, returns `items[]`.
- `listLinks({ from, type })` → asserts query-string + parsed list.

`lib/rule-check/graph-context.test.ts` (new):
- Happy path: all five slots populated; resulting bundle keys match.
- Partial failure: `applications` 404 → slot = []; other slots populated.
- Cache hit: second `getInstance("Candidate", id)` within the same bundle does NOT re-call fetch.
- `candidate` 404 → slot = null, bundle still returned (LLM handles).
- `getInstance` 401 → throws (caller decides fail-safe).

`lib/rule-check/runner.test.ts` (extend existing):
- Mock fetch + mock `chatComplete` to return canned tool-free JSON → assert `MatchResumeCheckResult` shape, stats counts, fold-to-decision logic (FAIL when any `fail`, REVIEW when any `pending`/`insufficient_info`, PASS otherwise).
- Tool-use round: mock LLM to emit one tool_calls round → assert dispatcher hits cache → assert second LLM call sees tool message → final JSON parsed.
- Tool-use loop cap: mock LLM to always emit tool_calls → assert loop terminates at 5 iterations → result is fail-safe FAIL with audit reason.
- Graph 401: mock fetch with `ok: false, status: 401` → result FAIL with `audit.fail_reason="ontology-graph-unavailable"`.
- Set order in prompt: spy on `chatComplete` input → assert section 4 contains "Set 1 ... Set 2 ... Set 3 ... Set 4" in that order and the short-circuit constraint paragraph.

`lib/rule-check/prompt.test.ts` (new):
- Given a grouped-steps fixture, rendered prompt has rules under Set headers in `order` ascending, with rules in array order (not re-sorted by id).
- The "执行约束" block is present verbatim.
- GRAPH_CONTEXT block emits each slot under its named subsection, `null` printed when slot missing.

## Open issues (deferred)

- `yeyang-runner.ts` alternate prompt source doesn't get the neo4j context. Toggle via `RULE_CHECK_PROMPT_SOURCE=yeyang` still works against the old behavior. Pin or remove in a follow-up.
- `lib/prompts/match-resume.ts` and `scripts/run-match-resume-prompt.ts` are retired by this design. Removal can land separately to keep this PR focused.
- `chatCompleteWithTools` (or the optional-`tools` param on `chatComplete`) — exact API shape decided during implementation; the design prefers the optional-param form to keep one entry point.
- HTTP retry / timeout for instance-client. Today's `fetchAction` in `lib/ontology-gen` has `timeoutMs: 5000` and no retry; we'll mirror that posture.

## Acceptance criteria

- [ ] `runRuleCheck(input)` returns `MatchResumeCheckResult` (new shape) for a successful end-to-end run against a live ontology service.
- [ ] All vitest cases above pass.
- [ ] `npm run build` is green.
- [ ] `matchResumeAgent` migrated to consume the new shape in the same PR.
- [ ] Prompt visibly forces Set order + short-circuit semantics; a manual run against the production fixture produces a `MatchResumeCheckResult` whose `explanations` honor the order.
- [ ] `chatComplete` in `server/llm/gateway.ts` exposes a tools entry point usable by both the old (no-tool) callers and the new tool-use loop.
