// Rule check orchestrator — neo4j-aware matchResume evaluation.
//
//   buildRuleCheckInput()   -- 5-block input builder (unchanged)
//   runRuleCheck()          -- full pipeline:
//     dims → fetch rules → filter → build graph context →
//     compose prompt → chatComplete (with tools) → fold to MatchResumeCheckResult

import { applyClientFilter, extractDims } from './ontology';
import { fetchRulesForMatchResume } from './ontology-source';
import { buildGraphContext, createDispatcher } from './graph-context';
import {
  composeMatchResumePrompt,
  MATCH_RESUME_SYSTEM_PROMPT,
} from './prompt';
import { projectResume } from './resume-projection';
import type {
  MatchResumeCheckResult,
  MatchResumeCheckStats,
  MatchResumeStepGroup,
  RuleCheckInput,
  RuleCheckRuntimeContext,
  RuleExplanation,
} from './types';
import { chatComplete } from '@/server/llm/gateway';

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

function isPartialResumeEnabled(): boolean {
  return process.env.RULE_CHECK_PARTIAL_RESUME !== 'false';
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
): MatchResumeCheckResult {
  return {
    decision: 'FAIL',
    stats: emptyStats(),
    explanations: [],
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
    },
  };
}

function parseLlmJson(
  text: string,
): { decision: string; stats?: unknown; explanations?: unknown } | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as { decision: string; stats?: unknown; explanations?: unknown };
  } catch {
    return null;
  }
}

function coerceStats(raw: unknown): MatchResumeCheckStats {
  const s = emptyStats();
  if (typeof raw !== 'object' || raw === null) return s;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(s) as (keyof MatchResumeCheckStats)[]) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) s[k] = v;
  }
  return s;
}

function coerceExplanations(raw: unknown): RuleExplanation[] {
  if (!Array.isArray(raw)) return [];
  const out: RuleExplanation[] = [];
  const allowed = new Set(['fail', 'pending', 'insufficient_info', 'not_executed']);
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.rule_id === 'string' &&
      typeof r.rule_name === 'string' &&
      typeof r.step_id === 'string' &&
      typeof r.status === 'string' &&
      allowed.has(r.status) &&
      typeof r.reason === 'string'
    ) {
      out.push({
        rule_id: r.rule_id,
        rule_name: r.rule_name,
        step_id: r.step_id,
        status: r.status as RuleExplanation['status'],
        reason: r.reason,
      });
    }
  }
  return out;
}

function foldDecision(stats: MatchResumeCheckStats): MatchResumeCheckResult['decision'] {
  if (stats.fail > 0) return 'FAIL';
  if (stats.pending > 0 || stats.insufficient_info > 0) return 'REVIEW';
  return 'PASS';
}

export async function runRuleCheck(
  input: RuleCheckInput,
): Promise<MatchResumeCheckResult> {
  const dims = extractDims(input.job_requisition);
  let sourceResult;
  try {
    sourceResult = await fetchRulesForMatchResume();
  } catch (err) {
    // Defensive: ontology-source today absorbs all errors internally and falls
    // back to JSON, but the contract isn't enforced. Surface as a fail-safe.
    return failSafe('llm-call-error', {});
  }
  const filtered = applyClientFilter(sourceResult.rules, dims);

  // Build the filtered Set groups by intersecting fetched steps with `filtered`.
  const filteredIds = new Set(filtered.map((r) => r.id));
  const filteredSteps: MatchResumeStepGroup[] = (sourceResult.steps ?? [])
    .map((s) => ({ ...s, rules: s.rules.filter((r) => filteredIds.has(r.id)) }))
    .filter((s) => s.rules.length > 0);

  // Pre-fetch graph context. Surface 401/502 as ontology-graph-unavailable.
  let graph;
  try {
    graph = await buildGraphContext({
      candidate_id: input.runtime_context.candidate_id,
      job_requisition_id:
        (input.job_requisition.job_requisition_id as string | undefined) ?? '',
    });
  } catch (err) {
    return failSafe('ontology-graph-unavailable', {
      rules_evaluated: filtered.length,
      rule_source: sourceResult.source,
    });
  }

  // Project resume (existing partial-projection logic).
  const projectedResume = isPartialResumeEnabled()
    ? projectResume(input.resume, filtered)
    : input.resume;

  const userPrompt = composeMatchResumePrompt({
    input: { ...input, resume: projectedResume },
    graph,
    steps: filteredSteps,
  });

  const dispatcher = createDispatcher(graph);

  let llmResult;
  try {
    llmResult = await chatComplete({
      system: MATCH_RESUME_SYSTEM_PROMPT,
      user: userPrompt,
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
    return failSafe(reason, {
      rules_evaluated: filtered.length,
      graph_calls: graph.fetch_count,
      rule_source: sourceResult.source,
    });
  }

  const parsed = parseLlmJson(llmResult.text);
  if (!parsed) {
    return failSafe('parse-error', {
      rules_evaluated: filtered.length,
      graph_calls: graph.fetch_count,
      llm_model: llmResult.modelUsed,
      llm_duration_ms: llmResult.durationMs,
      llm_round_trips: llmResult.toolUseIterations,
      llm_prompt_tokens: llmResult.usage?.promptTokens,
      llm_completion_tokens: llmResult.usage?.completionTokens,
      rule_source: sourceResult.source,
    });
  }

  const stats = coerceStats(parsed.stats);
  const explanations = coerceExplanations(parsed.explanations);
  const decision = foldDecision(stats);

  return {
    decision,
    stats,
    explanations,
    audit: {
      rules_evaluated: filtered.length,
      graph_calls: graph.fetch_count,
      llm_model: llmResult.modelUsed,
      llm_duration_ms: llmResult.durationMs,
      llm_round_trips: llmResult.toolUseIterations,
      llm_prompt_tokens: llmResult.usage?.promptTokens,
      llm_completion_tokens: llmResult.usage?.completionTokens,
      rule_source: sourceResult.source,
    },
  };
}
