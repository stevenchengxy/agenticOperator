// LLM Call B — given an AgentSpec, ask the LLM to fill the body of every
// step in one shot. Returns a StepBody[] keyed by step.id.
//
// One-shot rather than per-step (research doc §A.4 suggests per-step for
// parallel filling + smaller blast radius). One-shot is the MVP path:
//   - simpler, fewer round trips, fewer rate-limit collisions
//   - compiler (Phase 0c) is the ultimate validator so per-step retry isn't
//     needed for correctness — operator can hit "regenerate" if a step body
//     compiled bad
//
// Per-step parallelism can land as a Phase 1b2 optimization.

import type { AgentSpec } from '../spec-types';
import { getToolRegistry, type ToolRegistryEntry } from '../registries';
import type { DomainId } from '@/lib/domains';
import type { StepBody } from '../templates/render-agent';
import { pickCodegenGateway, makeClient } from './gateway';
import { pickFewShots, type FewShotEntry } from '../few-shot-index';

export type FillBodiesInput = {
  spec: AgentSpec;
  domain: DomainId;
};

export type FillBodiesResult = {
  stepBodies: StepBody[];
  modelUsed: string;
  durationMs: number;
};

// Function-call schema for the LLM output. Strict: every step listed in spec
// must appear in the returned `steps` array.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'body'],
        properties: {
          id: { type: 'string' },
          body: {
            type: 'string',
            description:
              "TS source for the step.run callback body, no outer braces. Use 'event', 'logger', and outputs from earlier steps. Prefer single async/await chains.",
          },
          imports: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['from', 'names'],
              properties: {
                from: { type: 'string' },
                names: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
} as const;

export async function fillStepBodies(input: FillBodiesInput): Promise<FillBodiesResult> {
  const t0 = Date.now();
  const gateway = pickCodegenGateway();
  const client = makeClient(gateway);

  const registry = getToolRegistry(input.domain);
  const systemPrompt = buildSystemPrompt(input.spec, registry);

  const completion = await client.chat.completions.create({
    model: gateway.model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          'Emit the step bodies as a tool call. One entry per step in the spec, in order.',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'submit_step_bodies',
          description: 'Submit per-step TypeScript bodies for the agent under construction.',
          parameters: SCHEMA,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'submit_step_bodies' } },
  });

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    throw new Error('LLM did not return a tool call for step bodies');
  }

  let parsed: { steps?: Array<{ id: string; body: string; imports?: StepBody['imports'] }> };
  try {
    parsed = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error('LLM step-body arguments were not valid JSON');
  }

  if (!Array.isArray(parsed.steps)) {
    throw new Error('LLM step-body response missing `steps` array');
  }

  // Keep only steps that match the spec (defense in depth against the LLM
  // inventing IDs).
  const specIds = new Set(input.spec.steps.map((s) => s.id));
  const stepBodies: StepBody[] = parsed.steps
    .filter((s) => specIds.has(s.id))
    .map((s) => ({ id: s.id, body: s.body, imports: s.imports }));

  return {
    stepBodies,
    modelUsed: gateway.model,
    durationMs: Date.now() - t0,
  };
}

function buildSystemPrompt(
  spec: AgentSpec,
  registry: ReadonlyArray<ToolRegistryEntry>,
): string {
  const toolsBlock = registry.length
    ? registry
        .map(
          (t) =>
            `  - ${t.id}\n      import { ${t.importName} } from '${t.importFrom}';\n      ${t.signature}\n      ${t.summary}`,
        )
        .join('\n')
    : '  (no tools registered — bodies should be minimal and may return null)';

  const stepsBlock = spec.steps
    .map(
      (s, i) =>
        `  ${i + 1}. id=${s.id} ${s.callsLib ? `(hint: ${s.callsLib})` : ''}\n      desc: ${s.description}\n      inputs: ${(s.inputs ?? []).join(', ') || '(none)'}\n      outputs: ${(s.outputs ?? []).join(', ') || '(none)'}`,
    )
    .join('\n');

  // Retrieve few-shots that match this spec's stage + the tools actually used.
  // The model sees real production-agent step bodies as the idiomatic template
  // for try/catch around RoboHire, NonRetriableError on 4xx, return-shape, etc.
  const callsLibs = spec.steps
    .map((s) => s.callsLib)
    .filter((x): x is string => !!x);
  const shots = pickFewShots({
    stage: spec.stage,
    toolIds: callsLibs,
    topN: 3,
  });
  const fewShotBlock = shots.length
    ? shots.map((s) => renderFewShot(s)).join('\n\n')
    : '(no few-shot examples available for this stage)';

  return [
    'You are filling step.run callback bodies for an Inngest agent.',
    '',
    'Hard rules:',
    '  - Output body = code INSIDE the async () => { ... } callback, no outer braces.',
    '  - Use `event` (Inngest event payload), `logger`, and any earlier step outputs.',
    '  - Only import from the tool registry below; never invent paths.',
    '  - Wrap external HTTP calls in try/catch; throw NonRetriableError for 4xx errors.',
    '  - Always log a useful one-liner on success via logger.info.',
    '  - Always return something so downstream steps can read the value.',
    '  - If a step has no clean tool match, return null with a TODO comment.',
    '',
    'Tool registry:',
    toolsBlock,
    '',
    'Few-shot examples from production agents (study these patterns):',
    fewShotBlock,
    '',
    `Agent under construction: ${spec.slug} — ${spec.displayName}`,
    `Trigger: ${spec.triggerEvent}    Emits: ${spec.emitEvents.join(', ') || '(none)'}`,
    '',
    'Steps to fill:',
    stepsBlock,
  ].join('\n');
}

function renderFewShot(s: FewShotEntry): string {
  return [
    `--- ${s.source} · step "${s.stepName}" (tools: ${s.toolIds.join(', ')})`,
    '```ts',
    s.body,
    '```',
  ].join('\n');
}
