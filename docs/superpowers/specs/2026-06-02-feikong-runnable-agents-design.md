# 费控-v1 Runnable Agent Pack — Design

**Date:** 2026-06-02
**Status:** Approved (user) — implementation in progress
**Author:** AO / Claude
**Related:** [2026-06-02-ontology-agent-generator-runnable-design.md](./2026-06-02-ontology-agent-generator-runnable-design.md) (the energy 能源调度-v1 delivery this mirrors), [project_energy_hitl_rulecheck], [project_ontology_runnable_agents]

## 1. Goal

Generate a **runnable** cost-control (费控-v1) agent pack from its ontology — workflow + actions + rules + data objects — exactly the way the energy-dispatch (能源调度-v1) pack was delivered: derived from the ontology, driven by deterministic hardcoded behaviors for the demo, with a real rule-check agent and human-in-the-loop (HITL) gates. The pack must:

1. Be **simulate-generatable** in the ontology agent generator UI (本体智能体生成器): 费控-v1 appears in the domain picker; infer → generate → deploy → run all work on it.
2. **Run end-to-end** ("跑通"): seed an expense claim → OCR → rule-check → budget → approval-suggestion → route → (auto-approve | manual-review HITL) → approval flow → ERP post → payment → archive; with a risk branch that suspends on L3/L4 and waits for a human.
3. Have a **correct rule-check agent** wired to the real 费控 rules (INV / STD / CMP / BUD groups), persisting auditable verdicts.
4. Have **use-case + instance data** that makes the flow run on real numbers, written both as in-code scenarios and as test-case data under `neo4j_data/费控-v1`.
5. Surface **all human messages in the notifications feed** (消息通知).
6. **Never pollute the production recruitment app** `agentic-operator-main` (`http://host.docker.internal:3002/api/inngest`, the "real 5 agents").

## 2. Non-goals

