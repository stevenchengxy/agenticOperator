// Domain → tool registry dispatch. Codegen LLM prompts are constructed
// against ONLY the current domain's registry, so generated R7 agents never
// reference RAAS libs and vice versa. See lib/domains.tsx for the scope.

import type { DomainId } from '@/lib/domains';
import { TOOL_REGISTRY_RAAS, type ToolRegistryEntry } from './tool-registry.raas';

const EMPTY: ReadonlyArray<ToolRegistryEntry> = [];

export function getToolRegistry(domain: DomainId): ReadonlyArray<ToolRegistryEntry> {
  switch (domain) {
    case 'raas':
      return TOOL_REGISTRY_RAAS;
    case 'r7':
      // R7 has no registered tools yet — codegen for R7 will return spec
      // with no callsLib, and step bodies stay as TODO until R7 onboarding.
      return EMPTY;
  }
}

export type { ToolRegistryEntry };
