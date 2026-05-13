import { prisma } from '@/server/db';
import { runRuleCheck, buildRuleCheckInput } from '@/lib/rule-check/runner';
import { buildInferenceChain } from '@/lib/rule-check/evidence';
import { fetchRulesForMatchResume } from '@/lib/rule-check/ontology-source';
import type { MatchResumeCheckResult, RuleResult } from '@/lib/rule-check/types';
import type { InferenceChain } from '@/lib/rule-check/evidence/types';
import { classifyMatch, type ExpectedOutcome, type ClassifyResult } from './match-classifier';
import { loadScenarios, type ScenarioFixture } from './scenarios-loader';

export type StreamEvent =
  | { type: 'started'; run_id: string }
  | { type: 'result'; run_id: string; scenario: ScenarioResultPayload }
  | { type: 'done'; run_id: string; summary: RunSummary }
  | { type: 'error'; run_id: string; message: string };

export type ScenarioResultPayload = {
  scenario_id: string;
  scenario_name: string;
  expected: ExpectedOutcome;
  actual: { decision: string; stats: MatchResumeCheckResult['stats'] };
  rule_results: RuleResult[];
  match_kind: string;
  failures: string[];
  inference_chain: InferenceChain[];
  graph_context: MatchResumeCheckResult['graph_context'];
  audit: {
    llm_ms: number;
    llm_model: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    finish_reason?: string;
    graph_calls: number;
    raw_llm_text?: string;
  };
};

export type RunSummary = {
  total: number;
  pass: number;
  fail: number;
  total_llm_ms: number;
};

export async function* streamRuleCheckRun(args: {
  model?: string;
  client_id_override?: string;
  scenario_ids?: string[];
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  const run = await prisma.ruleCheckRun.create({
    data: {
      status: 'running',
      model: args.model ?? process.env.AI_MODEL ?? 'gemini-3-flash-preview',
      clientIdOverride: args.client_id_override ?? null,
    },
  });
  yield { type: 'started', run_id: run.id };

  const scenarios = loadScenarios(args.scenario_ids);
  let pass = 0, fail = 0, capHits = 0, totalLlmMs = 0, totalP = 0, totalC = 0;

  try {
    for (const scenario of scenarios) {
      if (args.signal?.aborted) throw new Error('client-aborted');

      const result = await runOneScenario(scenario, args.model);
      const expected: ExpectedOutcome = {
        decision: scenario.expected.decision,
        rule_status: scenario.expected.rule_status,
      };
      const classified = classifyMatch(expected, result);
      const chains = await buildChainsForScenario(scenario, result);

      await prisma.ruleCheckScenarioResult.upsert({
        where: { runId_scenarioId: { runId: run.id, scenarioId: scenario.id } },
        create: scenarioRowData(run.id, scenario, result, classified, chains),
        update: scenarioRowData(run.id, scenario, result, classified, chains),
      });

      if (classified.kind === 'pass') pass++; else fail++;
      if (result.audit.llm_finish_reason === 'length') capHits++;
      totalLlmMs += result.audit.llm_duration_ms;
      totalP += result.audit.llm_prompt_tokens ?? 0;
      totalC += result.audit.llm_completion_tokens ?? 0;

      yield {
        type: 'result',
        run_id: run.id,
        scenario: {
          scenario_id: scenario.id,
          scenario_name: scenario.name,
          expected,
          actual: { decision: result.decision, stats: result.stats },
          rule_results: result.rule_results,
          match_kind: classified.kind,
          failures: classified.failures,
          inference_chain: chains,
          graph_context: result.graph_context,
          audit: {
            llm_ms: result.audit.llm_duration_ms,
            llm_model: result.audit.llm_model,
            prompt_tokens: result.audit.llm_prompt_tokens,
            completion_tokens: result.audit.llm_completion_tokens,
            finish_reason: result.audit.llm_finish_reason,
            graph_calls: result.audit.graph_calls,
            raw_llm_text: result.audit.raw_llm_text,
          },
        },
      };
    }

    await prisma.ruleCheckRun.update({
      where: { id: run.id },
      data: {
        status: 'done', finishedAt: new Date(),
        totalScenarios: scenarios.length,
        passCount: pass, failCount: fail,
        totalLlmMs, totalPromptTokens: totalP, totalCompletionTokens: totalC,
        capHits,
      },
    });
    yield {
      type: 'done', run_id: run.id,
      summary: { total: scenarios.length, pass, fail, total_llm_ms: totalLlmMs },
    };
  } catch (err) {
    const message = (err as Error).message ?? 'unknown error';
    await prisma.ruleCheckRun.update({
      where: { id: run.id },
      data: { status: 'error', finishedAt: new Date(), errorMessage: message },
    });
    yield { type: 'error', run_id: run.id, message };
  }
}

async function runOneScenario(
  scenario: ScenarioFixture,
  modelOverride?: string,
): Promise<MatchResumeCheckResult> {
  const input = buildRuleCheckInput({
    runtime_context: {
      upload_id: `eval-${scenario.id}`,
      candidate_id: scenario.candidate_id,
      resume_id: scenario.resume_id,
      employee_id: 'eval',
      received_at: new Date().toISOString(),
      trace_id: `eval-${scenario.id}`,
    },
    parsed_resume: null,
    job_requisition: { job_requisition_id: scenario.job_requisition_id },
  });
  return runRuleCheck(input, { model: modelOverride });
}

async function buildChainsForScenario(
  scenario: ScenarioFixture,
  result: MatchResumeCheckResult,
): Promise<InferenceChain[]> {
  if (!result.graph_context) return [];
  const ruleSource = await fetchRulesForMatchResume();
  const ruleById = new Map(ruleSource.rules.map((r) => [r.id, r]));
  const runtime = {
    upload_id: '', candidate_id: scenario.candidate_id, resume_id: scenario.resume_id,
    employee_id: '', received_at: new Date().toISOString(),
  };
  return result.rule_results
    .map((rr) => {
      const rule = ruleById.get(rr.rule_id);
      if (!rule || !result.graph_context) return null;
      return buildInferenceChain(result.graph_context, runtime, rule, rr);
    })
    .filter((c): c is InferenceChain => c !== null);
}

function scenarioRowData(
  runId: string,
  scenario: ScenarioFixture,
  result: MatchResumeCheckResult,
  classified: ClassifyResult,
  chains: InferenceChain[],
) {
  return {
    runId,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    expectedDecision: scenario.expected.decision,
    expectedRules: JSON.stringify(scenario.expected.rule_status),
    actualDecision: result.decision,
    actualStats: JSON.stringify(result.stats),
    ruleResults: JSON.stringify(result.rule_results),
    matchKind: classified.kind,
    failures: classified.failures.length ? JSON.stringify(classified.failures) : null,
    inferenceChain: JSON.stringify(chains),
    graphContext: JSON.stringify(result.graph_context ?? {}),
    llmMs: result.audit.llm_duration_ms,
    llmModel: result.audit.llm_model,
    promptTokens: result.audit.llm_prompt_tokens ?? null,
    completionTokens: result.audit.llm_completion_tokens ?? null,
    finishReason: result.audit.llm_finish_reason ?? null,
    graphCalls: result.audit.graph_calls,
    rawLlmText: result.audit.raw_llm_text ?? null,
  };
}