- No changes to the recruitment "real 5" agents or their event bus.
- No real OCR / ERP / bank integrations — all simulated deterministically for the demo.
- No live Allmeta dependency at runtime — the in-repo snapshot is the source of truth (Allmeta live read remains best-effort for the generator's infer step, as today).
- Not building a second website — the existing companion is extended into one multi-domain platform.

## 3. Isolation guarantee (the core constraint)

费控 agents run on a **separate Inngest app `agentic-operator-费控-v1`**, served at `/api/inngest/费控-v1` via the existing dynamic `[domain]` route, using a **domain-scoped Inngest client** (`new Inngest({ id: "agentic-operator-费控-v1" })`). They are **never** imported into `server/inngest/functions.ts`'s `allFunctions`.

This is the same boundary energy is supposed to have. The current reality (discovered during exploration): the energy "rich" functions (`energyFunctions`) are built with the **main** `inngest` client and were removed from `allFunctions` on 2026-06-02 to stop polluting recruitment — but never re-wired to a clean per-domain serve, so they are **orphaned/dormant** at HEAD. The generic per-domain app (`domain-app.ts`) only serves dumb DB *shells* (sleep + emit), which cannot do rule-check or HITL.

**Fix (chosen approach):** extend `domain-app.ts` with a **rich-pack registry** that serves real per-domain functions built with the per-domain client:

```ts
const RICH_DOMAIN_PACKS: Record<string, (client: Inngest) => InngestFunction[]> = {
  [ENERGY_DOMAIN_ID]:       (client) => buildEnergyFunctions(client),
  [COST_CONTROL_DOMAIN_ID]: (client) => buildCostControlFunctions(client),
};
```

`buildDomainFunctions(client, domain)` returns the rich pack (built with that domain's client, cached per domain) when one exists, else falls back to the existing shell path. This **re-homes energy** onto the clean mechanism and adds 费控 alongside it. The recruitment app is untouched.

**Verification of non-pollution:** a test asserts `allFunctions` (main app) contains zero slugs prefixed `energy-` or `feikong-`.

## 4. Shared factory parameterization

The energy factory `server/inngest/domains/energy/make-agent.ts` hardcodes `import { inngest }` and `ENERGY_BEHAVIORS`. To reuse it for 费控 (and to build with a per-domain client), add two opts:

- `opts.client: Inngest` — used for `client.createFunction(...)` (replaces the global `inngest`).
- `opts.behaviors: Record<string, Behavior>` — replaces the direct `ENERGY_BEHAVIORS` reference.

Energy keeps working (it passes its own client + `ENERGY_BEHAVIORS`). `domains/energy/index.ts` changes from a pre-built `energyFunctions` array to `buildEnergyFunctions(client)`. The factory + its helpers (`sim-tools`, `structured-output`, `run-state`, `is-active`) are generic enough to share; the `Behavior`/`Gate`/`HumanDecision` types move to a shared location or are imported by 费控 from energy.

## 5. The 费控 agent pack

`server/inngest/domains/feikong/` mirrors `domains/energy/`:

| File | Role |
|------|------|
| `index.ts` | `loadSnapshotOntology("费控-v1")` → `deriveAgents` → 14 specs; exports `buildCostControlFunctions(client)` + `costControlSpecs`. |
| `behaviors.ts` | `FEIKONG_BEHAVIORS` — deterministic logic per action (below). |
| `rule-check/run-rule-check.ts` | 筛查 → 二次验证 → 判断 → 落 `OntologyRuleCheck`. |
| `rule-check/evaluators.ts` | `judgeFeikongRules` — INV/STD/CMP/BUD numeric judges. |
| `sim-data.ts` | Expense-claim scenarios (instance data, threaded onto events). |
| `deploy.ts` | `ensureCostControlDeployed()` — deploy = activate `AgentVersion` rows. |

Plus:
- `lib/domain-ids.ts`: `COST_CONTROL_DOMAIN_ID = "费控-v1"`, `COST_CONTROL_EVENT_NS = "feikong"`.
- `lib/ontology-generator/analyze.ts`: add `[COST_CONTROL_DOMAIN_ID]: "feikong"` to `SLUG_PREFIX`.
- Snapshot: copy `actions/events/objects/rules_v0_1_001.json` from `~/Downloads/费控/费控-ontology/` into `lib/ontology-generator/snapshots/费控-v1/` as bare names (`workflow.json` already present).

**Confirmed ontology shape:** 14 actions (10 → `kind=llm`, 4 → `simulated-human`; actor distribution Human:4 / Agent:9 / Agent+Human:1), 19 events, 34 rules, 14 objects. Actions carry **no `system_prompt`/`user_prompt`** → the demo is driven by deterministic behaviors, not LLM prompts (LLM fallthrough still synthesizes from the event schema for any action without a behavior).

**Event namespace:** ASCII `feikong/<NAME>` (e.g. `feikong/EXPENSE_SUBMITTED`). Seed event = `feikong/EXPENSE_SUBMITTED` (consumed by `runInvoiceOCR`).

**Chain:**
`submitExpenseClaim` (seed / human) → `runInvoiceOCR` → `validateExpenseRules` (**rule-check**) → `occupyBudget` → `generateApprovalSuggestion` → `routeOrAutoApprove` → { `AUTO_APPROVED` → `runApprovalFlow` | `ROUTED_TO_MANUAL` → `manualReview` (**HITL gate**) } → `runApprovalFlow` (simulated multi-level) → `postToERP` → `initiatePayment` → `confirmPayment` → `archiveCase`.
Risk branch: `ANOMALY_DETECTED` / `RISK_EVENT_RAISED` → `disposeRiskEvent` (**HITL gate** for L3/L4 suspension).

**Behaviors (deterministic):** `runInvoiceOCR` (sim OCR + confidence), `validateExpenseRules` (rule-check), `occupyBudget` (budget math + BUDGET_OCCUPIED/INSUFFICIENT), `generateApprovalSuggestion` (synthesize recommendation + routing), `routeOrAutoApprove` (PIPE-01 five-condition gate → AUTO_APPROVED / ROUTED_TO_MANUAL), `manualReview` (HITL gate), `runApprovalFlow` (simulated level-by-level), `postToERP`/`initiatePayment`/`confirmPayment`/`archiveCase` (deterministic financial actions), `disposeRiskEvent` (HITL gate). `submitExpenseClaim`/`fixInvoice` are human/seed.

## 6. Rule-check agent — correctness (`validateExpenseRules`)

Same three-phase pattern as energy, with a **费控-specific evaluator** that reads the real rule fields (`id`, `specificScenarioStage`, `enforcementLevel`, `failurePolicy`, `standardizedLogicRule`):

- **筛查 (select):** group rules by `specificScenarioStage` → INV(8) → STD(6) → CMP(6) → BUD(4), evaluated in the fixed `PIPE-02` order.
- **二次验证 (verify):** baseline = all HARD rules (those whose `enforcementLevel`/`failurePolicy` block: 退回/驳回/硬阻断) are present in the selection; report missing/extra. Note: 费控 rules carry `failurePolicy`/`enforcementLevel` in the data, so red-lines are data-driven (energy's "missing failurePolicy" pitfall does not apply).
- **判断 (evaluate):** deterministic numeric checks against the scenario claim:
  - INV: whitelist/tax-id, duplicate (code+number), serial run, expiry, type↔category, **amount-consistency** (line vs invoice, tolerance 0.01) → block / PARTIAL.
  - STD: lodging/per-diem/hospitality over standard → **PARTIAL deduction** (standard vs actual → deducted amount).
  - CMP: splitting (7-day window), private-purchase, holiday/itinerary mismatch → **risk T1–T8 / L1–L4** + escalate.
  - BUD: category mismatch, insufficient budget, cost-center, period → RETURNED / T5 escalate.
  - Each verdict: `result` (PASS/FAIL/PARTIAL/NA), `riskType`, `riskLevel`, `defaultAction`, `beforeVal→afterVal`, `evidence`.
- **落 (persist):** `prisma.ontologyRuleCheck.create` + nested `evals` with `domain="费控-v1"`, `agentSlug="feikong-validate-expense-rules"`, `stage="规则校验"`. **PIPE-04 synthesis** (升风险 > 转人工 > 退回 > 核减 > 提示) decides the emitted event: `VALIDATION_COMPLETED` (clean / deduction-only) vs `ANOMALY_DETECTED` (risk).

The existing rule-check **audit dashboard already domain-scopes** (`/api/rule-check-audits?domain=…`), so 费控 verdicts appear there with no UI change.

## 7. HITL gates → notifications

Real gates use `step.waitForEvent("feikong/HUMAN_DECISION", { if: caseId + gate })` and call `recordNotification({ disposition→needs_human, domain: "费控-v1", … })`:

- **manualReview** — routed cases (over-threshold / risk / low-confidence / over-budget). Decisions: 确认核准 / 降额 / 退回 / 驳回.
- **disposeRiskEvent** — L3/L4 risk suspension. Decisions: 放行 / 暂缓 / 上报稽核.

Because **every** gate records a notification (`needs_human`, domain-scoped), all human messages land in `/api/notifications` (todo tab). The decision route flips the notification to `auto_handled` / `resolved`. This satisfies "确保所有人工的消息都能出现在消息通知里".

## 8. Unified event-push platform (one console)

Extend `companion/server.mjs` (:4180) from energy-only into a **multi-domain console**:

- **Domain switcher** (能源调度 / 费控). Per-domain gate→decision config (energy already there; add 费控 `manualReview` → [确认核准/降额/退回/驳回], `disposeRiskEvent` → [放行/暂缓/上报稽核]).
- **Seed/inject panel** — start a new case: pick domain + scenario, POST to the generalized `/api/ontology-generator/run`. This is the "注入事件" capability, now for both domains.
- **HITL panel** — polls `/api/notifications?needsHuman=1&domain=<domain>`, posts decisions to the **generalized** `/api/[domain]/human-decision` route (sends `<eventNs>/HUMAN_DECISION`, resolves the notification). The energy-specific `/api/energy/human-decision` is folded into this (kept as a thin alias or redirected).

`app/api/ontology-generator/run/route.ts` is generalized: a `SEED_EVENT` + deploy + scenario-builder registry keyed by domain, with `费控-v1 → feikong/EXPENSE_SUBMITTED + ensureCostControlDeployed + buildFeikongScenario`.

## 9. Instance data + neo4j_data test cases

Three deterministic scenarios (drawn from `00-费用管控测试用例集`), threaded onto every event like energy's dataset:

- **happy** — claim ≤20K, invoices ≤5K, OCR ≥0.95, no risk → AUTO_APPROVED → ERP/pay/archive.
- **deduction** — STD-01 lodging over standard → PARTIAL deduction → routes to manual review of the deduction.
- **risk-redline** — CMP-06 suspected private purchase → T7/L3 → RISK_EVENT_RAISED → suspension → `disposeRiskEvent` HITL gate.

**`neo4j_data/费控-v1`:** the same instance data, written out as test-case data in the format the directory already uses (to be matched to the existing `neo4j_data` convention during implementation — JSON entity rows / Cypher seed / per-scenario folder). This gives the demo a persistent corpus mirroring the in-code scenarios.

## 10. Generator simulate-generate

For 费控-v1 to be simulate-generated in the UI:
- Snapshot present under `snapshots/费控-v1/` (§5) → `infer` derives 14 candidates from the real ontology.
- 费控-v1 selectable in the generator's domain picker (sourced from the domains list / profiles — confirm 费控 profile entry exists or add one).
- `generate` writes the selected candidates as `AgentVersion` rows (`capturedFrom="ontology-gen"`, `domain="费控-v1"`); `deploy` flips them `active`; `run` seeds the chain.
- `ensureCostControlDeployed()` provides the runnable equivalent of clicking 部署 so a `run` fires immediately.

## 11. File-by-file change list

**New:** `domains/feikong/{index,behaviors,deploy,sim-data}.ts`, `domains/feikong/rule-check/{run-rule-check,evaluators}.ts`; `snapshots/费控-v1/{actions,events,objects,rules}.json`; `app/api/[domain]/human-decision/route.ts`; `neo4j_data/费控-v1/*`.

**Modified (surgical):** `lib/domain-ids.ts` (+constants), `lib/ontology-generator/analyze.ts` (+slug prefix), `lib/ontology-generator/profiles.ts` (+费控 profile if needed), `server/inngest/domains/energy/{index,make-agent}.ts` (parameterize client+behaviors), `server/inngest/domain-app.ts` (rich-pack registry + per-domain cache + re-home energy), `app/api/ontology-generator/run/route.ts` (domain registry), `companion/server.mjs` (multi-domain), possibly `lib/i18n.tsx` (费控 labels).

**Untouched:** `server/inngest/functions.ts` `allFunctions` (the isolation guarantee).

## 12. Verification

- Unit: `deriveAgents(loadSnapshotOntology("费控-v1"))` → 14 agents, correct kinds + trigger/emit edges.
- Unit: `judgeFeikongRules` on each scenario → expected PASS/PARTIAL/risk verdicts (deduction amounts, risk T/L correct).
- Unit/guard: `allFunctions` contains zero `energy-`/`feikong-` slugs.
- Build: `npm run build` (typecheck + lint) green.
- Manual: register 费控 domain app → from companion seed `happy` → trace runs ingest→archive; seed `risk-redline` → `disposeRiskEvent` gate fires → notification appears in 消息通知 → resolve in companion → chain resumes. Confirm generator UI lists 费控-v1 and infer→generate→deploy→run works.

## 13. Risks / open items

- **CJK app id / servePath** for `agentic-operator-费控-v1` — the existing shell path already uses CJK app ids; confirm Inngest dev accepts it (servePath is `encodeURIComponent`d). If problematic, derive an ASCII app id from the slug prefix.
- **neo4j_data format** — matched to existing convention during implementation (the extraction step inspects it).
- **Per-request rebuild cost** — rich packs (28 + 14 functions) are built per serve request; add a per-domain function cache keyed by domain to avoid rebuilding closures every poll.
- Energy re-homing must not regress the energy demo — covered by keeping energy's behaviors/specs intact and only swapping the client/registration path.
