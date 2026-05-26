# Rule-Check Completion + Neo4j↔Postgres Read Fallback — Design

**Date:** 2026-05-26
**Status:** Approved (brainstorm dialogue), pending implementation
**Author:** AO (with Steven)

## Context

Two related workstreams emerged from debugging the 陈思颖 rule-check case (CDG 规则错套到腾讯 IEG 岗位 + 极性误判 fail):

1. **Rule-check completion** — finish the rule extraction + LLM judgment + storage so results are explainable and correctly persisted.
2. **Read fallback** — AO dual-writes to Neo4j (Allmeta ontology) and partner Postgres (RAAS legacy DB). Reads should degrade gracefully: if one store misses, fall back to the other.

The earlier bug fixes (department filter, prompt polarity, severity lookup) already landed this session. This spec covers the remaining work.

## Workstream 1 — Rule-check completion

### 1.1 抓取:显式三层 + provenance（为何纳入/排除）

Today `fetchRulesViaOntologyApi` ([lib/rule-check/api-rule-fetcher.ts](../../../lib/rule-check/api-rule-fetcher.ts)) flat-filters rules via `ruleSurvivesFilter(r, clientName, bg)`. The outcome is correct (通用 ∪ 客户级 ∪ 部门级) but opaque.

**Change:** tag every rule with provenance and surface it.

```ts
type RuleProvenance = {
  rule_id: string;
  tier: 'general' | 'client' | 'department';  // 通用(CSI) / 客户 / 客户部门
  included: boolean;
  reason: string;  // "通用规则，无条件纳入" / "客户=腾讯 命中" /
                   // "部门=CDG 命中 bg=CDG" / "排除：规则部门=CDG ≠ 岗位 bg=IEG" /
                   // "排除：bg 未解析，部门专属规则 fail-closed"
};
```

- `RuleFetchResult` gains `provenance: RuleProvenance[]`.
- Persist to audit (extend the existing `filtered_out_rules` column → a richer `rule_provenance` payload; keep backward-compat reads).
- Surface in the audit detail UI so an operator can see why each rule was/wasn't fetched.

### 1.2 Check:LLM 详细判定 + next_action

Today the LLM emits `{rule_id, status, reason(≤40字)}` and **no next_action** (UI step ② shows "(未给)").

**Change** ([types.ts](../../../lib/rule-check/types.ts) · [prompt.ts](../../../lib/rule-check/prompt.ts) · [runner.ts](../../../lib/rule-check/runner.ts) · audit route):
- Per rule the LLM emits `{rule_id, status, reason, next_action}`.
- `reason` = **detailed for fail/pending/insufficient_info** (触发判定 → 字段取值 → 逻辑套用含极性 → 结论), **short for pass/not_triggered** (token budget).
- `next_action` enum **required**: `continue`(放行) / `block`(阻断) / `supplement`(补材料) / `review`. Mapping: fail→block, insufficient_info→supplement, pass/not_triggered→continue (pending folded away, see 1.3).
- `coerceRuleResults` parses `next_action`; audit route maps it onto the flag (no longer writes empty string).

### 1.3 决策:REVIEW → PASS

`foldDecision` ([runner.ts:244](../../../lib/rule-check/runner.ts)) currently returns `REVIEW` for `pending`. **Change:** fold `pending` → `PASS`. Remove the `待人工复核` third state; `rule_check_result` becomes binary `通过/未通过`. The agent's `decision !== 'FAIL'` PASS path stays; `MATCH_RULE_CHECK_PASSED` no longer carries 待人工复核.

### 1.4 存储:PASS 沿用现状；FAIL 无条件写 partner-pg 主表

Confirmed against RAAS schema (`raas_v4/backend/prisma/schema.prisma`): partner-pg `candidate_match_result` has **no** `rule_check_result`/`rule_check_reason` columns — only `match_score / match_reason / match_status` (+ AO-extended `job_posting_id / dimension_scores / core_tags / stage / experience_years`). `rule_check_*` live only on Allmeta/Neo4j.

| 结果 | Neo4j `Candidate_Match_Result` | partner-pg `candidate_match_result` |
|---|---|---|
| **PASS**（含原 REVIEW） | 沿用现状：unconditional write-cmr 写 `rule_check_result='通过'` | 不写（matchResume 下游建行） |
| **FAIL** | 写 `rule_check_result='未通过'` + `rule_check_reason`（现状已对） | **无条件**直写主表 `match_status='未通过'` + `match_reason=<原因>`, `match_score=null` |

**The fix:** today FAIL goes through the generic `saveMatchResultsToPartnerPg`, whose main-row write is gated by `if (resolvedJobPostingId)` and carries runtime_state + sparser guards meant for *match* results. A FAIL on a JR with no `job_posting` never lands in the main table. **Add a lean dedicated writer** that unconditionally upserts `candidate_match_result` with `match_status='未通过'` + `match_reason`, independent of posting and without the runtime_state/sparser machinery.

### 1.5 全量 i18n

Audit `app/rule-check/` + `components/rule-check/*` for hardcoded strings (incl. English like "LLM evidence"), route everything through `t()` in [lib/i18n.tsx](../../../lib/i18n.tsx) with zh/en keys. `RuleCheckAuditDetailDrawer.tsx` (1200+ lines) is the bulk.

## Workstream 2 — Neo4j↔Postgres read fallback

**Goal:** any agent reading an entity gets data even if one store misses. Bidirectional: Neo4j miss → try Postgres; (and where an agent reads Postgres-first, Postgres miss → try Neo4j).

**Where:** centralize in the read layer — [lib/rule-check/instance-client.ts](../../../lib/rule-check/instance-client.ts) `getInstance` / `listInstances` (all ontology reads funnel here). On Neo4j `null`/`[]`, query the mapped partner-pg table and normalize the row to the ontology shape.

**Mapping:** reuse [docs/ao-allmeta-field-alignment-table.md](../../ao-allmeta-field-alignment-table.md). Each entity gets a `pgRow → ontologyShape` normalizer (handles e.g. pg `job_requisition_id` ↔ ontology `job_position_id`, casing).

**Scope (first cut):** the 5 entities with clean pg tables — `Candidate`, `Resume`, `Job_Requisition`, `Application`, `Candidate_Match_Result`. **Relationships** (`EMPLOYED_BY` links, `Blacklist`) have no clean pg equivalent → out of scope for v1.

**Semantics:** primary store wins; fallback only triggers on miss → no conflict. Extra query only on miss; cache the result. Each fallback hit is logged (so silent divergence between stores is visible).

**Isolation:** this is a cross-cutting concern independent of rule-check. Separate phase/PR.

## Testing

TDD throughout. Per-file baseline diff (stash my changes, compare failure counts) to guarantee zero new failures — the repo has ~29 pre-existing/environmental failures unrelated to this work. i18n: a scan test for residual English / missing keys.

## Dependencies / open items

- **partner-pg has no rule_check columns** → FAIL stores into `match_status`/`match_reason` (decided; no RAAS change needed).
- The `raas_v4` schema on disk is an **old** RAAS mirror; the live table has more columns. `match_status`/`match_reason` are stable across both — safe to target.
- Read fallback assumes the pg readers (`lib/partner-pg/{candidates,parsed-resume,requirements}.ts`) exist for the core entities; verify coverage per entity during implementation.
