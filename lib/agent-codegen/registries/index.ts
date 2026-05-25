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
  switch (domain) {
    case 'raas':
      return TOOL_REGISTRY_RAAS;
    case 'r7':
      // R7 has no registered tools yet — codegen for R7 will return spec
      // with no callsLib, and step bodies stay as TODO until R7 onboarding.
      return EMPTY_TOOLS;
  }
}

export function getEventRegistry(domain: DomainId): ReadonlyArray<EventRegistryEntry> {
  switch (domain) {
    case 'raas':
      return EVENT_REGISTRY_RAAS;
    case 'r7':
      return EMPTY_EVENTS;
  }
}

export type { ToolRegistryEntry, EventRegistryEntry };
