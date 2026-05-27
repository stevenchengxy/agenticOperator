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

  // Defensive coercion: LLMs (especially with non-English intents) sometimes
  // emit step ids that aren't kebab-case ASCII (Chinese, underscores, leading
  // digits). Slugify them rather than hard-fail the whole generation.
  const coerced = coerceDraftShape(raw);

  const parsed = AgentPromptDraftSchema.safeParse(coerced);
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

/** Slugify an LLM-proposed step id into the kebab-case ASCII the schema requires.
 *  Falls back to `step-N` when nothing usable remains (e.g. all-Chinese id). */
function slugifyStepId(s: unknown, index: number): string {
  const base = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, ''); // schema requires a leading letter
  return base || `step-${index + 1}`;
}

/** Normalize the raw LLM draft before Zod validation: coerce step ids to
 *  kebab-case and de-dupe. Pure; tolerant of malformed shapes. */
function coerceDraftShape(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.steps)) {
    const seen = new Set<string>();
    obj.steps = obj.steps.map((s, i) => {
      if (!s || typeof s !== 'object') return s;
      const step = s as Record<string, unknown>;
      let id = slugifyStepId(step.id, i);
      while (seen.has(id)) id = `${id}-${i + 1}`;
      seen.add(id);
      return { ...step, id };
    });
  }
  return obj;
}
