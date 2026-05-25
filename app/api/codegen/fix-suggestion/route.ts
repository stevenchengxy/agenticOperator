// POST /api/codegen/fix-suggestion
//
// Ask the LLM to explain compiler diagnostics + propose a patched version
// of the file. Operator reviews the diff in the CompilerPanel dialog
// before clicking Apply.
//
// Body:
//   {
//     filename: string,               // virtual path (e.g. 'lib/generated/x/client.ts')
//     code: string,                   // current source
//     diagnostics: Diagnostic[],      // from /api/codegen/compile or pipeline.compile
//     domain: 'raas' | 'r7',
//   }
//
// Reply:
//   { explanation, patchedCode, changeSummary[], confidence, modelUsed, durationMs }

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { suggestFix } from '@/lib/agent-codegen/llm/code-fixer';

const DiagnosticSchema = z.object({
  file: z.string(),
  line: z.number().int().min(0),
  column: z.number().int().min(0),
  severity: z.enum(['error', 'warning']),
  code: z.number().int(),
  message: z.string(),
  category: z.enum(['import', 'type', 'syntax', 'other']),
});

const BodySchema = z.object({
  filename: z.string().min(1).max(512),
  code: z.string().min(8).max(256 * 1024),
  diagnostics: z.array(DiagnosticSchema).min(1).max(50),
  domain: z.enum(['raas', 'r7']),
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
    const result = await suggestFix(parsed.data);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      {
        error: 'fix_failure',
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}

export const maxDuration = 60;
