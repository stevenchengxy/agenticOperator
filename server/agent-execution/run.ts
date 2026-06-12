// Execution orchestrator: validate → build input → call the PURE runRuleCheck
// engine → map to the partner contract. Touches NOTHING in the production flow:
// no Inngest, no event emission, no production-table writes, no external side
// effects (shadow by construction — the engine is read-only compute).

import { buildRuleCheckInput, runRuleCheck } from '@/lib/rule-check';
import { getInstance } from '@/lib/rule-check/instance-client';
import { createAgentLogger, runWithLogger } from '@/lib/agent-logger';
import { loadVersion, listVersions, normalizeDomain } from './version-registry';
import { mapResultToResponse } from './mapper';
import type { ExecutionRequest, ExecutionResponse, ExecutionErrorCode } from './types';

function errResponse(
  executionId: string,
  correlation: ExecutionRequest['correlation'],
  code: ExecutionErrorCode,
  message: string,
  retryable: boolean,
  status: 'failed' | 'timeout' = 'failed',
): ExecuteOutcome {
  return {
    response: {
      executionId,
      status,
      correlation: correlation ?? null,
      result: null,
      trace: null,
      meta: null,
      error: { code, message, retryable },
    },
    llmFull: null,
  };
}

/** Full LLM prompt/response for A3 (never inlined into the A2 poll). */
export interface LlmFull {
  systemPrompt: string | null;
  userPrompt: string | null;
  responseText: string | null;
}

export interface ExecuteOutcome {
  response: ExecutionResponse;
  llmFull: LlmFull | null;
}

/** Run one execution end-to-end. Returns a terminal ExecutionResponse
 *  (status succeeded | failed | timeout) plus the LLM full text for A3.
 *  Never throws. */
