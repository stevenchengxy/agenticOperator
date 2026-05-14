# Manage axis — Design spec

**Date**: 2026-05-14
**Authors**: Steven · Claude
**Scope**: Agentic Operator "Manage" axis — human-driven write operations on workflow runs,
agents, and events. All actions are audit-logged.
**Out of scope**: Behavior axis (Monitor Agent, Manager Agent — separate spec). Read-only
observability (Monitor axis — already shipped). Automated/AI-driven interventions belong
in the Behavior axis.

---

## 0. Three-axis framework recap

| Axis | Nature | Status |
|------|--------|--------|
| Monitor | Read-only: observe runs, queues, failures, token spend | Shipped (2026-05-14) |
| **Manage** (this spec) | Human write-ops: restart, cancel, pause, resume, replay, config edits | Next |
| Behavior | Automated: Monitor Agent + Manager Agent, MONITOR_ALERT events | After Manage |

---

## 1. Non-goals

- **No AI-driven actions** — Manage is human-initiated only. Automated responses are Behavior.
- **No role-based access control in v1** — any authenticated user can perform any write op.
  An audit log records who/when for every action. RBAC is a v2 concern.
- **No bulk ops in v1** — all actions target a single run / agent / event at a time.
- **No UI for creating new workflow runs** — trigger events are emitted by external systems
  (RMS webhooks, scheduled sync). Manual trigger is a v2 stretch goal.

---

## 2. Permission model (v1)

- **Authentication**: any user with a valid AO session (currently unauthenticated in dev —
  v1 ships with session-cookie auth or no-auth behind VPN).
- **Authorization**: flat — all users can call all Manage APIs. No roles enforced.
- **Audit trail**: every successful write appends one `AuditLog` row:
  ```
  AuditLog {
    id           String   @id @default(cuid())
    action       String   // e.g. "run.restart", "run.cancel", "event.replay", "agent.config"
    actorId      String?  // session user ID (null in no-auth mode)
    targetType   String   // "WorkflowRun" | "AgentConfig" | "EventInstance"
    targetId     String   // the run/config/event ID acted on
    payload      String?  // JSON: parameters passed (e.g. reason for cancel)
    createdAt    DateTime @default(now())
  }
  ```
  `AuditLog` is append-only. No deletes. Retention: forever (or configurable TTL, v2).

---

## 3. Write operations

### 3.1 Restart / Replay a WorkflowRun

Re-emits the original trigger event for a run, creating a fresh execution from the start.

**When to use**: run failed at an early stage and the input data is still valid; operator
wants a clean retry without touching the original `WorkflowRun` row.

**Preconditions**: run must be in status `failed`, `completed`, or `timed_out`.

**Effect**:
1. Look up the original `triggerEvent` name and `triggerData` from `WorkflowRun`.
2. Call `em.publish(triggerEvent, triggerData, { causedBy: runId })` — EM dedup via
   `causedBy` prevents double-fire if the operator clicks twice.
3. A new `WorkflowRun` row is created by the downstream function (not by this API).
4. Append `AuditLog { action: "run.restart", targetId: runId }`.
5. Return `{ ok: true, newRunId: null }` — the new run ID is not known synchronously.

**API**: `POST /api/manage/runs/[id]/restart`
Body: `{ reason?: string }` (reason is stored in AuditLog.payload)
Response: `200 { ok: true }` | `409 { error: "INVALID_STATUS" }` | `404`

---

### 3.2 Cancel a WorkflowRun

Marks a running or suspended run as cancelled; sends a cancellation signal to Inngest.

**When to use**: run is stuck, input data is invalid, or client has withdrawn the request.

**Preconditions**: run must be in status `running` or `suspended`.

**Effect**:
1. Call Inngest `cancel` API (event-cancel via `inngest.cancel({ runId })`).
2. Update `WorkflowRun.status = 'interrupted'`, set `completedAt = now()`.
3. Close any open `HumanTask` rows for this run (status → `cancelled`).
4. Append `AuditLog { action: "run.cancel", targetId: runId, payload: { reason } }`.

**API**: `POST /api/manage/runs/[id]/cancel`
Body: `{ reason?: string }`
Response: `200 { ok: true }` | `409 { error: "INVALID_STATUS" }` | `404`

---

### 3.3 Pause a WorkflowRun

Suspends a running run at the next HITL checkpoint or step boundary.

**When to use**: operator needs to freeze a run temporarily (e.g., client requests a hold).

**Preconditions**: run must be in status `running`.

**Effect**:
1. Update `WorkflowRun.status = 'paused'`, `suspendedReason = reason`.
2. Inngest does not have a native "pause" primitive — implementation uses a `waitForEvent`
   step already embedded in the function, or a feature-flag checked at each step start.
   For v1: write a `PauseFlag` record checked at each agent step boundary.
3. Append `AuditLog { action: "run.pause" }`.

**API**: `POST /api/manage/runs/[id]/pause`
Body: `{ reason?: string }`
Response: `200 { ok: true }` | `409 { error: "INVALID_STATUS" }` | `404`

**Note**: Inngest-native suspend is preferred over a poll-based flag. If the Inngest SDK
version supports `step.waitForEvent` with a cancellation token, use that instead.

---

### 3.4 Resume a Paused WorkflowRun

Resumes a paused run from where it stopped.

**Preconditions**: run must be in status `paused`.

**Effect**:
1. Delete or clear the `PauseFlag` for the run.
2. Update `WorkflowRun.status = 'running'`, clear `suspendedReason`.
3. If using `waitForEvent`: emit the resume event that the paused step is waiting on.
4. Append `AuditLog { action: "run.resume" }`.

**API**: `POST /api/manage/runs/[id]/resume`
Response: `200 { ok: true }` | `409 { error: "NOT_PAUSED" }` | `404`

