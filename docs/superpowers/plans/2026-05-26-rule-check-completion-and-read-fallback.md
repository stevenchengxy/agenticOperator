# Rule-Check Completion + Read Fallback — Implementation Plan

> **For agentic workers:** Implement with TDD. Steps use checkbox (`- [ ]`) syntax. Per-file baseline diff to guarantee zero new failures (repo has ~29 pre-existing/environmental failures).

**Goal:** Finish rule-check (3-tier provenance, detailed LLM judgment + next_action, REVIEW→PASS, FAIL unconditional partner-pg write, full i18n) and add a Neo4j↔Postgres read fallback.

**Architecture:** Library-layer changes in `lib/rule-check/*`, agent wiring in `server/inngest/agents/rule-check-agent.ts`, audit API + drawer UI, i18n in `lib/i18n.tsx`, and a centralized read-fallback in `lib/rule-check/instance-client.ts`.

**Tech Stack:** Next.js 16 · TypeScript · vitest · Inngest · Allmeta Ontology API (Neo4j) · partner Postgres.

Spec: [docs/superpowers/specs/2026-05-26-rule-check-completion-and-read-fallback-design.md](../specs/2026-05-26-rule-check-completion-and-read-fallback-design.md)

---

## Phase ordering

1. **Storage core** — REVIEW→PASS fold + FAIL unconditional partner-pg main-row write (lean writer). Smallest, highest-confidence, user's deepest focus.
2. **LLM detail + next_action** — types/prompt/runner/audit-route.
3. **3-tier provenance** — api-rule-fetcher + audit + UI surfacing.
4. **i18n** — drawer + page, remove all English.
5. **Read fallback** — instance-client Neo4j↔pg (independent, can be parallel).

---

## Chunk 1: Storage core (REVIEW→PASS + FAIL pg write)

### Task 1.1: Fold `pending` → PASS in `foldDecision`

**Files:** Modify [lib/rule-check/runner.ts](../../../lib/rule-check/runner.ts) · Test [lib/rule-check/runner.test.ts](../../../lib/rule-check/runner.test.ts) (note: runner.test has 11 pre-existing stale-mock failures; add a focused unit test on `foldDecision` if exportable, else test via a small pure helper).

- [ ] Add/adjust test: stats with `pending>0` and `fail==0` → decision `PASS` (was `REVIEW`).
- [ ] Run → fails.
- [ ] Change `foldDecision`: drop the `if (stats.pending>0) return 'REVIEW'` line; pending folds into PASS. Keep `MatchResumeCheckResult['decision']` type as `'PASS'|'FAIL'` (drop `'REVIEW'`), update references.
- [ ] Run → passes. Typecheck the changed files.

### Task 1.2: Remove `待人工复核` third state in the agent

**Files:** Modify [server/inngest/agents/rule-check-agent.ts](../../../server/inngest/agents/rule-check-agent.ts) (`ruleCheckResult` ternary ~:434, REVIEW branches ~:447/:479).

- [ ] `rule_check_result` becomes binary: `decision==='FAIL' ? '未通过' : '通过'`. Remove `待人工复核` and `isReview` logic. PASS payload `rule_check_result='通过'`, `rule_check_reason=''`.
- [ ] Typecheck.

### Task 1.3: Lean unconditional partner-pg FAIL writer

**Files:** Create `lib/partner-pg/rule-check-result.ts` · Test `lib/partner-pg/rule-check-result.test.ts` · Modify rule-check-agent FAIL branch (~:531).

- [ ] Test (mock `withTx`/`query`): `saveRuleCheckFailToPartnerPg({candidate_match_result_id, candidate_id, job_requisition_id, client_id, match_reason})` upserts `candidate_match_result` with `match_status='未通过'`, `match_reason`, `match_score=null` — **regardless of job_posting** (no posting lookup, no runtime_state, no sparser guard). INSERT when absent, UPDATE when present.
- [ ] Run → fails.
- [ ] Implement: a single `withTx` that `SELECT 1 FROM candidate_match_result WHERE candidate_match_result_id=$1` then UPDATE-or-INSERT (`match_score=null, match_reason, match_status='未通过', stage='rule_check', created_by`). Use only columns confirmed present (candidate_match_result_id, candidate_id, job_requisition_id, match_score, match_reason, match_status, stage, created_by, created_at, updated_at).
- [ ] Run → passes.
- [ ] Wire agent FAIL branch to call `saveRuleCheckFailToPartnerPg` instead of `saveMatchResultsToPartnerPg`. Keep soft-fail.
- [ ] Typecheck. Per-file baseline diff.

---

## Chunk 2: LLM detail + next_action

### Task 2.1: Extend `RuleResult` with `next_action`

**Files:** Modify [lib/rule-check/types.ts](../../../lib/rule-check/types.ts).

