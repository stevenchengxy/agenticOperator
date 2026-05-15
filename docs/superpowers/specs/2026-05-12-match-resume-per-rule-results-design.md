---
title: matchResume rule check — per-rule debug visibility + neo4j-resourced resume
date: 2026-05-12
branch: create-action-prompt
status: approved
follows: 2026-05-12-match-resume-neo4j-rule-check-design.md
---

# matchResume rule check — per-rule debug visibility + neo4j-resourced resume

## Goal

Extend the just-shipped `MatchResumeCheckResult` so every evaluated rule's check result is visible (not just the rules that drove the decision), and route the resume input through neo4j instead of accepting it as a function parameter. Both changes are bounded to `lib/rule-check/`; downstream consumers (the `match-resume-agent`, Inngest event payloads) are NOT touched — the existing `explanations` field stays populated as a derived view so their reads continue to work.

## Non-goals

- Changes to `server/inngest/agents/match-resume-agent.ts` or `server/inngest/client.ts`.
- A retroactive cleanup of the deprecated `RuleCheckInput.resume` field at the call site — that lives in a follow-up.
- Reworking neo4j entity ↔ Resume linking (we use `list_instances("Resume", { candidate_id })`, accepting whatever cardinality the graph returns).
- Token-budget guard — per-rule output adds ~1000 tokens for a 25-rule call; we accept the cost.

## Output type — add `rule_results`, keep `explanations` derived

```ts
// New
export type RuleResult = {
  rule_id: string;
  rule_name: string;
  step_id: string;
  status: RuleStatus;   // full enum: pass | fail | pending | insufficient_info | not_triggered | not_executed
  /** Required when status ≠ 'pass' and ≠ 'not_triggered'. */
  reason?: string;
};

// Augmented (additive)
export type MatchResumeCheckResult = {
  decision: 'PASS' | 'FAIL' | 'REVIEW';
  stats: MatchResumeCheckStats;
  rule_results: RuleResult[];      // NEW — every rule in Set + within-set order
  explanations: RuleExplanation[]; // KEPT — derived from rule_results (filter to non-pass + non-not_triggered)
  audit: {...};
};
```

`RuleExplanation` keeps its narrower `status` type (`Exclude<RuleStatus, 'pass' | 'not_triggered'>`). The runner builds `explanations` by filtering `rule_results`. Downstream consumers see the same `explanations` shape they see today — no breaking change.

## Input type — `resume` becomes deprecated/optional

```ts
export interface RuleCheckInput {
  runtime_context: RuleCheckRuntimeContext;
  /** @deprecated Library now fetches resume from neo4j via candidate_id; this field is ignored. */
  resume?: Record<string, unknown>;
  job_requisition: Record<string, unknown> & { job_requisition_id: string };
  job_requisition_specification?: Record<string, unknown> | null;
  hsm_feedback?: Record<string, unknown> | null;
}
```

The existing caller (`buildRuleCheckInput({ parsed_resume })`) keeps building inputs with the field populated — the library now ignores it. A `@deprecated` JSDoc tells future maintainers (and most editors) that the field is no-op.

## Graph context — 6 slots

`buildGraphContext` now fans out 6 parallel fetches. The new slot is `resume`:

| Slot | Endpoint | Behavior on 404 / empty |
|---|---|---|
| `candidate` | `GET /instances/Candidate/{candidate_id}` | slot = null |
| `resume` (NEW) | `listInstances("Resume", { candidate_id }).then(rows => rows[0] ?? null)` | slot = null |
| `job_requisition` | `GET /instances/Job_Requisition/{job_requisition_id}` | slot = null |
| `applications` | `listInstances("Application", { candidate_id })` | slot = [] |
| `blacklist_hits` | `listInstances("Blacklist", { candidate_id })` | slot = [] |
| `employment_links` | `listLinks({ from: candidate_id, type: "EMPLOYED_BY" })` | slot = [] |

`fetch_count` floor goes from 5 → 6 after `buildGraphContext` returns.

`GraphContext` interface:

```ts
export interface GraphContext {
  candidate: Record<string, unknown> | null;
  resume: Record<string, unknown> | null;             // NEW
  job_requisition: Record<string, unknown> | null;
  applications: Array<Record<string, unknown>>;
  blacklist_hits: Array<Record<string, unknown>>;
  employment_links: Array<Record<string, unknown>>;
  fetch_count: number;
  _cache: Map<string, unknown>;
}
```

