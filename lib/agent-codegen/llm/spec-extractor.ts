// LLM Call A (Codegen v2) — given a human-completed AgentFormFields
// (identity / wire-up / behavior) plus a natural-language business
// description, ask the LLM to fill ONLY the steps[] array.
//
// The model never picks slug / displayName / stage / ownerTeam /
// triggerEvent / emitEvents / retries / errorHandling. Those decisions
// stay with the operator (the AgentConfigForm UI). This is the v2
// reframe — see docs/2026-05-25-codegen-use-cases.md.

import { z } from 'zod';
import {
  AgentSpecStepSchema,
  STEPS_ONLY_JSON_SCHEMA,
  type AgentFormFields,
  type AgentSpec,
  type AgentSpecStep,
} from '../spec-types';
import { getToolRegistry, type ToolRegistryEntry } from '../registries';
import { pickCodegenGateway, makeClient } from './gateway';
import { formatCanonicalForPrompt } from '../ontology/canonical-schemas';

export type GenerateStepsInput = {
  form: AgentFormFields;
  businessLogic: string;
  domain: 'raas' | 'r7';
};

export type GenerateStepsResult = {
  /** The full AgentSpec, assembled from form + LLM-emitted steps. */
  spec: AgentSpec;
  modelUsed: string;
  durationMs: number;
};

const StepsOnlySchema = z.object({
  steps: z.array(AgentSpecStepSchema).min(1).max(12),
});

export async function generateSteps(input: GenerateStepsInput): Promise<GenerateStepsResult> {
  const t0 = Date.now();
  const gateway = pickCodegenGateway();
  const client = makeClient(gateway);

  const tools = getToolRegistry(input.domain);
  const systemPrompt = buildSystemPrompt(input.form, tools);

  const completion = await client.chat.completions.create({
    model: gateway.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.businessLogic },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'submit_steps',
          description:
            'Submit the steps[] array for the agent under construction. Identity/wire-up come from the form, not from you.',
          parameters: STEPS_ONLY_JSON_SCHEMA,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'submit_steps' } },
  });

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    throw new Error('LLM did not return a tool call');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error('LLM tool call arguments were not valid JSON');
  }

  const parsed = StepsOnlySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'LLM-emitted steps failed schema validation: ' + JSON.stringify(parsed.error.issues),
    );
  }

  // Assemble the final AgentSpec from form fields + LLM-emitted steps.
  const spec: AgentSpec = {
    ...input.form,
    steps: parsed.data.steps as AgentSpecStep[],
  };

  return {
    spec,
    modelUsed: gateway.model,
    durationMs: Date.now() - t0,
  };
}

function buildSystemPrompt(
  form: AgentFormFields,
  tools: ReadonlyArray<ToolRegistryEntry>,
): string {
  const toolsBlock = tools.length
    ? tools
        .map((t) => {
          const head = `  - ${t.id} [${t.category}]\n      import { ${t.importName} } from '${t.importFrom}';\n      ${t.signature}\n      ${t.summary}`;
          // Bundle J — show canonical entity hint when relevant; helps the
          // LLM realize "this step writes Candidate" → it shapes the input
          // around canonical fields when proposing inputs/outputs.
          if (t.canonicalEntity) {
            return `${head}\n      → writes ontology entity "${t.canonicalEntity}" (canonical fields exposed at step-body fill time).`;
          }
          return head;
        })
        .join('\n')
    : '  (no tools registered for this domain — leave callsLib empty in each step)';

  return [
    'You are filling the steps[] array of an Inngest agent for the RAAS',
    'recruitment workflow. Identity, wire-up, and behavior settings are',
    'already decided by the operator (shown below) — do NOT change them,',
    'do NOT emit a different slug / stage / event / etc.',
    '',
    'Operator-fixed configuration:',
    `  slug:          ${form.slug}`,
    `  displayName:   ${form.displayName}`,
    `  stage:         ${form.stage}`,
    `  ownerTeam:     ${form.ownerTeam}`,
    `  triggerEvent:  ${form.triggerEvent}`,
    `  emitEvents:    [${form.emitEvents.join(', ')}]`,
    `  retries:       ${form.retries}`,
    `  errorHandling: ${form.errorHandling}`,
    '',
    'Tool registry — only these may appear in step.callsLib:',
    toolsBlock,
    '',
    'Hard rules:',
    '  1. Output ONLY a steps[] array via submit_steps. Never reply in prose.',
    '  2. Each step.id: kebab-case, unique within the spec.',
    '  3. 3-6 steps preferred, max 12.',
    '  4. callsLib: pick a registry id when a step calls one — otherwise omit.',
    '  5. Sequence steps so the last step emits the configured downstream event(s)',
    '     via the inngest.send tool (callsLib="inngest.send"), once per emitEvents entry.',
    '  6. Production agent shape: (a) fetch state from partner-pg, (b) mirror to',
    '     Allmeta Neo4j, (c) call RoboHire, (d) persist back to partner-pg,',
    '     (e) emit the configured downstream event. Follow this unless the',
    '     business description says otherwise.',
  ].join('\n');
}
