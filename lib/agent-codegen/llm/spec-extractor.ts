// LLM Call A — natural-language prompt → AgentSpec JSON.
//
// Uses OpenAI-compatible function calling for structured output. The function
// schema doubles as a hard constraint (model can't return free-form text)
// and as the runtime contract — output is re-validated through Zod after
// parsing in case the model violates the schema anyway.

import { AGENT_SPEC_JSON_SCHEMA, AgentSpecSchema, type AgentSpec } from '../spec-types';
import { getToolRegistry, type ToolRegistryEntry } from '../registries';
import type { DomainId } from '@/lib/domains';
import { pickCodegenGateway, makeClient } from './gateway';

export type ExtractSpecInput = {
  prompt: string;
  domain: DomainId;
  /** Optional known-good event names for the prompt (when not given the LLM
   *  may invent ones). Phase 1b stub passes an empty list; later we plumb
   *  in EventDefinition rows. */
  knownEvents?: string[];
};

export type ExtractSpecResult = {
  spec: AgentSpec;
  modelUsed: string;
  durationMs: number;
};

export async function extractSpec(input: ExtractSpecInput): Promise<ExtractSpecResult> {
  const t0 = Date.now();
  const gateway = pickCodegenGateway();
  const client = makeClient(gateway);

  const registry = getToolRegistry(input.domain);
  const systemPrompt = buildSystemPrompt(registry, input.knownEvents ?? []);

  const completion = await client.chat.completions.create({
    model: gateway.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.prompt },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'submit_agent_spec',
          description: 'Submit the final AgentSpec for the agent to be generated.',
          parameters: AGENT_SPEC_JSON_SCHEMA,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'submit_agent_spec' } },
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

  const parsed = AgentSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'LLM-emitted spec failed schema validation: ' + JSON.stringify(parsed.error.issues),
    );
  }

  return {
    spec: parsed.data,
    modelUsed: gateway.model,
    durationMs: Date.now() - t0,
  };
}

function buildSystemPrompt(
  registry: ReadonlyArray<ToolRegistryEntry>,
  knownEvents: string[],
): string {
  const toolsBlock = registry.length
    ? registry
        .map((t) => `  - ${t.id}\n      import { ${t.importName} } from '${t.importFrom}';\n      ${t.signature}\n      ${t.summary}`)
        .join('\n')
    : '  (no tools registered for this domain — leave callsLib empty in each step)';

  const eventsBlock = knownEvents.length
    ? knownEvents.map((e) => `  - ${e}`).join('\n')
    : '  (no event list provided — pick reasonable names ending in past tense, e.g. RESUME_PROCESSED)';

  return [
    'You are an Agentic Operator agent designer. Given a natural-language',
    'business description, emit a single AgentSpec by calling submit_agent_spec.',
    'Never reply in prose; always use the tool.',
    '',
    'Tool registry (only these libs may appear in step.callsLib):',
    toolsBlock,
    '',
    'Known event names (use one as triggerEvent; emitEvents must be reasonable):',
    eventsBlock,
    '',
    'Rules:',
    '  1. slug must be kebab-case, end in "-agent".',
    '  2. stage must be one of: system, requirement, jd, resume, match, interview, eval, package, submit.',
    '  3. Each step.id must be kebab-case and unique within the spec.',
    '  4. Prefer 3-6 steps; never exceed 12.',
    '  5. If a step needs to call a registered tool, set callsLib to that id; otherwise leave it null.',
  ].join('\n');
}
