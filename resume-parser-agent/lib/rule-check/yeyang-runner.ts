// Rule-check runner — 叶洋 v4 path.
//
// 跟 runner.ts(POC 版)对等的实现,但用叶洋的 v4 静态 snapshot
// 替代 POC 的 prompt composer。LLM 输出 schema 不同(KEEP/DROP/PAUSE
// vs terminal/step_results),映射到同一个 RuleCheckVerdict 给上游用。
//
// 用静态 snapshot,不调主仓 Ontology API:
//   - 优点:无 HTTP / 无 Neo4j 依赖,跑得最快
//   - 缺点:ontology 改了要主仓 `npm run gen:v4-snapshot` 重生成 + cp 过来
//
// 这条路径在 matchResumeAgent 通过 RULE_CHECK_PROMPT_SOURCE=yeyang 启用。

import { runLlm } from './llm';
import { extractDims, filterRules } from './ontology';
import type {
  LlmRuleCheckOutput,
  RuleCheckInput,
  RuleCheckVerdict,
  RuleFlag,
} from './types';
import {
  fillRuntimeInput,
  matchResumeActionObject,
  type MatchResumeRuntimeInput,
} from './yeyang';

const YEYANG_SYSTEM_PROMPT = `你是 matchResume action 的执行智能体。严格按照 user 消息中描述的步骤、规则原文和输出格式产出 JSON。

边界约束:
- 只能依据 user 消息中引用的 action / step / rule 原文判断,不得补充判断条件
- 不要给候选人打匹配分数(Robohire 的活)
- 不要在 evidence 里编造简历未提供的信息
- 输出必须是合法 JSON,不要在 JSON 外加任何文本`;

// ─── client_id → 叶洋 RuntimeClient 的归一化 ───
// 主仓 snapshot 在 prompt 里展示的样例是 "腾讯 / 互动娱乐事业群" — 中文 canonical
// 名。我们的 jr.client_id 是 "CLI_TENCENT" / "CLI_TENCENT_PCG" / "字节" 等,
// 需要归一化(逻辑跟 ontology.ts 的 extractDims 对齐)。

function normalizeClientName(clientId: string): string {
  if (!clientId) return '';
  const upper = clientId.toUpperCase();
  if (upper.includes('TENCENT')) return '腾讯';
  if (upper.includes('BYTEDANCE') || upper.includes('BYTE')) return '字节';
  return clientId;
}

const BG_DISPLAY: Record<string, string> = {
  IEG: '互动娱乐事业群',
  PCG: '平台与内容事业群',
  WXG: '微信事业群',
  CDG: '企业发展事业群',
  CSIG: '云与智慧产业事业群',
  TEG: '技术工程事业群',
  TikTok: 'TikTok',
};

function buildRuntimeInput(input: RuleCheckInput): MatchResumeRuntimeInput {
  const jr = input.job_requisition;
  const dims = extractDims(jr);

  const department = dims.business_group
    ? (BG_DISPLAY[dims.business_group] ?? dims.business_group)
    : undefined;

  return {
    kind: 'matchResume',
    client: {
      name: dims.client_id || normalizeClientName(String(jr.client_id ?? '')),
      ...(department ? { department } : {}),
      ...(dims.studio ? { studio: dims.studio } : {}),
    },
    job: {
      ...jr,
      job_requisition_id: jr.job_requisition_id,
    },
    resume: {
      ...input.resume,
      candidate_id:
        typeof input.runtime_context.candidate_id === 'string' &&
        input.runtime_context.candidate_id.length > 0
          ? input.runtime_context.candidate_id
          : (typeof input.resume.candidate_id === 'string'
              ? input.resume.candidate_id
              : 'unknown'),
    },
  };
}

// ─── 叶洋 prompt 期望的输出 schema(parse 后的形状) ───

interface YeyangStepResult {
  status?: 'not_started' | 'completed' | 'blocked' | 'pending_human';
  fired_rule_ids?: string[];
  blocking_rule_ids?: string[];
  notifications?: unknown[];
  [k: string]: unknown;
}

interface YeyangLlmOutput {
  match_results?: unknown[];
  overall_status?: string;
  notifications?: Array<{
    recipient?: string;
    channel?: string;
    trigger_rule_id?: string;
    reason?: string;
  }>;
  terminal?: boolean;
  step_results?: Record<string, YeyangStepResult>;
  [k: string]: unknown;
}

