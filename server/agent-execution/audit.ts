// Audit-log bridge for the Agent Execution API.
//
// Lands each partner-eval execution in AO's UNIFIED audit log (the LogEvent
// table) so it is visible in /api/log-events + the 终端日志 tab — satisfying the
// "审计全量落库" requirement. Deliberately tagged with a DISTINCT source +
// agent so it stays OUT of every recruitment-specific surface:
//   - source='agent-execution'  → /analytics (counts category='api' only),
//                                  error-rate/cost monitors (read InngestRunArchive),
//                                  dependency monitor (category='dependency')都不会计入。
//   - writes LogEvent ONLY (not AgentActivity → avoids the WorkflowRun FK +
//     /monitor timeline pollution; not RuleCheckAudit → stays out of /rule-check
//     + /funnel; not recordNotification → no notification-center fan-out).
//
// recordLogEvent is fire-and-forget and never throws, so audit can never break
// or slow an execution.

import { recordLogEvent } from '@/server/log/log-event';

export const AGENT_EXECUTION_LOG_SOURCE = 'agent-execution';
export const AGENT_EXECUTION_LOG_AGENT = 'agent-execution-api';

export type AuditType =
  | 'event_received' // 受理
  | 'agent_start' // 开始执行
  | 'agent_complete' // 完成(含 decision)
  | 'agent_error'; // 失败(结构化 error)

export interface AuditExecutionInput {
  type: AuditType;
  executionId: string;
  traceId?: string | null;
  message: string;
  payload?: unknown;
  durationMs?: number | null;
}

/** Record one audit-log row for an execution lifecycle event. Tagged so it
 *  surfaces in the audit log but never pollutes recruitment monitors/analytics/
 *  notifications. Fire-and-forget. */
export function auditExecution(input: AuditExecutionInput): void {
  let payloadJson: string | null = null;
  if (input.payload !== undefined) {
    try {
      payloadJson = JSON.stringify(input.payload).slice(0, 4000);
    } catch {
      payloadJson = null;
    }
  }
  void recordLogEvent({
    type: input.type,
    message: input.message.slice(0, 2000),
    source: AGENT_EXECUTION_LOG_SOURCE,
    agent: AGENT_EXECUTION_LOG_AGENT,
    // executionId as the audit run key — LogEvent.runId has NO FK (unlike
    // AgentActivity), so /api/log-events?runId=exec_... returns the full trail.
    runId: input.executionId,
    traceId: input.traceId ?? null,
    payloadJson,
    durationMs: input.durationMs ?? null,
  }).catch(() => {});
}
