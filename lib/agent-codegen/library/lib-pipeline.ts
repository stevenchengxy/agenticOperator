// Library codegen pipeline — Phase 2 MVP.
//
//   LibraryFormFields + CurlExample[]
//     ↓ generateLibrary()           — LLM Call C (methods[] + sharedTypes[])
//   LibraryGenerationOutput
//     ↓ renderHttpClient()          — deterministic single-file template
//   { suggestedPath, content, registrySuggestion }
//     ↓ compile()                   — Phase 0c in-process overlay typecheck
//   CompileResult
//
// Output bundles everything for the UI: rendered client.ts, suggested
// TOOL_REGISTRY entries the operator can paste into tool-registry.raas.ts,
// and the compile diagnostics for the generated file.

import { generateLibrary } from './llm/lib-spec-extractor';
import { renderHttpClient } from './templates/render-http-client';
import { compile } from '@/lib/agent-codegen/compiler/compile';
import type { CompileResult } from '@/lib/agent-codegen/compiler/types';
import type { CurlExample, LibraryFormFields, LibraryGenerationOutput } from './lib-spec-types';

export type RunLibPipelineInput = {
  form: LibraryFormFields;
  examples: CurlExample[];
};

export type RunLibPipelineResult = {
  output: LibraryGenerationOutput;
  code: { path: string; content: string };
  registrySuggestion: Array<{
    id: string;
    importFrom: string;
    importName: string;
    signature: string;
    summary: string;
  }>;
  compile: CompileResult;
  timings: { genMs: number; renderMs: number; compileMs: number; totalMs: number };
  modelUsed: string;
};

export async function runLibPipeline(input: RunLibPipelineInput): Promise<RunLibPipelineResult> {
  const t0 = Date.now();

  const gen = await generateLibrary({ form: input.form, examples: input.examples });

  const tRender0 = Date.now();
  const rendered = renderHttpClient({ form: input.form, output: gen.output });
  const renderMs = Date.now() - tRender0;

  const compileRes = await compile({
    files: [{ path: rendered.suggestedPath, content: rendered.content }],
  });

  return {
    output: gen.output,
    code: { path: rendered.suggestedPath, content: rendered.content },
    registrySuggestion: rendered.registrySuggestion,
    compile: compileRes,
    timings: {
      genMs: gen.durationMs,
      renderMs,
      compileMs: compileRes.durationMs,
      totalMs: Date.now() - t0,
    },
    modelUsed: gen.modelUsed,
  };
}