function isYeyangOutput(x: unknown): x is YeyangLlmOutput {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function collectBlockingReasons(out: YeyangLlmOutput): string[] {
  const reasons: string[] = [];
  if (out.step_results) {
    for (const [stepKey, step] of Object.entries(out.step_results)) {
      if (Array.isArray(step.blocking_rule_ids)) {
        for (const ruleId of step.blocking_rule_ids) {
          reasons.push(`${ruleId}:${stepKey}_blocking`);
        }
      }
    }
  }
  if (Array.isArray(out.notifications)) {
    for (const n of out.notifications) {
      if (n.trigger_rule_id) {
        reasons.push(`${n.trigger_rule_id}:notify_${n.recipient ?? 'unknown'}`);
      }
    }
  }
  return reasons;
}

function collectHitFlags(out: YeyangLlmOutput): RuleFlag[] {
  const flags: RuleFlag[] = [];
  if (!out.step_results) return flags;
  for (const step of Object.values(out.step_results)) {
    if (Array.isArray(step.fired_rule_ids)) {
      for (const ruleId of step.fired_rule_ids) {
        const isBlocking = Array.isArray(step.blocking_rule_ids)
          ? step.blocking_rule_ids.includes(ruleId)
          : false;
        flags.push({
          rule_id: ruleId,
          rule_name: '', // 叶洋 schema 不带 rule_name 回写
          applicable_client: '',
          severity: isBlocking ? 'terminal' : 'flag_only',
          applicable: true,
          result: isBlocking ? 'FAIL' : 'PASS',
        });
      }
    }
  }
  return flags;
}

/** Map 叶洋 LLM output → binary PASS/FAIL verdict。 */
function foldVerdict(parsed: YeyangLlmOutput | null): {
  decision: 'PASS' | 'FAIL';
  llm_decision: 'KEEP' | 'DROP' | 'PAUSE' | 'UNKNOWN';
  failure_reasons: string[];
  hit_flags: RuleFlag[];
} {
  if (!parsed) {
    return {
      decision: 'FAIL',
      llm_decision: 'UNKNOWN',
      failure_reasons: ['parse-error:llm-json-invalid'],
      hit_flags: [],
    };
  }

  const blockingReasons = collectBlockingReasons(parsed);
  const hit_flags = collectHitFlags(parsed);

  // 终止信号:terminal=true OR overall_status=全部不匹配 OR 任一 step blocked
  const terminalBlock = parsed.terminal === true;
  const overallReject = parsed.overall_status === '全部不匹配';
  const anyStepBlocked =
    parsed.step_results &&
    Object.values(parsed.step_results).some((s) => s.status === 'blocked');

  // pending_human:treat as FAIL — 我们的 binary gate 只有 PASS/FAIL,
  // 需要人工的也不能直接推进 matchResume(后续如果需要 3-state 再扩)
  const anyStepPendingHuman =
    parsed.step_results &&
    Object.values(parsed.step_results).some((s) => s.status === 'pending_human');

  if (terminalBlock || overallReject || anyStepBlocked) {
    return {
      decision: 'FAIL',
      llm_decision: 'DROP',
      failure_reasons: blockingReasons.length > 0 ? blockingReasons : ['terminal-or-reject'],
      hit_flags,
    };
  }

  if (anyStepPendingHuman) {
    return {
      decision: 'FAIL',
      llm_decision: 'PAUSE',
      failure_reasons:
        blockingReasons.length > 0 ? blockingReasons : ['pending-human-confirmation'],
      hit_flags,
    };
  }

  return {
    decision: 'PASS',
    llm_decision: 'KEEP',
    failure_reasons: [],
    hit_flags,
  };
}

export async function runRuleCheckYeyang(input: RuleCheckInput): Promise<RuleCheckVerdict> {
  const dims = extractDims(input.job_requisition);
  // filterRules 不影响 prompt(叶洋的 snapshot 已经预包了所有 rules),
  // 但保留这一调用以填 audit 的 rules_evaluated 字段,跟 POC 路径对等。
  const { rules: filtered, total } = filterRules(dims);

  const runtimeInput = buildRuntimeInput(input);
  const filled = fillRuntimeInput(matchResumeActionObject, runtimeInput);
  const userPrompt = filled.prompt;

  let llmResult;
  try {
    llmResult = await runLlm({
      system: YEYANG_SYSTEM_PROMPT,
      user: userPrompt,
    });
  } catch (err) {
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
      },
    };
  }

  const parsed = isYeyangOutput(llmResult.parsed_json) ? llmResult.parsed_json : null;
  const verdict = foldVerdict(parsed);

  // 把叶洋 schema 反贴回 POC 的 LlmRuleCheckOutput 形状(给 audit / debug 用),
  // 顶层 overall_decision 由 wrapper 推出来的 llm_decision 填充。
  const pseudoLlmOutput: LlmRuleCheckOutput | null = parsed
    ? {
        candidate_id: input.runtime_context.candidate_id,
        job_requisition_id: input.job_requisition.job_requisition_id,
        overall_decision:
          verdict.llm_decision === 'KEEP'
            ? 'KEEP'
            : verdict.llm_decision === 'PAUSE'
              ? 'PAUSE'
              : 'DROP',
        drop_reasons: verdict.failure_reasons,
        rule_flags: verdict.hit_flags,
      }
    : null;

  return {
    decision: verdict.decision,
    llm_decision: verdict.llm_decision,
    failure_reasons: verdict.failure_reasons,
    hit_flags: verdict.hit_flags,
    llm_output: pseudoLlmOutput,
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
    },
  };
}
