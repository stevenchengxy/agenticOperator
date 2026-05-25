// POST /api/codegen/auto-iterate
//
// Bundle M — runs the AI-native closed loop server-side:
//   generate → eval → if not FULL → AI refines prose → regenerate → ...
//   up to N=3 iterations (configurable 1-5), stops early on:
//   verdict = FULL, no score improvement, or pipeline error.
//
// Each round consumes ~2 LLM calls (spec extractor + step body filler)
// plus 1 refinement call (rounds > 0). 3 rounds ≈ 6-9 LLM calls + 3
// in-process compiles. Wall time 90s-4min.
//
// Body:
//   {
//     form: AgentFormFields,
//     initialBusinessLogic: string,
//     domain: 'raas' | 'r7',
//     maxIterations?: number  // default 3, capped at 5
//   }
//
// Reply: AutoIterateRunResult { rounds, finalRound, stopReason, totalDurationMs }

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { autoIterate } from '@/lib/agent-codegen/eval/auto-iterate';
import { AgentFormFieldsSchema } from '@/lib/agent-codegen/spec-types';

const BodySchema = z.object({
  form: AgentFormFieldsSchema,
  initialBusinessLogic: z.string().min(8).max(8_000),
  domain: z.enum(['raas', 'r7']),
  maxIterations: z.number().int().min(1).max(5).optional(),
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
    const result = await autoIterate(parsed.data);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      {
        error: 'auto_iterate_failure',
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}

// 3 rounds × ~90s pipeline + ~10s refine = 5 minutes worst case.
export const maxDuration = 360;