export async function executeRuleCheck(
  executionId: string,
  req: ExecutionRequest,
): Promise<ExecuteOutcome> {
  const corr = req.correlation ?? null;

  // ── Contract validation (guide §4.5) ───────────────────────────────────
  if (req.scenario !== 'matchResume') {
    return errResponse(executionId, corr, 'SCENARIO_UNSUPPORTED', `scenario '${req.scenario}' not supported (MVP: matchResume only)`, false);
  }
  if (req.entry?.stepIds != null) {
    return errResponse(executionId, corr, 'SCENARIO_UNSUPPORTED', 'entry.stepIds is not supported — AO evaluates the full rule set in one pass (guide §4.1)', false);
  }
  if (req.mode != null && req.mode !== 'shadow') {
    return errResponse(executionId, corr, 'INPUT_INVALID', `mode '${req.mode}' not supported (only shadow)`, false);
  }
  if (req.inputs?.overrides != null) {
    return errResponse(executionId, corr, 'INPUT_INVALID', 'inputs.overrides not supported in MVP (must be null)', false);
  }

  const version = req.ontology?.version ?? '';
  const loaded = loadVersion(version);
  if (!loaded) {
    return errResponse(executionId, corr, 'ONTOLOGY_VERSION_UNAVAILABLE', `${version || '(empty)'} 不可用,当前可加载版本: ${listVersions().join(', ') || '(none)'}`, false);
  }

  // ── Resolve inputs (ref / inline) ──────────────────────────────────────
  const jobInline = req.inputs?.job?.inline ?? null;
  const jobRef = req.inputs?.job?.ref ?? null;
  const candInline = req.inputs?.candidate?.inline ?? null;
  const candRef = req.inputs?.candidate?.ref ?? null;

  if (candInline) {
    // Injecting inline candidate into the graph path needs the §10-④ schema
    // alignment — not in MVP. Refuse honestly rather than run a different path.
    return errResponse(executionId, corr, 'INPUT_INVALID', 'inline candidate not supported in MVP — use candidate.ref (guide §10-④)', false);
  }
  if (!candRef?.id) {
    return errResponse(executionId, corr, 'INPUT_INVALID', 'inputs.candidate.ref.id is required (MVP)', false);
  }
  if (!jobRef?.id && !jobInline) {
    return errResponse(executionId, corr, 'INPUT_INVALID', 'inputs.job requires ref.id or inline', false);
  }

  const candidateId = candRef.id;
  const traceId = corr?.runId ?? null;
  const logger = createAgentLogger({
    agent: 'agentExecution',
    runId: executionId,
    traceId,
    anchors: { candidate_id: candidateId, execution_id: executionId },
  });

  return runWithLogger(logger, async () => {
    logger.event('execution.start', { scenario: req.scenario, version, candidate_id: candidateId });

    // Resolve candidate (Neo4j-only, no fallback — guide §9.4). Miss → hard error.
    let candidate: Record<string, unknown> | null = null;
    try {
      candidate = await getInstance('Candidate', candidateId);
    } catch (e) {
      return errResponse(executionId, corr, 'ONTOLOGY_GRAPH_UNAVAILABLE', `candidate lookup failed: ${(e as Error).message}`, true);
    }
    if (!candidate) {
      return errResponse(executionId, corr, 'INPUT_REF_NOT_FOUND', `candidate '${candidateId}' not found in Neo4j (no fallback)`, false);
    }

    // Resolve job (inline wins; ref → Neo4j w/ partner-pg fallback for JR only).
    let jr: Record<string, unknown>;
    let jobStore = 'inline';
    if (jobInline) {
      jr = { ...jobInline };
    } else {
      let jobRow: Record<string, unknown> | null = null;
      try {
        jobRow = await getInstance('Job_Requisition', jobRef!.id);
      } catch (e) {
        return errResponse(executionId, corr, 'ONTOLOGY_GRAPH_UNAVAILABLE', `job lookup failed: ${(e as Error).message}`, true);
      }
      if (!jobRow) {
        return errResponse(executionId, corr, 'INPUT_REF_NOT_FOUND', `job '${jobRef!.id}' not found`, false);
      }
      jr = jobRow;
      jobStore = 'neo4j';
    }
    if (typeof jr.job_requisition_id !== 'string' || !jr.job_requisition_id) {
      jr.job_requisition_id = jobRef?.id ?? '';
    }

    const input = buildRuleCheckInput({
      runtime_context: {
        upload_id: `exec_${executionId}`,
        candidate_id: candidateId,
        resume_id: '',
        employee_id: process.env.RAAS_DEFAULT_EMPLOYEE_ID ?? 'eval-test-builder',
        trace_id: traceId,
      },
      parsed_resume: null,
      job_requisition: jr,
    });

    const startedAt = new Date().toISOString();
    // Honor config.timeoutMs (default 120s) — race the engine against a timer so
    // a hung LLM call yields a terminal EXECUTION_TIMEOUT instead of a stuck run.
    const timeoutMs = req.config?.timeoutMs ?? 120000;
    const TIMEOUT = Symbol('timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result;
    try {
      const raced = await Promise.race([
        runRuleCheck(input, { model: req.config?.model ?? undefined, logger }),
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
        }),
      ]);
      if (raced === TIMEOUT) {
        logger.event('execution.timeout', { timeout_ms: timeoutMs });
        return errResponse(executionId, corr, 'EXECUTION_TIMEOUT', `execution exceeded timeoutMs=${timeoutMs}`, true, 'timeout');
      }
      result = raced;
    } catch (e) {
      return errResponse(executionId, corr, 'INTERNAL', `engine error: ${(e as Error).message}`, false);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const finishedAt = new Date().toISOString();

    // Infra failure (NOT a business result) → structured error, never a decision.
    const failReason = result.audit.fail_reason;
    if (failReason) {
      const detail = result.audit.llm_error_detail ?? '';
      // Gateway rate-limit (429 / too-many-requests) → distinct retryable code.
      const isRateLimited =
        failReason === 'llm-call-error' && /429|rate[\s_-]?limit|too many requests/i.test(detail);
      const map: Record<string, { code: ExecutionErrorCode; retryable: boolean }> = {
        'ontology-graph-unavailable': { code: 'ONTOLOGY_GRAPH_UNAVAILABLE', retryable: true },
        'llm-call-error': { code: 'MODEL_UNAVAILABLE', retryable: true },
        'tool-use-loop-exceeded': { code: 'INTERNAL', retryable: false },
        'parse-error': { code: 'INTERNAL', retryable: false },
      };
      const m = isRateLimited
        ? { code: 'UPSTREAM_RATE_LIMITED' as ExecutionErrorCode, retryable: true }
        : map[failReason] ?? { code: 'INTERNAL' as ExecutionErrorCode, retryable: false };
      logger.event('execution.infra-failure', { fail_reason: failReason, code: m.code });
      return errResponse(executionId, corr, m.code, `engine infra failure: ${failReason}${detail ? ` — ${detail}` : ''}`, m.retryable);
    }

    const response = mapResultToResponse({
      result,
      executionId,
      requestedDomain: req.ontology.domain,
      version,
      correlation: corr,
      inputsResolved: { candidate: { store: 'neo4j' }, job: { store: jobStore } },
      aoAuditId: null,
      ruleCount: loaded.ruleCount,
      startedAt,
      finishedAt,
    });
    logger.event('execution.done', { decision: response.result?.decision, rules: result.rule_results.length });
    void normalizeDomain; // domain normalization is applied at read time in graph/rule fetch
    return {
      response,
      llmFull: {
        systemPrompt: result.audit.system_prompt ?? null,
        userPrompt: result.audit.user_prompt ?? null,
        responseText: result.audit.llm_raw_text ?? null,
      },
    };
  });
}
