# Event/Run durability (write-through) + remove candidate-tracking from the events page

Date: 2026-06-11
Status: Approved (design)

Two independent tasks, one spec:

1. **Durability** — every Inngest event and every agent run must survive an Inngest restart; today they can be lost.
2. **Removal** — delete the candidate-tracking tab from the `/events` page (events surface only).

---

## Task 1 — Write-through persistence of events and runs

### Problem

The Inngest dev server (`:8288`) is the live source of truth for events/runs/traces and is **ephemeral** — it loses everything on restart. The only durability mechanism today is a **poller**, [scripts/inngest-archiver.ts](../../../scripts/inngest-archiver.ts), which every `ARCHIVE_INTERVAL_MS` (default 30s) mirrors Inngest into the Postgres archive tables.

A poller against an ephemeral source is inherently lossy:

- A run that **starts and finishes inside one poll gap** (short runs `< 30s`) is never seen.
- Events beyond the **200/poll** cap (`ARCHIVE_EVENT_LIMIT` / `ARCHIVE_RUN_LIMIT`) on a busy window are dropped — there is no pagination/backfill.
- **Step traces** are only fetched *after* a run goes terminal, once; an in-flight run loses step I/O if Inngest restarts mid-execution.
- On an Inngest restart there is **no detection and no backfill** — the cursor just advances over empty data.

Current facts (verified):

- Inngest SDK **4.3.0**; client created at [server/inngest/client.ts:496](../../../server/inngest/client.ts) with **no middleware**.
- Reads already resolve Postgres-first / live-fallback via [lib/inngest-source.ts](../../../lib/inngest-source.ts) over tables `InngestEventArchive` / `InngestRunArchive` / `InngestStepArchive` ([prisma/schema.prisma](../../../prisma/schema.prisma) ~925–1006).
- Writer surface to reuse, [lib/inngest-archive/writer.ts](../../../lib/inngest-archive/writer.ts): `archiveEvents(events)` (insert, `skipDuplicates`), `upsertRun(run)` (upsert on `runId`, only mutates status/endedAt/durationMs/eventName, never `traceFetched`), `archiveRunTrace(runId, history)` (tx: set `traceFetched=true`, delete+recreate steps), `readRunSyncState()`, `updateCursor(stats)`. Field mapping via [lib/inngest-archive/mappers.ts](../../../lib/inngest-archive/mappers.ts).
- Most business events flow through the chokepoint [server/em/publish.ts](../../../server/em/publish.ts) (writes an `EventInstance` then `inngest.send()`), but **6+ bypass sites** call `inngest.send()` directly (human-decision, rule-check replay, ontology-generator, scripts).

### Solution: stop depending on the poll — persist in-process at the moment things happen

Add **one Inngest client middleware** that writes into the **same archive tables the UI already reads**, reusing the existing writer/mappers. No new tables, no new read path, no schema migration.

New module (isolated to avoid import cycles): `lib/inngest-archive/write-through.ts`, exporting an `InngestMiddleware`.

| Hook | Fires | Persists | Reuses |
|---|---|---|---|
| `onSendEvent` → `transformOutput` | every `inngest.send()`, in-process, with Inngest's assigned event ids | event row → `InngestEventArchive` | `archiveEvents()` (idempotent via `skipDuplicates`) |
| `onFunctionRun` start (`transformInput` / `beforeExecution`) | first request of a run | run row: status **Running**, `startedAt`, fn slug/name, `eventName`, `triggerEventIds` | `upsertRun()` (idempotent on `runId`) |
| `onFunctionRun` `finished` | run reaches terminal | run row: terminal status + `output`/error + `endedAt` + `durationMs`; then immediately fetch + archive its trace | `upsertRun()` + `getRunHistory(runId)` → `archiveRunTrace()` |

Why this is lossless by construction:

- The **run row exists from the first HTTP request** of the run, not 30s later → short runs are captured.
- The **terminal status + output is written synchronously at finish** → a run Inngest forgets on restart is fully preserved.
- **Events are written at send** with their real Inngest ids → no poll-window or 200-cap loss.
- **Steps** are captured **event-driven at finish** (immediately, not on the next poll). If that one fetch fails, the row stays `traceFetched=false` so the existing poller still backstops it — graceful degradation to today's behavior, never worse.

