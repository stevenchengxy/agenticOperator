# Multi-Agent Monitor — P2 + P3 Implementation Plan

> **For agentic workers:** TDD. Pure-logic cores get unit tests; LLM/DB/UI wiring is typecheck + smoke verified. Spec: `docs/superpowers/specs/2026-06-04-multi-agent-monitor-architecture-design.md`. Builds on P1 (`lib/monitor/*`, `scripts/monitor-sweeper.ts`).

**Goal:** Add the AI fact-monitoring layer (sampled groundedness judge + cross-family jury), drift/calibration, triage clustering, and a minimal monitor-evals view — off-Inngest, AI strictly optional behind a gateway try/catch, domain-scoped.

**Architecture:** Pure functions for all logic (sampling, jury tally, cross-family judge pick, groundedness parse/decide, drift, confusion matrix, triage clustering) — injectable `JudgeFn` and eval-store so everything is unit-tested without LLM/DB. Thin Postgres + gateway wiring. A `runEvalSample(deps)` orchestrator is fired fire-and-forget by the sweeper and by `POST /api/monitor/eval`. New tables `MonitorEval` (durable observation cache, 90d retention) + `MonitorConfig` (per-domain) via `npm run db:push`.

**Tech Stack:** TS, Prisma, vitest, `server/llm/gateway.ts` (`chatComplete`/`isGatewayConfigured`), reuse `lib/rule-check/verify-prompt.ts` `pickVerifierModel` for cross-family judges.

---

## Schema (one db:push)

`MonitorEval` (per spec §9.2: domain, kind, agent, runId, auditId, anchorsJson, score, verdict, juryVotesJson, rationale, judgeModel, judgeFamily, judgePromptVersion, rubricVersion, primaryAgreed, llmPromptTokens, llmCompletionTokens, llmDurationMs, sampledFrom, sweepWindow, autonomyMode, suppressed, humanLabel, agreement, aiSource; `@@unique([kind, sampledFrom])`; indexes domain+ts, kind+ts, auditId, runId).
`MonitorConfig` (`@id domain`, samplingPct, judgeFamily, autonomy, thresholdsJson, enabledMonitorsJson).

---

## P2 Tasks

### T1 — sampling.ts (pure)
- [ ] Test: `sampleByPct(items, pct)` deterministic stride sampling → ~pct of items, stable, empty/0/100 edges.
- [ ] Impl. Green. Commit.

### T2 — judge.ts (pure)
- [ ] Test: `tallyJury([g,g,ng])` → majority `grounded`, agreement 2/3; `pickJuryModels(primaryModel,3)` → 3 ids, none same family as primary (reuse pickVerifierModel); `normalizeVerdict` maps strings → grounded|not_grounded|unsure.
- [ ] Impl. Green. Commit.

### T3 — monitor-config.ts (pure)
- [ ] Test: `resolveMonitorConfig(null, domain)` → defaults; a row overrides samplingPct/judgeFamily/autonomy.
- [ ] Impl + `JUDGE_PROMPT_VERSION`/`RUBRIC_VERSION` consts. Green. Commit.

### T4 — groundedness.ts (pure parse/decide)
- [ ] Test: `parseGroundedness(jsonText)` → {score,verdict,rationale} tolerant of fences/garbage (null on unusable); `decideVerdict(score, t)` → grounded/not_grounded boundary.
- [ ] Impl + `buildGroundednessPrompt(sample)`. Green. Commit.

### T5 — run-eval.ts (orchestrator, fakes)
- [ ] Test: `runEvalSample({port,config,judge,store,now})` samples outputs, judges each, escalates contested (primary≠second) to jury, writes MonitorEval rows via store, emits a finding for not_grounded; gateway-down judge → fallback skip (no throw).
- [ ] Impl. Green. Commit.

### T6 — llm-judge.ts (thin wiring)
- [ ] `makeLlmJudge()` : JudgeFn over chatComplete (isGatewayConfigured guard → null/fallback), returns {verdict,score,rationale,model,family,tokens,ms}. Typecheck.
- [ ] Commit.

### T7 — pg-eval-store.ts (thin wiring)
- [ ] `createPgEvalStore()` (upsert MonitorEval on (kind,sampledFrom)), `getMonitorConfig(domain)`, `recentEvalsForDrift()`. Typecheck.
- [ ] Commit.

### T8 — app/api/monitor/eval/route.ts
- [ ] POST → runEvalSample(real deps) fire-and-forget; GET → recent MonitorEval. Typecheck.
- [ ] Commit.

### T9 — sweeper integration
- [ ] Sweeper fires `runEvalSample` fire-and-forget each tick, gated `MONITOR_EVAL`, never blocks deterministic monitors. Typecheck + load test.
- [ ] Commit.

## P3 Tasks

### T10 — drift.ts (pure)
- [ ] Test: `agreementRate(original, rejudge)` only compares same judgePromptVersion pairs → fraction agreeing; flags drift below threshold.
- [ ] Impl. Green. Commit.

### T11 — calibration.ts (pure)
- [ ] Test: `confusion(pairs)` → {tp,fp,tn,fn,precision,recall,f1,kappa} on a known set (incl. Cohen's κ).
- [ ] Impl. Green. Commit.

### T12 — triage.ts (pure)
- [ ] Test: `clusterFiring(notifs)` groups firing alerts by dedupe prefix + domain → clusters with counts; singletons pass through.
- [ ] Impl. Green. Commit.

### T13 — app/api/monitor/findings/route.ts
- [ ] GET → firing Notification (monitor-prefixed) + recent MonitorEval, domain-scoped. Typecheck. Commit.

### T14 — app/api/monitor/calibration/route.ts
- [ ] GET → confusion matrix from labelled MonitorEval; POST → attach humanLabel to an eval. Typecheck. Commit.

### T15 — minimal evals view (no dirty-file touch)
- [ ] `app/monitor/evals/page.tsx` + `components/monitor/MonitorEvalsContent.tsx` (standalone; does NOT touch dirty MonitorContent.tsx) rendering findings + eval scores + calibration. Build-verified. Commit.

## Out of scope
- Guardrails (spec §17 optional/default-off).
- Modifying the dirty `components/monitor/MonitorContent.tsx` (user WIP) — new standalone view instead.

## Final
- [ ] `npm test` (monitor suite green, no new regressions), `tsc --noEmit` clean for my files.
- [ ] Live eval smoke: `POST /api/monitor/eval` or sweeper tick — judge runs or degrades to fallback (gateway), no throw.
