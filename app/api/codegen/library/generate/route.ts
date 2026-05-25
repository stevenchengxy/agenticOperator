// POST /api/codegen/library/generate
//
// Library codegen pipeline — Phase 2 MVP.
//
// Body:
//   {
//     form: {
//       name: string,                  // kebab-case, e.g. 'rms-client'
//       description: string,
//       baseUrl: string,
//       authStyle: 'bearer' | 'api-key' | 'basic' | 'none',
//       envVarsRequired: string[],
//     },
//     examples: Array<{
//       httpVerb: 'GET' | 'POST' | ...,
//       httpPath: string,              // '/api/v1/applications/:id'
//       description: string,
//       requestSample?: string,        // JSON example
//       responseSample?: string,       // JSON example
//     }>,
//   }
//
// Reply (200):
//   {
//     output: { methods, sharedTypes },
//     code: { path, content },
//     registrySuggestion: Array<{ id, importFrom, importName, signature, summary }>,
//     compile, timings, modelUsed
//   }

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runLibPipeline } from '@/lib/agent-codegen/library/lib-pipeline';
import {
  CurlExampleSchema,
  LibraryFormFieldsSchema,
} from '@/lib/agent-codegen/library/lib-spec-types';

const BodySchema = z.object({
  form: LibraryFormFieldsSchema,
  examples: z.array(CurlExampleSchema).min(1).max(20),
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
    const result = await runLibPipeline(parsed.data);
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

export const maxDuration = 120;
