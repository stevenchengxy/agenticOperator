// End-to-end codegen pipeline — Codegen v2 (form-first).
//
//   form (operator-completed) + businessLogic (operator prose) + domain
//     ↓ generateSteps()           — LLM Call A (steps[] only, ~70% smaller schema)
//   AgentSpec (form + LLM steps)
//     ↓ fillStepBodies()          — LLM Call B (one-shot, all step.run bodies)
//   StepBody[]
//     ↓ renderAgent()             — deterministic string template
//   { suggestedPath, content }
//     ↓ compile()                 — Phase 0c in-process TS overlay typecheck
//   CompileResult
//
// Output bundles everything so the UI can populate Spec / Code / Diff tabs
// and the right-rail compiler panel from one POST.

import type { DomainId } from '@/lib/domains';
import { generateSteps } from './llm/spec-extractor';
import { fillStepBodies } from './llm/step-body-filler';
import { renderAgent } from './templates/render-agent';
import { compile } from './compiler/compile';
import type { AgentFormFields, AgentSpec } from './spec-types';
import type { CompileResult } from './compiler/types';

export type RunPipelineInput = {
  form: AgentFormFields;
  businessLogic: string;
  domain: DomainId;
  /** Skip LLM Call B and emit TODO placeholder bodies. Faster preview;
   *  the Code tab still renders and compiles (TODO branches `return null`). */
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

  // Stage 1 — LLM generates steps[]; pipeline assembles full AgentSpec.
  const stepsRes = await generateSteps({
    form: input.form,
    businessLogic: input.businessLogic,
    domain: input.domain,
  });

  // Stage 2 — step body fill (optional)
  const tBody0 = Date.now();
  const bodies = input.skipStepBodies
    ? { stepBodies: [], modelUsed: stepsRes.modelUsed, durationMs: 0 }
    : await fillStepBodies({ spec: stepsRes.spec, domain: input.domain });
  const bodiesMs = Date.now() - tBody0;

  // Stage 3 — template render
  const tRender0 = Date.now();
  const rendered = renderAgent({ spec: stepsRes.spec, stepBodies: bodies.stepBodies });
  const renderMs = Date.now() - tRender0;

  // Stage 4 — compile against the real project (overlay)
  const compileRes = await compile({
    files: [{ path: rendered.suggestedPath, content: rendered.content }],
    domain: input.domain,
  });

  return {
    spec: stepsRes.spec,
    code: { path: rendered.suggestedPath, content: rendered.content },
    compile: compileRes,
    timings: {
      specMs: stepsRes.durationMs,
      bodiesMs,
      renderMs,
      compileMs: compileRes.durationMs,
      totalMs: Date.now() - t0,
    },
    modelUsed: bodies.modelUsed,
  };
}
