# Behavior axis — Design spec

**Date**: 2026-05-14
**Authors**: Steven · Claude
**Scope**: Agentic Operator "Behavior" axis — two new autonomous agents (Monitor Agent +
Manager Agent) that observe the running system and make automated response decisions,
publishing structured alert and action events through EM.
**Out of scope**: Human-initiated write ops (Manage axis). Read-only observability (Monitor axis).

---

## 0. Three-axis framework recap

| Axis | Nature | Status |
|------|--------|--------|
| Monitor | Read-only: observe runs, queues, failures, token spend | Shipped (2026-05-14) |
| Manage | Human write-ops: restart, cancel, pause, resume, replay, config edits | Next |
| **Behavior** (this spec) | Automated: Monitor Agent (anomaly detection) + Manager Agent (response decisions) | After Manage |

---

## 1. Architecture overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         AO data layer (Prisma / SQLite)                    │
│  AgentActivity · EventInstance · AgentEpisode · HealthIncident · WorkflowRun │
└─────────────────────────────┬──────────────────────────────────────────────┘
                              │ reads (every 60s)
                              ▼
                  ┌───────────────────────┐
                  │   Monitor Agent       │
                  │  (Inngest function)   │
                  │  Anomaly detection    │
                  │  rule-based v1 →      │
                  │  LLM-driven v2        │
                  └──────────┬────────────┘
                             │ em.publish MONITOR_ALERT
                             ▼
                  ┌───────────────────────┐
                  │   Manager Agent       │
                  │  (Inngest function)   │
                  │  Severity evaluation  │
                  │  Response selection   │
                  │  (rule-based v1 →     │
                  │   LLM-driven v2)      │
                  └──────────┬────────────┘
                             │ em.publish MANAGER_ACTION
                             │
              ┌──────────────┼──────────────────┐
              ▼              ▼                   ▼
       Manage API      HumanTask          Throttle AgentConfig
   (restart/cancel)   (escalation)       (change maxRetries)