### The poller stays — demoted to reconciliation

No change to the poller. It is already idempotent and overlaps safely with write-through:

- Events: `archiveEvents` `skipDuplicates` on event id.
- Runs: `upsertRun` on `runId` (last-write-wins on mutable fields; both write-through and poll read the same terminal truth from Inngest, so they converge).
- Steps: `archiveRunTrace` delete+recreate, gated by `traceFetched` — the poll skips runs write-through already traced.

It now only mops up edge cases: events sent from outside this process, replays, and anything write-through somehow missed.

### Bypass sites: captured for free

The 6+ direct `inngest.send()` sites go through the same client, so `onSendEvent` persists them even though they skip `em/publish`. No per-site change needed for archive durability. (Their `EventInstance` business-log gap is out of scope — separate concern.)

### Guardrails / risks handled

- **Multiple Inngest clients.** Attach the middleware to *every* client (main + any per-domain client in [client.ts](../../../server/inngest/client.ts) / [server/inngest/domain-app.ts](../../../server/inngest/domain-app.ts)). Implementation step 1 enumerates them.
- **Exact 4.3.0 hook shape.** Verify hook names and output-access (`finished({ result })` etc.) against the installed `inngest` typings as the first implementation step; adjust mapping accordingly.
- **Latency.** The only network call is the per-finish trace fetch — make it fire-and-forget with `.catch()` logging. Run terminal state is already persisted synchronously before it; the trace is backstopped by the poller. Middleware must never add latency to or throw into a function response.
- **Import cycles.** Middleware module imports only the writer/mappers/admin-client (which import Prisma), never agent factories or `AGENT_MAP`. Lazy-import if any cycle appears.
- **Business tables untouched.** `WorkflowRun` / `AgentActivity` are owned by agent code; write-through targets only the Inngest archive tables (the run/event monitor mirror). `WorkflowRun` ↔ Inngest `runId` mapping is unchanged.
- **Cursor.** Write-through writes outside the poll tick; cursor counts (archiver health telemetry) simply won't bump for those — acceptable. Optionally refresh `lastSuccessAt`; not required.

### Testing (TDD)

- Unit: middleware against a mocked writer — assert correct row mapping on send-event / run-start / run-finish, and idempotent overlap with the poller (same ids → no dup, terminal status preserved).
- Integration (one): emit an event, run a short function, restart Inngest, confirm the event + run + steps survive in Postgres and render via `inngest-source`.

---

## Task 2 — Remove the candidate-tracking tab from `/events` (events surface only)

Per decision: remove the events-page surface; **keep** the shared backend/components the candidate journey page depends on.

### Remove

- [components/events/EventsContent.tsx](../../../components/events/EventsContent.tsx) — drop `'candidates'` from the `view` union, the `CandidatesToggleBtn`, the `CandidateTrackingTab` import, and the conditional render branch.
- Delete [components/events/CandidateTrackingTab.tsx](../../../components/events/CandidateTrackingTab.tsx).
- [lib/i18n.tsx](../../../lib/i18n.tsx) — remove `em_candidates_*` + `evx_candidate_tracking` keys (zh **and** en) **only after** grepping each key for zero remaining references (the journey page may reuse one or two — verify per-key before deleting).
- Any LeftNav / CommandPalette entry or deep-link targeting `?view=candidates`.

### Keep (used by `/entities/candidate/:id`)

- [app/api/events/candidates/route.ts](../../../app/api/events/candidates/route.ts) + its test.
- [components/events/PipelineRibbon.tsx](../../../components/events/PipelineRibbon.tsx).
- [lib/events/pipeline-stages.ts](../../../lib/events/pipeline-stages.ts).
- [components/entity/EntityJourneyContent.tsx](../../../components/entity/EntityJourneyContent.tsx) — its pipeline ribbon keeps working.

### Verification

`knip` + `npm run build` after removal — confirm nothing is left dangling and the kept files remain reachable.

---

## Non-goals

- No schema migration (reuse existing archive tables).
- No change to `WorkflowRun` / `AgentActivity`.
- No change to `/funnel`.
- Do not remove the shared candidate-stage ribbon/backend (journey page keeps it).
- Hardening the poller's own pagination/backfill is not required once write-through is the primary path (poller is now a safety net).
