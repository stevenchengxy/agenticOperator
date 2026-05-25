// POST /api/codegen/generate  (Codegen v2 — form-first)
//
// Runs the full v2 pipeline: form + businessLogic → steps[] (LLM A) →
// step bodies (LLM B) → render → compile.
//
// Body:
//   {
//     form: AgentFormFields {
//       slug, displayName, stage, ownerTeam,
//       triggerEvent, emitEvents[], retries, errorHandling
//     },
//     businessLogic: string,
//     domain: 'raas' | 'r7',
//     skipStepBodies?: boolean
//   }
//
// Reply (200):
//   {
//     spec, code: { path, content }, compile, timings, modelUsed
//   }
//
// Errors:
//   400 invalid_body — Zod validation failed
//   500 pipeline_failure — anything thrown inside the pipeline

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runPipeline } from '@/lib/agent-codegen/pipeline';
import { AgentFormFieldsSchema } from '@/lib/agent-codegen/spec-types';

const BodySchema = z.object({
  form: AgentFormFieldsSchema,
  businessLogic: z.string().min(8).max(8_000),
  domain: z.enum(['raas', 'r7']),
  skipStepBodies: z.boolean().optional(),
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
    const result = await runPipeline(parsed.data);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      {
        error: 'pipeline_failure',
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}

// Codegen can take 30-90s end-to-end (two LLM calls + project compile).
export const maxDuration = 120;