```

---

## 2. Data sources

Both agents consume the following AO data:

| Source | Used for |
|--------|----------|
| `AgentActivity` | Per-agent error counts, invocation counts, last activity timestamp |
| `AgentEpisode` | P95 latency (`durationMs`), token usage trends (`tokenUsage.total`), judge scores |
| `EventInstance` | Queue depth (events `status='pending'`), DLQ (events `status='failed'`) |
| `HealthIncident` | Existing incident records — deduplicate against open incidents |
| `WorkflowRun` | Stuck runs (`status='running'` + `lastActivityAt > threshold`) |

The Monitor Agent reads these via Prisma queries inside the Inngest function. No additional
API surface is needed for the read path.

---

## 3. Monitor Agent

### 3.1 Trigger

- **Schedule**: Inngest cron, every 60 seconds.
- **Event**: `MONITOR_TICK` (emitted by the cron, consumed by the function).

### 3.2 Detection rules (v1 — heuristic)

The agent evaluates the following conditions over a configurable look-back window
(default: last 5 minutes):

| Rule | Condition | Severity | Alert type |
|------|-----------|----------|-----------|
| High error rate | agent error rate > 5% in window | `warn` (>5%) / `critical` (>20%) | `error_rate` |
| Queue depth | `EventInstance` pending count > 100 | `warn` (>100) / `critical` (>500) | `queue_depth` |
| High latency | P95 `durationMs` > 5000ms | `warn` | `latency` |
| Stuck run | `WorkflowRun.status='running'` + no activity for >30min | `warn` | `stuck_run` |
| DLQ growth | new `DLQEntry` rows in window > 10 | `critical` | `dlq` |
| No activity | an agent has 0 invocations when it should have had some (based on upstream events) | `info` | `idle_agent` |

Thresholds are read from `AgentConfig.behaviorConfig` (a JSON column, added to schema in
Behavior Phase 1). Operators can tune thresholds per-agent without a deploy.

### 3.3 Deduplication

Before publishing a `MONITOR_ALERT`, the agent checks `HealthIncident` for an open incident
of the same `agentName + alertType`. If an open incident exists, the alert is suppressed
(no new event). This prevents alert storms during sustained degradation.

### 3.4 Output event: `MONITOR_ALERT`

```typescript
type MonitorAlertPayload = {
  alertId: string;          // cuid, matches HealthIncident.id
  agentName: string;        // canonical short (or "system" for cross-agent)
  alertType: string;        // "error_rate" | "queue_depth" | "latency" | "stuck_run" | "dlq" | "idle_agent"
  severity: "info" | "warn" | "critical";
  metric: {
    name: string;           // human-readable metric name
    value: number;          // current measured value
    threshold: number;      // the threshold that was crossed
  };
  affectedRunIds: string[]; // up to 5 most recent affected run IDs
  detectedAt: string;       // ISO timestamp
  windowSeconds: number;    // look-back window used
};
```

The alert is persisted as both:
1. An `EventInstance` (via `em.publish('MONITOR_ALERT', payload)`).
2. A `HealthIncident` row (`status='open'`, linked to the EventInstance).

---

## 4. Manager Agent

### 4.1 Trigger

Subscribes to `MONITOR_ALERT` events via Inngest `onEvent`.

### 4.2 Decision logic (v1 — declarative rules)

The Manager Agent maps `alertType + severity` to a response action:

| Alert type | Severity | Response |
|-----------|----------|----------|
| `error_rate` | `warn` | Log + notify (no action) |
| `error_rate` | `critical` | Create `HumanTask` ("Investigate agent errors") |
| `queue_depth` | `warn` | Log only |
| `queue_depth` | `critical` | Create `HumanTask` ("Queue critical — review DLQ") |
| `latency` | `warn` | Increase `AgentConfig.maxRetries` by 1 (via Manage API) |
| `stuck_run` | `warn` | Create `HumanTask` ("Investigate stuck run [id]") |
| `dlq` | `critical` | Create `HumanTask` ("DLQ growth — replay or discard events") |
| `idle_agent` | `info` | Log only (may indicate upstream agent is also idle — expected) |

Rules are stored in a static map in the Manager Agent function (v1). In v2, rules are loaded
from `AgentConfig.behaviorConfig` to allow per-agent tuning without deploy.

### 4.3 LLM-driven decision (v2 — deferred)

In v2, the Manager Agent calls Claude with:
- The `MONITOR_ALERT` payload
- The last 10 `MANAGER_ACTION` decisions for this agent (context/history)
- The current `AgentConfig` (temperature, retries, etc.)
- A policy prompt describing the response options and constraints

Claude returns a structured JSON decision: `{ action, confidence, reasoning }`. A confidence
threshold gates whether the LLM decision is applied automatically (high confidence) or
converted to a `HumanTask` for operator approval (low confidence).

The LLM path is gated behind a feature flag in `AgentConfig.behaviorConfig.useLlmManager`.

### 4.4 Output event: `MANAGER_ACTION`

```typescript
type ManagerActionPayload = {
  actionId: string;           // cuid
  alertId: string;            // links back to the MONITOR_ALERT
  agentName: string;
  decision: "no_op" | "notify" | "create_hitl" | "adjust_config" | "restart_run" | "cancel_run";
  decisionMethod: "rule" | "llm";
  confidence?: number;        // 0–1, only set for llm decisions
  reasoning?: string;         // LLM-generated explanation or rule name
  targetId?: string;          // run ID if decision=restart_run/cancel_run; config key if adjust_config
  outcome?: "pending" | "applied" | "failed"; // updated after action execution
  appliedAt?: string;
};
```

Persisted as an `EventInstance` via `em.publish('MANAGER_ACTION', payload)`.

### 4.5 Action execution

After publishing `MANAGER_ACTION`, the Manager Agent executes the decided action:

- `create_hitl` → INSERT `HumanTask` with link to alertId and runId.
- `adjust_config` → POST `/api/manage/agents/[name]/config` (internal call, skips auth,
  appends to `AuditLog` with `actorId = 'manager-agent'`).
- `restart_run` / `cancel_run` → POST `/api/manage/runs/[id]/restart` or `/cancel`
  (same pattern: internal call, `actorId = 'manager-agent'`).
- `no_op` / `notify` → log only; update `ManagerActionPayload.outcome = 'applied'`.

On execution failure, `outcome = 'failed'` and a new `HumanTask` is created as a fallback
so the failure never goes unnoticed.

---

## 5. Escalation paths

Not every alert goes to a human. The escalation ladder:

```
MONITOR_ALERT (info)   → no escalation
MONITOR_ALERT (warn)   → Manager Agent tries auto-fix; escalates to HumanTask if auto-fix fails
MONITOR_ALERT (critical) → direct HumanTask creation (do not wait for auto-fix to fail first)
```

HumanTask priority field:
- `info` alert escalation → priority `low`
- `warn` alert escalation → priority `medium`
- `critical` alert escalation → priority `high`

An operator can acknowledge a `HumanTask` generated by the Manager Agent, closing the linked
`HealthIncident`. Acknowledgement suppresses further alerts for that `agentName + alertType`
for a configurable cooldown period (default: 1 hour).

---

## 6. Persistence

Both `MONITOR_ALERT` and `MANAGER_ACTION` are persisted through the standard EM path:

1. `em.publish()` writes an `EventInstance` row (name, payload, status, causedBy).
2. The Monitor Agent additionally writes a `HealthIncident` row (linked to the EventInstance).
3. The Manager Agent updates `HealthIncident.status` when an action is applied (`→ 'mitigating'`)
   or resolved by a human (`→ 'resolved'`).

Schema additions needed:

```prisma
model HealthIncident {
  id               String   @id @default(cuid())
  eventInstanceId  String?  @unique   // links to MONITOR_ALERT EventInstance
  agentName        String
  alertType        String
  severity         String
  status           String   @default("open")  // open | mitigating | resolved
  resolvedAt       DateTime?
  resolvedBy       String?  // actorId or "manager-agent"
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
}
```

`ManagerAction` outcomes are stored inside the `MANAGER_ACTION` `EventInstance.payload`
(updated in-place via a Prisma update after execution). No separate table needed in v1.

---

## 7. New UI route: `/behavior`

A new page showing the recent activity of the two Behavior agents.

### Layout (3 panels)

```
┌─── KPI strip ──────────────────────────────────────────────────────────┐
│  Open incidents: 3   Alerts (24h): 47   Auto-resolved: 38   Escalated: 6│
└────────────────────────────────────────────────────────────────────────┘

