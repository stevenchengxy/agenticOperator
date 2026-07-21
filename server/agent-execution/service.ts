// Service layer for the Agent Execution API: idempotent accept (A1), background
// run, and poll (A2). Persists ONLY to the new agent_execution table — production
// tables are never written. Runs on AO's persistent Next server (port 3002), so
// the fire-and-forget background promise completes normally (not serverless).

import { randomUUID } from 'node:crypto';
import { prisma } from '@/server/db';
import { executeRuleCheck } from './run';
import { auditExecution } from './audit';
import type { ExecutionRequest, ExecutionResponse, ExecutionStatus } from './types';

export interface AcceptResult {
  executionId: string;
  status: ExecutionStatus;
  duplicate: boolean;
}

/** Thrown by acceptExecution when in-flight runs ≥ the concurrency cap. The
 *  route turns this into HTTP 429 + Retry-After so the partner backs off. */
export class ConcurrencyLimitError extends Error {
  constructor(public retryAfterSec: number) {
    super('agent-execution concurrency limit reached');
    this.name = 'ConcurrencyLimitError';
  }
}

const MAX_CONCURRENT = Math.max(1, Number(process.env.AGENT_EXECUTION_MAX_CONCURRENT ?? '4') || 4);

function newExecutionId(): string {
  return `exec_${randomUUID().replace(/-/g, '')}`;
}

/** A1: accept (idempotent on clientRequestId). Kicks off the run in the
 *  background and returns immediately. */
export async function acceptExecution(req: ExecutionRequest): Promise<AcceptResult> {
  const existing = await prisma.agentExecution.findUnique({
    where: { clientRequestId: req.clientRequestId },
  });
  if (existing) {
    // Idempotent replay never consumes a concurrency slot.
    return { executionId: existing.id, status: existing.status as ExecutionStatus, duplicate: true };
  }

  // Soft concurrency backpressure (advisory; a small race is acceptable). New
  // requests beyond the cap get 429 + Retry-After at the route layer.
  const inFlight = await prisma.agentExecution.count({
    where: { status: { in: ['pending', 'running'] } },
  });
  if (inFlight >= MAX_CONCURRENT) {
    throw new ConcurrencyLimitError(5);
  }

  const executionId = newExecutionId();
  try {
    await prisma.agentExecution.create({
      data: {
        id: executionId,
        clientRequestId: req.clientRequestId,
        status: 'pending',
        runId: req.correlation?.runId ?? null,
        testCaseId: req.correlation?.testCaseId ?? null,
        domain: req.ontology?.domain ?? '',
        ontologyVersion: req.ontology?.version ?? '',
        scenario: req.scenario ?? '',
        mode: req.mode ?? 'shadow',
        requestJson: JSON.stringify(req),
      },
    });
  } catch (e) {
    // Idempotency race: a concurrent request created the row first.
    const dup = await prisma.agentExecution.findUnique({ where: { clientRequestId: req.clientRequestId } });
    if (dup) return { executionId: dup.id, status: dup.status as ExecutionStatus, duplicate: true };
    throw e;
  }

  // 审计:受理 (统一审计日志,source='agent-execution' → 不污染招聘面)。
  auditExecution({
    type: 'event_received',
    executionId,
    traceId: req.correlation?.runId ?? null,
    message: `执行受理 scenario=${req.scenario} version=${req.ontology?.version ?? ''}`,
    payload: { clientRequestId: req.clientRequestId, testCaseId: req.correlation?.testCaseId ?? null },
  });

  // Fire-and-forget — the persistent server keeps the promise alive.
  void runInBackground(executionId, req);

  return { executionId, status: 'pending', duplicate: false };
}

