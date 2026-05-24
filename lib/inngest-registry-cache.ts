// Tiny module — holds the last cached registry snapshot in module-scope
// so sync helpers in lib/agent-mapping.ts can read it without importing
// lib/inngest-registry.ts (which would create a cycle via AGENT_MAP).
//
// Per plan 2026-05-25 Task 3.

import type { LiveRegistryEntry } from '@/lib/inngest-registry';

let snapshot: LiveRegistryEntry[] = [];

export function __getCachedRegistrySnapshotSync(): LiveRegistryEntry[] {
  return snapshot;
}

export function __setCachedRegistrySnapshot(entries: LiveRegistryEntry[]): void {
  snapshot = entries;
}
