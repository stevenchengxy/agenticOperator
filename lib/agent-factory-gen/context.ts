// Shared generation context — the blackboard passed through the pipeline so each
// agent's generation can see the others (to wire events / detect closure). This
// is the "上下文共享信息" the factory needs to produce a coherent agent graph
// instead of N independent agents.

import fs from "node:fs";
import path from "node:path";
import { fetchRunnableOntology, type DomainOntology, type OntologyAction } from "@/lib/ontology-generator/ontology-source";
import type { ToolRegistry } from "@/lib/tools/registry";
import { resolveRegistry } from "@/lib/tools/resolve-registry";
import type { GeneratedAgentSpec, GenEvent, GenEventSink } from "./types";

export interface GenerationContext {
  domainId: string;
  /** ontology read from Neo4j (Allmeta) first, in-repo snapshot fallback */
  ontology: DomainOntology;
  registry: ToolRegistry;
  /** accumulated specs — grows as the pipeline runs (the shared blackboard) */
  specs: GeneratedAgentSpec[];
  /** event name -> actions that emit it */
  producers: Map<string, string[]>;
  /** event name -> actions that consume it */
  consumers: Map<string, string[]>;
  /** events with an external producer (workflow entry points) */
  entryEvents: Set<string>;
  /** events that legitimately terminate (no internal consumer expected) */
  terminalEvents: Set<string>;
  log: string[];
  /** streams the factory's internal reasoning live (no-op when not streaming) */
  emit: GenEventSink;
  /** small human-perceptible delay between streamed steps (0 = instant, for tests) */
  pace: () => Promise<void>;
}

function push(map: Map<string, string[]>, key: string, val: string) {
  const arr = map.get(key) ?? [];
  arr.push(val);
  map.set(key, arr);
}

/** Read entry/terminal event lists from the snapshot's workflow.json metadata.
 *  loadSnapshotWorkflow drops the envelope, so we read it raw here. Returns {}
 *  for live-only domains (no snapshot) — closure then relies on event producers. */
function readWorkflowMeta(domainId: string): { entry_events?: string[]; terminal_events?: string[] } {
  try {
    const p = path.join(process.cwd(), "lib", "ontology-generator", "snapshots", domainId, "workflow.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { metadata?: { entry_events?: string[]; terminal_events?: string[] } };
    return raw.metadata ?? {};
  } catch {
    return {};
  }
}

export function isAgentAction(a: OntologyAction): boolean {
  return (a.actor ?? []).some((x) => String(x).toLowerCase() === "agent");
}

/** 3-way action role. Unlike isAgentAction's all-or-nothing filter, this keeps
 *  Human-actor actions (as "hitl") instead of dropping them — so domains with
 *  human-in-the-loop gates (energy / 费控) don't lose their HITL steps during
 *  generation. "agent" → an LLM agent; "hitl" → a human-decision gate; "other"
 *  → system/automated steps the factory doesn't generate an agent for. */
export type ActionRole = "agent" | "hitl" | "other";

export function actionRole(a: OntologyAction): ActionRole {
  const actors = (a.actor ?? []).map((x) => String(x).toLowerCase());
  if (actors.some((x) => x === "agent")) return "agent";
  if (actors.some((x) => x === "human" || x.includes("人"))) return "hitl";
  return "other";
}

export function isHitlAction(a: OntologyAction): boolean {
  return actionRole(a) === "hitl";
}

export async function buildContext(domainId: string, registry?: ToolRegistry, onEvent?: GenEventSink, paceMs = 0): Promise<GenerationContext> {
  const ontology = await fetchRunnableOntology(domainId);
  // Resolve the per-domain tool registry from the ontology we just read
  // (recruitment → hand-coded library; other domains → declared/generic). An
  // explicit registry (tests) overrides.
  const reg = registry ?? resolveRegistry(domainId, ontology);
  const meta = readWorkflowMeta(domainId);

  const producers = new Map<string, string[]>();
  const consumers = new Map<string, string[]>();
  for (const a of ontology.actions) {
    for (const e of a.triggered_event ?? []) push(producers, e, a.name);
    for (const e of a.trigger ?? []) push(consumers, e, a.name);
  }

  // entry = declared entries ∪ events whose payload has no source_action (external producer)
  const entryEvents = new Set<string>(meta.entry_events ?? []);
  for (const ev of ontology.events) {
    if (!ev.payload?.source_action) entryEvents.add(ev.name);
  }
  const terminalEvents = new Set<string>(meta.terminal_events ?? []);

  return {
    domainId,
    ontology,
    registry: reg,
    specs: [],
    producers,
    consumers,
    entryEvents,
    terminalEvents,
    log: [`ontology source=${ontology.source}, actions=${ontology.actions.length}, events=${ontology.events.length}`],
    emit: onEvent ?? (() => {}),
    pace: () => (paceMs > 0 ? new Promise((r) => setTimeout(r, paceMs)) : Promise.resolve()),
  };
}

// re-export so callers can type the sink without reaching into types.ts
export type { GenEvent };
