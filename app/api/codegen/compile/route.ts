// POST /api/codegen/compile
//
// Run the AO codegen in-process compiler over a set of virtual files
// (overlaid on top of the real project for `@/` alias resolution + type
// inference against existing libs/agents).
//
// Used by:
//   - the Phase 1b codegen pipeline (LLM output → compiler → review gate)
//   - the Phase 1a codegen-page UI (operator "Compile" button on the
//     Monaco code tab — surfaces diagnostics inline)
//
// Body:  CompileRequest  (lib/agent-codegen/compiler/types.ts)
// Reply: CompileResult

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { compile } from '@/lib/agent-codegen/compiler/compile';
import type { CompileResult } from '@/lib/agent-codegen/compiler/types';

const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

const BodySchema = z.object({
  files: z
    .array(
      z.object({
        // Restrict path to the project tree, no traversal, no absolute paths.
        path: z
          .string()
          .min(1)
          .max(512)
          .refine((p) => !p.startsWith('/') && !p.includes('..') && SAFE_PATH.test(p), {
            message: 'path must be a safe project-relative path',
          }),
        // ~256 KB per file is generous for a single generated agent.
        content: z.string().max(256 * 1024),
      }),
    )
    .min(1)
    .max(20),
  domain: z.enum(['raas', 'r7']).optional(),
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
    const result: CompileResult = await compile(parsed.data);
    return NextResponse.json(result);
  } catch (e) {
    // Compiler set-up failure (e.g. tsconfig missing). Bubble up as 500 so
    // the UI distinguishes this from "compile ran, found errors".
    return NextResponse.json(
      { error: 'compiler_failure', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
