/**
 * smoke.ts — Plan 3
 *
 * Simulates the agent chain defined by a GeneratedAgentSpec[] to detect:
 *  - unreached agents (no entry path)
 *  - dangling emits (events produced by no consumer and not a clear terminal)
 *  - tool execution errors (via dry-run execute calls)
 *
 * Does NOT call the LLM. Pure graph traversal + dry-run tool execution.
 */

import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import type { ToolRegistry } from "@/lib/tools/registry";

export interface SmokeResult {
  passed: boolean;
  /** short names of agents that were reached and simulated */
  ranAgents: string[];
  /** emitted events that had no consumer (legitimate chain endpoints) */
  reachedTerminals: string[];
  /** emitted events that had no consumer but look like mid-chain (suspicious) */
  dangling: string[];
  /** short names of agents that were never reached from any entry point */
  unreached: string[];
  errors: { agent: string; error: string }[];
}

/** Events matching this pattern are accepted as legitimate terminals (no consumer
 *  needed). Includes *_MISSING / *_ERROR dead-end outcomes (kept in sync with the
 *  validator's TERMINAL_RE). */
const TERMINAL_RE = /FAIL|FAILED|SENT|GENERATED|CHECKED|CONFLICT|DONE|PASSED_NO|REJECTED|MISSING|ERROR/i;

const MAX_HOPS = 64;

export async function simulateChain(
  specs: GeneratedAgentSpec[],
  registry: ToolRegistry,
  opts?: { dryRun?: boolean },
): Promise<SmokeResult> {
  const dryRun = opts?.dryRun !== false; // default true

  // Build lookup maps
  // triggerMap: event name → specs that are triggered by it
  const triggerMap = new Map<string, GeneratedAgentSpec[]>();
  // allEmittedEvents: union of every event any spec emits (excluding "—")
  const allEmittedEvents = new Set<string>();

  for (const spec of specs) {
    for (const ev of spec.emit) {
      if (ev && ev !== "—") allEmittedEvents.add(ev);
    }
    for (const ev of spec.trigger) {
      if (!ev) continue;
      if (!triggerMap.has(ev)) triggerMap.set(ev, []);
      triggerMap.get(ev)!.push(spec);
    }
  }

  // Entry events: events consumed by some spec but NOT emitted by any spec
  const entryEvents = new Set<string>();
  for (const [ev] of triggerMap) {
    if (!allEmittedEvents.has(ev)) entryEvents.add(ev);
  }

  // BFS
  const ranSet = new Set<string>(); // spec.short values
  const visitedEvents = new Set<string>();
  const reachedTerminals = new Set<string>();
  const errors: { agent: string; error: string }[] = [];

  const queue: string[] = [...entryEvents];
  let hops = 0;

  while (queue.length > 0 && hops < MAX_HOPS) {
    const ev = queue.shift()!;
    if (visitedEvents.has(ev)) continue;
    visitedEvents.add(ev);
    hops++;

    const triggered = triggerMap.get(ev) ?? [];
    for (const spec of triggered) {
      if (ranSet.has(spec.short)) continue;
      ranSet.add(spec.short);

      // Execute each step's tool (dry-run)
      for (const step of spec.steps) {
        if (!step.tool) continue;
        const td = registry.get(step.tool);
        if (td?.execute) {
          try {
            await td.execute({}, { dryRun, traceId: "smoke" });
          } catch (err) {
            errors.push({
              agent: spec.short,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Enqueue emitted events
      for (const emittedEv of spec.emit) {
        if (!emittedEv || emittedEv === "—") continue;
        if (triggerMap.has(emittedEv)) {
          // Some spec consumes it → enqueue
          queue.push(emittedEv);
        } else {
          // No consumer → terminal
          reachedTerminals.add(emittedEv);
        }
      }
    }
  }

  // Dangling: emitted events with no consumer that are NOT legit terminals
  const dangling: string[] = [];
  for (const ev of reachedTerminals) {
    if (!TERMINAL_RE.test(ev)) {
      dangling.push(ev);
    }
  }

  // Unreached: specs never ran
  const unreached = specs.filter((s) => !ranSet.has(s.short)).map((s) => s.short);

  const ranAgents = [...ranSet];
  const reachedTerminalList = [...reachedTerminals];

  const passed =
    errors.length === 0 &&
    unreached.length === 0 &&
    reachedTerminalList.length > 0;

  return {
    passed,
    ranAgents,
    reachedTerminals: reachedTerminalList,
    dangling,
    unreached,
    errors,
  };
}
