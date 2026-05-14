// Test-only parallel rule-check runner with stub LLM.
//
// 跟 lib/rule-check/runner.ts 的 runRuleCheck() 镜像逻辑,但 LLM 调用替换成
// scripts/e2e-mock-test/llm-stub.ts 的 deterministic stub。**不动 production
// runner.ts**,确保用户"不改 schema / 流程"的硬约束。
//
// 真实 LLM gateway 恢复后,直接用 runRuleCheck() 替换本函数即可。

import {
  applyClientFilter,
  classifyRules,
  extractDims,
} from '../../lib/rule-check/ontology';
import { fetchRulesForMatchResume } from '../../lib/rule-check/ontology-source';
import { RULE_CHECK_SYSTEM_PROMPT, composePrompt } from '../../lib/rule-check/prompt';
import { fieldsProjected, projectResume } from '../../lib/rule-check/resume-projection';
import type {
  LlmRuleCheckOutput,
  RuleCheckInput,
  RuleCheckVerdict,
  RuleFlag,
} from '../../lib/rule-check/types';

import { stubLlmCall } from './llm-stub';

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

export async function runRuleCheckStubbed(input: RuleCheckInput): Promise<RuleCheckVerdict> {
  const dims = extractDims(input.job_requisition);
  const sourceResult = await fetchRulesForMatchResume();
  const filtered = applyClientFilter(sourceResult.rules, dims);
  const total = sourceResult.rules.length;
  const classified = classifyRules(filtered);

  const projectedResume = projectResume(input.resume, filtered);
  const projectedInput: RuleCheckInput = { ...input, resume: projectedResume };
  const fieldsUsed = fieldsProjected(filtered);

  const userPrompt = composePrompt({ input: projectedInput, classified, dims });

  const llmResult = await stubLlmCall({
    system: RULE_CHECK_SYSTEM_PROMPT,
    user: userPrompt,
  });

  const parsed = safeIsLlmOutput(llmResult.parsed_json) ? llmResult.parsed_json : null;
  const llm_decision = parsed?.overall_decision ?? 'UNKNOWN';

  let decision: 'PASS' | 'FAIL';
  if (parsed === null) decision = 'FAIL';
  else if (llm_decision === 'KEEP') decision = 'PASS';
  else decision = 'FAIL';

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