The tool dispatcher's `get_instance` branch is unchanged — if the LLM calls `get_instance("Resume", <id>)` for some specific resume, it follows the existing flow (cache check → HTTP call → cache).

**Rationale for `listInstances` over `runtime_context.resume_id`**: the user's explicit framing was "通过 candidate id 查询" — candidate is the stable handle, resume_id may not always be populated by the caller. If `listInstances` returns multiple rows (a candidate with multiple Resume nodes), we take the first. If the deployment requires "latest resume", that's a follow-up — we'll add a sort param when the data shape forces it.

## Runner changes

Pipeline keeps its shape; three localized edits:

1. **Drop the `projectResume(input.resume, ...)` call.** The resume now arrives via `graph.resume`, not `input.resume`. `projectResume` and `fieldsProjected` remain in `resume-projection.ts` (the function is unused by the runner but still exported so existing tests pass).
2. **Render the resume from graph context, not input.** The prompt's previous §2.2 (resume block) is dropped — the resume lives in §3 Graph context. This keeps a single source of truth for what the LLM sees.
3. **Coerce LLM's new shape.** Replace `coerceExplanations` with `coerceRuleResults` that accepts the broader status enum. Derive `explanations` from the result:

```ts
function coerceRuleResults(raw: unknown): RuleResult[] { /* accepts all 6 statuses */ }

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
```

`failSafe()` returns `rule_results: []` alongside the existing `explanations: []`.

## Prompt changes

