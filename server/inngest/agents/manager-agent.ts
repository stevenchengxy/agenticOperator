// server/inngest/agents/manager-agent.ts
//
// Manager Agent — Behavior axis Phase 1.
//
// Inngest function subscribed to MONITOR_ALERT events. For each alert:
//   1. Applies pure rule-based decision policy (manager-rules.ts)
//   2. Persists decision back onto BehaviorAlert row
//   3. Executes the action (escalate → HumanTask; throttle/auto_restart → log v1; monitor → no-op)
//   4. Publishes MANAGER_ACTION for the full causal trail

import { inngest } from '@/server/inngest/client';
import { em } from '@/server/em';
import { prisma } from '@/server/db';
import { decide } from './manager-rules';
import type { MonitorAlertData, ManagerActionData } from '@/lib/behavior/types';

export const managerAgent = inngest.createFunction(
  { id: 'agent.manager', name: 'Manager Agent (response decisions)', triggers: [{ event: 'MONITOR_ALERT' }] },
  async ({ event, step }) => {
    const alertData = event.data as MonitorAlertData;
    const decision = await decide(alertData);

    // Step 1: Persist decision on BehaviorAlert
    await step.run('persist-decision', async () => {
      await prisma.behaviorAlert.updateMany({
        where: { id: alertData.alertId, resolvedAt: null },
        data: {
          managerActionTaken: decision.action,
          managerActionAt: new Date(),
        },
      });
    });

    // Step 2: Execute action
    await step.run('execute-action', async () => {
      switch (decision.action) {
        case 'escalate': {
          // Create a HumanTask for operator review
          await prisma.humanTask.create({
            data: {
              runId: 'system',
              nodeId: 'manager-agent',
              nodeName: 'ManagerAgent',
              title: `Manager escalation: ${alertData.alertKey}`,
              payload: JSON.stringify({
                alertId: alertData.alertId,
                alertKey: alertData.alertKey,
                severity: alertData.severity,
                ruleId: alertData.ruleId,
                details: alertData.details,
                reason: decision.reason,
              }),
              status: 'pending',
            },
          });
          break;
        }
        case 'auto_restart': {
          // Phase 2: real auto_restart — POST to /api/manage/runs/[id]/restart
          // Check autoRestartCount cap first (max 2 restarts per 1h per alert key)
          const alertRow = await prisma.behaviorAlert.findUnique({ where: { id: alertData.alertId } });
          const lastAt = alertRow?.lastAutoRestartAt;
          const count = alertRow?.autoRestartCount ?? 0;
          const withinWindow = lastAt && (Date.now() - lastAt.getTime()) < 60 * 60 * 1000;
          const cappedOut = withinWindow && count >= 2;

          if (cappedOut) {
            // Fall back to escalate — runaway restart loop prevention
            console.warn(
              `[manager-agent] auto_restart cap hit for ${alertData.alertKey} (count=${count}) — escalating instead`,
            );
            await prisma.humanTask.create({
              data: {
                runId: 'system',
                nodeId: 'manager-agent',
                nodeName: 'ManagerAgent',
                title: `Auto-restart cap hit: ${alertData.alertKey}`,
                payload: JSON.stringify({
                  alertId: alertData.alertId,
                  alertKey: alertData.alertKey,
                  severity: alertData.severity,
                  reason: `Auto-restart attempted ${count} times in 1h — requires operator review.`,
                }),
                status: 'pending',
              },
            });
            break;
          }

          // Attempt the restart via Manage API
          try {
            const baseUrl = process.env.AO_INTERNAL_URL ?? 'http://localhost:3002';
            const affectedRunId = alertData.alertKey.split('.')[1] ?? '';
            if (affectedRunId) {
              const resp = await fetch(`${baseUrl}/api/manage/runs/${affectedRunId}/restart`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: `Manager Agent auto_restart: ${decision.reason}` }),
                signal: AbortSignal.timeout(8000),
              });
              if (resp.ok) {
                // Increment counter + mark alert resolved
                await prisma.behaviorAlert.update({
                  where: { id: alertData.alertId },
                  data: {
                    autoRestartCount: { increment: 1 },
                    lastAutoRestartAt: new Date(),
                    resolvedAt: new Date(),
                  },
                });
                console.log(`[manager-agent] auto_restart succeeded for ${affectedRunId}`);
              } else {
                console.warn(`[manager-agent] auto_restart failed: HTTP ${resp.status}`);
              }
            }
          } catch (e) {
            console.warn(`[manager-agent] auto_restart fetch failed: ${(e as Error).message}`);
          }
          break;
        }
        case 'throttle': {
          // Phase 2: real throttle — POST to /api/manage/agents/[name]/throttle
          try {
            const baseUrl = process.env.AO_INTERNAL_URL ?? 'http://localhost:3002';
            const agentName = alertData.alertKey.split('.')[1] ?? alertData.alertKey;
            const resp = await fetch(`${baseUrl}/api/manage/agents/${agentName}/throttle`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ untilMs: 60_000, reason: decision.reason }),
              signal: AbortSignal.timeout(5000),
            });
            if (resp.ok) {
              console.log(`[manager-agent] throttle applied to ${agentName} for 60s`);
            } else {
              console.warn(`[manager-agent] throttle failed: HTTP ${resp.status}`);
            }
          } catch (e) {
            console.warn(`[manager-agent] throttle fetch failed: ${(e as Error).message}`);
          }
          break;
        }
        case 'monitor': {
          // no-op: observation only
          break;
        }
      }
    });

    // Step 3: Emit MANAGER_ACTION for the causal trail
    await step.run('emit-action-event', async () => {
      const actionData: ManagerActionData = {
        ...alertData,
        decision,
      };
      await em.publish('MANAGER_ACTION', actionData, {
        source: 'agent.manager',
        causedBy: { eventId: event.id ?? '', name: 'MONITOR_ALERT' },
      });
    });

    return { alertId: alertData.alertId, alertKey: alertData.alertKey, decision };
  },
);
