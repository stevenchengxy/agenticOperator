// server/inngest/agents/manager-rules.ts
//
// Pure, side-effect-free decision policy for the Manager Agent (v1: hand-tuned rules).
// Every branch is unit-testable in isolation.
//
// Phase 2 addition: BEHAVIOR_DECISION_MODE env scaffold.
// Set BEHAVIOR_DECISION_MODE=llm to route decisions through the LLM path.
// LLM call is not yet implemented — it falls back to rules with a warning.

import type { MonitorAlertData, ManagerDecision } from '@/lib/behavior/types';

export type { ManagerDecision };

/**
 * Top-level decision entry point. Checks BEHAVIOR_DECISION_MODE env;
 * if 'llm', runs the LLM path (not yet implemented — falls back to rules).
 * Otherwise delegates directly to decideAction (rule-based).
 */
export async function decide(alert: MonitorAlertData): Promise<ManagerDecision> {
  if (process.env.BEHAVIOR_DECISION_MODE === 'llm') {
    // TODO: call LLM with alert context. For v1 scaffold: return rules result.
    // Expected shape: fetch Anthropic API with alert payload + last 10 MANAGER_ACTION
    // decisions for this agent as context, return structured JSON decision.
    console.warn('[behavior] LLM mode not yet implemented, falling back to rules');
  }
  return decideAction(alert);
}

/**
 * Decide what the Manager Agent should do in response to a MONITOR_ALERT.
 *
 * Decision table (v1):
 *
 * | alertKey prefix          | severity | action       |
 * |--------------------------|----------|--------------|
 * | agent_error_rate.*       | error    | escalate     |
 * | agent_error_rate_degraded.*| warning | monitor     |
 * | queue_backlog.*          | warning  | throttle     |
 * | hitl_stale.*             | warning  | escalate     |
 * | run_stalled.*            | error    | escalate     |
 * | em_degraded              | error    | escalate     |
 * | (fallback)               | any      | monitor      |
 */
export function decideAction(alert: MonitorAlertData): ManagerDecision {
  const { alertKey, severity } = alert;

  if (alertKey.startsWith('agent_error_rate.')) {
    return severity === 'error'
      ? { action: 'escalate', reason: 'Error rate exceeds 20% — operator review required.' }
      : { action: 'monitor', reason: 'Error rate degraded but within monitor threshold.' };
  }

  if (alertKey.startsWith('agent_error_rate_degraded.')) {
    return { action: 'monitor', reason: 'Error rate degraded (5–20%) — continuous observation.' };
  }

  if (alertKey.startsWith('queue_backlog.')) {
    return { action: 'throttle', reason: 'Queue backlog growing — throttle recommendation logged.' };
  }

  if (alertKey.startsWith('hitl_stale.')) {
    return { action: 'escalate', reason: 'HITL task stale > 30 min — escalate to operator.' };
  }

  if (alertKey.startsWith('run_stalled.')) {
    return { action: 'escalate', reason: 'Run stalled > 30 min without activity — operator review required.' };
  }

  if (alertKey === 'em_degraded') {
    return { action: 'escalate', reason: 'EM in degraded mode — SRE attention required.' };
  }

  // Fallback: unknown alert type — observe only
  return { action: 'monitor', reason: `Unknown alert type "${alertKey}" — observe only.` };
}
