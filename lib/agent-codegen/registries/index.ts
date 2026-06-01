// Domain → tool / event registry dispatch. Codegen LLM prompts are
// constructed against ONLY the current domain's registries, so generated
// R7 agents never reference RAAS libs / events and vice versa.
// See lib/domains.tsx for the scope.

import type { DomainId } from '@/lib/domains';
import { TOOL_REGISTRY_RAAS, type ToolRegistryEntry } from './tool-registry.raas';
import { EVENT_REGISTRY_RAAS, type EventRegistryEntry } from './event-registry.raas';

const EMPTY_TOOLS: ReadonlyArray<ToolRegistryEntry> = [];
const EMPTY_EVENTS: ReadonlyArray<EventRegistryEntry> = [];

export function getToolRegistry(domain: DomainId): ReadonlyArray<ToolRegistryEntry> {
  // Phase 0 (2026-06-01): DomainId widened to string for user-extensible
  // domains. raas keeps its built-in registry; everything else (r7 + any
  // user-created domain) returns the empty set, so codegen falls back to
  // TODO bodies until that domain's registry is wired in (Phase 1 chore).
  if (domain === 'raas') return TOOL_REGISTRY_RAAS;
  return EMPTY_TOOLS;
}

export function getEventRegistry(domain: DomainId): ReadonlyArray<EventRegistryEntry> {
  if (domain === 'raas') return EVENT_REGISTRY_RAAS;
  return EMPTY_EVENTS;
}

export type { ToolRegistryEntry, EventRegistryEntry };
