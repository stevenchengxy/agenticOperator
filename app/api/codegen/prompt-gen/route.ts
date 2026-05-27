// POST /api/codegen/prompt-gen
//
// Given an operator intent (+ optional locked fields), invokes PromptGen to
// synthesize a structured AgentPrompt that the operator then reviews and
// confirms before injecting into the existing codegen pipeline.
//
// Body:
//   {
//     intent: string,
//     domain: 'raas' | 'r7',
//     locked?: Partial<AgentFormFields>,
//     blueprintSlug?: string,
//   }
//
// Reply (200):
//   { prompt, missingTools, modelUsed, durationMs }
//
// Errors:
//   400 invalid_body — Zod validation failed
//   500 promptgen_failure — anything thrown inside generateAgentPrompt

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { generateAgentPrompt } from '@/lib/agent-codegen/prompt-gen/prompt-gen';

const BodySchema = z.object({
  intent: z.string().min(4).max(2_000),
  domain: z.enum(['raas', 'r7']),
  locked: z
    .object({
      slug: z.string().optional(),
      displayName: z.string().optional(),
      stage: z.string().optional(),
      ownerTeam: z.string().optional(),
      triggerEvent: z.string().optional(),
      emitEvents: z.array(z.string()).optional(),
      retries: z.number().int().optional(),
      errorHandling: z.enum(['retry', 'dlq', 'hitl-fallback']).optional(),
    })
    .optional(),
  blueprintSlug: z.string().optional(),
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
    const result = await generateAgentPrompt({
      intent: parsed.data.intent,
      domain: parsed.data.domain,
      locked: (parsed.data.locked ?? {}) as never,
      blueprintSlug: parsed.data.blueprintSlug,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      {
        error: 'promptgen_failure',
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}

export const maxDuration = 60;
