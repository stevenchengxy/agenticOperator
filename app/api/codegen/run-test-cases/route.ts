// POST /api/codegen/run-test-cases
//
// Dynamically execute the generated test cases for a (spec, code) pair.
// Used by the EvaluationPanel "Execute" button.
//
// Body:
//   {
//     code: string,                 // generated agent source
//     testCases: TestCase[],        // from the eval report
//     domain: 'raas' | 'r7',
//     timeoutMs?: number,
//   }
//
// Reply:
//   {
//     results: DynamicRunResult[],
//     passed, failed, total, totalDurationMs
//   }
//
// Notes:
//   - Each case runs in a vm-isolated context with mocked tool imports
//     (no fs/net/env passthrough). See lib/agent-codegen/eval/dynamic-runner.ts
//     for the sandboxing details.
//   - Failures are part of the response (200 OK); 4xx/5xx only when the
//     request body is malformed or the setup itself crashes.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runDynamicCases } from '@/lib/agent-codegen/eval/run-dynamic-cases';
import { getToolRegistry } from '@/lib/agent-codegen/registries';

const MockSetupSchema = z.object({
  toolId: z.string(),
  returns: z.unknown(),
});

const TestCaseSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: z.enum(['happy-path', 'missing-trigger-field', 'downstream-4xx', 'idempotency']),
  inputEvent: z.object({
    name: z.string(),
    data: z.record(z.string(), z.unknown()),
  }),
  mockSetup: z.array(MockSetupSchema),
  expectedOutcome: z.object({
    handlerResolves: z.enum(['success', 'non-retriable-error', 'retriable-error']),
    expectedEmits: z.array(z.string()),
  }),
});

const BodySchema = z.object({
  code: z.string().min(8).max(256 * 1024),
  testCases: z.array(TestCaseSchema).min(1).max(20),
  domain: z.enum(['raas', 'r7']),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', detail: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const summary = await runDynamicCases({
      source: parsed.data.code,
      testCases: parsed.data.testCases,
      toolRegistry: getToolRegistry(parsed.data.domain),
      timeoutMs: parsed.data.timeoutMs,
    });
    return NextResponse.json(summary);
  } catch (e) {
    return NextResponse.json(
      {
        error: 'runner_failure',
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}

// 4 cases × ~5s timeout default = 20s upper bound; bump to 60s for safety.
export const maxDuration = 60;
