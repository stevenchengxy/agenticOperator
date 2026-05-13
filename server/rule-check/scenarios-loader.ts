// Server-friendly re-export of fixtures used by both the test-suite CLI and
// the /rule-check UI's API routes. Pulling from the same source keeps
// "seed data" and "expected outcomes" in lockstep.
import { SCENARIOS, SHARED_JDS, type ScenarioFixture } from '@/scripts/rule-check-test-suite/fixtures';

export type { ScenarioFixture };

export function loadScenarios(ids?: string[]): ScenarioFixture[] {
  if (!ids || ids.length === 0) return [...SCENARIOS];
  const set = new Set(ids);
  return SCENARIOS.filter((s) => set.has(s.id));
}

export function loadSharedJds(): ReadonlyArray<Record<string, unknown>> {
  return [...SHARED_JDS];
}
