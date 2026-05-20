// Rule check orchestrator — neo4j-aware matchResume evaluation.
//
//   buildRuleCheckInput()   -- 5-block input builder (unchanged)
//   runRuleCheck()          -- full pipeline:
//     dims → fetch rules → filter → build graph context →
//     compose prompt → chatComplete (with tools) → fold to MatchResumeCheckResult

import { extractDims } from './ontology';
import { fetchRulesViaOntologyApi, RuleFetchApiError } from './api-rule-fetcher';
import { buildGraphContext, createDispatcher } from './graph-context';
import {
  composeMatchResumePrompt,
  MATCH_RESUME_SYSTEM_PROMPT,
} from './prompt';
import type {
  MatchResumeCheckResult,
  MatchResumeCheckStats,
  MatchResumeStepGroup,
  RuleCheckInput,
  RuleCheckRuntimeContext,
  RuleExplanation,
  RuleResult,
  RuleStatus,
} from './types';
import { chatComplete } from '@/server/llm/gateway';
import { ruleCheckLog } from './log';
import { createNullLogger, type AgentLogger } from '@/lib/agent-logger';

const TOOL_SCHEMA = [
  {
    type: 'function' as const,
    function: {
      name: 'get_instance',
      description: 'Fetch one ontology instance by label + primary key value.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['label', 'value'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_instances',
      description: 'List instances of a label filtered by property equality.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          filters: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['label'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_links',
      description: 'List ontology links by from/to/type filters.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
  },
];

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


function emptyStats(): MatchResumeCheckStats {
  return {
    total: 0,
    pass: 0,
    fail: 0,
    pending: 0,
    insufficient_info: 0,
    not_triggered: 0,
    not_executed: 0,
  };
}

function failSafe(
  reason: MatchResumeCheckResult['audit']['fail_reason'],
  base: Partial<MatchResumeCheckResult['audit']> = {},
  graph_context?: import('./graph-context').GraphContext,
): MatchResumeCheckResult {
  return {
    decision: 'FAIL',
    stats: emptyStats(),
    rule_results: [],
    explanations: [],
    graph_context,
    audit: {
      rules_evaluated: base.rules_evaluated ?? 0,
      graph_calls: base.graph_calls ?? 0,
      llm_model: base.llm_model ?? 'unknown',
      llm_duration_ms: base.llm_duration_ms ?? 0,
      llm_round_trips: base.llm_round_trips ?? 0,
      llm_prompt_tokens: base.llm_prompt_tokens,
      llm_completion_tokens: base.llm_completion_tokens,
      rule_source: base.rule_source ?? 'json-fallback',
      fail_reason: reason,
      raw_llm_text: base.raw_llm_text,
      llm_finish_reason: base.llm_finish_reason,
    },
  };
}

/**
 * Strip a leading ```json (or ```) fence and a trailing ``` if present. LLMs
 * (Gemini especially) often wrap JSON in a markdown code fence even when the
 * prompt forbids it. This is a single-line tolerance layer.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  // ```json\n ... \n``` or ```\n ... \n```
  const m = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (m) return m[1].trim();
  return trimmed;
}

function parseLlmJson(
  text: string,
): { decision?: unknown; stats?: unknown; rule_results?: unknown } | null {
  const cleaned = stripCodeFence(text);
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as { decision?: unknown; stats?: unknown; rule_results?: unknown };
  } catch {
    return null;
  }
}

function coerceRuleResults(
  raw: unknown,
  steps: MatchResumeStepGroup[],
): RuleResult[] {
  // rule_name and step_id are derived server-side from the steps catalog rather
  // than emitted by the LLM. This saves ~30 tokens per rule entry — critical
  // when the gateway clamps max_tokens aggressively and we're emitting one
  // entry per evaluated rule.
  const lookup = new Map<string, { rule_name: string; step_id: string }>();
  for (const s of steps) {
    for (const r of s.rules) {
      lookup.set(r.id, { rule_name: r.businessLogicRuleName, step_id: s.step_id });
    }
  }

  if (!Array.isArray(raw)) return [];
  const allowed = new Set<RuleStatus>([
    'pass',
    'fail',
    'pending',
    'insufficient_info',
    'not_triggered',
    'not_executed',
  ]);
  const out: RuleResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.rule_id !== 'string' ||
      typeof r.status !== 'string' ||
      !allowed.has(r.status as RuleStatus)
    ) {
      continue;
    }
    const meta = lookup.get(r.rule_id);
    if (!meta) continue;
    const status = r.status as RuleStatus;
    const reason = typeof r.reason === 'string' ? r.reason : undefined;
    const reasonRequired = status !== 'pass' && status !== 'not_triggered';
    if (reasonRequired && !reason) continue;
    out.push({
      rule_id: r.rule_id,
      rule_name: meta.rule_name,
      step_id: meta.step_id,
      status,
      reason,
    });
  }
  return out;
}

function deriveExplanations(rule_results: RuleResult[]): RuleExplanation[] {
  return rule_results
    .filter((r) => r.status !== 'pass' && r.status !== 'not_triggered')
    .map((r) => ({
      rule_id: r.rule_id,
      rule_name: r.rule_name,
      step_id: r.step_id,
      status: r.status as RuleExplanation['status'],
      reason: r.reason ?? '',
    }));
}

function statsFromResults(results: RuleResult[]): MatchResumeCheckStats {
  const s = emptyStats();
  s.total = results.length;
  for (const r of results) {
    if (r.status === 'pass') s.pass++;
    else if (r.status === 'fail') s.fail++;
    else if (r.status === 'pending') s.pending++;
    else if (r.status === 'insufficient_info') s.insufficient_info++;
    else if (r.status === 'not_triggered') s.not_triggered++;
    else if (r.status === 'not_executed') s.not_executed++;
  }
  return s;
}

function foldDecision(stats: MatchResumeCheckStats): MatchResumeCheckResult['decision'] {
  // Only REAL rule violations (status='fail') block matching. Missing data
  // (status='insufficient_info') folds to PASS — we shouldn't penalize the
  // candidate for incomplete graph context. Only `pending` (rule triggered
  // and explicitly needs HSM judgment) still goes to REVIEW.
  if (stats.fail > 0) return 'FAIL';
  if (stats.pending > 0) return 'REVIEW';
  return 'PASS';
}

export type RunRuleCheckOptions = {
  /** Override the gateway's default model for this call only. */
  model?: string;
  /** Per-run agent logger — Ontology API 调用 + step 事件全部走它落到 logs/。 */
  logger?: AgentLogger;
};

