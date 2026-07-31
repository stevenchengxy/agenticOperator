# External Dependency Health — Implementation Plan

> **For agentic workers:** Implemented in-session with TDD. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when a paid external dependency (RoboHire / LLM gateway) is dead — out-of-funds, faulting, or returning empty — judge *which* on the AO side, fail the affected run instead of letting it report false success, and surface one deduped, auto-resolving alert in 消息通知 plus a product-quality Dependency Health surface.

**Architecture:** AO-side only. ① a pure classifier turns each external call's result (error or empty-200) into a `DepOutcome`; ② a `reportDependencyDegraded` helper writes a structured `LogEvent` signal (`category: 'dependency'`) and throws so the run fails/parks; ③ the monitor sweeper reads those signals, ④ a pure `dependency` monitor groups by `(provider, domain)` and judges 没钱/故障/说不准 from direct-signal + persistence, firing a deduped critical/warn notification that auto-resolves; ⑤ a `/api/dependency-health` route + a Dependency Health card on `/fleet` give the at-a-glance operator view.

**Tech Stack:** TypeScript, Next.js App Router, Prisma/Postgres, Inngest (`NonRetriableError`), vitest, Tailwind v4 (`--c-*` tokens).

**Spec:** [docs/superpowers/specs/2026-06-05-external-dependency-health-design.md](./2026-06-05-external-dependency-health-design.md)

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `lib/dependency-health/types.ts` | Shared types: `DepReason`, `DepProvider`, `DepOutcome`, `DepFailure`, `DepLabel` | Create |
| `lib/dependency-health/classify.ts` | Per-call classification (structured error → reason; empty-200 predicates) | Create |
| `lib/dependency-health/report.ts` | `reportDependencyDegraded` — write LogEvent signal + throw (park vs NonRetriable) | Create |
| `server/log/log-event.ts:19` | Add `dependency_degraded` → `{level:'warn', category:'dependency'}` to `levelCategoryFor` | Modify |
| `server/inngest/agents/resume-parser-agent.ts` | Classify parse result; report+throw on degraded | Modify |
| `server/inngest/agents/create-jd-agent.ts` | Classify generate-jd result | Modify |
| `server/inngest/agents/match-resume-agent.ts` | Classify match result (keep `MATCH_FAILED`) | Modify |
| `server/inngest/agents/interview-inviter-agent.ts` | Classify invite result (keep `INTERVIEW_INVITATION_FAILED`) | Modify |
| `lib/rule-check/runner.ts` + `server/inngest/agents/rule-check-agent.ts` | Classify LLM degrade (incl. empty text); report at infra-fail point | Modify |
| `lib/monitor/monitor-types.ts` | Add `dependencyFailures` to port, `DepFailure`, thresholds | Modify |
| `lib/monitor/pg-read-port.ts` | Implement `dependencyFailures` over `LogEvent` | Modify |
| `lib/monitor/dependency.ts` | The monitor: group + judge 没钱/故障/说不准 + findings/activeKeys | Create |
| `scripts/monitor-sweeper.ts:37` | Register `dependencyMonitor` | Modify |
| `app/api/dependency-health/route.ts` | Summarize current provider states for the UI | Create |
| `components/fleet/DependencyHealthCard.tsx` | Product UI card | Create |
| `components/fleet/FleetContent.tsx` (or equivalent) | Mount the card | Modify |
| `lib/i18n.tsx` | zh + en strings (`dep_*`) | Modify |

---

## Chunk 1: Detection core (classifier + report helper)

### Task 1: Shared types

**Files:** Create `lib/dependency-health/types.ts`

- [ ] Define:
```ts
export type DepProvider = 'robohire' | 'llm';
export type DepReason = 'quota' | 'auth' | 'rate_limit' | 'empty' | 'server' | 'network';
export type DepLabel = 'out_of_funds' | 'fault' | 'unknown'; // 没钱了 / 故障了 / 说不准

export type DepOutcome =
  | { ok: true }
  | { ok: false; provider: DepProvider; op: string; reason: DepReason; detail: string };

export interface DepFailure {
  provider: DepProvider;
  op: string;
  reason: DepReason;
  domain: string;
  runId: string | null;
  ts: Date;
  anchors?: Record<string, string>;
}
```

