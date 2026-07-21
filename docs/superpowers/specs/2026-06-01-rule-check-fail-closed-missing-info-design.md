# Rule-check fail-closed on missing info (insufficient_info / pending / not_executed)

**Date:** 2026-06-01
**Status:** Design — pending implementation
**Area:** `lib/rule-check/`, `server/inngest/agents/rule-check-agent.ts`, rule-check UI + i18n

## Problem

Today the rule-check decision is **binary PASS/FAIL** and **fail-open on uncertainty**.
`foldDecision()` ([lib/rule-check/runner.ts:266-276](../../../lib/rule-check/runner.ts#L266-L276))
folds *every* non-`fail` per-rule status into PASS — including `insufficient_info`
(rule applies but the resume doesn't carry the field) and `pending` (rule needs HSM
subjective judgment). Only a confirmed `fail` (cited violation) blocks.

Consequence (the motivating example): a candidate who worked at 腾讯CDG, where a
mandatory rule requires 正式编制, but the resume never states 编制 status. The rule
*is* triggered (they worked at CDG), the verifying field is missing → LLM returns
`insufficient_info` → **today this silently PASSes.**

**Desired policy:** for a mandatory rule we can't auto-confirm, the candidate must
**not pass**. We fail-closed, the reason explains *why* (and flags it for 人工复核),
and — per the user — this is treated as a **FAIL** that writes `未通过` to the partner
main table exactly like a confirmed violation (no separate hold/queue).

## Decisions (locked with the user)

1. **Outcome = FAIL.** `insufficient_info` on a mandatory rule blocks (不通过). No new
   third "REVIEW" decision; the candidate is failed.
2. **Same write path.** A missing-info FAIL writes `match_status='未通过'` to partner-pg
   and emits `MATCH_RULE_CHECK_FAILED` exactly like a confirmed violation — **no
   distinction in the write**. The human-review signal lives in the **reason text**.
3. **Scope of blocking statuses:** `insufficient_info`, `pending`, **and** `not_executed`
   all fail-closed (anything the agent can't auto-confirm).
4. **Severity gate:** blocking on these statuses applies to **底线规则 = `terminal` +
   `needs_human`** (i.e. `severity !== 'flag_only'`). Because `flag_only`/optional rules
   are already filtered out of scope by the fetcher, in practice this is *every in-scope
   rule*. The gate is implemented explicitly anyway (future-proof; unknown severity →
   treated as blocking = fail-closed default).
5. **Per-rule classification is UNCHANGED.** The LLM still classifies honestly:
   missing field → `insufficient_info` (never `fail`; `fail` still requires a cited
   value). Only the **server-side fold** and the **reason composition** change. The
   LLM is *not* told the new fold (so it has no incentive to shade `insufficient_info`
   → `pass` to dodge a block).
6. **Second verifier (二次验证) must learn the new policy** — otherwise it systematically
   disagrees with every new missing-info FAIL and tanks the confidence score. It also
   gets a new `INSUFFICIENT_INFO` second-verdict so it can mirror + annotate.
7. **UI shows 通过/不通过 (zh) / pass/fail (en)** via a shared `verdictLabel()` helper.
   Per-rule states stay granular internally; only the *display* collapses/localizes.

### Non-goals / out of scope

- Confirmed `fail` keeps blocking **regardless of severity** (unchanged from today). The
  severity gate applies only to the *newly*-blocking statuses.
- No new human-review queue/UI workflow. Review happens via the existing audit-detail
  page (per-rule flags already distinguish INSUFFICIENT_INFO/REVIEW from FAIL).
- `pending`→verify-agreement nuance (original flag result `REVIEW`) is left on the
  existing UNSURE handling; only `insufficient_info` gets a mirrored second-verdict this
  pass. Noted as a possible follow-up.
- No change to rule extraction / ontology data. The example only works if a 编制 rule
  exists and is triggered — that's ontology config, not this change.

## Architecture / components

The change is narrow and lives at three seams: **fold**, **reason composition**, and
**display**, plus the **verifier prompt**. One shared status→tag helper keeps the four
reason sites consistent.

### A. Severity-aware fold — `lib/rule-check/runner.ts`

Replace the stats-only `foldDecision(stats)` with a severity-aware fold over
`rule_results`. Build a `severityByRuleId` map from the fetched rules
(`Rule.severity`, already derived from `enforcementLevel`+`failurePolicy` at fetch time —
see [ontology.ts:37-40](../../../lib/rule-check/ontology.ts#L37-L40)).

```ts
const BLOCK_WHEN_UNCONFIRMABLE: RuleStatus[] = ['insufficient_info', 'pending', 'not_executed'];

export function foldDecision(
  rule_results: RuleResult[],
  severityByRuleId: Map<string, Severity>,
): 'PASS' | 'FAIL' {
  for (const r of rule_results) {
    if (r.status === 'fail') return 'FAIL';           // confirmed violation — blocks regardless of severity
    if (BLOCK_WHEN_UNCONFIRMABLE.includes(r.status)) {
      const sev = severityByRuleId.get(r.rule_id) ?? 'terminal'; // unknown → fail-closed
      if (sev !== 'flag_only') return 'FAIL';         // 底线规则(terminal/needs_human) can't be confirmed → 不通过
    }
  }
  return 'PASS';
}
```

- Caller (`runRuleCheck`) builds `severityByRuleId` from `sourceResult.rules` and passes it.
- Update the dated comment block to the 2026-06-01 fail-closed policy.
- The decision type stays `'PASS' | 'FAIL'`. The dead `'REVIEW'` in
  `MatchResumeCheckResult['decision']` ([types.ts:134](../../../lib/rule-check/types.ts))
  may be removed as opt-in cleanup (verify no remaining references to the *decision-level*
  REVIEW; the per-rule flag `'REVIEW'` string is separate and stays).

### B. Reason composition — widen + annotate (shared helper)

`result.explanations` already excludes `pass`/`not_triggered`
([runner.ts:240-249](../../../lib/rule-check/runner.ts#L240-L249)), so it is exactly the
set `{fail, insufficient_info, pending, not_executed}` — the blocking set. The four sites
that currently `.filter(e => e.status === 'fail')` drop that filter (use all explanations)
and format each line through one shared helper:

```ts
// lib/rule-check/runner.ts (exported) — single source of truth for the human-review tag.
export function explanationTag(status: RuleStatus): string {
  switch (status) {
    case 'insufficient_info': return '（信息不足·需人工复核）';
    case 'pending':           return '（需 HSM 人工复核）';
    case 'not_executed':      return '（未能评估·需人工复核）';
    default:                  return ''; // 'fail' — confirmed violation, no tag
  }
}
export function formatExplanation(e: RuleExplanation): string {
  return `[${e.rule_id}] ${e.rule_name}${explanationTag(e.status)}: ${e.reason ?? ''}`;
}
```

Apply at all four sites in
[server/inngest/agents/rule-check-agent.ts](../../../server/inngest/agents/rule-check-agent.ts):

| Site | Lines | Field | Change |
|---|---|---|---|
| Prisma audit | 424-428 | `failure_reasons` | all explanations + tag |
| Neo4j CMR | 514-521 | `rule_check_reason` | all explanations + tag |
| partner-pg + event | 566-578 | `failedRules` / `failureReason` (→ `match_reason` + `MATCH_RULE_CHECK_FAILED.rule_check_reason`/`failed_rules`) | all explanations + tag |

Result: a candidate failing *purely* on `insufficient_info` no longer has a blank reason
— `match_reason`, `rule_check_reason`, the event, and the audit all read e.g.
`[10-5] 腾讯CDG正式编制核验（信息不足·需人工复核）: 简历未提供编制字段，无法确认`.

Also update the stale policy comments at
[rule-check-agent.ts:419-421](../../../server/inngest/agents/rule-check-agent.ts#L419-L421)
and [540-542](../../../server/inngest/agents/rule-check-agent.ts#L540-L542).

> The per-rule **flag** rows (462-488) stay granular (`INSUFFICIENT_INFO` / `REVIEW` /
> `FAIL` / `PASS` / `NOT_TRIGGERED`) — that breakdown is what a reviewer reads to tell an
> info-gap fail from a hard violation. No change there.

### C. Prompt — neutralize the stale fold text (keep classification honest)

`lib/rule-check/prompt.ts`:

- **`DECISION_FOLD_BLOCK` (60-66)** currently tells the LLM "insufficient_info 与 pending
  都不阻断" — now false. Rewrite §6 to: *server computes the final decision; you only
  output `rule_results[]`; classify each rule's true status per §5 and do **not** change
  a status to influence the outcome.* Do **not** reveal that these statuses now block
  (avoids an incentive to mis-classify missing-info as `pass`).
- **§7 next_action note (line 82)** — drop the misleading "（人工复核，不阻断）" /
  "（…，不阻断）" parentheticals on `pending`/`insufficient_info`. `next_action` stays an
  advisory per-rule field (review/supplement); the decision is what blocks now.
- **§5 decision tree (24-58)** and the self-check (94-99) are unchanged — they keep the
  invariant "missing field → insufficient_info, never fail".

### D. Second verifier (二次验证) — `lib/rule-check/verify-prompt.ts`

1. **`VERIFY_SYSTEM_PROMPT`** gains the new policy so the cross-check agrees with
   missing-info FAILs instead of flagging them as errors:
   > 评分政策(2026-06-01):强制规则(底线/需人工)若所需信息缺失或无法自动确认 → 应判
   > **不通过**(原模型会标 INSUFFICIENT_INFO/REVIEW)。凡 agent 无法自证达标的都不放行。
   > 你应认可这类"信息不足→不通过"为**正确**结论;若你也认为信息不足,`second_verdict`
   > 用 `INSUFFICIENT_INFO`,并在 `judgment_reasoning` 写明"因信息不足而不通过"。
2. **`SecondVerdict`** = `'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'INSUFFICIENT_INFO' | 'UNSURE'`.
   - `normSecondVerdict` (345-350): recognize `INSUFFICIENT_INFO` / `INSUFFICIENTINFO` /
     `INSUFFICIENT` aliases.
   - `verdictsAgree` (356-361): `second === 'INSUFFICIENT_INFO'` agrees iff
     `original === 'INSUFFICIENT_INFO'`. (Keeps the agreement-rate honest under the new
     policy; `UNSURE` still never agrees.)
   - Output-schema enum line (182) updated to list `INSUFFICIENT_INFO`.

### E. UI — shared `verdictLabel()`, localized 通过/不通过 / pass/fail

Add a shared helper (e.g. `components/rule-check/verdict-label.ts` or a small export in
an existing rule-check UI util) that maps a decision/flag-result string to a localized
label via `t()`:

| Internal | zh | en |
|---|---|---|
| decision `PASS` / flag `PASS` | 通过 | pass |
| decision `FAIL` / flag `FAIL` | 不通过 | fail |
| flag `INSUFFICIENT_INFO` | 不通过·信息不足 | fail (insufficient info) |
| flag `REVIEW` (pending) | 不通过·待 HSM 复核 | fail (HSM review) |
| flag `NOT_TRIGGERED` / `NOT_APPLICABLE` | 不适用 | N/A |

Apply at:

- **Decision banner** — [RuleCheckAuditDetailDrawer.tsx:436](../../../components/rule-check/RuleCheckAuditDetailDrawer.tsx#L436)
  renders raw `detail.decision` → `verdictLabel(detail.decision, t)`. (Component needs
  `useApp()`.)
- **Per-rule badges** — [RuleSelectionVerifyTab.tsx:395, 524, 584](../../../components/rule-check/RuleSelectionVerifyTab.tsx#L395)
  render raw `flag.result` / `o.original_result` → `verdictLabel(...)`.
- **Result strip** — `RuleResultStrip` (190-213): the "✗" count includes
  `FAIL + INSUFFICIENT_INFO + REVIEW`; "⊘" = `NOT_TRIGGERED/NOT_APPLICABLE`; localize labels.
- **Second-verdict badge** — `SV_META` (1054-1059) gains an `INSUFFICIENT_INFO` entry
  (zh "不通过·信息不足" / variant `err`).
- **Other surfaces** — `/rule-check` list, matrix, stats: replace any raw decision render
  with the same `verdictLabel()` helper.

### F. i18n keys — `lib/i18n.tsx` (add under both `zh` and `en`)

`rc_verdict_pass`, `rc_verdict_fail`, `rc_verdict_insufficient`, `rc_verdict_review`,
`rc_verdict_na`, plus `rc_sv_insufficient` for the second-verdict badge. Follow the
existing `rc_*` namespace; values per the table in §E. (Aligns with the "no dev jargon in
user-facing UI" rule.)

## Data flow (after change)

```
LLM per-rule status (UNCHANGED: insufficient_info / pending / fail / …)
        │
        ▼
foldDecision(rule_results, severityByRuleId)        ← NEW: fail-closed, severity-gated
        │  fail  OR  (insufficient_info|pending|not_executed on severity≠flag_only)
        ▼
   decision = FAIL
        │
        ├─ Prisma audit.failure_reasons       (all explanations + tag)   ← NEW tag
        ├─ Neo4j CMR.rule_check_reason='未通过' (all explanations + tag)   ← NEW tag
        ├─ partner-pg match_status='未通过' + match_reason (tagged)        ← NEW tag
        └─ emit MATCH_RULE_CHECK_FAILED (rule_check_reason tagged)         ← NEW tag

二次验证 verifier: knows new policy → agrees with missing-info FAIL, can mirror
                  second_verdict=INSUFFICIENT_INFO + annotate                ← NEW

UI: verdictLabel() → 通过/不通过 (zh) | pass/fail (en) everywhere decision shown  ← NEW
```

## Edge cases

- **Confirmed `fail` on any severity** → blocks (unchanged).
- **Unknown severity** for a rule_id (catalog miss) → treated as blocking (fail-closed default).
- **Candidate fails only on `insufficient_info`** → reason is non-empty + tagged (the bug
  this design fixes).
- **Verifier sees `original_result = INSUFFICIENT_INFO`** → with the new policy + verdict
  it can return `INSUFFICIENT_INFO` and count as agreement (no false "disagree").
- **`infra` failures** (llm-call-error, ontology-graph-unavailable, parse-error, …) are
  unchanged: they still throw → Inngest retry+park, candidate **not** rejected. Missing-info
  fails have `fail_reason = undefined`, so they flow through the normal FAIL path, never the
  infra-park branch.

## Consequences / trade-offs

- **FAIL rate rises** (intended fail-closed posture): more `未通过` rows in partner-pg and
  more `MATCH_RULE_CHECK_FAILED` events. Mitigation: every such reason is tagged
  「信息不足·需人工复核」 so reviewers can filter info-gap fails from hard violations, and
  per-rule flags keep the granular breakdown.
- Downstream consumers of `MATCH_RULE_CHECK_FAILED` see higher volume.

## Testing (vitest)

- `foldDecision`: insufficient_info-only → FAIL; pending-only → FAIL; not_executed-only →
  FAIL; not_triggered-only → PASS; pass-only → PASS; mixed; flag_only severity on a
  missing-info status → PASS (gate); unknown severity → FAIL (default).
- Reason composition: a missing-info-only FAIL yields a non-empty, tagged
  `failureReason` / `failure_reasons` / `rule_check_reason`.
- `verify-prompt`: `normSecondVerdict` parses `INSUFFICIENT_INFO`; `verdictsAgree`
  INSUFFICIENT_INFO↔INSUFFICIENT_INFO true, vs others false.
- UI: `verdictLabel()` returns the right zh/en strings for each internal value.
- Update existing tests that assert insufficient_info/pending → PASS.
```
