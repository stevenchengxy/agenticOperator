// prompt-gen.ts
// PromptGen LLM call: intent + locked fields → structured AgentPrompt.
// Mirrors spec-extractor.ts: gateway → tool_choice function → JSON.parse → Zod safeParse.
// Uses static eventContexts (synchronous), no live DB / Neo4j query.

import { pickPromptGenGateway, makeClient } from '../llm/gateway';
import { getToolRegistry } from '../registries';
import { CANONICAL_ENTITIES } from '../ontology/canonical-schemas';
import type { DomainId } from '@/lib/domains';
import type { AgentFormFields } from '../spec-types';
import {
  AgentPromptDraftSchema,
  AGENT_PROMPT_DRAFT_JSON_SCHEMA,
  type AgentPrompt,
  type FieldOrigin,
} from './prompt-types';
import { eventContexts } from './context-sources';
import { selectContext } from './context-select';
import { assembleSystemPrompt } from './context-assembler';
import { loadAgentExemplars } from './agent-exemplars';

export type GenerateAgentPromptInput = {
  intent: string;
  locked: Partial<AgentFormFields>;
  domain: DomainId;
  blueprintSlug?: string;
};

export type GenerateAgentPromptResult = {
  prompt: AgentPrompt;
  modelUsed: string;
  missingTools: string[];
  durationMs: number;
};

export async function generateAgentPrompt(
  input: GenerateAgentPromptInput,
): Promise<GenerateAgentPromptResult> {
  const t0 = Date.now();

  // Static event contexts — synchronous, no DB query
  const events = eventContexts(input.domain);

  const selected = selectContext({
    intent: input.intent,
    locked: input.locked,
    events,
    tools: getToolRegistry(input.domain),
    entities: CANONICAL_ENTITIES,
    agents: loadAgentExemplars(),
    blueprintSlug: input.blueprintSlug,
  });

  const systemPrompt = assembleSystemPrompt({ selected, locked: input.locked });

  const gateway = pickPromptGenGateway();
  const client = makeClient(gateway);
  const completion = await client.chat.completions.create({
    model: gateway.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.intent },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'submit_agent_prompt',
          description: 'Submit the structured Agent Prompt.',
          parameters: AGENT_PROMPT_DRAFT_JSON_SCHEMA,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'submit_agent_prompt' } },
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

  const parsed = AgentPromptDraftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'PromptGen output failed schema validation: ' + JSON.stringify(parsed.error.issues),
    );
  }

  // Provenance: locked fields → 'locked', everything LLM proposed → 'inferred'
  const lockedKeys = new Set(
    Object.keys(input.locked).filter(
      (k) => (input.locked as Record<string, unknown>)[k] != null,
    ),
  );
  const fieldOrigin: Record<string, FieldOrigin> = {};
  for (const key of ['triggerEvent', 'stage', 'emitEvents', 'slug', 'displayName', 'ownerTeam']) {
    fieldOrigin[key] = lockedKeys.has(key) ? 'locked' : 'inferred';
  }

  const prompt: AgentPrompt = {
    ...parsed.data,
    trigger: { ...parsed.data.trigger, confirmed: false },
    fieldOrigin,
  };

  // Tool-gap protocol: flag any tool in the prompt not found in the registry
  const registryIds = new Set(getToolRegistry(input.domain).map((t) => t.id));
  const missingTools = prompt.tools.filter((t) => !registryIds.has(t));

  return {
    prompt,
    modelUsed: gateway.model,
    missingTools,
    durationMs: Date.now() - t0,
  };
}
