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
import { decideAction } from './manager-rules';
import type { MonitorAlertData, ManagerActionData } from '@/lib/behavior/types';

export const managerAgent = inngest.createFunction(
  { id: 'agent.manager', name: 'Manager Agent (response decisions)', triggers: [{ event: 'MONITOR_ALERT' }] },
  async ({ event, step }) => {
    const alertData = event.data as MonitorAlertData;
    const decision = decideAction(alertData);

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
          // v1: log a recommendation; real auto-restart requires Manage axis integration
          console.log(`[manager-agent] auto_restart recommended for ${alertData.alertKey} — deferred to Manage axis v2`);
          break;
        }
        case 'throttle': {
          // v1: log a recommendation; real throttling requires AgentConfig write
          console.log(`[manager-agent] throttle recommendation for ${alertData.alertKey}: ${decision.reason}`);
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
