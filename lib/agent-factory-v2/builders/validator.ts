/**
 * validator.ts — Plan 4 Chunk C
 *
 * Static event-graph closure check for GeneratedAgentSpec[].
 * No LLM calls — pure deterministic validation.
 */

import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";

/** Regex for terminal-looking event names that are expected to have no consumers.
 *  Includes *_MISSING / *_ERROR (e.g. RESUME_INFO_MISSING, RESUME_PARSE_ERROR) —
 *  these are legitimate dead-end outcomes, not unwired mid-chain events. */
const TERMINAL_RE = /FAIL|SENT|GENERATED|CHECKED|CONFLICT|PASSED_NO|REJECTED|DONE|MISSING|ERROR/i;

export interface ValidationResult {
  ok: boolean;
  danglingEmits: string[];
  orphanTriggers: string[];
  emptyToolAgents: string[];
  slugCollisions: string[];
  issues: string[];
}

/**
 * Statically validate the event-graph closure of a set of GeneratedAgentSpec.
 *
 * - danglingEmits: events produced by agents but consumed by none, AND not
 *   terminal-looking (non-terminal dangling = likely wiring bug).
 * - orphanTriggers: events consumed by agents but produced by none (informational;
 *   some are legitimate entry points from the outside world).
 * - emptyToolAgents: specs with 0 tools (agents that would do no work).
 * - slugCollisions: duplicate slug values across specs.
 * - ok: true only when no danglingEmits, no emptyToolAgents, no slugCollisions.
 */
export function validateSpecs(specs: GeneratedAgentSpec[]): ValidationResult {
  const issues: string[] = [];

  // Collect all produced and consumed event names
  const produced = new Set<string>();
  const consumed = new Set<string>();

  for (const spec of specs) {
    for (const ev of spec.emit) {
      if (ev && ev !== "—") produced.add(ev);
    }
    for (const ev of spec.trigger) {
      if (ev && ev !== "—") consumed.add(ev);
    }
  }

  // danglingEmits: produced but not consumed AND not terminal-looking
  const danglingEmits: string[] = [];
  for (const ev of produced) {
    if (!consumed.has(ev) && !TERMINAL_RE.test(ev)) {
      danglingEmits.push(ev);
    }
  }

  // orphanTriggers: consumed but not produced (informational)
  const orphanTriggers: string[] = [];
  for (const ev of consumed) {
    if (!produced.has(ev)) {
      orphanTriggers.push(ev);
    }
  }

  // emptyToolAgents: specs with 0 tools
  const emptyToolAgents = specs
    .filter((s) => s.tools.length === 0)
    .map((s) => s.short || s.slug || s.key);

  // slugCollisions: duplicate slugs
  const slugCounts = new Map<string, number>();
  for (const spec of specs) {
    slugCounts.set(spec.slug, (slugCounts.get(spec.slug) ?? 0) + 1);
  }
  const slugCollisions = [...slugCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([slug]) => slug);

  // Build issues list
  if (danglingEmits.length > 0) {
    issues.push(`Dangling emits (non-terminal events with no consumer): ${danglingEmits.join(", ")}`);
  }
  if (orphanTriggers.length > 0) {
    issues.push(`Orphan triggers (events with no producer, may be external entry points): ${orphanTriggers.join(", ")}`);
  }
  if (emptyToolAgents.length > 0) {
    issues.push(`Agents with 0 tools (would do no work): ${emptyToolAgents.join(", ")}`);
  }
  if (slugCollisions.length > 0) {
    issues.push(`Duplicate slugs: ${slugCollisions.join(", ")}`);
  }

  const ok = danglingEmits.length === 0 && emptyToolAgents.length === 0 && slugCollisions.length === 0;

  return {
    ok,
    danglingEmits,
    orphanTriggers,
    emptyToolAgents,
    slugCollisions,
    issues,
  };
}