- **Drop §2.2 (resume).** Inputs section now has 4 subsections: runtime_context, job_requisition, job_requisition_specification, hsm_feedback. (resume removed, since it's not in the input anymore.)
- **§3 Graph context gains `### 3.2 resume`.** The other slots shift down one number: 3.1 candidate, 3.2 resume, 3.3 job_requisition, 3.4 applications, 3.5 blacklist_hits, 3.6 employment_links. The note "已经按 candidate_id / job_requisition_id 预拉取" stays — resume now part of the same pre-fetch story.
- **§6 Output schema** updated to require `rule_results` (not `explanations`):

```json
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
```

Prompt text additions:
- "每条规则都必须有一条对应的 `rule_results` 条目，按 Set 顺序、Set 内列出顺序输出。"
- "`reason` 字段在 status ∈ {fail, pending, insufficient_info, not_executed} 时必填；status='pass' 或 'not_triggered' 时可填短说明也可省略。"
- "stats 各字段必须与 rule_results 中相应 status 的计数一致；任何不一致以 rule_results 为准（runner 会按 rule_results 重新计算 stats）。"

That last point matters: the **runner recomputes stats from the rule_results** rather than trusting the LLM-emitted `stats`. This eliminates an LLM hallucination surface and ensures `decision` always reflects the actual rule outcomes.

## Stats — now derived from rule_results

```ts
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

The LLM's emitted `stats` is ignored. Fewer guarantees needed from the model.

## Error policy

| Condition | Behavior |
|---|---|
| Resume slot empty (no Resume row for candidate_id) | slot = null; LLM marks resume-dependent rules `insufficient_info`. No fail-safe. |
| 401 / 5xx on the Resume fetch | rolls into existing `ontology-graph-unavailable` (buildGraphContext throws). No new fail_reason. |
| LLM emits malformed `rule_results` OR fewer entries than filteredSteps had rules | `parse-error` fail-safe. The schema requires strict 1:1 emission (one entry per filtered rule); under-emission means the LLM didn't follow the contract and we don't trust the partial output. |

No new `fail_reason` enum literals. The strict-1:1 requirement matches the acceptance criterion below.

## Tests

`graph-context.test.ts` (extend existing 8 cases):
- Extend "fetches all five slots in parallel" → "fetches all six slots in parallel" with the resume slot populated via `mListInst` mock; assert `ctx.resume` and `ctx.fetch_count === 6`.
- Add "resume slot null when no row" — `listInstances('Resume', ...)` returns `[]` → `ctx.resume === null`.

`prompt.test.ts` (extend existing 8 cases):
- "renders the GraphContext section with named slots" — update to assert all 6 subsections including `### 3.2 resume`.
- "includes the new output schema with stats fields" — update to assert `rule_results` is mentioned and `explanations` is NOT (the LLM doesn't emit it).
- New test: "instructs LLM to emit one rule_results entry per rule, in Set order".

`runner.test.ts` (rewrite the 7 mock-LLM-response fixtures):
- FAIL case: LLM emits one `rule_results` entry with status='fail'; runner returns `decision='FAIL'`, `stats.fail=1`, and `explanations` contains that one entry.
- PASS case: LLM emits one entry with status='pass'; runner returns `decision='PASS'`, `explanations=[]`.
- REVIEW case: LLM emits one entry with status='pending'; `explanations` contains it.
- Test stat consistency: LLM emits 2 results (one pass, one fail) — runner-computed stats are `{ total: 2, pass: 1, fail: 1, ... }` regardless of any `stats` block the LLM may have included.
- New test: "derives explanations from rule_results (filters pass + not_triggered)" — LLM emits 4 entries (pass, fail, not_triggered, pending) → `explanations` length is 2 (fail + pending).

## Migration & compatibility

- `match-resume-agent.ts` continues to read `ruleCheck.explanations`, `ruleCheck.stats`, `ruleCheck.audit.*`. All three populated identically. No agent code change needed.
- `server/inngest/client.ts` event payload types unchanged (`failed_rules` still mapped from `explanations`).
- `RuleCheckInput.resume` becomes optional but still typed; the agent's `buildRuleCheckInput({ parsed_resume })` keeps working. The library logs a debug-level message once per `runRuleCheck` if `input.resume` is set (signaling that the field is being ignored), but doesn't change behavior.

## File map

| Path | Status | Change |
|---|---|---|
| `lib/rule-check/types.ts` | MODIFIED | Add `RuleResult` type; add `rule_results` to `MatchResumeCheckResult`; mark `RuleCheckInput.resume` deprecated/optional |
| `lib/rule-check/graph-context.ts` | MODIFIED | Add `resume` slot (parallel listInstances("Resume", { candidate_id }) → first row); update `GraphContext` interface |
| `lib/rule-check/graph-context.test.ts` | MODIFIED | Update "five slots" assertions to six; add "resume slot null" case |
| `lib/rule-check/runner.ts` | MODIFIED | Drop `projectResume` call; replace `coerceExplanations` with `coerceRuleResults` + `deriveExplanations` + `statsFromResults`; strict 1:1 check on `rule_results` count vs filteredSteps |
| `lib/rule-check/runner.test.ts` | MODIFIED | Rewrite fixture LLM responses to use `rule_results`; add explanations-derivation + stats-recompute tests |
| `lib/rule-check/prompt.ts` | MODIFIED | Drop §2.2 resume rendering; add §3.2 resume slot; rewrite §6 schema to require `rule_results`; instruct LLM "one entry per rule" |
| `lib/rule-check/prompt.test.ts` | MODIFIED | Update GraphContext subsection assertions; assert §6 mentions `rule_results` |

## Acceptance criteria

- [ ] `runRuleCheck(input)` returns a `MatchResumeCheckResult` whose `rule_results.length` equals `audit.rules_evaluated` (one entry per filtered rule).
- [ ] `explanations` matches `rule_results.filter(non-pass + non-not_triggered)` byte-for-byte.
- [ ] `stats` is the runner-computed aggregation, not the LLM's emitted block.
- [ ] All existing `lib/rule-check/*.test.ts` and `lib/rule-check/graph-context.test.ts` cases pass.
- [ ] `match-resume-agent.ts` compiles without modification and its existing reads of `ruleCheck.explanations` / `ruleCheck.stats` still work.
- [ ] `npm run build` is green.
- [ ] Manual smoke against a live ontology service produces a `MatchResumeCheckResult` with `rule_results.length > 0` and a populated `resume` graph slot.

## Open issues / deferred

- Multiple Resume rows per candidate: current behavior takes index `[0]`. If the data model evolves to require "latest by `updated_at`" or similar, we'll need a sort param on `listInstances`. Out of scope.
- `RuleCheckInput.resume` removal at the caller: out of scope per the user's "don't touch other code" constraint. A follow-up PR can drop the field + its `parsed_resume` carrier in `BuildInputArgs`.
- `runtime_context.resume_id` is now unused by the library. We don't remove it (could be useful for telemetry / linking). If it stays unused for a release cycle, future cleanup can drop it.
