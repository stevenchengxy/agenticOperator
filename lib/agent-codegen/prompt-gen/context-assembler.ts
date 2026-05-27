// context-assembler.ts
// Renders a SelectedContext (+ locked fields) into the PromptGen system prompt.
// Pure string assembly; the only "intelligence" is layout + the hard rules that
// keep the LLM grounded in real events/tools and respectful of locked fields.

import type { AgentFormFields } from '../spec-types';
import type { SelectedContext } from './context-select';

export function assembleSystemPrompt(args: {
  selected: SelectedContext;
  locked: Partial<AgentFormFields>;
}): string {
  const { selected, locked } = args;

  const eventsBlock = selected.events.length
    ? selected.events
        .map((e) => {
          const fields = e.payloadFields.length
            ? `\n      payload: ${e.payloadFields.map((f: { name: string; type: string; required: boolean }) => `${f.name}:${f.type}${f.required ? '!' : ''}`).join(', ')}`
            : '';
          return `  - ${e.name} [${e.stage}] — ${e.summary}${fields}`;
        })
        .join('\n')
    : '  (no events available)';

  const toolsBlock = selected.tools.length
    ? selected.tools
        .map((t) => `  - ${t.id} [${t.category}] — ${t.summary}${t.canonicalEntity ? ` (writes ${t.canonicalEntity})` : ''}`)
        .join('\n')
    : '  (no tools available)';

  const entitiesBlock = selected.entities.length
    ? selected.entities.map((e) => `  - ${e.name}: ${e.fields.map((f: { name: string }) => f.name).slice(0, 12).join(', ')}`).join('\n')
    : '  (no entities relevant)';

  const blueprintBlock = selected.blueprint
    ? `Blueprint agent (${selected.blueprint.slug}, stage ${selected.blueprint.stage}) — imitate its shape/idioms:\n${selected.blueprint.source.slice(0, 2000)}`
    : '(no blueprint selected)';

  const lockedEntries = Object.entries(locked).filter(([, v]) => v != null && (!Array.isArray(v) || v.length > 0));
  const lockedBlock = lockedEntries.length
    ? lockedEntries.map(([k, v]) => `  - ${k} = ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)} (LOCKED — treat as a hard constraint, do not change)`).join('\n')
    : '  (no locked fields — you may propose all of trigger/stage/emits, but the operator must confirm them)';

  return [
    'You are PromptGen for the RAAS recruitment workflow. Produce a structured,',
    'human-readable Agent Prompt (via the submit_agent_prompt tool) describing ONE',
    'Inngest workflow agent: what it does, what it reads, its ordered steps, the',
    'tools it uses, and what it emits. You write the PROMPT, not the code — a',
    'downstream step decomposes it into executable steps and another writes the TS.',
    '',
    'Event surface (static registry) — only reference these event names:',
    eventsBlock,
    '',
    'Tool surface — only reference these tool ids in steps[].usesTools:',
    toolsBlock,
    '',
    'Ontology entities the relevant tools write (use canonical field names):',
    entitiesBlock,
    '',
    blueprintBlock,
    '',
    'Operator constraints:',
    lockedBlock,
    '',
    'Hard rules:',
    '  1. Output ONLY via submit_agent_prompt. Never reply in prose.',
    '  2. trigger.event and every emits[] entry MUST be from the event surface above.',
    '  3. Every steps[].usesTools entry MUST be a tool id from the tool surface.',
    '  4. Respect LOCKED fields exactly. Do NOT invent a slug — that is the operator\'s.',
    '  5. Encode the dual-write contract (Postgres then Neo4j) + idempotency in constraints[].',
    '  6. acceptance[] must state observable success (e.g. "emits exactly one downstream event").',
    '  7. 3-6 steps preferred, max 12.',
  ].join('\n');
}
