// Pure mapper: AO engine result (MatchResumeCheckResult) → partner contract
// (ExecutionResponse). No I/O except ruleTextSha256 (reads the pinned snapshot).
// Kept pure + side-effect-free so it is unit-testable and the route layer stays thin.
//
// Mapping rules are documented in docs/api/agent-execution-api-partner-guide.md §4.4.

import type { MatchResumeCheckResult, RuleResult, RuleStatus } from '@/lib/rule-check/types';
import { ruleTextSha256 } from './version-registry';
import type {
  AoRuleStatus,
  Decision,
  EvalStatus,
  ExecutionResponse,
  RuleEvaluation,
} from './types';

// Bumped when the engine or this mapper changes shape; surfaced as meta.agentVersion.
export const AGENT_VERSION = 'rule-check-agent@2026-06-11';
// The production prompt is unversioned today; this is the MVP marker. When the
// interpretation/evidence split lands (guide §10-④) this bumps + interpretationSource
// flips to 'native'.
export const PROMPT_VERSION = 'match-rule-check@2026-06-11-mvp';

export interface MapArgs {
  result: MatchResumeCheckResult;
  executionId: string;
  requestedDomain: string;
  version: string;
  correlation: { runId?: string; testCaseId?: string } | null;
  inputsResolved: { candidate: { store: string }; job: { store: string } };
  aoAuditId: string | null;
  ruleCount: number;
  startedAt: string | null;
  finishedAt: string | null;
}

/** AO 引擎 6 态 → partner 5+1 态 (guide §4.4.2). */
function aoStatusToEval(status: RuleStatus): EvalStatus {
  switch (status) {
    case 'pass':
      return 'evaluated_passed';
    case 'fail':
      return 'evaluated_violated';
    case 'not_triggered':
      return 'evaluated_not_applicable';
    case 'insufficient_info':
    case 'pending':
    case 'not_executed':
      return 'evaluated_inconclusive';
    default:
      return 'evaluated_inconclusive';
  }
}

/** decision 三态 (guide §4.4.1): PASS→matched; FAIL with a fail-rule→not_matched;
 *  FAIL with only inconclusive→needs_review. */
function foldDecision(result: MatchResumeCheckResult): Decision {
  if (result.decision === 'PASS') return 'matched';
  const hasFail = result.rule_results.some((r) => r.status === 'fail');
  return hasFail ? 'not_matched' : 'needs_review';
}

function evaluatedEvaluation(rr: RuleResult, version: string): RuleEvaluation {
  const reason = rr.reason ?? '';
  return {
    ruleId: rr.rule_id,
    subPoint: null, // AO 每规则单条记录,子判断点折叠进 evidence (guide §10-⑩)
    stepId: rr.step_id || null,
    status: aoStatusToEval(rr.status),
    aoStatus: rr.status as AoRuleStatus,
    ruleTextSnapshot: {
      field: 'standardizedLogicRule',
      sha256: ruleTextSha256(version, rr.rule_id),
      version,
    },
    // MVP: prompt 未拆分前,interpretation/evidence 都源自 reason,如实标记。
    interpretation: reason,
    evidence: reason,
    verdictReason: reason,
    interpretationSource: 'derived-from-reason',
  };
}

function excludedEvaluation(
  prov: { rule_id: string; reason: string },
  version: string,
): RuleEvaluation {
  return {
    ruleId: prov.rule_id,
    subPoint: null,
    stepId: null,
    status: 'retrieved_not_evaluated',
    aoStatus: 'excluded',
    ruleTextSnapshot: {
      field: 'standardizedLogicRule',
      sha256: ruleTextSha256(version, prov.rule_id),
      version,
    },
    interpretation: '',
    evidence: '',
    verdictReason: prov.reason, // 确定性前置过滤的排除理由 (guide §4.4.2)
    interpretationSource: 'derived-from-reason',
  };
}

function buildSummary(decision: Decision, result: MatchResumeCheckResult): string {
  if (decision === 'matched') return '全部在辖规则通过,匹配。';
  const fails = result.rule_results.filter((r) => r.status === 'fail');
  if (decision === 'not_matched') {
    const ids = fails.map((r) => `[${r.rule_id}] ${r.rule_name}`).join('; ');
    return `因以下规则未通过,判定不匹配:${ids || '(见 ruleEvaluations)'}。`;
  }
  const incon = result.rule_results.filter((r) =>
    ['insufficient_info', 'pending', 'not_executed'].includes(r.status),
  );
  const ids = incon.map((r) => `[${r.rule_id}] ${r.rule_name}`).join('; ');
  return `存在无法自证达标的底线规则,需人工复核(fail-closed):${ids || '(见 ruleEvaluations)'}。`;
}

