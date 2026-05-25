// Auto-iterate orchestrator — closes the AI-native codegen loop (Bundle M).
//
//   round 0:  pipeline(form, businessLogic_0) → eval_0
//   round 1:  refine(form, businessLogic_0, code_0, eval_0) → businessLogic_1
//             pipeline(form, businessLogic_1) → eval_1
//   ...
//   stop on:  (a) verdict = FULL
//             (b) aggregateScore did NOT strictly improve over previous round
//             (c) maxIterations reached (default 3)
//             (d) pipeline or eval threw (preserve previous result + error)
//
// The "did not improve" stop is critical — prevents runaway LLM cost when
// the model keeps producing equally-bad refinements. The very first round
// always runs unconditionally (it's the baseline).

import { runPipeline } from '../pipeline';
import { evaluateExisting } from './evaluate-existing';
import { refineBusinessLogic, type AutoIterateResult } from '../llm/auto-iterator';
import type { AgentFormFields } from '../spec-types';
import type { EvaluationReport, ReplacementVerdict } from './evaluation-report';
import type { DomainId } from '@/lib/domains';

export type AutoIterateRunInput = {
  form: AgentFormFields;
  initialBusinessLogic: string;
  domain: DomainId;
  /** Default 3. Capped at 5 to bound cost. */
  maxIterations?: number;
};

export type IterationRecord = {
  round: number;
  businessLogic: string;
  /** Set when refine() was called for this round (round > 0). */
  refinement?: AutoIterateResult;
  evaluation: EvaluationReport;
  /** The generated code at this round — preserved for diff / "rollback" UX. */
  code: { path: string; content: string };
  pipelineTotalMs: number;
};

export type AutoIterateRunResult = {
  rounds: IterationRecord[];
  finalRound: IterationRecord;
  stopReason: 'verdict-full' | 'no-improvement' | 'max-iterations' | 'error';
  totalDurationMs: number;
  /** Set when stopReason = 'error'. */
  errorMessage?: string;
};

export async function autoIterate(input: AutoIterateRunInput): Promise<AutoIterateRunResult> {
  const t0 = Date.now();
  const max = Math.min(Math.max(input.maxIterations ?? 3, 1), 5);
  const rounds: IterationRecord[] = [];

  let businessLogic = input.initialBusinessLogic;
  let previousScore = -1;
  let lastRefinement: AutoIterateResult | undefined;
  let stopReason: AutoIterateRunResult['stopReason'] = 'max-iterations';
  let errorMessage: string | undefined;

  for (let round = 0; round < max; round++) {
    let pipelineRes;
    try {
      pipelineRes = await runPipeline({
        form: input.form,
        businessLogic,
        domain: input.domain,
      });
    } catch (e) {
      stopReason = 'error';
      errorMessage = `pipeline failed round ${round}: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }

    let evaluation: EvaluationReport;
    try {
      evaluation = await evaluateExisting({
        spec: pipelineRes.spec,
        code: pipelineRes.code.content,
        prompt: businessLogic,
        domain: input.domain,
        modelUsed: pipelineRes.modelUsed,
        compileResult: pipelineRes.compile,
        pipelineTotalMs: pipelineRes.timings.totalMs,
      });
    } catch (e) {
      stopReason = 'error';
      errorMessage = `evaluation failed round ${round}: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }

    rounds.push({
      round,
      businessLogic,
      refinement: lastRefinement,
      evaluation,
      code: pipelineRes.code,
      pipelineTotalMs: pipelineRes.timings.totalMs,
    });

    // Stop conditions
    if (evaluation.finalVerdict === 'FULL') {
      stopReason = 'verdict-full';
      break;
    }
    if (round > 0 && evaluation.aggregateScore <= previousScore) {
      stopReason = 'no-improvement';
      break;
    }
    if (round === max - 1) {
      stopReason = 'max-iterations';
      break;
    }

    // Refine for next round
    previousScore = evaluation.aggregateScore;
    try {
      lastRefinement = await refineBusinessLogic({
        form: input.form,
        currentBusinessLogic: businessLogic,
        currentCode: pipelineRes.code.content,
        evaluation,
      });
      businessLogic = lastRefinement.refinedBusinessLogic;
    } catch (e) {
      stopReason = 'error';
      errorMessage = `refinement failed after round ${round}: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
  }

  if (rounds.length === 0) {
    // The very first pipeline call threw — bubble it up.
    throw new Error(errorMessage ?? 'auto-iterate produced zero rounds');
  }

  return {
    rounds,
    finalRound: rounds[rounds.length - 1],
    stopReason,
    totalDurationMs: Date.now() - t0,
    errorMessage,
  };
}

/** Convenience reading of "best verdict so far" given a round list. */
export function bestVerdict(rounds: IterationRecord[]): ReplacementVerdict {
  const order: ReplacementVerdict[] = ['FULL', 'PARTIAL', 'DRAFT'];
  for (const v of order) {
    if (rounds.some((r) => r.evaluation.finalVerdict === v)) return v;
  }
  return 'DRAFT';
}