- [ ] Add `next_action?: 'continue'|'block'|'supplement'|'review'` to `RuleResult` and `RuleExplanation`.

### Task 2.2: Prompt — detailed reason + next_action schema

**Files:** Modify [lib/rule-check/prompt.ts](../../../lib/rule-check/prompt.ts) · Test [lib/rule-check/prompt.test.ts](../../../lib/rule-check/prompt.test.ts).

- [ ] Test: rendered prompt contains next_action enum guidance + "详细" instruction for fail; schema block shows `next_action`.
- [ ] Run → fails.
- [ ] Update OUTPUT_SCHEMA + reason-length guidance: fail/pending/insufficient_info → detailed (触发判定→字段取值→逻辑→结论); pass/not_triggered → short. Add `next_action` to schema with the enum + mapping rules.
- [ ] Run → passes.

### Task 2.3: Runner parses `next_action`

**Files:** Modify [lib/rule-check/runner.ts](../../../lib/rule-check/runner.ts) `coerceRuleResults`.

- [ ] Test: a rule_result with `next_action:'block'` is preserved; invalid/missing defaults by status (fail→block, pass→continue, insufficient_info→supplement).
- [ ] Run → fails. Implement. Run → passes.

### Task 2.4: Audit route maps next_action (not empty string)

**Files:** Modify [app/api/rule-check-audits/[auditId]/route.ts](../../../app/api/rule-check-audits/[auditId]/route.ts) `extractRawFlagsByRuleId`.

- [ ] `next_action` comes from rule_results (or status-derived default) instead of `''`.

---

## Chunk 3: 3-tier provenance

### Task 3.1: Provenance in the fetcher

**Files:** Modify [lib/rule-check/api-rule-fetcher.ts](../../../lib/rule-check/api-rule-fetcher.ts) · Test [lib/rule-check/api-rule-fetcher.test.ts](../../../lib/rule-check/api-rule-fetcher.test.ts).

- [ ] Add pure `classifyTier(rule)` + `ruleProvenance(rule, clientName, bg)` → `{tier, included, reason}`. Test: CDG rule for IEG → `{tier:'department', included:false, reason:'排除：规则部门=CDG ≠ 岗位 bg=IEG'}`; 通用 → `{tier:'general', included:true, ...}`.
- [ ] Run → fails. Implement (reuse `ruleSurvivesFilter` internals). Run → passes.
- [ ] `RuleFetchResult` gains `provenance: RuleProvenance[]`; populate in `fetchRulesViaOntologyApi`; log it.

### Task 3.2: Persist + surface provenance

**Files:** Modify runner (thread provenance into audit), rule-check-agent (persist into `filtered_out_rules`/new field), audit route + drawer (display).

- [ ] Persist provenance JSON to audit; render a "为何纳入/排除" section in the drawer (i18n keys).

---

## Chunk 4: i18n

### Task 4.1: Audit + key extraction

**Files:** [components/rule-check/RuleCheckAuditDetailDrawer.tsx](../../../components/rule-check/RuleCheckAuditDetailDrawer.tsx), other `components/rule-check/*`, [app/rule-check/page.tsx](../../../app/rule-check/page.tsx) · [lib/i18n.tsx](../../../lib/i18n.tsx).

- [ ] Grep hardcoded strings (incl. English "LLM evidence"). Add zh/en keys under a `rc_*` namespace. Replace literals with `t()`.
- [ ] Scan test / grep for residual non-`t()` user-facing strings.

---

## Chunk 5: Read fallback (independent)

### Task 5.1: Per-entity pg→ontology normalizers

**Files:** Create `lib/rule-check/pg-fallback.ts` · Test `lib/rule-check/pg-fallback.test.ts`.

- [ ] For each of Candidate / Resume / Job_Requisition / Application / Candidate_Match_Result: a `normalize<Entity>(pgRow) → ontologyShape` using [docs/ao-allmeta-field-alignment-table.md](../../ao-allmeta-field-alignment-table.md). Test each mapping (e.g. pg `job_requisition_id` → ontology `job_position_id`).

### Task 5.2: Wrap instance-client reads with fallback

**Files:** Modify [lib/rule-check/instance-client.ts](../../../lib/rule-check/instance-client.ts).

- [ ] `getInstance` returns null → query mapped pg table → normalize → return (logged as fallback hit). `listInstances` `[]` → same. Cache. Relationships (`listLinks`) unchanged (out of scope v1).
- [ ] Tests with mocked fetch (Neo4j miss) + mocked pg reader → returns normalized row.

---

## Done criteria

- All new tests green; per-file baseline diff shows zero new failures.
- `npx tsc --noEmit` clean for all changed files.
- Rule-check page renders zh/en with no English leakage.