---

### 3.5 Replay an EventInstance

Re-publishes a specific `EventInstance` through EM, triggering downstream consumers again.

**When to use**: an event was published but the downstream function crashed or missed it;
operator wants to re-drive the downstream without restarting the whole run.

**Preconditions**: `EventInstance` must exist. No status precondition (can replay any event).

**Effect**:
1. Look up `EventInstance` by ID.
2. Call `em.publish(eventName, payload, { causedBy: eventInstanceId })`.
   EM dedup: if the same `causedBy` already produced a live `EventInstance`, EM returns
   the existing one and does NOT double-fire. Operator gets back the existing/new ID.
3. Append `AuditLog { action: "event.replay", targetId: eventInstanceId }`.

**API**: `POST /api/manage/events/[id]/replay`
Response: `200 { ok: true, eventInstanceId: string }` | `404`

---

### 3.6 Edit AgentConfig

Updates an agent's runtime configuration (temperature, maxRetries, promptAppend).
Changes take effect on the next run — in-flight runs are not affected.

**Fields editable in v1**:
- `temperature` (0.0 – 1.0)
- `maxRetries` (0 – 10)
- `promptAppend` (freeform string, appended to the base system prompt)

**Fields NOT editable via Manage** (require a deploy):
- `tier` (model tier — changing this needs a deployment change)
- `maxOutputTokens` (same)
- `enabled` (disabling an agent is a Manage v2 concern with extra safeguards)

**Effect**:
1. Upsert `AgentConfig` row for the given agent `short` name.
2. Append `AuditLog { action: "agent.config", targetType: "AgentConfig", targetId: short,
   payload: { before: oldValues, after: newValues } }`.
3. No run-in-progress interruption. The changed config is read at step start.

**API**: `POST /api/manage/agents/[name]/config`
Body: `{ temperature?: number; maxRetries?: number; promptAppend?: string }`
Response: `200 { ok: true, config: AgentConfig }` | `400 { error: "VALIDATION" }` | `404`

---

## 4. UI integration

### 4.1 Run detail page (`/monitor/runs/[id]`)

Add an **Actions** dropdown menu in the top-right of the run detail header (next to the
back-link and run ID). Menu items appear/grey out based on current run status:

| Action | Visible when status is |
|--------|----------------------|
| Restart | `failed` \| `completed` \| `timed_out` |
| Cancel | `running` \| `suspended` |
| Pause | `running` |
| Resume | `paused` |

Each action shows a confirmation modal with a reason text field before POSTing.
After success, the page re-polls and updates to reflect the new status.

### 4.2 Agent detail page (`/monitor/agents/[name]`) — Config tab

The Config tab currently shows read-only fields. Add an **Edit** button that toggles
the `dl` into an inline form. On save:
1. POST to `/api/manage/agents/[name]/config`.
2. Optimistically update the displayed values.
3. Show a transient success toast.

The read-only notice at the bottom of the Config tab is replaced with
"Last edited by [actor] at [timestamp]" sourced from the most recent `AuditLog` row.

### 4.3 EventInstance detail page (future)

Add a **Replay** button. Out of scope for v1 UI (the API is available; UI is v2).

---

## 5. Risk: cascading effects

Every Manage write op can trigger downstream work. Key mitigations:

| Risk | Mitigation |
|------|-----------|
| Double-restart (operator clicks twice) | `em.publish` dedup via `causedBy=runId` |
| Replay causes duplicate processing | Same `causedBy` dedup in EM |
| Cancel leaves orphaned HumanTasks | Route closes all open HumanTask rows atomically |
| Config change affects in-flight run | Config is read at step start; in-flight steps complete with old values |
| Paused run never resumed | `PauseFlag` table has a `expiresAt`; runs auto-resume after TTL (v2) |

**Operator education**: show a warning banner on the Restart and Replay confirmation modals:
"This will re-trigger downstream work. Ensure idempotency or check for duplicate output."

---

## 6. API surface summary

```
POST /api/manage/runs/[id]/restart    — re-emit trigger event
POST /api/manage/runs/[id]/cancel     — cancel and mark interrupted
POST /api/manage/runs/[id]/pause      — suspend at next boundary
POST /api/manage/runs/[id]/resume     — resume a paused run
POST /api/manage/events/[id]/replay   — re-publish an EventInstance
POST /api/manage/agents/[name]/config — upsert AgentConfig fields
```

All routes return `{ ok: true }` on success and `{ error: string, message: string }` on
failure. All routes append to `AuditLog` on success.

---

## 7. Implementation phases

**Phase 1 — Foundation (1 sprint)**
- Add `AuditLog` to Prisma schema + migrate.
- Implement `POST /api/manage/runs/[id]/cancel` (simplest write; just status update + log).
- Wire the Actions dropdown into the run detail page (cancel only).

**Phase 2 — Restart + Replay (1 sprint)**
- Implement `restart` and `event replay` routes (both use `em.publish`).
- Add restart to the Actions dropdown.
- Add Replay API (no UI yet).

**Phase 3 — Pause/Resume (1 sprint)**
- Design and implement PauseFlag or `waitForEvent` suspend mechanism.
- Implement `pause` and `resume` routes.
- Add to Actions dropdown.

**Phase 4 — AgentConfig edit UI (0.5 sprint)**
- Convert Config tab from read-only to editable form.
- Implement `POST /api/manage/agents/[name]/config`.
- Show AuditLog attribution in the Config tab footer.

**Phase 5 — Hardening (0.5 sprint)**
- Rate limiting on write routes (max 10 restarts/min per run).
- AuditLog viewer page (`/manage/audit`).
- Notification when a Manage action completes (WebSocket or SSE).
