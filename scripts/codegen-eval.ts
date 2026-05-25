#!/usr/bin/env node
// CLI for running codegen evaluations against the 5 production-agent fixtures.
//
// Usage:
//   npm run codegen:eval                              # all fixtures, structural + review + behavior
//   npm run codegen:eval -- --fixture=create-jd-agent
//   npm run codegen:eval -- --fixture=interview-inviter-agent --full
//   npm run codegen:eval -- --list
//
// Output sections (always printed):
//   1. Structural score (D4)
//   2. Code review (E1)
//   3. Behavioral diff vs ground truth (E3) — only when a record exists
//   4. Generated test cases (E4)
//   5. Final verdict — FULL / PARTIAL / DRAFT
//
// Requires the same LLM env vars as /api/codegen/generate
// (AI_BASE_URL + AI_API_KEY, or OPENAI_API_KEY; AI_CODEGEN_MODEL optional).

import { FIXTURES, findFixture } from '../lib/agent-codegen/eval/fixtures';
import { runEval, formatEvaluationReport } from '../lib/agent-codegen/eval/run-eval';
import type { EvaluationReport } from '../lib/agent-codegen/eval/evaluation-report';

function parseArgs(argv: string[]): { fixture?: string; list?: boolean } {
  const out: { fixture?: string; list?: boolean } = {};
  for (const a of argv) {
    if (a === '--list') out.list = true;
    else if (a.startsWith('--fixture=')) out.fixture = a.slice('--fixture='.length);
    // --review / --behavior / --full retained as no-ops — the new runner
    // always populates every sub-report; flags are kept for backward
    // compatibility with prior docs.
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log('Available fixtures:');
    for (const f of FIXTURES) {
      console.log(`  ${f.name.padEnd(28)} → ${f.productionPath}`);
    }
    return;
  }

  const targets = args.fixture
    ? [findFixture(args.fixture)].filter((f): f is (typeof FIXTURES)[number] => !!f)
    : FIXTURES;

  if (targets.length === 0) {
    console.error(`Unknown fixture: ${args.fixture}`);
    console.error('Run `npm run codegen:eval -- --list` to see options.');
    process.exit(1);
  }

  const reports: EvaluationReport[] = [];
  for (const f of targets) {
    process.stdout.write(`Running ${f.name} … `);
    try {
      const r = await runEval(f);
      console.log(`${r.finalVerdict} (${(r.aggregateScore * 100).toFixed(1)}%)`);
      reports.push(r);
    } catch (e) {
      console.log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const r of reports) {
    console.log(formatEvaluationReport(r));
  }

  if (reports.length > 1) {
    const mean = reports.reduce((a, r) => a + r.aggregateScore, 0) / reports.length;
    const verdictCounts = reports.reduce<Record<string, number>>((acc, r) => {
      acc[r.finalVerdict] = (acc[r.finalVerdict] ?? 0) + 1;
      return acc;
    }, {});
    console.log('═══════════════════════════════════════════');
    console.log(
      `Mean aggregate across ${reports.length} fixtures: ${(mean * 100).toFixed(1)}%   ` +
        `verdicts: ${Object.entries(verdictCounts).map(([k, v]) => `${k}=${v}`).join(' · ')}`,
    );
  }
}

main().catch((e) => {
  console.error('Eval crashed:', e);
  process.exit(1);
});