export async function runRuleCheck(
  input: RuleCheckInput,
  opts: RunRuleCheckOptions = {},
): Promise<MatchResumeCheckResult> {
  // dims 不再用于 rule filtering(新 fetcher 直接走 Neo4j client lookup),
  // 但保留 extractDims 调用做侧效验证(防御 ill-formed JR);return 不读它。
  void extractDims(input.job_requisition);
  const logger = opts.logger ?? createNullLogger();

  // 2026-05-20 重写:走 /actions/ruleCheckForMatchResume/rules + Neo4j client lookup,
  // 不再读 rules.json,不再 fallback。
  let sourceResult;
  try {
    // raw client_id 从 JR 上取(extractDims normalize 过的会丢失原始 ID,这里用原 JR)
    const rawClientId =
      typeof input.job_requisition.client_id === 'string'
        ? (input.job_requisition.client_id as string)
        : null;
    sourceResult = await fetchRulesViaOntologyApi({
      clientId: rawClientId,
      logger,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    ruleCheckLog.error('rule-fetch.failed', { message: msg });
    logger.event('rule-fetch.failed', { message: msg });
    const reason = err instanceof RuleFetchApiError ? 'ontology-graph-unavailable' : 'llm-call-error';
    return failSafe(reason, { rule_source: 'ontology-api' });
  }

  const filteredSteps: MatchResumeStepGroup[] = sourceResult.steps;
  const expectedRuleCount = filteredSteps.reduce(
    (sum, s) => sum + s.rules.length,
    0,
  );

  ruleCheckLog.info('runRuleCheck.start', {
    candidate_id: input.runtime_context.candidate_id,
    resume_id: input.runtime_context.resume_id,
    job_requisition_id: input.job_requisition.job_requisition_id,
    model_override: opts.model,
    expected_rule_count: expectedRuleCount,
    rule_source: sourceResult.source,
    client_name_resolved: sourceResult.client_name_resolved,
    api_rule_count: sourceResult.api_rule_count,
    filtered_rule_count: sourceResult.filtered_rule_count,
  });
  logger.event('runRuleCheck.start', {
    candidate_id: input.runtime_context.candidate_id,
    resume_id: input.runtime_context.resume_id,
    job_requisition_id: input.job_requisition.job_requisition_id,
    client_id_raw: input.job_requisition.client_id ?? null,
    client_name_resolved: sourceResult.client_name_resolved,
    api_rule_count: sourceResult.api_rule_count,
    filtered_rule_count: sourceResult.filtered_rule_count,
    rule_ids: sourceResult.rules.map((r) => r.id),
  });

  // Pre-fetch graph context. Surface 401/502 as ontology-graph-unavailable.
  let graph;
  try {
    graph = await buildGraphContext({
      candidate_id: input.runtime_context.candidate_id,
      job_requisition_id:
        (input.job_requisition.job_requisition_id as string | undefined) ?? '',
    });
    ruleCheckLog.data('neo4j.graph.fetched', {
      candidate_id: input.runtime_context.candidate_id,
      fetch_count: graph.fetch_count,
      slots: {
        candidate: graph.candidate,
        resume: graph.resume,
        job_requisition: graph.job_requisition,
        applications: graph.applications,
        blacklist_hits: graph.blacklist_hits,
        employment_links: graph.employment_links,
      },
    });
  } catch (err) {
    ruleCheckLog.error('neo4j.graph.failed', {
      candidate_id: input.runtime_context.candidate_id,
      message: (err as Error).message,
    });
    return failSafe('ontology-graph-unavailable', {
      rules_evaluated: expectedRuleCount,
      rule_source: sourceResult.source,
    });
  }

  // resume now lives in graph.resume; the prompt no longer reads input.resume.
  const userPrompt = composeMatchResumePrompt({
    input,
    graph,
    steps: filteredSteps,
  });

  const dispatcher = createDispatcher(graph);

  ruleCheckLog.data('llm.request', {
    model: opts.model ?? null,
    system_chars: MATCH_RESUME_SYSTEM_PROMPT.length,
    user_chars: userPrompt.length,
    user_prompt: userPrompt,
    rules_in_prompt: expectedRuleCount,
  });

  let llmResult;
  try {
    llmResult = await chatComplete({
      system: MATCH_RESUME_SYSTEM_PROMPT,
      user: userPrompt,
      // Rule check emits one rule_results entry per evaluated rule. With
      // 20-40 rules surviving the client filter (and each entry carrying a
      // Chinese-language reason — more bytes per token than English), the
      // output regularly exceeds 8000 tokens. 16k handles ~40 rules with
      // headroom; bump to 32k+ if deployments routinely have >60 rules.
      maxTokens: 16000,
      model: opts.model,
      // temperature + extra_body (Kimi thinking-disable) are model-aware in
      // the gateway; we let chatComplete pick the right defaults so the same
      // code works for Kimi K2.6 AND Gemini-3-flash-preview without changes.
      tools: {
        schema: TOOL_SCHEMA,
        onToolCall: dispatcher,
        maxIterations: 5,
      },
    });
  } catch (err) {
    const msg = (err as Error).message ?? '';
    const reason: MatchResumeCheckResult['audit']['fail_reason'] = /tool-use loop/.test(msg)
      ? 'tool-use-loop-exceeded'
      : 'llm-call-error';
    ruleCheckLog.error('llm.failed', { reason, message: msg });
    return failSafe(reason, {
      rules_evaluated: expectedRuleCount,
      graph_calls: graph.fetch_count,
      rule_source: sourceResult.source,
    });
  }

  ruleCheckLog.data('llm.response', {
    model: llmResult.modelUsed,
    duration_ms: llmResult.durationMs,
    tool_rounds: llmResult.toolUseIterations,
    finish_reason: llmResult.finishReason,
    prompt_tokens: llmResult.usage?.promptTokens,
    completion_tokens: llmResult.usage?.completionTokens,
    text: llmResult.text,
  });

  const parsed = parseLlmJson(llmResult.text);
  const auditOnError = {
    rules_evaluated: expectedRuleCount,
    graph_calls: graph.fetch_count,
    llm_model: llmResult.modelUsed,
    llm_duration_ms: llmResult.durationMs,
    llm_round_trips: llmResult.toolUseIterations,
    llm_prompt_tokens: llmResult.usage?.promptTokens,
    llm_completion_tokens: llmResult.usage?.completionTokens,
    rule_source: sourceResult.source,
    // Keep up to 50k so the test-suite report can show the full response.
    raw_llm_text: llmResult.text?.slice(0, 50000),
    llm_finish_reason: llmResult.finishReason,
  };
  if (!parsed) {
    ruleCheckLog.error('parse.failed', { reason: 'not-json' });
    return failSafe('parse-error', auditOnError, graph);
  }

  const ruleResults = coerceRuleResults(parsed.rule_results, filteredSteps);
  if (ruleResults.length !== expectedRuleCount) {
    ruleCheckLog.error('parse.count-mismatch', {
      expected: expectedRuleCount, got: ruleResults.length,
    });
    return failSafe('parse-error', auditOnError, graph);
  }

  const stats = statsFromResults(ruleResults);
  const explanations = deriveExplanations(ruleResults);
  const decision = foldDecision(stats);
  ruleCheckLog.info('runRuleCheck.done', {
    candidate_id: input.runtime_context.candidate_id,
    decision, stats, expected_rule_count: expectedRuleCount,
  });

  return {
    decision,
    stats,
    rule_results: ruleResults,
    explanations,
    graph_context: graph,
    audit: {
      rules_evaluated: expectedRuleCount,
      graph_calls: graph.fetch_count,
      llm_model: llmResult.modelUsed,
      llm_duration_ms: llmResult.durationMs,
      llm_round_trips: llmResult.toolUseIterations,
      llm_prompt_tokens: llmResult.usage?.promptTokens,
      llm_completion_tokens: llmResult.usage?.completionTokens,
      rule_source: sourceResult.source,
      llm_finish_reason: llmResult.finishReason,
      // 2026-05-20: surface the prompts + raw response so the /rule-check
      // audit UI's User Prompt / LLM Response / Rule Flags tabs have data.
      user_prompt: userPrompt,
      system_prompt: MATCH_RESUME_SYSTEM_PROMPT,
      llm_raw_text: llmResult.text,
    },
  };
}
