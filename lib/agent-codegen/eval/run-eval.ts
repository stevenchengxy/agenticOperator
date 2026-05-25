// Eval runner — Bundle E version.
//
// Replaces the D4-only runner: now runs structural score + code review +
// (optionally) behavioral diff against ground truth + always generates
// declarative test cases for hand inspection.
//
// CLI flags map to which sub-reports get computed:
//   default        — structural only (cheap, fast)
//   --review       — + code reviewer
//   --behavior     — + behavioral diff (needs a ground truth record)
//   --full         — all of the above

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runPipeline } from '../pipeline';
import { scoreCandidate, DEFAULT_WEIGHTS } from './score';
import { reviewCode } from './code-reviewer';
import {
  extractTrace,
  diffAgainstGroundTruth,
  scoreBehavioralDiff,
  verdictOf,
} from './behavioral-analyzer';
import { generateTestCases } from './test-case-generator';
import {
  computeFinalVerdict,
  type EvaluationReport,
} from './evaluation-report';
import { getToolRegistry } from '../registries';
import { findGroundTruth } from './ground-truth';
import { pickRealEventFixture } from './real-event-fixtures';
import type { EvalFixture } from './fixtures';

const ROOT = process.cwd();

export type RunOptions = {
  review?: boolean;
  behavior?: boolean;
};

export async function runEval(
  fixture: EvalFixture,
  opts: RunOptions = {},
  domain: 'raas' | 'r7' = 'raas',
): Promise<EvaluationReport> {
  const productionContent = await readFile(path.join(ROOT, fixture.productionPath), 'utf8');

  const pipeline = await runPipeline({
    form: fixture.form,
    businessLogic: fixture.businessLogic,
    domain,
  });

  const toolRegistry = getToolRegistry(domain);

  // 1. Structural
  const structural = scoreCandidate(productionContent, pipeline.code.content, DEFAULT_WEIGHTS);

  // 2. Code review (always cheap — run it unconditionally; --review just
  // surfaces it in the printed output, but the data is always populated)
  const review = reviewCode({
    source: pipeline.code.content,
    spec: pipeline.spec,
    toolRegistry,
  });

  // 3. Behavioral (only when a ground truth record exists)
  const gt = findGroundTruth(fixture.name);
  const behavioral = gt
    ? (() => {
        const trace = extractTrace(pipeline.code.content, toolRegistry);
        const diff = diffAgainstGroundTruth(trace, gt, pipeline.code.content);
        const score = scoreBehavioralDiff(diff, gt);
        const verdict = verdictOf(score, diff);
        return { trace, diff, score, verdict };
      })()
    : undefined;

  // 4. Test cases (always). Bundle N: real EventInstance payload preferred.
  let realEvent: Awaited<ReturnType<typeof pickRealEventFixture>> = null;
  try {
    realEvent = await pickRealEventFixture(pipeline.spec.triggerEvent);
  } catch {
    realEvent = null;
  }
  const generatedTestCases = generateTestCases(
    pipeline.spec,
    toolRegistry,
    realEvent?.data ?? null,
  );

  const final = computeFinalVerdict(
    structural,
    review,
    behavioral
      ? { score: behavioral.score, verdict: behavioral.verdict, diff: behavioral.diff }
      : undefined,
    gt?.replacementVerdict,
  );

  return {
    fixtureName: fixture.name,
    productionPath: fixture.productionPath,
    modelUsed: pipeline.modelUsed,
    structural,
    review,
    behavioral,
    generatedTestCases,
    realEventFixture: realEvent
      ? {
          eventInstanceId: realEvent.eventInstanceId,
          source: realEvent.source,
          tsIso: realEvent.ts.toISOString(),
        }
      : null,
    compileOk: pipeline.compile.ok,
    compileDiagnosticsCount: pipeline.compile.diagnostics.length,
    pipelineTotalMs: pipeline.timings.totalMs,
    aggregateScore: final.aggregateScore,
    finalVerdict: final.finalVerdict,
    summary: final.summary,
  };
}

// Re-export for CLI convenience.
export { formatEvaluationReport } from './evaluation-report';