/** Side effects the production agent path WOULD run for this decision —
 *  declared (shadow), never executed by the execution API (guide §3.5). */
function suppressedSideEffects(decision: Decision): string[] {
  if (decision === 'matched') {
    return ['neo4j.writeCandidateMatchResult', 'emit:MATCH_RULE_CHECK_PASSED'];
  }
  return [
    'neo4j.writeCandidateMatchResult',
    'partnerPg.saveRuleCheckFail(match_status=未通过)',
    'notification.recruitmentLifecycle',
    'emit:MATCH_RULE_CHECK_FAILED',
  ];
}

export function mapResultToResponse(a: MapArgs): ExecutionResponse {
  const { result, version } = a;
  const decision = foldDecision(result);

  const evaluated = result.rule_results.map((rr) => evaluatedEvaluation(rr, version));
  const provenance = result.audit.rule_provenance ?? [];
  const evaluatedIds = new Set(result.rule_results.map((r) => r.rule_id));
  const excluded = provenance
    .filter((p) => !p.included && !evaluatedIds.has(p.rule_id))
    .map((p) => excludedEvaluation(p, version));
  const ruleEvaluations = [...evaluated, ...excluded];

  // retrievedRuleIds = full provenance set (incl excluded); fall back to evaluated ids.
  const retrievedRuleIds =
    provenance.length > 0
      ? Array.from(new Set(provenance.map((p) => p.rule_id)))
      : Array.from(evaluatedIds);

  const hardRequirements = result.rule_results
    .filter((r) => r.status === 'pass' || r.status === 'fail')
    .map((r) => ({
      requirement: r.rule_name,
      verdict: (r.status === 'fail' ? 'fail' : 'pass') as 'pass' | 'fail',
      byRuleId: r.rule_id,
      reason: r.reason ?? '',
    }));

  const vetoedBy = result.rule_results.filter((r) => r.status === 'fail').map((r) => r.rule_id);

  // steps[]: AO 单轮全规则评估 → 按 stepId 分组重建 (guide §4.2 粒度说明)。
  const byStep = new Map<string, string[]>();
  for (const rr of result.rule_results) {
    const sid = rr.step_id || 'unknown';
    if (!byStep.has(sid)) byStep.set(sid, []);
    byStep.get(sid)!.push(rr.rule_id);
  }
  const steps = Array.from(byStep.entries()).map(([stepId, ruleIds], i) => ({
    seq: i + 1,
    actionId: '10',
    stepId,
    title: stepId,
    status: 'completed',
    startedAt: a.startedAt,
    endedAt: a.finishedAt,
    ruleIds,
    llmCallIds: ['llm-001'],
    toolCalls: [],
    suppressedSideEffects: i === byStep.size - 1 ? suppressedSideEffects(decision) : [],
    note: null,
  }));

  const promptRef = `/api/agent-execution/executions/${a.executionId}/llm-calls/llm-001`;
  const llmCalls = [
    {
      callId: 'llm-001',
      stepId: null,
      model: result.audit.llm_model,
      purpose: '规则评估(全规则单轮)',
      inputTokens: result.audit.llm_prompt_tokens ?? 0,
      outputTokens: result.audit.llm_completion_tokens ?? 0,
      latencyMs: result.audit.llm_duration_ms,
      promptRef,
    },
  ];

  return {
    executionId: a.executionId,
    status: 'succeeded',
    correlation: a.correlation,
    result: {
      scenario: 'matchResume',
      decision,
      decisionDetail: { hardRequirements, score: null, vetoedBy },
      summary: buildSummary(decision, result),
      emittedEvents: [decision === 'matched' ? 'MATCH_RULE_CHECK_PASSED' : 'MATCH_RULE_CHECK_FAILED'],
    },
    trace: { steps, ruleEvaluations, retrievedRuleIds, llmCalls },
    meta: {
      agentVersion: AGENT_VERSION,
      promptVersion: PROMPT_VERSION,
      model: result.audit.llm_model,
      ontologyLoaded: {
        domain: a.requestedDomain,
        version,
        ruleCount: a.ruleCount,
        liveConsistency: null,
      },
      inputsResolved: a.inputsResolved,
      aoAuditId: a.aoAuditId,
      mode: 'shadow',
      usage: {
        inputTokens: result.audit.llm_prompt_tokens ?? 0,
        outputTokens: result.audit.llm_completion_tokens ?? 0,
        usd: null,
      },
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
    },
    error: null,
  };
}
