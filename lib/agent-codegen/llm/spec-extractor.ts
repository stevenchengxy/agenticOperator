// LLM Call A — natural-language prompt → AgentSpec JSON.
//
// Uses OpenAI-compatible function calling for structured output. The function
// schema doubles as a hard constraint (model can't return free-form text)
// and as the runtime contract — output is re-validated through Zod after
// parsing in case the model violates the schema anyway.

import { AGENT_SPEC_JSON_SCHEMA, AgentSpecSchema, type AgentSpec } from '../spec-types';
import {
  getToolRegistry,
  getEventRegistry,
  type ToolRegistryEntry,
  type EventRegistryEntry,
} from '../registries';
import type { DomainId } from '@/lib/domains';
import { pickCodegenGateway, makeClient } from './gateway';

export type ExtractSpecInput = {
  prompt: string;
  domain: DomainId;
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

  const tools = getToolRegistry(input.domain);
  const events = getEventRegistry(input.domain);
  const systemPrompt = buildSystemPrompt(tools, events);

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
  tools: ReadonlyArray<ToolRegistryEntry>,
  events: ReadonlyArray<EventRegistryEntry>,
): string {
  const toolsBlock = tools.length
    ? tools
        .map(
          (t) =>
            `  - ${t.id} [${t.category}]\n      import { ${t.importName} } from '${t.importFrom}';\n      ${t.signature}\n      ${t.summary}`,
        )
        .join('\n')
    : '  (no tools registered for this domain — leave callsLib empty in each step)';

  const eventsBlock = events.length
    ? events
        .map((e) => `  - ${e.name} (${e.stage}, ${e.direction})  — ${e.summary}`)
        .join('\n')
    : '  (no event registry — pick reasonable past-tense names, e.g. RESUME_PROCESSED)';

  return [
    'You are an Agentic Operator agent designer for the RAAS recruitment',
    'workflow. Given a natural-language business description, emit a single',
    'AgentSpec by calling submit_agent_spec. Never reply in prose; always',
    'use the tool.',
    '',
    'Tool registry — only these may appear in step.callsLib:',
    toolsBlock,
    '',
    'Event registry — triggerEvent MUST be one of these names, and every',
    'emitEvents entry MUST also be from this list:',
    eventsBlock,
    '',
    'Hard rules:',
    '  1. slug: kebab-case ending in "-agent" (e.g. "salary-checker-agent").',
    '  2. stage: one of system, requirement, jd, resume, match, interview, eval, package, submit.',
    '  3. Each step.id: kebab-case, unique within spec.',
    '  4. 3-6 steps preferred, max 12.',
    '  5. callsLib: pick a registry id when the step calls one — otherwise omit.',
    '  6. triggerEvent + emitEvents: NEVER invent names; pick from the event registry.',
    '  7. Pattern hint: production agents typically (a) fetch state from partner-pg,',
    '     (b) mirror to Allmeta Neo4j, (c) call RoboHire, (d) persist back to partner-pg,',
    '     (e) emit the downstream event. Follow this shape unless the prompt says otherwise.',
  ].join('\n');
}
