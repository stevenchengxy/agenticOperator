// server/inngest/agents/monitor-agent.ts
//
// Monitor Agent — Behavior axis Phase 1.
//
// Cron-driven Inngest function (every 60s). Reads last 5 min of runtime
// data, evaluates 6 heuristic rules, publishes MONITOR_ALERT events for
// new anomalies via em.publish. Deduplicates against open BehaviorAlert
// rows. Auto-resolves alerts that no longer fire (if > 5 min old).
//
// Rules:
//   1. agent_error_rate.*         — error rate > 20% (min 5 attempts)  → error
//   2. agent_error_rate_degraded.*— error rate 5-20% (min 5 attempts)  → warning
//   3. queue_backlog.*            — accepted EventInstance > 100 in 15m → warning
//   4. hitl_stale.*               — HumanTask pending > 30 min          → warning
//   5. run_stalled.*              — WorkflowRun running > 30 min + no AgentActivity → error
//   6. em_degraded                — EmSystemStatus.state !== 'healthy'  → error

import { randomUUID } from 'node:crypto';
import { inngest } from '@/server/inngest/client';
import { em } from '@/server/em';
import { prisma } from '@/server/db';
import type { MonitorAlertData } from '@/lib/behavior/types';

// ── Constants ─────────────────────────────────────────────────────────────

const WINDOW_5MIN_MS = 5 * 60 * 1000;
const WINDOW_15MIN_MS = 15 * 60 * 1000;
const STALL_THRESHOLD_MS = 30 * 60 * 1000;
const HITL_STALE_MS = 30 * 60 * 1000;
const AUTO_RESOLVE_MIN_AGE_MS = 5 * 60 * 1000;
const ERROR_RATE_ERROR_THRESHOLD = 0.20;  // >20% → error
const ERROR_RATE_WARN_THRESHOLD = 0.05;   // >5% → warning
const MIN_ATTEMPTS_FOR_RATE = 5;
const QUEUE_BACKLOG_THRESHOLD = 100;

// ── Rule types ────────────────────────────────────────────────────────────

type FiredRule = {
  alertKey: string;
  severity: string;
  ruleId: string;
  details: string;
};

// ── Snapshot ──────────────────────────────────────────────────────────────

async function loadSnapshot(now: Date) {
  const since5m = new Date(now.getTime() - WINDOW_5MIN_MS);
  const since15m = new Date(now.getTime() - WINDOW_15MIN_MS);
  const stallCutoff = new Date(now.getTime() - STALL_THRESHOLD_MS);
  const hitlStaleCutoff = new Date(now.getTime() - HITL_STALE_MS);

  const [activities, eventInstances, pendingHitl, stalledRuns, emStatus] = await Promise.all([
    // AgentActivity in last 5 min (error + all)
    prisma.agentActivity.findMany({
      where: { createdAt: { gte: since5m } },
      select: { agentName: true, type: true, runId: true },
    }),
    // EventInstance accepted in last 15 min
    prisma.eventInstance.findMany({
      where: { ts: { gte: since15m }, status: 'accepted' },
      select: { name: true, id: true },
    }),
    // HumanTask pending + older than 30 min
    prisma.humanTask.findMany({
      where: { status: 'pending', createdAt: { lte: hitlStaleCutoff } },
      select: { id: true, createdAt: true },
    }),
    // WorkflowRun stuck in 'running' > 30 min with no activity since then
    prisma.workflowRun.findMany({
      where: {
        status: 'running',
        lastActivityAt: { lte: stallCutoff },
      },
      select: { id: true, lastActivityAt: true },
    }),
    // EM singleton status
    prisma.emSystemStatus.findUnique({ where: { id: 'singleton' } }),
  ]);

  return { activities, eventInstances, pendingHitl, stalledRuns, emStatus };
}

// ── Rule evaluation ───────────────────────────────────────────────────────

