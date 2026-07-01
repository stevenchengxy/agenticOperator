// Meta-Orchestrator (blueprint P3 — the conductor of conductors).
//
// Its core intelligence is ONE loop: walk the domain's required node-slots (the
// ontology's agent actions), and for EACH slot decide build-vs-reuse —
//   · ask the Selection Harness "do we have an agent that fits this event slot?"
//   · yes  → reuse it (free, proven)
//   · no   → mark it for the Generation Harness to build
// The output is a concrete orchestration plan: a node DAG where every node is
// either a reused registry agent or a generation task. Downstream, the orchestrator
// dispatches the generations, composes the chain, and hands it to the Verification +
// Execution harnesses. This module is the deterministic core; the live ReAct wrapper
// (dispatch + compose + schedule) builds on top of it.

import type { RegistryAgent } from "./types";
import { selectFromAgents } from "./selection";
import { listRegistryAgents } from "./registry";

/** A required node-slot in the domain's chain (one ontology agent action). */
export interface NodeNeed {
  action: string;
  triggerEvents: string[];
  emitEvents: string[];
}

export interface OrchestrationNode {
  action: string;
  triggerEvents: string[];
  emitEvents: string[];
  decision: "reuse" | "generate";
  /** the reused registry agent (null when generate). */
  agent: RegistryAgent | null;
  reason: string;
}

export interface OrchestrationPlan {
  domain: string;
  nodes: OrchestrationNode[];
  reuseCount: number;
  generateCount: number;
  /** EXTERNAL entry events (consumed but produced by no agent) — platform/human
   *  inputs where independent agents start. Not gaps. */
  entryEvents: string[];
  /** INTERNAL events = what the domain's agents are supposed to produce (ontology
   *  agent-action outputs). An unproduced internal event is a real chain gap. */
  internalEvents: string[];
  /** reserved for cross-registry gaps; gaps are computed at compose-time. */
  danglingTriggers: string[];
  summary: string;
}

/** The core build-vs-reuse plan over a set of node-slots — pure, testable. */
export function planFromOntology(needs: NodeNeed[], registry: RegistryAgent[], domain: string): OrchestrationPlan {
  const nodes: OrchestrationNode[] = needs.map((n) => {
    const sel = selectFromAgents(registry, { triggerEvents: n.triggerEvents, emitEvents: n.emitEvents, capability: n.action, domain });
    return {
      action: n.action,
      triggerEvents: n.triggerEvents,
      emitEvents: n.emitEvents,
      decision: sel.decision,
      agent: sel.best,
      reason: sel.reason,
    };
  });

  // event provenance: INTERNAL events = what the domain's agents produce (the
  // ontology's agent-action outputs). EXTERNAL events (everything an agent consumes
  // but no agent produces) are platform/human entry points — independent agents
  // start there and are NOT broken links.
  const internalEvents = [...new Set(needs.flatMap((n) => n.emitEvents))];
  const internalSet = new Set(internalEvents);
  const allTriggers = new Set(needs.flatMap((n) => n.triggerEvents));
  const entryEvents = [...allTriggers].filter((t) => !internalSet.has(t)); // external entries
  const danglingTriggers: string[] = []; // gaps are computed at compose-time over real signatures

  const reuseCount = nodes.filter((n) => n.decision === "reuse").length;
  const generateCount = nodes.length - reuseCount;
  return {
    domain,
    nodes,
    reuseCount,
    generateCount,
    entryEvents,
    internalEvents,
    danglingTriggers,
    summary: `域「${domain}」需 ${nodes.length} 个节点：复用 ${reuseCount} 个现成、生成 ${generateCount} 个新的。外部入口事件:${entryEvents.join("、") || "(无)"}。`,
  };
}

/** The composed, executable result of a plan: which existing agents to bind, which
 *  to generate, and whether the COMPOSED chain (reused agents' REAL signatures +
 *  generation slots) actually connects. This is where reuse earns its keep AND
 *  where it bites: a reused agent may emit a slightly different event than the slot
 *  expected, opening a gap the orchestrator must close (re-map or generate). */
export interface ExecutionManifest {
  domain: string;
  reuse: RegistryAgent[];   // bind these existing nodes
  generate: NodeNeed[];     // hand these slots to the Generation Harness
  entryEvents: string[];
  /** triggers in the composed chain that NOTHING upstream produces (and aren't
   *  entries) — a real gap, often a reused agent's emit not matching the slot. */
  gaps: Array<{ event: string; neededBy: string; hint: string }>;
  chainOk: boolean;
  summary: string;
}

/** Validate that a set of nodes (by their REAL trigger/emit) forms a connected
 *  FOREST: every consumed trigger is either produced by some node, or is an EXTERNAL
 *  event (a platform/human input that no agent in the domain produces) — external
 *  triggers are legit entry points, so an independent, externally-triggered agent is
 *  NOT a broken link.
 *
 *  `internalEvents` = the events the domain's AGENTS are supposed to produce (the
 *  ontology's agent-action outputs). A gap is ONLY an INTERNAL event with no producer
 *  in the assembly — i.e. an agent that should make it is missing. Triggers that
 *  aren't internal are external entries and never count as gaps. */
