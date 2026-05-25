// runDynamicCases — orchestrator that runs every generated test case
// for a given (spec, code) pair through the dynamic-runner, and rolls up
// pass/fail counts.
//
// Opt-in path (vs the always-on structural/review/behavioral analysis)
// because:
//   - it's slow (vm spin-up + per-case handler execution, ~50-300ms each)
//   - it requires the generated code to actually compile + execute, which
//     not every codegen draft will satisfy
//
// Triggered from:
//   - POST /api/codegen/run-test-cases (UI Execute button)
//   - npm run codegen:eval --execute (future flag)

import { runTestCase, type DynamicRunResult } from './dynamic-runner';
import type { TestCase } from './test-case-generator';
import type { ToolRegistryEntry } from '../registries';

export type DynamicCasesSummary = {
  results: DynamicRunResult[];
  passed: number;
  failed: number;
  total: number;
  totalDurationMs: number;
};

export async function runDynamicCases(opts: {
  source: string;
  testCases: TestCase[];
  toolRegistry: ReadonlyArray<ToolRegistryEntry>;
  timeoutMs?: number;
}): Promise<DynamicCasesSummary> {
  const t0 = Date.now();
  const results: DynamicRunResult[] = [];
  for (const tc of opts.testCases) {
    const r = await runTestCase({
      source: opts.source,
      testCase: tc,
      toolRegistry: opts.toolRegistry,
      timeoutMs: opts.timeoutMs,
    });
    results.push(r);
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    results,
    passed,
    failed: results.length - passed,
    total: results.length,
    totalDurationMs: Date.now() - t0,
  };
}
