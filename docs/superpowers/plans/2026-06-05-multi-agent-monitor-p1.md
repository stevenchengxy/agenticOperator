# Multi-Agent Monitor — P1 (Deterministic Monitor Backbone) Implementation Plan

> **For agentic workers:** Implement with TDD. Steps use checkbox (`- [ ]`) syntax. Spec: `docs/superpowers/specs/2026-06-04-multi-agent-monitor-architecture-design.md`.

**Goal:** Build the deterministic monitor backbone (health / SLA / cost / error-rate) that reads the Postgres Inngest archive and emits notifications via the existing `recordNotification` pipeline, with stale-alert resolution — off-Inngest, no LLM, zero schema migration.

**Architecture:** Each monitor is a **pure async function** `(port: MonitorReadPort, thresholds) → MonitorResult` returning `{ findings: CaptureInput[]; activeKeys: string[] }`. A `MonitorReadPort` abstracts the archive reads (Postgres-backed impl + injectable fake for tests). A `runSweep(deps)` orchestrator records findings and resolves stale firing alerts; a standalone `scripts/monitor-sweeper.ts` long-poller wires real deps (pgrep-guarded single instance, mirrors the archiver). All logic is unit-tested with a fake port — no DB needed.

**Tech Stack:** TypeScript, Prisma (read `InngestRunArchive`/`InngestStepArchive`, write `Notification`), vitest, existing `server/notifications/ingest.ts` (`recordNotification`) + `lib/monitor/run-token-usage.ts` (`getRunTokenUsage`).