function evaluateRules(snapshot: Awaited<ReturnType<typeof loadSnapshot>>): FiredRule[] {
  const { activities, eventInstances, pendingHitl, stalledRuns, emStatus } = snapshot;
  const fired: FiredRule[] = [];

  // Rule 1 + 2: Agent error rate
  const agentAttempts: Record<string, number> = {};
  const agentErrors: Record<string, number> = {};
  for (const a of activities) {
    if (!a.agentName) continue;
    agentAttempts[a.agentName] = (agentAttempts[a.agentName] ?? 0) + 1;
    if (a.type === 'error' || a.type === 'agent_error' || a.type === 'failure') {
      agentErrors[a.agentName] = (agentErrors[a.agentName] ?? 0) + 1;
    }
  }
  for (const [agentName, attempts] of Object.entries(agentAttempts)) {
    if (attempts < MIN_ATTEMPTS_FOR_RATE) continue;
    const errors = agentErrors[agentName] ?? 0;
    const rate = errors / attempts;
    if (rate > ERROR_RATE_ERROR_THRESHOLD) {
      fired.push({
        alertKey: `agent_error_rate.${agentName}`,
        severity: 'error',
        ruleId: 'agent_error_rate',
        details: JSON.stringify({ agentName, errorRate: rate, errors, attempts, threshold: ERROR_RATE_ERROR_THRESHOLD }),
      });
    } else if (rate > ERROR_RATE_WARN_THRESHOLD) {
      fired.push({
        alertKey: `agent_error_rate_degraded.${agentName}`,
        severity: 'warning',
        ruleId: 'agent_error_rate_degraded',
        details: JSON.stringify({ agentName, errorRate: rate, errors, attempts, threshold: ERROR_RATE_WARN_THRESHOLD }),
      });
    }
  }

  // Rule 3: Queue backlog per event name
  const eventCounts: Record<string, number> = {};
  for (const ev of eventInstances) {
    eventCounts[ev.name] = (eventCounts[ev.name] ?? 0) + 1;
  }
  for (const [eventName, count] of Object.entries(eventCounts)) {
    if (count > QUEUE_BACKLOG_THRESHOLD) {
      fired.push({
        alertKey: `queue_backlog.${eventName}`,
        severity: 'warning',
        ruleId: 'queue_backlog',
        details: JSON.stringify({ eventName, count, threshold: QUEUE_BACKLOG_THRESHOLD }),
      });
    }
  }

  // Rule 4: HITL stale
  for (const task of pendingHitl) {
    fired.push({
      alertKey: `hitl_stale.${task.id}`,
      severity: 'warning',
      ruleId: 'hitl_stale',
      details: JSON.stringify({ taskId: task.id, createdAt: task.createdAt }),
    });
  }

  // Rule 5: Run stalled
  for (const run of stalledRuns) {
    fired.push({
      alertKey: `run_stalled.${run.id}`,
      severity: 'error',
      ruleId: 'run_stalled',
      details: JSON.stringify({ runId: run.id, lastActivityAt: run.lastActivityAt }),
    });
  }

  // Rule 6: EM degraded
  if (emStatus && emStatus.state !== 'healthy') {
    fired.push({
      alertKey: 'em_degraded',
      severity: 'error',
      ruleId: 'em_degraded',
      details: JSON.stringify({ state: emStatus.state, since: emStatus.degradedSince }),
    });
  }

  return fired;
}

// ── Main function ─────────────────────────────────────────────────────────

export const monitorAgent = inngest.createFunction(
  { id: 'agent.monitor', name: 'Monitor Agent (anomaly detection)', triggers: [{ cron: '*/1 * * * *' }] },
  async ({ step }) => {
    const now = new Date();

    // Steps 1-4 run in a single step to avoid Inngest JSON-serialization of
    // Date objects across step boundaries. The snapshot loads, rule evaluation,
    // dedup, publish, and auto-resolve all happen in one atomic step.run block.
    const result = await step.run('evaluate-and-publish', async () => {
      const snapshot = await loadSnapshot(now);
      const fired = evaluateRules(snapshot);
      const firedKeys = new Set(fired.map((f) => f.alertKey));
      const published: string[] = [];
      const updated: string[] = [];

      // Fetch all currently open alerts in one query
      const openAlerts = await prisma.behaviorAlert.findMany({
        where: { resolvedAt: null },
        select: { id: true, alertKey: true, firstSeenAt: true },
      });
      const openByKey = new Map(openAlerts.map((a) => [a.alertKey, a]));

      for (const rule of fired) {
        const existing = openByKey.get(rule.alertKey);
        if (existing) {
          // Dedup: update lastSeenAt only
          await prisma.behaviorAlert.update({
            where: { id: existing.id },
            data: { lastSeenAt: now },
          });
          updated.push(rule.alertKey);
        } else {
          // New alert: insert BehaviorAlert + publish MONITOR_ALERT event
          const alertId = randomUUID();
          await prisma.behaviorAlert.create({
            data: {
              id: alertId,
              alertKey: rule.alertKey,
              severity: rule.severity,
              ruleId: rule.ruleId,
              details: rule.details,
              firstSeenAt: now,
              lastSeenAt: now,
            },
          });

          const alertData: MonitorAlertData = {
            alertId,
            alertKey: rule.alertKey,
            severity: rule.severity,
            ruleId: rule.ruleId,
            details: rule.details,
            detectedAt: now.toISOString(),
          };

          await em.publish('MONITOR_ALERT', alertData, {
            source: 'agent.monitor',
          });
          published.push(rule.alertKey);
        }
      }

      // Auto-resolve alerts that no longer fire (and are > 5 min old)
      const autoResolveAge = new Date(now.getTime() - AUTO_RESOLVE_MIN_AGE_MS);
      for (const alert of openAlerts) {
        if (!firedKeys.has(alert.alertKey) && alert.firstSeenAt <= autoResolveAge) {
          await prisma.behaviorAlert.updateMany({
            where: { alertKey: alert.alertKey, resolvedAt: null },
            data: { resolvedAt: now },
          });
        }
      }

      return { fired: fired.length, published, updated };
    });

    return { now: now.toISOString(), ...result };
  },
);