### Task 2: Classifier — structured errors

**Files:** Create `lib/dependency-health/classify.ts`; Test `lib/dependency-health/classify.test.ts`

- [ ] **Test first** — `classifyRobohire` maps a thrown `RobohireApiError`:
  - `QUOTA_EXHAUSTED`(402) → `{ok:false, reason:'quota'}`
  - `RATE_LIMITED`(429) → `reason:'rate_limit'`
  - `NETWORK`(0) → `reason:'network'`
  - `SERVER`(5xx) → `reason:'server'`
  - 401/403 `CLIENT` → `reason:'auth'`
  - and `classifyLlm` maps gateway errors: message `/insufficient_quota|quota|billing/i` → `quota`; `/timeout|ECONN|network/i` → `network`; 429 → `rate_limit`; 401/403 → `auth`; else 5xx → `server`.
- [ ] Implement `classifyRobohire(op, err)` + `classifyLlm(op, err)`. Use `err instanceof RobohireApiError` → switch on `.code`/`.httpStatus`. For LLM, inspect `err.message`/`err.status`.
- [ ] Run: `npm test -- classify` → PASS. Commit.

### Task 3: Classifier — empty-200 predicates

**Files:** `lib/dependency-health/classify.ts` (+ test)

- [ ] **Test first** — empty predicates:
  - `classifyRobohire('parseResume', { data: {} })` → `reason:'empty'`; `{data:{name:'a'}}` → `ok:true`.
  - `classifyRobohire('matchResume', { data: { } })` (no `matchScore`) → `empty`; with `matchScore:0.7` (a number) → `ok:true`. (NB: score 0 is valid → check `typeof === 'number'`.)
  - `classifyRobohire('generateJd', { data: {} })` (no title/description) → `empty`; with `description:'…'` → ok.
  - `classifyRobohire('inviteCandidate', { data: {} })` (no `login_url`/`user_id`/`reused`) → `empty`; with `login_url` → ok.
  - `classifyLlm('ruleCheck', '')` and `'   '` → `empty`; `'text'` → ok.
- [ ] Implement per-op `isEmptyPayload`. For success path, `classifyRobohire(op, {data})` runs the predicate; returns `ok:true` or `{reason:'empty'}`.
- [ ] Run: `npm test -- classify` → PASS. Commit.

### Task 4: `levelCategoryFor` mapping

**Files:** Modify `server/log/log-event.ts:19`; Test `server/log/log-event.test.ts` (or extend existing)

- [ ] **Test** — `levelCategoryFor('dependency_degraded')` → `{level:'warn', category:'dependency'}`.
- [ ] Add the case. Run test → PASS. Commit.

### Task 5: `reportDependencyDegraded` helper

**Files:** Create `lib/dependency-health/report.ts`; Test `lib/dependency-health/report.test.ts`

- [ ] **Test first** (inject a fake `recordLogEvent`):
  - Calling with `reason:'quota'` writes one signal with `type:'dependency_degraded'`, `payloadJson` containing `{provider, op, reason, domain, anchors, inngestRunId}`, and **throws** a retriable error (NOT `NonRetriableError`).
  - `reason:'auth'` → throws `NonRetriableError`.
  - The signal write happens *before* the throw (await ordering).
