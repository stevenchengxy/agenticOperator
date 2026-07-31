// Agent Execution API — request/response contract types (partner 对接).
//
// Mirrors docs/api/agent-execution-api-partner-guide.md §4. The execution核 is the
// pure runRuleCheck() engine; nothing here touches the Inngest pipeline, emits
// events, or writes production tables — so AO's normal flow is unaffected.

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export type Decision = 'matched' | 'not_matched' | 'needs_review';

/** Partner's 5-state + AO's honest 6th (评估了但无法定论). See guide §4.4.2. */
export type EvalStatus =
  | 'not_retrieved'
  | 'retrieved_not_evaluated'
  | 'evaluated_not_applicable'
  | 'evaluated_passed'
  | 'evaluated_violated'
  | 'evaluated_inconclusive';

/** AO 引擎原生 6 态 (供核对). */
export type AoRuleStatus =
  | 'pass'
  | 'fail'
  | 'pending'
  | 'insufficient_info'
  | 'not_triggered'
  | 'not_executed';

export interface ExecutionRefInput {
  store: 'neo4j';
  id: string;
}

export interface ExecutionInputs {
  candidate: { ref?: ExecutionRefInput | null; inline?: Record<string, unknown> | null };
  job: { ref?: ExecutionRefInput | null; inline?: Record<string, unknown> | null };
  overrides?: Record<string, unknown> | null;
}

export interface ExecutionRequest {
  clientRequestId: string;
  correlation?: { runId?: string; testCaseId?: string } | null;
  ontology: { domain: string; version: string };
  scenario: string;
  entry?: { actionId?: string | null; stepIds?: string[] | null } | null;
  inputs: ExecutionInputs;
  mode?: 'shadow' | null;
  config?: { model?: string | null; timeoutMs?: number | null; traceLevel?: 'full' | 'basic' | null } | null;
}

export interface RuleEvaluation {
  ruleId: string;
  subPoint: string | null;
  stepId: string | null;
  status: EvalStatus;
  /** AO 引擎原生状态 (扩展字段,供核对). */
  aoStatus: AoRuleStatus | 'excluded';
  ruleTextSnapshot: { field: string; sha256: string | null; version: string } | null;
  interpretation: string;
  evidence: string;
  verdictReason: string;
  /** MVP: interpretation/evidence 来源标记 (未拆 prompt 前 = 从 reason 派生). */
  interpretationSource: 'derived-from-reason' | 'native';
}

export interface ExecutionResponse {
  executionId: string;
  status: ExecutionStatus;
  correlation: { runId?: string; testCaseId?: string } | null;
  result: {
    scenario: string;
    decision: Decision;
    decisionDetail: {
      hardRequirements: Array<{ requirement: string; verdict: 'pass' | 'fail'; byRuleId: string; reason: string }>;
      score: number | null;
      vetoedBy: string[];
    };
    summary: string;
    emittedEvents: string[];
  } | null;
  trace: {
    steps: Array<Record<string, unknown>>;
    ruleEvaluations: RuleEvaluation[];
    retrievedRuleIds: string[];
    llmCalls: Array<Record<string, unknown>>;
  } | null;
  meta: {
    agentVersion: string;
    promptVersion: string;
    model: string;
    ontologyLoaded: { domain: string; version: string; ruleCount: number; liveConsistency: unknown | null };
    inputsResolved: { candidate: { store: string }; job: { store: string } };
    aoAuditId: string | null;
    mode: string;
    usage: { inputTokens: number; outputTokens: number; usd: number | null };
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

/** Structured error codes (guide §4.5). */
export type ExecutionErrorCode =
  | 'ONTOLOGY_VERSION_UNAVAILABLE'
  | 'INPUT_REF_NOT_FOUND'
  | 'INPUT_INVALID'
  | 'SCENARIO_UNSUPPORTED'
  | 'MODEL_UNAVAILABLE'
  | 'UPSTREAM_RATE_LIMITED'
  | 'EXECUTION_TIMEOUT'
  | 'ONTOLOGY_GRAPH_UNAVAILABLE'
  | 'UNAUTHORIZED'
  | 'INTERNAL';
