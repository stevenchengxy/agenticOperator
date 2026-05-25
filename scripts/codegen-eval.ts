#!/usr/bin/env node
// CLI for running codegen evals against the 5 production-agent fixtures.
//
// Usage:
//   npm run codegen:eval                      # run all 5 fixtures sequentially
//   npm run codegen:eval -- --fixture=create-jd-agent
//   npm run codegen:eval -- --list            # show fixture names + exit
//
// Requires the same LLM env vars as the /api/codegen/generate route
// (AI_BASE_URL + AI_API_KEY, or OPENAI_API_KEY; AI_CODEGEN_MODEL optional).
// Each fixture takes 30-90s of wall time + LLM cost.

import { FIXTURES, findFixture } from '../lib/agent-codegen/eval/fixtures';
import { runEval, formatReport, type EvalReport } from '../lib/agent-codegen/eval/run-eval';

function parseArgs(argv: string[]): { fixture?: string; list?: boolean } {
  const out: { fixture?: string; list?: boolean } = {};
  for (const a of argv) {
    if (a === '--list') out.list = true;
    else if (a.startsWith('--fixture=')) out.fixture = a.slice('--fixture='.length);
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

  const reports: EvalReport[] = [];
  for (const f of targets) {
    process.stdout.write(`Running ${f.name} … `);
    try {
      const r = await runEval(f);
      console.log(`composite ${(r.score.composite * 100).toFixed(1)}%`);
      reports.push(r);
    } catch (e) {
      console.log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const r of reports) {
    console.log(formatReport(r));
  }

  if (reports.length > 1) {
    const mean = reports.reduce((a, r) => a + r.score.composite, 0) / reports.length;
    console.log('────────────────────────────────────────');
    console.log(`Mean composite across ${reports.length} fixtures: ${(mean * 100).toFixed(1)}%`);
  }
}

main().catch((e) => {
  console.error('Eval crashed:', e);
  process.exit(1);
});
