// End-to-end codegen pipeline (Phase 1b MVP).
//
//   prompt + domain
//     ↓ extractSpec()                 — LLM Call A
//   AgentSpec
//     ↓ fillStepBodies()              — LLM Call B (one-shot, all steps)
//   StepBody[]
//     ↓ renderAgent()                 — deterministic template
//   { suggestedPath, content }
//     ↓ compile()                     — Phase 0c in-process TS overlay
//   CompileResult
//
// Output bundles everything so the UI can populate Spec / Code / Diff tabs
// and the right-rail compiler panel from one POST.

import type { DomainId } from '@/lib/domains';
import { extractSpec } from './llm/spec-extractor';
import { fillStepBodies } from './llm/step-body-filler';
import { renderAgent } from './templates/render-agent';
import { compile } from './compiler/compile';
import type { AgentSpec } from './spec-types';
import type { CompileResult } from './compiler/types';

export type RunPipelineInput = {
  prompt: string;
  domain: DomainId;
  /** When true, skip LLM Call B and emit TODO step bodies. Faster + cheaper
   *  preview; the Code tab will still render and compile (TODOs return null). */
  skipStepBodies?: boolean;
};

export type RunPipelineResult = {
  spec: AgentSpec;
  code: { path: string; content: string };
  compile: CompileResult;
  timings: { specMs: number; bodiesMs: number; renderMs: number; compileMs: number; totalMs: number };
  modelUsed: string;
};

export async function runPipeline(input: RunPipelineInput): Promise<RunPipelineResult> {
  const t0 = Date.now();

  // Stage 1 — spec extraction
  const specRes = await extractSpec({ prompt: input.prompt, domain: input.domain });

  // Stage 2 — step body fill (optional)
  const tBody0 = Date.now();
  const bodies = input.skipStepBodies
    ? { stepBodies: [], modelUsed: specRes.modelUsed, durationMs: 0 }
    : await fillStepBodies({ spec: specRes.spec, domain: input.domain });
  const bodiesMs = Date.now() - tBody0;

  // Stage 3 — template render
  const tRender0 = Date.now();
  const rendered = renderAgent({ spec: specRes.spec, stepBodies: bodies.stepBodies });
  const renderMs = Date.now() - tRender0;

  // Stage 4 — compile against the real project (overlay)
  const compileRes = await compile({
    files: [{ path: rendered.suggestedPath, content: rendered.content }],
    domain: input.domain,
  });

  return {
    spec: specRes.spec,
    code: { path: rendered.suggestedPath, content: rendered.content },
    compile: compileRes,
    timings: {
      specMs: specRes.durationMs,
      bodiesMs,
      renderMs,
      compileMs: compileRes.durationMs,
      totalMs: Date.now() - t0,
    },
    modelUsed: bodies.modelUsed,
  };
}
