// POST /api/codegen/library/draft-examples
//
// Convert a natural-language wrapper description into a draft list of
// CurlExample entries. The operator reviews + refines in the UI before
// running the full library codegen pipeline.
//
// Body:    { description: string, baseUrlHint?: string }
// Reply:   { examples: CurlExample[], modelUsed, durationMs }

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { draftExamplesFromNL } from '@/lib/agent-codegen/library/llm/draft-examples-from-nl';

const BodySchema = z.object({
  description: z.string().min(12).max(4000),
  baseUrlHint: z.string().url().optional(),
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
    const result = await draftExamplesFromNL(parsed.data);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      {
        error: 'draft_failure',
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}

export const maxDuration = 60;
