// Rule check orchestrator — single entry for matchResumeAgent.
//
//   buildRuleCheckInput()    -- 组装 5-block input(从 RaasRequirement +
//                               parsed resume + runtime context)
//   runRuleCheck()           -- 跑完整 pipeline:dims → 过滤规则 → 投影
//                               parsed resume(per Kenny §2)→ 渲染 prompt
//                               → 调 LLM → 折叠成 binary PASS/FAIL verdict
//                               + 透传 resume_augmentation(per Kenny §3)
//
// Binary 折叠规则:
//   LLM overall_decision="KEEP"  → PASS    (推进 matchResume)
//   LLM overall_decision="DROP"  → FAIL    (terminal 规则命中,中止)
//   LLM overall_decision="PAUSE" → FAIL    (需 HSM 复核,暂不推进 matchResume)
//   LLM 解析失败                 → FAIL    (安全侧,加 parse_error 标记)

import { applyClientFilter, classifyRules, extractDims } from './ontology';
import { runLlm } from './llm';
import { fetchRulesForMatchResume } from './ontology-source';
import { RULE_CHECK_SYSTEM_PROMPT, composePrompt } from './prompt';
import { fieldsProjected, projectResume } from './resume-projection';
import type {
  LlmRuleCheckOutput,
  RuleCheckInput,
  RuleCheckRuntimeContext,
  RuleCheckVerdict,
  RuleFlag,
} from './types';
import { runRuleCheckYeyang } from './yeyang-runner';

export interface BuildInputArgs {
  runtime_context: RuleCheckRuntimeContext;
  parsed_resume: Record<string, unknown> | null | undefined;
  job_requisition: Record<string, unknown>;
  job_requisition_specification?: Record<string, unknown> | null;
  hsm_feedback?: Record<string, unknown> | null;
}

export function buildRuleCheckInput(args: BuildInputArgs): RuleCheckInput {
  const jr = args.job_requisition;
  const jrid =
    typeof jr.job_requisition_id === 'string' && jr.job_requisition_id.trim()
      ? (jr.job_requisition_id as string)
      : '';
  return {
    runtime_context: args.runtime_context,
    resume: args.parsed_resume ?? {},
    job_requisition: { ...jr, job_requisition_id: jrid },
    job_requisition_specification: args.job_requisition_specification ?? null,
    hsm_feedback: args.hsm_feedback ?? null,
  };
}

function safeIsLlmOutput(x: unknown): x is LlmRuleCheckOutput {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return r.overall_decision === 'KEEP' || r.overall_decision === 'DROP' || r.overall_decision === 'PAUSE';
}

function collectHitFlags(out: LlmRuleCheckOutput | null): RuleFlag[] {
  if (!out || !Array.isArray(out.rule_flags)) return [];
  return out.rule_flags.filter(
    (f) => f.applicable === true && (f.result === 'FAIL' || f.result === 'REVIEW'),
  );
}

function collectFailureReasons(out: LlmRuleCheckOutput | null): string[] {
  if (!out) return [];
  const reasons: string[] = [];
  if (Array.isArray(out.drop_reasons)) reasons.push(...out.drop_reasons);
  if (Array.isArray(out.pause_reasons)) reasons.push(...out.pause_reasons);
  return reasons;
}

/**
 * Resume projection 总开关。默认 true(用 partial)。
 * RULE_CHECK_PARTIAL_RESUME=false → 整段 parsed resume 发给 LLM(diagnostic 用)
 */
function isPartialResumeEnabled(): boolean {
  return process.env.RULE_CHECK_PARTIAL_RESUME !== 'false';
}

/**
 * Pick prompt builder based on env:
 *   RULE_CHECK_PROMPT_SOURCE=yeyang → 叶洋 v4 snapshot (lib/rule-check/yeyang/)
 *   RULE_CHECK_PROMPT_SOURCE=poc (or anything else) → POC composer (default)
 *
 * Read per-invocation (not module-level const) so Inngest cloud toggle 立即生效。
 */
