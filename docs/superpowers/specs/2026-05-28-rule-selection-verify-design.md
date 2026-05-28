# 规则筛选交叉验证 (Rule Selection Cross-Validation)

**Date:** 2026-05-28
**Area:** `/rule-check` audit detail drawer
**Status:** approved → implementing

## Problem

The rule-check audit detail drawer shows *what* the primary LLM decided (用户提示词 /
规则判定 / LLM 响应 / 实例数据) but gives the reviewer no independent signal of
*whether the rule selection + per-rule verdicts are trustworthy* for this specific
candidate × position. A leader/client looking at a PASS/FAIL has to take the single
model's word for it.

## Goal

Add a **first tab「规则筛选」** (before 用户提示词) that runs a **second, independent
LLM** to cross-check the rule check, and surfaces:

1. The selection/filtering evidence & reasoning (why this rule set, per existing
   `rule_provenance` + `filtered_out_rules`, re-judged by the verifier).
2. A **different model's** verdict on each rule (PASS/FAIL/NA/UNSURE) + reasoning.
3. A **confidence %** that the rule selection *and* verdicts are correct & applicable
   to this candidate-position match, broken down across multiple dimensions.

## Constraints / Decisions

- **Pure LLM, no heuristic fallback.** The second opinion + confidence come from a real
  `chatComplete` call (reuse `server/llm/gateway.ts`). No gateway configured → tab shows
  an honest "需配置 LLM gateway" empty state; we never fabricate a verdict.
- **Unified confidence** = selection-correct + verdict-correct, produced *by the verifier
  model* (not a hardcoded weighted sum). Per-dimension scores also model-produced. The
  two-model per-rule **agreement rate** is computed factually (comparing two real model
  outputs) and shown as a transparency metric alongside the gauge.
- **Auto-runs on tab open** (revised per user). The tab is first + default and the
  cross-validation kicks off automatically when it mounts (no CTA click) — "在运行中就
  直接进行交叉验证". Result cached in the drawer per `auditId`; "重新验证" re-runs.
  **No Prisma migration** (in-memory only).
- **Cross-family verifier.** `pickVerifierModel` chooses a model from a *different family*
  than the primary, using ids the gateway actually serves (gemini → `anthropic/claude-haiku-4.5`,
  claude → `openai/gpt-5.4-mini`); gateway-aware for the direct-OpenAI fallback; env
  override `RULE_CHECK_VERIFIER_MODEL`.
- **Flag resolution = same as detail route.** The `RuleCheckFlag` table is often empty, so
  the verify route reuses `extractRawFlagsByRuleId` + `mergeFlagsWithRawFallback` (exported
  from the detail route) to recover the full rule set from `llm_raw_text`. Without this the
  verifier sees 0 rules and wrongly reports "nothing was evaluated".
- **Verifier prompt feeds rule definitions.** Each rule's definition (title +
  submissionCriteria/logic) is extracted from the original `user_prompt` and inlined per
  rule (`extractRuleDefs`), with the primary's verdict/evidence — so the verifier can judge
  each rule and **echo the real rule_id** (e.g. `10-25`), which the agreement rate needs.

## Backend

### `lib/rule-check/verify-prompt.ts`
- Types: `RuleSelectionVerification`, `VerifyResponse`, `VerifierDimension`, `RuleOpinion`.
- `pickVerifierModel(primaryModel)`: `RULE_CHECK_VERIFIER_MODEL` env override; else a
  cross-family default that differs from `primaryModel` (gemini → `openai/gpt-4o-mini`,
  else gemini default). Returns `{ model }`.
- `composeVerifyPrompt(input)`: compact candidate profile + JD + full flag list (rule_id,
  name, severity, applicable, original result, evidence) + provenance (why included) +
  filtered_out (why excluded) + original decision. Bounded size (trim resume/JD to key
  fields). System prompt pins strict JSON schema.
- `parseVerification(rawText, flags)`: tolerant JSON parse (strip code fences); validate &
  coerce; compute factual `agreement_rate` from `rule_opinions` vs original flag results.

### `POST /api/rule-check-audits/[auditId]/verify`
- `force-dynamic`. Prisma reads audit + flags. Parse `parsed_resume_json` /
  `job_requisition_json` / `rule_provenance` / `filtered_out_rules`.
- `isGatewayConfigured()` false → `{ ok:false, reason:'gateway_unavailable' }`.
- Else `chatComplete({ system, user, model: verifierModel, maxTokens, temperature:0.2 })`.
- Parse → `{ ok:true, verification, primary_model, verifier_model, duration_ms, usage }`.
- Errors → `{ ok:false, reason:'parse_error'|'llm_error', error }`.

## Frontend

### `components/rule-check/RuleSelectionVerifyTab.tsx` (new file)
- Props: `{ detail, cached, onResult }` (cache lifted to the drawer Body, keyed by auditId).
- Auto-runs on mount (running → result | error); "重新验证" re-runs.
- **适配规则 (AdaptedRules)** — selection chain summary + one expandable card per rule.
  Each card expands to three sub-sections: ① 原规则 (reuses the shared `RuleDefinitionPanel`
  → `/api/ontology/rules/[ruleId]`, the live Neo4j rule via AllmetaOntology), ② 原模型 LLM
  judgment + evidence + provenance, ③ 第二模型验证 (the matched second opinion + agree/
  disagree). The card header shows an agree/disagree chip once verification completes, so
  "which rule" is never ambiguous (the standalone opinions list was removed).
- **Validation summary** — confidence ring gauge (sweep + count-up) + verdict + model pair +
  agreement rate; dimension bars (width grow, stagger); missing/over-included callouts; footer.
- POST via `fetchJson` with `timeoutMs: 90_000` (default 5s is too short for an LLM call).

### `components/rule-check/RuleDefinitionPanel.tsx` (extracted from the drawer)
- `RuleDefinitionPanel` + `RuleDefinitionBody` + `RuleField` + `OntologyRuleResponse`,
  moved out of the drawer so both the drawer and the verify tab import it (breaks the
  drawer ⇄ verify-tab import cycle).

### Wiring — `RuleCheckAuditDetailDrawer.tsx`
- `Tab` type gains `"verify"`; placed first; default `useState<Tab>("verify")`.
- New `TabBtn` 规则筛选; tab body renders `<RuleSelectionVerifyTab/>`.
- Verify result cache state in `RuleCheckAuditDetailBody`, keyed by `auditId`.

### `app/globals.css`
- New keyframes under the rc- motion block: ring stroke sweep, dimension bar width grow.
  Guard with `prefers-reduced-motion`.

### `lib/i18n.tsx`
- `rc_verify_*` keys in both `zh` and `en`.

## Out of scope / deferred
- Persisting verifications to Postgres (would need a Prisma migration + writer).
- Auto-running on drawer open.
