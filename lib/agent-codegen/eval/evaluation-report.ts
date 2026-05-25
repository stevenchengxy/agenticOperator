// Aggregated evaluation report — combines:
//   1. structural score (D4 score.ts — imports / steps / tools / patterns / loc)
//   2. static code review (code-reviewer.ts — 8 rules)
//   3. behavioral analysis (behavioral-analyzer.ts — TS-AST step trace + diff
//      against the hand-written ground truth record)
//   4. generated test cases (test-case-generator.ts — declarative, for hand review)
//
// Final field is `replacementVerdict`: FULL / PARTIAL / DRAFT, decided by
// the behavioral verdict + the structural composite score.

import type { ScoreBreakdown } from './score';
import type { ReviewReport } from './code-reviewer';
import type {
  BehavioralTrace,
  BehavioralDiff,
} from './behavioral-analyzer';
import type { TestCase } from './test-case-generator';
import type { GroundTruth } from './ground-truth';

export type ReplacementVerdict = 'FULL' | 'PARTIAL' | 'DRAFT';

export type EvaluationReport = {
  fixtureName: string;
  productionPath: string;
  modelUsed: string;

  // Sub-reports
  structural: ScoreBreakdown;
  review: ReviewReport;
  behavioral?: {
    trace: BehavioralTrace;
    diff: BehavioralDiff;
    score: number;
    verdict: ReplacementVerdict;
  };
  generatedTestCases: TestCase[];

  // Pipeline meta (carried from upstream)
  compileOk: boolean;
  compileDiagnosticsCount: number;
  pipelineTotalMs: number;

  // Final aggregate
  /** 0..1 — weighted mean of structural composite + behavioral score (when available). */
  aggregateScore: number;
  /** Final go/no-go for replacing the production agent with the generated code. */
  finalVerdict: ReplacementVerdict;
  /** One-line operator-facing summary; uses the GroundTruth.replacementVerdict
   *  when behavioral analysis succeeded; otherwise an auto-generated message. */
  summary: string;
};

export function computeFinalVerdict(
  structural: ScoreBreakdown,
  review: ReviewReport,
  behavioral?: { score: number; verdict: ReplacementVerdict; diff: BehavioralDiff },
  groundTruthVerdict?: string,
): { aggregateScore: number; finalVerdict: ReplacementVerdict; summary: string } {
  // No ground truth → fall back to structural only.
  if (!behavioral) {
    const agg = structural.composite;
    const verdict: ReplacementVerdict = agg >= 0.85 ? 'FULL' : agg >= 0.6 ? 'PARTIAL' : 'DRAFT';
    return {
      aggregateScore: agg,
      finalVerdict: verdict,
      summary:
        `Structural-only evaluation (no ground truth). Composite ${(agg * 100).toFixed(1)}%, review ${review.errorCount} errors / ${review.warningCount} warnings.`,
    };
  }

  // Both signals — weight behavioral higher (it's the more semantic test).
  const agg = structural.composite * 0.35 + behavioral.score * 0.65;
  // Downgrade verdict if review has errors regardless of scores.
  let verdict: ReplacementVerdict = behavioral.verdict;
  if (review.errorCount > 0 && verdict === 'FULL') verdict = 'PARTIAL';
  if (review.errorCount > 2 && verdict === 'PARTIAL') verdict = 'DRAFT';

  const stepSummary =
    behavioral.diff.missingSteps.length === 0
      ? 'all expected steps present'
      : `${behavioral.diff.missingSteps.length} step(s) missing: ${behavioral.diff.missingSteps.map((s) => s.id).join(', ')}`;
  const summary =
    `${verdict}. Aggregate ${(agg * 100).toFixed(1)}% · structural ${(structural.composite * 100).toFixed(1)}% · behavioral ${(behavioral.score * 100).toFixed(1)}% · review ${review.errorCount} err/${review.warningCount} warn · ${stepSummary}.` +
    (groundTruthVerdict ? `\n  Ground-truth note: ${groundTruthVerdict}` : '');

  return { aggregateScore: agg, finalVerdict: verdict, summary };
}

// ────────────────────────────────────────────────────────────────────────
// Pretty-printer for CLI / log output
// ────────────────────────────────────────────────────────────────────────

export function formatEvaluationReport(r: EvaluationReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1).padStart(5)}%`;
  const lines: string[] = [
    '',
    `═════ Evaluation · ${r.fixtureName} ═════`,
    `Production: ${r.productionPath}`,
    `Model:      ${r.modelUsed}   Pipeline ${r.pipelineTotalMs} ms   Compile ${r.compileOk ? '✓' : '❌'} ${r.compileDiagnosticsCount} diag`,
    '',
    '── 1. Structural (D4) ──',
    `  imports ${pct(r.structural.imports)}   steps ${pct(r.structural.steps)}   tools ${pct(r.structural.tools)}   patterns ${pct(r.structural.patterns)}   loc ${pct(r.structural.loc)}`,
    `  composite ${pct(r.structural.composite)}`,
    '',
    '── 2. Code review ──',
    `  ${r.review.passed ? '✓ passed' : '✗ failed'} — ${r.review.errorCount} error · ${r.review.warningCount} warning · ${r.review.infoCount} info`,
    ...r.review.issues.slice(0, 8).map(
      (i) =>
        `  [${i.severity.padEnd(7)}] ${i.ruleId}${i.line ? ` (L${i.line})` : ''}: ${i.message}` +
        (i.hint ? `\n      → ${i.hint}` : ''),
    ),
    r.review.issues.length > 8 ? `  … +${r.review.issues.length - 8} more` : '',
    '',
  ];

  if (r.behavioral) {
    lines.push(
      '── 3. Behavioral (TS-AST vs GroundTruth) ──',
      `  score ${pct(r.behavioral.score)}   verdict ${r.behavioral.verdict}`,
      `  matched steps:    ${r.behavioral.diff.matchedSteps.map((s) => s.id).join(', ') || '(none)'}`,
      `  missing steps:    ${r.behavioral.diff.missingSteps.map((s) => s.id).join(', ') || '(none)'}`,
      `  unexpected steps: ${r.behavioral.diff.unexpectedSteps.map((s) => s.id).join(', ') || '(none)'}`,
      `  matched emits:    ${r.behavioral.diff.matchedEmits.map((e) => e.name).join(', ') || '(none)'}`,
      `  missing emits:    ${r.behavioral.diff.missingEmits.map((e) => e.name).join(', ') || '(none)'}`,
      `  conventions:      NonRetriable=${r.behavioral.diff.conventionsMet.nonRetriable} · try/catch=${r.behavioral.diff.conventionsMet.tryCatch} · logger=${r.behavioral.diff.conventionsMet.loggerCalls} (need ≥ ${r.behavioral.diff.conventionsMet.loggerCallsMet ? 'met' : 'low'})`,
      '',
    );
  } else {
    lines.push('── 3. Behavioral ── (skipped: no ground-truth record for this fixture)', '');
  }

  lines.push(
    `── 4. Generated test cases (${r.generatedTestCases.length}) ──`,
    ...r.generatedTestCases.map((c) => `  · ${c.name} [${c.category}]`),
    '',
    '════ Verdict ════',
    `  ${r.finalVerdict}   aggregate ${pct(r.aggregateScore)}`,
    `  ${r.summary}`,
    '',
  );

  return lines.join('\n');
}