function getPromptSource(): 'yeyang' | 'poc' {
  return process.env.RULE_CHECK_PROMPT_SOURCE === 'yeyang' ? 'yeyang' : 'poc';
}

export async function runRuleCheck(input: RuleCheckInput): Promise<RuleCheckVerdict> {
  if (getPromptSource() === 'yeyang') {
    return runRuleCheckYeyang(input);
  }

  const dims = extractDims(input.job_requisition);
  // Phase 2:rule 列表 source — primary 调 Ontology API,失败 fallback 到 JSON。
  const sourceResult = await fetchRulesForMatchResume();
  // (client × business_group) 过滤还是在这边做 — Ontology API 当前不支持
  // server-side client filter,等 Phase 3 叶洋 v5 + 陈洋 ontology 改动后切换
  const filtered = applyClientFilter(sourceResult.rules, dims);
  const total = sourceResult.rules.length;
  const classified = classifyRules(filtered);

  // Kenny §2 — partial resume projection。默认开,RULE_CHECK_PARTIAL_RESUME=false
  // 时退回整段发给 LLM(诊断用,生产不应该用)。
  //
  // projectedInput 沿用 input 其他字段(runtime_context / job_requisition /
  // spec / hsm_feedback),只把 resume 投影成 partial。
  const projectedResume = isPartialResumeEnabled()
    ? projectResume(input.resume, filtered)
    : input.resume;
  const projectedInput: RuleCheckInput = { ...input, resume: projectedResume };
  const fieldsUsed = isPartialResumeEnabled() ? fieldsProjected(filtered) : null;

  const userPrompt = composePrompt({ input: projectedInput, classified, dims });

  let llmResult;
  try {
    llmResult = await runLlm({
      system: RULE_CHECK_SYSTEM_PROMPT,
      user: userPrompt,
    });
  } catch (err) {
    // LLM gateway misconfigured / network error → FAIL-safe(不让 candidate
    // 偷溜进 matchResume,但保留诊断信息)
    return {
      decision: 'FAIL',
      llm_decision: 'UNKNOWN',
      failure_reasons: [`llm-call-error:${(err as Error).message.slice(0, 120)}`],
      hit_flags: [],
      llm_output: null,
      audit: {
        rules_evaluated: filtered.length,
        rules_total_in_ontology: total,
        dims,
        llm_model: 'unknown',
        llm_duration_ms: 0,
        raw_text_preview: '',
        parse_error: (err as Error).message,
        partial_resume_fields: fieldsUsed,
        rule_source: sourceResult.source,
      },
    };
  }

  const parsed = safeIsLlmOutput(llmResult.parsed_json) ? llmResult.parsed_json : null;
  const llm_decision = parsed?.overall_decision ?? 'UNKNOWN';

  let decision: 'PASS' | 'FAIL';
  if (parsed === null) {
    decision = 'FAIL';
  } else if (llm_decision === 'KEEP') {
    decision = 'PASS';
  } else {
    decision = 'FAIL';
  }

  const failure_reasons =
    decision === 'FAIL' && parsed
      ? collectFailureReasons(parsed)
      : decision === 'FAIL'
        ? [`parse-error:${llmResult.parse_error ?? 'no-parsed-json'}`]
        : [];

  return {
    decision,
    llm_decision,
    failure_reasons,
    hit_flags: collectHitFlags(parsed),
    resume_augmentation:
      typeof parsed?.resume_augmentation === 'string' && parsed.resume_augmentation.trim()
        ? parsed.resume_augmentation
        : undefined,
    llm_output: parsed,
    audit: {
      rules_evaluated: filtered.length,
      rules_total_in_ontology: total,
      dims,
      llm_model: llmResult.model_used,
      llm_duration_ms: llmResult.duration_ms,
      llm_prompt_tokens: llmResult.prompt_tokens,
      llm_completion_tokens: llmResult.completion_tokens,
      raw_text_preview: llmResult.raw_text.slice(0, 500),
      parse_error: llmResult.parse_error,
      partial_resume_fields: fieldsUsed,
      rule_source: sourceResult.source,
    },
  };
}