export function validateChain(
  nodes: Array<{ name: string; triggerEvents: string[]; emitEvents: string[] }>,
  internalEvents: string[],
): { chainOk: boolean; gaps: Array<{ event: string; neededBy: string; hint: string }> } {
  const produced = new Set(nodes.flatMap((n) => n.emitEvents.filter((e) => e && e !== "—")));
  const internal = new Set(internalEvents);
  const gaps: Array<{ event: string; neededBy: string; hint: string }> = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    for (const t of n.triggerEvents) {
      // skip empty/placeholder, already-produced upstream, OR external (not an
      // agent-produced event → a legit platform/human entry, independent agents start here)
      if (!t || t === "—" || produced.has(t) || !internal.has(t)) continue;
      // t IS internal (some agent is supposed to produce it) but nothing in the
      // assembly does → real gap: a needed producer agent is missing.
      const k = t + "|" + n.name;
      if (seen.has(k)) continue;
      seen.add(k);
      gaps.push({ event: t, neededBy: n.name, hint: `${n.name} 监听内部事件 ${t}，但组装后没有任何 agent 产出它——该事件本应由某个上游 agent 生成(漏装了产出方,或复用的上游 agent emit 名对不齐)。补生成产出方、或重映射上游 emit。` });
    }
  }
  return { chainOk: gaps.length === 0, gaps };
}

/** Compose the plan into an executable manifest + validate the composed chain over
 *  the REAL signatures (reused agents bring their own trigger/emit). */
export function composeExecution(plan: OrchestrationPlan): ExecutionManifest {
  const reuse = plan.nodes.filter((n) => n.decision === "reuse" && n.agent).map((n) => n.agent!) as RegistryAgent[];
  const generate = plan.nodes.filter((n) => n.decision === "generate").map((n) => ({ action: n.action, triggerEvents: n.triggerEvents, emitEvents: n.emitEvents }));
  // reused nodes contribute their REAL signature; generate slots the slot's expected one
  const composed = plan.nodes.map((n) => (n.decision === "reuse" && n.agent
    ? { name: n.action, triggerEvents: n.agent.triggerEvents, emitEvents: n.agent.emitEvents }
    : { name: n.action, triggerEvents: n.triggerEvents, emitEvents: n.emitEvents }));
  const { chainOk, gaps } = validateChain(composed, plan.internalEvents);
  return {
    domain: plan.domain,
    reuse, generate, entryEvents: plan.entryEvents, gaps, chainOk,
    summary: `复用 ${reuse.length} · 生成 ${generate.length} · ${chainOk ? "组装后链路连通 ✓" : `⚠ ${gaps.length} 处断点(复用签名对不齐)`}`,
  };
}

/** The generation seam: hand the novel node-slots to the Generation Harness and
 *  get back the agents it built (as registry nodes). Injectable so the orchestration
 *  is testable with a mock + runnable against the real factory. */
export type GenerateDispatch = (needs: NodeNeed[], domain: string) => Promise<RegistryAgent[]>;

export interface OrchestrationResult {
  domain: string;
  plan: OrchestrationPlan;
  reused: RegistryAgent[];
  generated: RegistryAgent[];
  /** chain validation over the FINAL set (reused + freshly generated, real sigs). */
  chainOk: boolean;
  gaps: Array<{ event: string; neededBy: string; hint: string }>;
  /** every slot filled (reused or generated) AND the chain connects. */
  complete: boolean;
  summary: string;
}

/** Pure assembly core: given a plan + the agents the Generation Harness produced for
 *  its novel slots, compose the FINAL node set and validate the chain end-to-end.
 *  Testable without a DB or a live factory. */
export function assembleOrchestration(plan: OrchestrationPlan, generated: RegistryAgent[]): OrchestrationResult {
  const reused = plan.nodes.filter((n) => n.decision === "reuse" && n.agent).map((n) => n.agent!) as RegistryAgent[];
  const finalNodes = [...reused, ...generated].map((a) => ({ name: a.name, triggerEvents: a.triggerEvents, emitEvents: a.emitEvents }));
  const { chainOk, gaps } = validateChain(finalNodes, plan.internalEvents);
  const filled = reused.length + generated.length;
  const complete = filled >= plan.nodes.length && chainOk;
  return {
    domain: plan.domain, plan, reused, generated, chainOk, gaps, complete,
    summary: `域「${plan.domain}」：复用 ${reused.length} + 新生成 ${generated.length} = ${filled}/${plan.nodes.length} 个节点 · ${complete ? "组装后端到端连通 ✓" : chainOk ? "节点未填满" : `⚠ ${gaps.length} 处链断`}`,
  };
}

/** The full orchestration loop: plan build-vs-reuse → dispatch the Generation
 *  Harness for the novel slots → compose the final node set → validate. This is the
 *  Meta-Orchestrator's end-to-end run; `dispatch` is the seam to the factory. */
export async function runOrchestration(needs: NodeNeed[], domain: string, dispatch: GenerateDispatch): Promise<OrchestrationResult> {
  const registry = await listRegistryAgents(domain);
  const plan = planFromOntology(needs, registry, domain);
  const toGenerate = plan.nodes.filter((n) => n.decision === "generate").map((n) => ({ action: n.action, triggerEvents: n.triggerEvents, emitEvents: n.emitEvents }));
  const generated = toGenerate.length ? await dispatch(toGenerate, domain) : [];
  return assembleOrchestration(plan, generated);
}

/** Live wrapper: read the registry, plan build-vs-reuse for a set of node-slots. */
export async function orchestrate(needs: NodeNeed[], domain: string): Promise<OrchestrationPlan> {
  const registry = await listRegistryAgents(domain);
  return planFromOntology(needs, registry, domain);
}