- [ ] Implement:
```ts
export async function reportDependencyDegraded(o, ctx): Promise<never> {
  await recordLogEvent({
    type: 'dependency_degraded',
    message: `${friendly(o.provider)} ${o.op} 退化:${o.reason} — ${o.detail}`,
    source: o.provider === 'llm' ? 'LLM 网关' : 'RoboHire',
    agent: ctx.agent, runId: ctx.runId ?? null,
    payloadJson: JSON.stringify({ ...o, domain: ctx.domain, anchors: ctx.anchors, inngestRunId: ctx.runId }),
  });
  const recoverable = o.reason === 'quota' || o.reason === 'rate_limit' || o.reason === 'network' || o.reason === 'server';
  if (recoverable) throw new Error(`dependency ${o.provider}/${o.op} ${o.reason}: ${o.detail}`);
  throw new NonRetriableError(`dependency ${o.provider}/${o.op} ${o.reason}: ${o.detail}`);
}
```
  (`recordLogEvent` is injectable via param default for testability.)
- [ ] Run → PASS. Commit. **Then dispatch plan-reviewer-substitute check via `npm run build` typecheck at chunk end.**

---

## Chunk 2: Agent integration (the 5 agents)

For each agent: at the external-call site, on **caught error** → `classifyX(op, err)`; on **success** → `classifyX(op, result)` to catch empty-200; if `!ok` → `await reportDependencyDegraded(outcome, ctx)` (which throws). Preserve existing `*_FAILED` event emits (emit *then* report) for match/invite.

### Task 6: resume-parser-agent
**Files:** Modify `server/inngest/agents/resume-parser-agent.ts:158-219`
- [ ] In the catch: replace the bespoke `isClientError → NonRetriableError` with `await reportDependencyDegraded(classifyRobohire('parseResume', e), ctx)`. After a successful `parseRes`, add `const oc = classifyRobohire('parseResume', parseRes); if (!oc.ok) await reportDependencyDegraded(oc, ctx);`
- [ ] Build typecheck. Commit.

### Task 7: create-jd-agent
**Files:** Modify `server/inngest/agents/create-jd-agent.ts:217-246` — same pattern with `'generateJd'`.

### Task 8: match-resume-agent
**Files:** Modify `server/inngest/agents/match-resume-agent.ts:110-162`
- [ ] Keep the `MATCH_FAILED` emit. On degraded: emit `MATCH_FAILED` (as today), **then** `await reportDependencyDegraded(classifyRobohire('matchResume', errOrData), ctx)`.

### Task 9: interview-inviter-agent
**Files:** Modify `server/inngest/agents/interview-inviter-agent.ts:183-294`
- [ ] Keep `INTERVIEW_INVITATION_FAILED`. Emit then report. Map existing `QUOTA_EXHAUSTED`/`ROBOHIRE_QUOTA` to the classifier.

### Task 10: rule-check (LLM)
**Files:** Modify `lib/rule-check/runner.ts` (add empty-text classification) + `server/inngest/agents/rule-check-agent.ts` (at the `isInfraFailure` throw point, also `await reportDependencyDegraded(classifyLlm('ruleCheck', …), ctx)`).
- [ ] rule-check already throws+parks; we ADD the dependency signal so it shows as an LLM 没钱/故障 alert. Don't double-throw — report (which throws) replaces the existing throw at that point, or report-then-rethrow-equivalent. Keep candidate-NOT-rejected semantics.
- [ ] Build typecheck green for all 5. Commit.

---

## Chunk 3: Monitor (read-port + judgment + sweeper)

### Task 11: Port + types + thresholds
**Files:** Modify `lib/monitor/monitor-types.ts`
- [ ] Add to `MonitorReadPort`: `dependencyFailures(windowMs: number): Promise<DepFailure[]>`. Import/re-export `DepFailure` from dependency-health types.
- [ ] Add thresholds: `depFailWindowMs: 15*60_000`, `depFailMinCount: 2`, `depUnknownEscalateCount: 6` to `MonitorThresholds` + `DEFAULT_THRESHOLDS`.

