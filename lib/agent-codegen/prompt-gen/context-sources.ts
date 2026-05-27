// context-sources.ts
// PromptGen data layer — STATIC. Reads the curated codegen event registry, the
// same source existing codegen uses (event-registry.raas.ts: "the auditable
// source of truth for now"). No DB / Neo4j query: generation is deterministic
// and reproducible. `payloadFields` is reserved for a future offline snapshot
// (spec Part 9); it is [] today.

import type { DomainId } from '@/lib/domains';
import { getEventRegistry } from '../registries';

export type EventPayloadField = { name: string; type: string; required: boolean };

export type EventContext = {
  name: string;
  stage: string;
  summary: string;
  direction: 'consume' | 'produce' | 'both';
  payloadFields: EventPayloadField[]; // [] until the offline snapshot lands (Part 9)
};

export function eventContexts(domain: DomainId): EventContext[] {
  return getEventRegistry(domain).map((e) => ({
    name: e.name,
    stage: e.stage,
    summary: e.summary,
    direction: e.direction,
    payloadFields: [],
  }));
}
