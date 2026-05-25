// evaluate-existing — score code + spec the UI already has, WITHOUT
// re-running the (expensive) LLM pipeline.
//
// Two entry points exist now:
//   - runEval()           (run-eval.ts)  — fixture → runPipeline → score
//   - evaluateExisting()  (this file)    — pre-existing artifacts → score
//
// Both share the same scoring stack (structural / review / behavioral /
// test cases) and emit the same EvaluationReport shape, so the CLI and
// the UI render identical output.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { scoreCandidate, DEFAULT_WEIGHTS, type ScoreBreakdown } from './score';
import { reviewCode } from './code-reviewer';
import {
  extractTrace,
  diffAgainstGroundTruth,
  scoreBehavioralDiff,
  verdictOf,
} from './behavioral-analyzer';
import { generateTestCases } from './test-case-generator';
import { computeFinalVerdict, type EvaluationReport } from './evaluation-report';
import { getToolRegistry } from '../registries';
import { findGroundTruth } from './ground-truth';
import { findFixture } from './fixtures';
import { byInngestSlug } from '@/lib/agent-mapping';
import type { AgentSpec } from '../spec-types';
import type { DomainId } from '@/lib/domains';
import type { CompileResult } from '../compiler/types';

const ROOT = process.cwd();

export type EvaluateExistingInput = {
  spec: AgentSpec;
  code: string;
  /** Original business-description prose. Optional — used only in summary. */
  prompt?: string;
  domain: DomainId;
  /**
   * Explicit fixture name OR derived from spec.slug. When resolved, enables
   * structural-diff-vs-production + behavioral-vs-ground-truth.
   */
  fixtureName?: string;
  /** Carry-through from the upstream pipeline so the report shows it. */
  modelUsed?: string;
  compileResult?: CompileResult;
  pipelineTotalMs?: number;
};

export async function evaluateExisting(
  input: EvaluateExistingInput,
): Promise<EvaluationReport> {
  const toolRegistry = getToolRegistry(input.domain);

  // Resolve fixture: explicit > slug-derived. The fixture (when present)
  // gives us the production source path + ground truth record.
  const resolvedFixtureName =
    input.fixtureName ??
    findFixture(input.spec.slug)?.name ??
    byInngestSlug(input.spec.slug)?.short.toLowerCase().replace(/\s+/g, '-') ??
    undefined;
  const fixture = resolvedFixtureName ? findFixture(resolvedFixtureName) : undefined;
  const groundTruth = resolvedFixtureName ? findGroundTruth(resolvedFixtureName) : undefined;

  // 1. Structural — only when we have a production file to compare against.
  let structural: ScoreBreakdown;
  if (fixture) {
    const productionContent = await readFile(
      path.join(ROOT, fixture.productionPath),
      'utf8',
    );
    structural = scoreCandidate(productionContent, input.code, DEFAULT_WEIGHTS);
  } else {
    // Synthetic identity score — no production reference. Composite 1.0
    // here would over-credit; we set everything to 0 except patterns which
    // can still be measured from candidate alone. UI explains the absence.
    structural = {
      imports: 0,
      steps: 0,
      tools: 0,
      patterns: 0,
      loc: 0,
      composite: 0,
      details: {
        prodImports: [],
        candImports: [],
        missingImports: [],
        extraImports: [],
        prodSteps: [],
        candSteps: [],
        missingSteps: [],
        extraSteps: [],
      },
    };
  }

  // 2. Code review — always runs (cheap, no inputs beyond spec + code).
  const review = reviewCode({
    source: input.code,
    spec: input.spec,
    toolRegistry,
  });

  // 3. Behavioral diff — only when a ground truth record exists.
  const behavioral = groundTruth
    ? (() => {
        const trace = extractTrace(input.code, toolRegistry);
        const diff = diffAgainstGroundTruth(trace, groundTruth, input.code);
        const score = scoreBehavioralDiff(diff, groundTruth);
        const verdict = verdictOf(score, diff);
        return { trace, diff, score, verdict };
      })()
    : undefined;

  // 4. Test cases — always.
  const generatedTestCases = generateTestCases(input.spec, toolRegistry);

  const final = computeFinalVerdict(
    structural,
    review,
    behavioral
      ? { score: behavioral.score, verdict: behavioral.verdict, diff: behavioral.diff }
      : undefined,
    groundTruth?.replacementVerdict,
  );

  return {
    fixtureName: resolvedFixtureName ?? '(ad-hoc — no production reference)',
    productionPath: fixture?.productionPath ?? '(no fixture matched)',
    modelUsed: input.modelUsed ?? 'unknown',
    structural,
    review,
    behavioral,
    generatedTestCases,
    compileOk: input.compileResult?.ok ?? true,
    compileDiagnosticsCount: input.compileResult?.diagnostics.length ?? 0,
    pipelineTotalMs: input.pipelineTotalMs ?? 0,
    aggregateScore: final.aggregateScore,
    finalVerdict: final.finalVerdict,
    summary: final.summary,
  };
}