### Task 12: pg-read-port impl
**Files:** Modify `lib/monitor/pg-read-port.ts`; Test `lib/monitor/pg-read-port.dependency.test.ts`
- [ ] Implement `dependencyFailures(windowMs)`: `prisma.logEvent.findMany({ where: { category:'dependency', ts:{gte:cutoff} }, select:{ runId:true, ts:true, payloadJson:true, agent:true } })`, parse `payloadJson` → `DepFailure[]` (skip rows with unparseable/incomplete payload).
- [ ] Integration test: write a dependency LogEvent, assert it reads back as a `DepFailure`. Run → PASS. Commit.

### Task 13: dependency monitor + judgment
**Files:** Create `lib/monitor/dependency.ts`; Test `lib/monitor/dependency.test.ts`
- [ ] **Test first** (fake port returning `DepFailure[]`):
  - any `quota` in a `(provider,domain)` group → label `out_of_funds`, `level:'critical'`, fires at N≥1, dedupeKey `dep_down.<provider>.<domain>`.
  - all `server`/`network`/`rate_limit`, N≥`depFailMinCount` → `fault`, critical.
  - only `auth`/`empty`, N≥`depFailMinCount` → `unknown`, `level:'warn'`; N≥`depUnknownEscalateCount` → escalate `level:'critical'`.
  - below threshold (e.g. one stray `empty`) → no finding.
  - `activeKeys` lists every firing key (for resolve).
  - message copy is business-language (no `402`/code), names affected ops + domain.
- [ ] Implement `dependencyMonitor(port, t)`: read `dependencyFailures(t.depFailWindowMs)`, group by `(provider, domain)`, `judge(failures)` → `{label, level}`, build `CaptureInput` with `category:'system'` (always-visible infra), `source` = friendly provider, `domain` carried in body, `dedupeHint` = key. Return `{prefix:'dep_down.', findings, activeKeys}`.
- [ ] Run → PASS. Commit.

### Task 14: Register in sweeper
**Files:** Modify `scripts/monitor-sweeper.ts:37`
- [ ] `import { dependencyMonitor }` and add to `monitors` array. Build. Commit.

---

## Chunk 4: Frontend (product surface)

### Task 15: `/api/dependency-health` read route
**Files:** Create `app/api/dependency-health/route.ts`
- [ ] GET → read firing `dep_down.*` notifications + recent `category:'dependency'` LogEvents; return per-provider `{provider, label, severity, count, sinceTs, lastReason, affectedOps[], affectedDomains[]}`. Healthy when no firing alert + no recent failures.
- [ ] Manual curl sanity. Commit.

### Task 16: Dependency Health card
**Files:** Create `components/fleet/DependencyHealthCard.tsx`; Modify the fleet content component; Modify `lib/i18n.tsx`
- [ ] Card lists each dependency (RoboHire, AI 网关) with a status pill (健康 green / 没钱了 red / 故障了 amber / 说不准 grey), count, "since", last reason in business language, affected agents, and a deep-link to 消息通知. Use atoms (`Card`, `CardHead`, `StatusDot`, `Badge`) + `--c-*` tokens only. Poll the API on an interval (match existing fleet polling).
- [ ] Add `dep_*` zh + en i18n keys.
- [ ] Mount on `/fleet`. Verify in dev. Commit.

---

## Verification
- [ ] `npm test` green (classifier, report, monitor, read-port).
- [ ] `npm run build` green (typecheck + lint).
- [ ] Manual: simulate a `dependency_degraded` LogEvent → sweeper fires one `dep_down.*` alert → card shows 没钱了 → clear signals → auto-resolves.

## Decisions baked in (revertible)
1. Signal stored in `LogEvent` (`category:'dependency'`), zero migration.
2. Dependency alerts are `category:'system'` → always visible (infra outage shouldn't hide behind a domain tab); affected domain shown in body.
3. `quota`/`rate_limit`/`network`/`server` → retriable (park, auto-resume after top-up); `auth`/client-bad-input → `NonRetriableError`.
4. Thresholds: quota fires N≥1; others N≥2; unknown warn→critical at N≥6. Window 15m, sweep 60s.
5. `safeLlm` (energy) out of scope.
