// context-select.ts
// Heuristic context selection: trims the full domain surface to a relevant,
// token-bounded subset given operator intent + locked fields. Pure & explainable.
// (Embedding/RAG retrieval is a phase-2 upgrade, only if this proves imprecise.)

import type { AgentFormFields } from '../spec-types';
import type { EventContext } from './context-sources';
import type { ToolRegistryEntry } from '../registries';
import type { CanonicalEntity } from '../ontology/canonical-schemas';

export type AgentExemplar = {
  slug: string;
  stage: string;
  triggerEvent: string;
  emitEvents: string[];
  source: string;
};

export type SelectContextInput = {
  intent: string;
  locked: Partial<AgentFormFields>;
  events: EventContext[];
  tools: ReadonlyArray<ToolRegistryEntry>;
  entities: ReadonlyArray<CanonicalEntity>;
  agents: AgentExemplar[];
  blueprintSlug?: string;
};

export type SelectedContext = {
  events: EventContext[];
  tools: ToolRegistryEntry[];
  entities: CanonicalEntity[];
  blueprint: AgentExemplar | null;
};

const MAX_EVENTS = 12;
const MAX_TOOLS = 16;

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

export function selectContext(input: SelectContextInput): SelectedContext {
  const { intent, locked, events, tools, entities, agents, blueprintSlug } = input;

  // ── events ──────────────────────────────────────────────────────────────
  let selectedEvents: EventContext[];
  const lockedNames = new Set<string>(
    [locked.triggerEvent, ...(locked.emitEvents ?? [])].filter(Boolean) as string[],
  );
  if (lockedNames.size > 0) {
    // locked events + same-stage neighbors (topological proximity via stage)
    const lockedStages = new Set(events.filter((e) => lockedNames.has(e.name)).map((e) => e.stage));
    selectedEvents = events.filter(
      (e) => lockedNames.has(e.name) || lockedStages.has(e.stage),
    );
  } else {
    // rank by keyword overlap of (name + summary) with the intent
    const intentTokens = new Set(tokens(intent));
    selectedEvents = [...events]
      .map((e) => {
        const et = tokens(`${e.name} ${e.summary} ${e.stage}`);
        const score = et.filter((w) => intentTokens.has(w)).length;
        return { e, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.e);
    // keep top MAX_EVENTS
    const positives = selectedEvents.filter((_, i) => i < MAX_EVENTS);
    selectedEvents = positives;
  }
  if (locked.stage) {
    const inStage = selectedEvents.filter((e) => e.stage === locked.stage);
    if (inStage.length > 0) selectedEvents = [...inStage, ...selectedEvents.filter((e) => e.stage !== locked.stage)];
  }
  selectedEvents = selectedEvents.slice(0, MAX_EVENTS);

  // ── tools ───────────────────────────────────────────────────────────────
  // Heuristic: include all registry tools (registry is small & curated), but
  // rank by intent keyword overlap so the prompt leads with the relevant ones.
  const intentTokens = new Set(tokens(intent));
  const selectedTools = [...tools]
    .map((tEntry) => {
      const tt = tokens(`${tEntry.id} ${tEntry.summary} ${tEntry.category}`);
      const score = tt.filter((w) => intentTokens.has(w)).length;
      return { tEntry, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TOOLS)
    .map((x) => x.tEntry);

  // ── entities ── only those written by a selected tool ─────────────────────
  const writtenEntities = new Set(
    selectedTools.map((tEntry) => tEntry.canonicalEntity).filter(Boolean) as string[],
  );
  const selectedEntities = entities.filter((e) => writtenEntities.has(e.name));

  // ── blueprint ─────────────────────────────────────────────────────────────
  let blueprint: AgentExemplar | null = null;
  if (blueprintSlug) {
    blueprint = agents.find((a) => a.slug === blueprintSlug) ?? null;
  } else if (locked.stage) {
    blueprint = agents.find((a) => a.stage === locked.stage) ?? null;
  } else if (locked.triggerEvent) {
    blueprint = agents.find((a) => a.triggerEvent === locked.triggerEvent) ?? null;
  }

  return { events: selectedEvents, tools: selectedTools, entities: selectedEntities, blueprint };
}
