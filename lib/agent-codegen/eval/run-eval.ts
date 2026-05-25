// Eval runner — load a fixture, run the codegen pipeline, score the
// generated source against the production reference, print a report.
//
// Used by:
//   - scripts/codegen-eval.ts (CLI)
//   - future eval UI (Bundle E)

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runPipeline } from '../pipeline';
import { scoreCandidate, DEFAULT_WEIGHTS, type ScoreBreakdown } from './score';
import type { EvalFixture } from './fixtures';

const ROOT = process.cwd();

export type EvalReport = {
  fixtureName: string;
  productionPath: string;
  score: ScoreBreakdown;
  generated: { path: string; content: string };
  productionContent: string;
  pipelineTimings: { specMs: number; bodiesMs: number; renderMs: number; compileMs: number; totalMs: number };
  modelUsed: string;
  compileOk: boolean;
  compileDiagnosticsCount: number;
};

export async function runEval(fixture: EvalFixture, domain: 'raas' | 'r7' = 'raas'): Promise<EvalReport> {
  const productionContent = await readFile(path.join(ROOT, fixture.productionPath), 'utf8');

  const pipeline = await runPipeline({
    form: fixture.form,
    businessLogic: fixture.businessLogic,
    domain,
  });

  const score = scoreCandidate(productionContent, pipeline.code.content, DEFAULT_WEIGHTS);

  return {
    fixtureName: fixture.name,
    productionPath: fixture.productionPath,
    score,
    generated: pipeline.code,
    productionContent,
    pipelineTimings: pipeline.timings,
    modelUsed: pipeline.modelUsed,
    compileOk: pipeline.compile.ok,
    compileDiagnosticsCount: pipeline.compile.diagnostics.length,
  };
}

/** Pretty-print an eval report for a terminal. */
export function formatReport(r: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1).padStart(5)}%`;
  const lines: string[] = [
    '',
    `── Codegen eval · ${r.fixtureName} ──────────────────`,
    `Production: ${r.productionPath}`,
    `Model:      ${r.modelUsed}`,
    `Pipeline:   ${r.pipelineTimings.totalMs} ms (spec ${r.pipelineTimings.specMs} + bodies ${r.pipelineTimings.bodiesMs} + render ${r.pipelineTimings.renderMs} + compile ${r.pipelineTimings.compileMs})`,
    `Compile:    ${r.compileOk ? '✓ OK' : '❌ FAIL'} · ${r.compileDiagnosticsCount} diagnostic${r.compileDiagnosticsCount === 1 ? '' : 's'}`,
    '',
    `Score dimensions (weights ${formatWeights(DEFAULT_WEIGHTS)}):`,
    `  imports  ${pct(r.score.imports)}    steps    ${pct(r.score.steps)}`,
    `  tools    ${pct(r.score.tools)}    patterns ${pct(r.score.patterns)}`,
    `  loc      ${pct(r.score.loc)}`,
    '',
    `COMPOSITE  ${pct(r.score.composite)}`,
    '',
    'Diff details:',
    `  imports missing in generated:  ${r.score.details.missingImports.join(', ') || '(none)'}`,
    `  imports extra in generated:    ${r.score.details.extraImports.join(', ') || '(none)'}`,
    `  steps missing in generated:    ${r.score.details.missingSteps.join(', ') || '(none)'}`,
    `  steps extra in generated:      ${r.score.details.extraSteps.join(', ') || '(none)'}`,
    '',
  ];
  return lines.join('\n');
}

function formatWeights(w: typeof DEFAULT_WEIGHTS): string {
  return `imports ${w.imports}, steps ${w.steps}, tools ${w.tools}, patterns ${w.patterns}, loc ${w.loc}`;
}