**Scope (P1 only):** deterministic monitors + sweeper + resolve + read-port + a tiny `GET /api/notifications` per-row `domain` finisher. **Out of scope (P2/P3):** LLM groundedness sampling, jury, drift/calibration, `MonitorEval`/`MonitorConfig` tables, UI tab.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/monitor/monitor-types.ts` (create) | `MonitorReadPort` interface, `MonitorResult`, `MonitorThresholds`, `DEFAULT_THRESHOLDS`, `domainForRun()` |
| `lib/monitor/health.ts` (create) | health/liveness: stalled-run detection from latest step time |
| `lib/monitor/sla.ts` (create) | SLA: p95 step/run duration vs threshold |
| `lib/monitor/cost.ts` (create) | cost/token budget + runaway (tool-step count) |
| `lib/monitor/error-rate.ts` (create) | windowed error rate with min-volume guard |
| `lib/monitor/resolve.ts` (create) | pure `keysToResolve()` diff + `resolveStale()` DB wiring |
| `lib/monitor/sweep.ts` (create) | `runSweep(deps)` orchestrator (injectable deps) |
| `lib/monitor/pg-read-port.ts` (create) | Postgres-backed `MonitorReadPort` (thin, over prisma + reader) |
| `lib/monitor/*.test.ts` (create) | unit tests per monitor + resolve + sweep, fake port |
| `scripts/monitor-sweeper.ts` (create) | standalone long-poller entrypoint (wires real deps) |
| `scripts/dev-bootstrap.mjs` (modify) | spawn sweeper, pgrep-guarded, `MONITOR_SWEEP` env |
| `app/api/notifications/route.ts` (modify) | return per-row `domain` in GET map |

**Interfaces (locked):**

```ts
// lib/monitor/monitor-types.ts
import type { CaptureInput } from '@/server/notifications/derive';

export interface RunHeartbeat { runId: string; functionSlug: string; lastStepAt: Date | null; startedAt: Date | null; }
export interface StepTiming { runId: string; functionSlug: string; durationMs: number; }
export interface ErrorWindow { errors: number; total: number; byAgent: Record<string, { errors: number; total: number }>; }

export interface MonitorReadPort {
  inflightRuns(): Promise<RunHeartbeat[]>;
  stepTimings(sinceMs: number): Promise<StepTiming[]>;
  tokenUsageByRun(runIds: string[]): Promise<Record<string, { total: number }>>;
  toolStepCounts(runIds: string[]): Promise<Record<string, number>>;
  recentRunIds(sinceMs: number): Promise<{ runId: string; functionSlug: string }[]>;
  errorWindow(windowMs: number): Promise<ErrorWindow>;
}

export interface MonitorResult { findings: CaptureInput[]; activeKeys: string[]; prefix: string; }

export interface MonitorThresholds {
  stallMs: number;        // health
  slaP95Ms: number;       // sla
  budgetTokens: number;   // cost per domain window
  toolLoop: number;       // runaway
  errorRatePct: number;   // error-rate
  minVolume: number;      // error-rate min sample
}
```

---

## Task 1: monitor-types + domainForRun

**Files:** Create `lib/monitor/monitor-types.ts`, Test `lib/monitor/monitor-types.test.ts`

- [ ] Write failing test: `domainForRun({functionSlug,eventName})` maps energy-ns → `能源调度-v1`, feikong-ns → `费控-v1`, else recruitment `招聘-v1`.
- [ ] Run → fail (module missing).
- [ ] Implement types + `DEFAULT_THRESHOLDS` + `domainForRun` (use `eventNsForDomain` inverse / ns prefix on eventName||functionSlug).
- [ ] Run → pass. Commit (pathspec).

## Task 2: health monitor

**Files:** Create `lib/monitor/health.ts`, Test `lib/monitor/health.test.ts`

- [ ] Failing test: given inflight run whose `lastStepAt` is `now - 6min` and `stallMs=5min` → one finding `level:'critical'`, `category:'system'`, `dedupeHint:'run_stalled.<runId>'`, anchors carry runId; a fresh run (lastStepAt 1min ago) → no finding; `activeKeys` lists only stalled keys.
- [ ] Run → fail. Implement `healthMonitor(port, t)`. Run → pass. Commit.

## Task 3: sla monitor

**Files:** Create `lib/monitor/sla.ts`, Test `lib/monitor/sla.test.ts`

- [ ] Failing test: step timings where p95 per-agent > `slaP95Ms` → finding `category:'agent_lifecycle'`(→'agent'), `dedupeHint:'sla_breach.<slug>'`, warning; under threshold → none.
- [ ] Implement p95 computation + per-functionSlug grouping. Run → pass. Commit.

## Task 4: cost monitor (budget + runaway)

**Files:** Create `lib/monitor/cost.ts`, Test `lib/monitor/cost.test.ts`

- [ ] Failing test: (a) domain token sum > `budgetTokens` → `dedupeHint:'cost_budget.<domain>'` critical system; (b) a run with toolStepCount > `toolLoop` → `dedupeHint:'runaway.<runId>'` critical.
- [ ] Implement using `tokenUsageByRun` + `toolStepCounts` + `domainForRun`. Run → pass. Commit.

## Task 5: error-rate monitor

**Files:** Create `lib/monitor/error-rate.ts`, Test `lib/monitor/error-rate.test.ts`

- [ ] Failing test: byAgent {errors:5,total:10} with `errorRatePct=30, minVolume:5` → finding `dedupeHint:'error_rate.<agent>'`; {errors:1,total:1} (below minVolume) → none (no 100% noise).
- [ ] Implement. Run → pass. Commit.

## Task 6: resolve

**Files:** Create `lib/monitor/resolve.ts`, Test `lib/monitor/resolve.test.ts`

- [ ] Failing test (pure): `keysToResolve(['run_stalled.a','run_stalled.b'], new Set(['run_stalled.a']))` → `['run_stalled.b']`.
- [ ] Implement pure `keysToResolve` + `resolveStale(prefix, activeKeys, deps)` thin DB wiring (deps-injected `findFiring`/`markResolved`). Test the wiring with fakes. Run → pass. Commit.

## Task 7: sweep orchestrator

**Files:** Create `lib/monitor/sweep.ts`, Test `lib/monitor/sweep.test.ts`

- [ ] Failing test: `runSweep({port, record, resolveStale, thresholds, monitors})` with a fake monitor returning 1 finding + activeKeys → `record` called once with that finding, `resolveStale` called with the monitor prefix + activeKeys; a monitor that throws does not abort the others (Promise.allSettled). Idempotency note documented.
- [ ] Implement. Run → pass. Commit.

## Task 8: pg read-port (thin wiring, typecheck-verified)

**Files:** Create `lib/monitor/pg-read-port.ts`

- [ ] Implement `createPgReadPort(): MonitorReadPort` over prisma (`inngestRunArchive` running + steps for `inflightRuns`; `inngestStepArchive` for `stepTimings`/`toolStepCounts`; `getRunTokenUsage` for tokens; run status `Failed` vs total for `errorWindow`). No new test (DB-bound); verified by `npm run build` typecheck.
- [ ] Commit.

## Task 9: sweeper entrypoint + dev-bootstrap

**Files:** Create `scripts/monitor-sweeper.ts`, Modify `scripts/dev-bootstrap.mjs`

- [ ] Implement long-poll loop (`while(!stopping){ runSweep(realDeps); sleep(MONITOR_SWEEP_INTERVAL_MS||60000) }`), clean-shutdown on SIGTERM/SIGINT, gated by `MONITOR_SWEEP!=='0'`.
- [ ] Wire into dev-bootstrap: `spawn` + `pgrep -f scripts/monitor-sweeper` dedup guard (mirror archiver block). Gate with `MONITOR_SWEEP`.
- [ ] `npm run build` typecheck. Commit.

## Task 10: GET per-row domain finisher

**Files:** Modify `app/api/notifications/route.ts`, Test (extend route test if present, else add to derive/ingest area)

- [ ] Add `domain: n.domain` to the GET `notifications.map(...)` object. Verify no consumer breaks. Commit.

## Final: full test + build

- [ ] `npm test` (vitest run) — all monitor tests green + no regressions.
- [ ] `npm run build` — typecheck/lint clean.
- [ ] Commit any fixups (pathspec). Report.