async function runInBackground(executionId: string, req: ExecutionRequest): Promise<void> {
  const traceId = req.correlation?.runId ?? null;
  const startMs = Date.now();
  try {
    await prisma.agentExecution.update({
      where: { id: executionId },
      data: { status: 'running', startedAt: new Date() },
    });
  } catch {
    // row vanished — nothing to do
    return;
  }
  auditExecution({ type: 'agent_start', executionId, traceId, message: '开始执行(shadow,纯计算)' });

  let response: ExecutionResponse;
  let llmFull: unknown = null;
  try {
    const outcome = await executeRuleCheck(executionId, req);
    response = outcome.response;
    llmFull = outcome.llmFull;
  } catch (e) {
    response = {
      executionId,
      status: 'failed',
      correlation: req.correlation ?? null,
      result: null,
      trace: null,
      meta: null,
      error: { code: 'INTERNAL', message: (e as Error).message ?? String(e), retryable: false },
    };
  }

  // Stamp the persisted executionId into the response (mapper used it already).
  response.executionId = executionId;

  try {
    await prisma.agentExecution.update({
      where: { id: executionId },
      data: {
        status: response.status,
        resultJson: JSON.stringify(response),
        llmFullJson: llmFull ? JSON.stringify(llmFull) : null,
        model: response.meta?.model ?? null,
        promptTokens: response.meta?.usage.inputTokens ?? null,
        completionTokens: response.meta?.usage.outputTokens ?? null,
        errorCode: response.error?.code ?? null,
        errorMessage: response.error?.message ?? null,
        finishedAt: new Date(),
      },
    });
  } catch {
    // best-effort; the poll will keep returning 'running' if this failed
  }

  // 审计:终态 (成功 → agent_complete 含 decision;失败 → agent_error 含 error code)。
  const durationMs = Date.now() - startMs;
  if (response.status === 'succeeded') {
    auditExecution({
      type: 'agent_complete',
      executionId,
      traceId,
      durationMs,
      message: `完成 decision=${response.result?.decision ?? '?'}`,
      payload: {
        decision: response.result?.decision,
        vetoedBy: response.result?.decisionDetail.vetoedBy,
        rulesEvaluated: response.trace?.ruleEvaluations.length,
        retrievedRuleIds: response.trace?.retrievedRuleIds.length,
        model: response.meta?.model,
        tokens: response.meta?.usage,
        version: response.meta?.ontologyLoaded.version,
      },
    });
  } else {
    auditExecution({
      type: 'agent_error',
      executionId,
      traceId,
      durationMs,
      message: `执行失败 ${response.error?.code ?? 'UNKNOWN'}: ${response.error?.message ?? ''}`,
      payload: { error: response.error, status: response.status },
    });
  }
}

/** A2: poll. Returns the full response once done, else a status-only envelope. */
export async function getExecution(executionId: string): Promise<ExecutionResponse | null> {
  const row = await prisma.agentExecution.findUnique({ where: { id: executionId } });
  if (!row) return null;

  if (row.resultJson) {
    try {
      return JSON.parse(row.resultJson) as ExecutionResponse;
    } catch {
      // fall through to a status envelope
    }
  }
  return {
    executionId: row.id,
    status: row.status as ExecutionStatus,
    correlation: row.runId || row.testCaseId ? { runId: row.runId ?? undefined, testCaseId: row.testCaseId ?? undefined } : null,
    result: null,
    trace: null,
    meta: null,
    error: row.errorCode ? { code: row.errorCode, message: row.errorMessage ?? '', retryable: false } : null,
  };
}

/** A3: the full LLM prompt/response for a finished execution's call.
 *  MVP: the engine makes one batched LLM call ('llm-001'); we surface its index
 *  (model/tokens) merged with the full prompt/response persisted in llm_full_json.
 *  No production-table dependency. Returns null if execution/call unknown. */
export async function getLlmCall(
  executionId: string,
  callId: string,
): Promise<Record<string, unknown> | null> {
  const row = await prisma.agentExecution.findUnique({ where: { id: executionId } });
  if (!row) return null;

  let index: Record<string, unknown> | undefined;
  if (row.resultJson) {
    try {
      const resp = JSON.parse(row.resultJson) as ExecutionResponse;
      index = resp.trace?.llmCalls.find((c) => (c as { callId?: string }).callId === callId) as
        | Record<string, unknown>
        | undefined;
    } catch {
      // ignore
    }
  }
  if (!index) return null;

  let full: { systemPrompt?: string | null; userPrompt?: string | null; responseText?: string | null } = {};
  if (row.llmFullJson) {
    try {
      full = JSON.parse(row.llmFullJson);
    } catch {
      // ignore
    }
  }
  return {
    ...index,
    prompt: { system: full.systemPrompt ?? null, user: full.userPrompt ?? null },
    response: full.responseText ?? null,
  };
}
