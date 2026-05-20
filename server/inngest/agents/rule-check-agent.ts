// ruleCheckAgent — Workflow node 10.5 (NEW PR-4 2026-05-19).
//
// 订阅 RULE_CHECK_REQUESTED(由 matchResumeAgent 第一段 emit),跑 LLM
// rule check,根据 decision emit MATCH_RULE_CHECK_PASSED / RULE_CHECK_FAILED。
//
// runRuleCheck 内部已 fail-safe in-band(异常返回 decision='FAIL'+audit.fail_reason),
// 不会抛错。retries=1 主要是为 Inngest step.run 自己的层级异常兜底。
//
// 见 docs/superpowers/specs/2026-05-19-rule-check-independent-agent-design.md §5.2

import { buildRuleCheckInput, runRuleCheck } from '@/lib/rule-check';
import { extractDims } from '@/lib/rule-check/ontology';
import {
  inngest,
  type RuleCheckRequestedData,
  type RuleCheckPassedData,
  type MatchEventData,
  type RuleCheckAuditMeta,
} from '@/server/inngest/client';

const AGENT_ID = 'rule-check-agent';
const AGENT_NAME = 'ruleCheck';

// Exported separately so it can be unit-tested without needing a live
// Inngest runtime. See rule-check-agent.test.ts.
export async function ruleCheckAgentHandler({
  event,
  step,
  logger,
}: {
  event: { name: string; data: RuleCheckRequestedData };
  step: {
    run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
    sendEvent: (id: string, e: { name: string; data: unknown }) => Promise<unknown>;
  };
  logger: { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void };
}) {
  const data = event.data;
  const stepKey = sanitize(data.job_requisition_id);

  const result = await step.run(`rule-check-${stepKey}`, async () => {
    const input = buildRuleCheckInput({
      runtime_context: data.runtime_context,
      parsed_resume: data.parsed_resume,
      job_requisition: data.job_requisition,
    });
    const r = await runRuleCheck(input);
    logger.info(
      `[${AGENT_NAME}] decision=${r.decision} stats=pass:${r.stats.pass}/fail:${r.stats.fail}/pending:${r.stats.pending}/info:${r.stats.insufficient_info} ` +
        `rules=${r.audit.rules_evaluated} graph_calls=${r.audit.graph_calls} ` +
        `model=${r.audit.llm_model} latency_ms=${r.audit.llm_duration_ms} ` +
        `tool_rounds=${r.audit.llm_round_trips}` +
        (r.audit.fail_reason ? ` fail_reason=${r.audit.fail_reason}` : ''),
    );
    return r;
  });

  const dims = extractDims(data.job_requisition);
  const audit: RuleCheckAuditMeta = {
    rules_evaluated: result.audit.rules_evaluated,
    graph_calls: result.audit.graph_calls,
    client_id: dims.client_id,
    business_group: dims.business_group,
    studio: dims.studio,
    llm_model: result.audit.llm_model,
    llm_duration_ms: result.audit.llm_duration_ms,
    llm_round_trips: result.audit.llm_round_trips,
    llm_prompt_tokens: result.audit.llm_prompt_tokens,
    llm_completion_tokens: result.audit.llm_completion_tokens,
    rule_source: result.audit.rule_source,
    fail_reason: result.audit.fail_reason,
  };

  if (result.decision === 'PASS') {
    const payload: RuleCheckPassedData = {
      upload_id: data.upload_id,
      candidate_id: data.candidate_id,
      resume_id: data.resume_id,
      job_requisition_id: data.job_requisition_id,
      client_id: data.client_id ?? '',
      audit,
      // 透传给 matchResumeAgent 第二段
      job_requisition: data.job_requisition,
      parsed_resume: data.parsed_resume,
      runtime_context: data.runtime_context,
      employee_id: data.employee_id,
    };
    await step.sendEvent(`emit-passed-${stepKey}`, { name: 'MATCH_RULE_CHECK_PASSED', data: payload });
    return { ok: true, decision: 'PASS' as const, job_requisition_id: data.job_requisition_id };
  }

  // Plan B (2026-05-19): rule-check FAIL/REVIEW → emit MATCH_FAILED directly
  // (统一三事件家族,partner dispatcher 消费同样 payload 形状).
  const failedPayload: MatchEventData = {
    job_requisition_id: data.job_requisition_id,
    candidate_id: data.candidate_id || null,
    matching_score: null,  // rule-check 阶段无 score
    upload_id: data.upload_id || null,
    success: false,
    data: {
      rule_check_decision: result.decision,  // 'FAIL' | 'REVIEW'
      failed_rules: result.explanations.map((e) => ({
        rule_id: e.rule_id,
        rule_name: e.rule_name,
        step_id: e.step_id,
        status: e.status,
        reason: e.reason,
      })),
      audit,
    },
    error: `rule-check-${result.decision.toLowerCase()}`,
  };
  await step.sendEvent(`emit-match-failed-${stepKey}`, {
    name: 'MATCH_FAILED',
    data: failedPayload,
  });
  return { ok: true, decision: result.decision, job_requisition_id: data.job_requisition_id };
}

export const ruleCheckAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Rule Check Agent (workflow node 10.5)',
    retries: 1,
    triggers: [{ event: 'RULE_CHECK_REQUESTED' }],
  },
  async (ctx) => ruleCheckAgentHandler(ctx as unknown as Parameters<typeof ruleCheckAgentHandler>[0]),
);

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
}