┌─── Recent alerts (left, 40%) ──┐ ┌─── Manager decisions (right, 60%) ──┐
│ [crit] ResumeParser            │ │ Alert → Decision → Outcome           │
│   error_rate 23% > 5%          │ │ [crit] ResumeParser error_rate →     │
│   2 min ago · 3 runs affected  │ │   create_hitl → HumanTask #t7 created│
│                                │ │                                      │
│ [warn] Publisher               │ │ [warn] Publisher latency →           │
│   latency P95 6200ms           │ │   adjust_config maxRetries 3→4 ✓    │
│   5 min ago                    │ │                                      │
│ ...                            │ │ ...                                  │
└────────────────────────────────┘ └──────────────────────────────────────┘

┌─── Incident timeline (below, full width) ──────────────────────────────┐
│  Scrollable list of HealthIncident rows with status badges              │
└────────────────────────────────────────────────────────────────────────┘
```

The page polls `/api/behavior/alerts` and `/api/behavior/decisions` (new routes, read-only)
every 15 seconds. No writes from this page — all write actions are via Manage axis.

---

## 8. Phased rollout

**Phase 1 — Schema + Monitor Agent skeleton (1 sprint)**
- Add `HealthIncident` to Prisma schema.
- Add `behaviorConfig` JSON column to `AgentConfig`.
- Implement Monitor Agent Inngest function (cron every 60s).
- Implement 2 rules: `error_rate` + `queue_depth`.
- Persist alerts as `EventInstance` + `HealthIncident`.
- No Manager Agent yet.

**Phase 2 — Manager Agent + rule engine (1 sprint)**
- Implement Manager Agent: subscribes to `MONITOR_ALERT`.
- Implement rule map for all 6 alert types.
- Wire `create_hitl` and `notify` actions.
- Add `MANAGER_ACTION` persistence.
- Extend Monitor Agent with remaining 4 rules.

**Phase 3 — Manage API integration (0.5 sprint)**
- Wire `adjust_config`, `restart_run`, `cancel_run` actions
  (requires Manage axis Phase 1–2 shipped first).
- Add cooldown/dedup logic for escalation suppression.

**Phase 4 — /behavior UI (1 sprint)**
- New `/behavior` route with 3-panel layout.
- Read-only API routes (`/api/behavior/alerts`, `/api/behavior/decisions`).
- Incident acknowledgement from the HumanTask inbox.

**Phase 5 — LLM-driven decisions (1 sprint)**
- Implement LLM decision path in Manager Agent.
- Feature-flag `useLlmManager` in `AgentConfig.behaviorConfig`.
- Low-confidence LLM decisions → `HumanTask` for approval.
- Reasoning logged in `MANAGER_ACTION.payload.reasoning`.
