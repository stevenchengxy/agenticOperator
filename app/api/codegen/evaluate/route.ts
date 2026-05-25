// POST /api/codegen/evaluate
//
// Evaluate existing codegen artifacts (spec + generated code) without
// re-running the LLM pipeline. The Codegen page calls this immediately
// after a successful generate, and also when the operator hand-edits the
// code tab and wants to re-check.
//
// Body:
//   {
//     spec: AgentSpec,
//     code: string,
//     prompt?: string,
//     domain: 'raas' | 'r7',
//     fixtureName?: string,    // optional override; auto-detected from spec.slug otherwise
//     modelUsed?: string,
//     pipelineTotalMs?: number,
//   }
//
// Reply: EvaluationReport

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { evaluateExisting } from '@/lib/agent-codegen/eval/evaluate-existing';
import { AgentSpecSchema } from '@/lib/agent-codegen/spec-types';

const BodySchema = z.object({
  spec: AgentSpecSchema,
  code: z.string().min(8).max(256 * 1024),
  prompt: z.string().max(8_000).optional(),
  domain: z.enum(['raas', 'r7']),
  fixtureName: z.string().max(64).optional(),
  modelUsed: z.string().max(80).optional(),
  pipelineTotalMs: z.number().int().nonnegative().optional(),
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
    const report = await evaluateExisting(parsed.data);
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json(
      {
        error: 'evaluation_failure',
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}

export const maxDuration = 30;
