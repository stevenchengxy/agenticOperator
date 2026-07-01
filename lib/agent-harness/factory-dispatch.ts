// The real generation seam: the Meta-Orchestrator → the Generation Harness (factory
// brain). When the orchestrator decides a node-slot must be BUILT (no reuse), this
// drives the actual autonomous factory brain to generate it — same brain, same
// tools, same dynamic codegen the chatbot uses. NOTHING is hardcoded:
//   · the goal is composed from the live novel slots,
//   · the brain reads the live ontology + dynamically designs/writes/sandboxes,
//   · generated agents are read back from the registry by EVENT SIGNATURE (not by a
//     hardcoded name map), so whatever the brain named them, we still match.
//
// This is the live integration point — it runs the LLM brain to completion, so it
// needs the gateway up. The deterministic loop logic is tested via assembleOrchestration.

import { runBrain } from "@/lib/agent-factory-v3/brain/conductor";
import { P1_TOOLS } from "@/lib/agent-factory-v3/tools";
import { P2_TOOLS, P3_TOOLS } from "@/lib/agent-factory-v3/tools/p2-p3";
import { collectGeneratedAgents } from "./registry";
import type { GenerateDispatch, NodeNeed } from "./orchestrator";
import type { RegistryAgent } from "./types";

const ALL_TOOLS = [...P1_TOOLS, ...P2_TOOLS, ...P3_TOOLS];

/** Compose a SCOPED generation goal: build only the novel slots; the rest are
 *  covered by existing agents the orchestrator will bind. */
function scopedGoal(needs: NodeNeed[]): string {
  const lines = needs.map((n) => `· ${n.action}：触发 ${n.triggerEvents.join("/") || "入口"} → 产出 ${n.emitEvents.join("/") || "终态"}`);
  return [
    "本业务域的多数动作已由现成 agent 覆盖。请【只】为下面这些【尚无现成 agent】的动作生成新 agent，逐个走全流程：",
    lines.join("\n"),
    "",
    "对每个动作：read_ontology 接地 → design_agent(input/output schema 必须引用真实 DataObjects) → codegen_agent(AI 亲写 .ts) → sandbox_run 验证 → finish。",
    "事件签名必须严格匹配上面给定的 触发/产出（这样才能和现成 agent 拼成一条链）。",
    "不要为清单以外的动作生成 agent——那些会复用现成的。",
  ].join("\n");
}

/** Match a generated agent to a novel slot by EVENT SIGNATURE (robust to whatever
 *  the brain named it): shares a trigger AND (if the slot constrains emits) an emit. */
function fillsSlot(agent: RegistryAgent, slot: NodeNeed): boolean {
  const trigOk = agent.triggerEvents.some((t) => slot.triggerEvents.includes(t));
  const emitOk = slot.emitEvents.length === 0 || agent.emitEvents.some((e) => slot.emitEvents.includes(e));
  return trigOk && emitOk;
}

/** The live dispatch: drive the factory brain to build the novel slots, then read
 *  back the agents it generated, matched by signature. */
export const factoryDispatch: GenerateDispatch = async (needs: NodeNeed[], domain: string): Promise<RegistryAgent[]> => {
  if (!needs.length) return [];
  // snapshot what already exists so we can tell apart NEW generations from old ones
  const before = new Set((await collectGeneratedAgents(domain)).map((a) => a.codeRef));

  // drive the real autonomous brain to completion (it persists to AgentVersion on finish)
  for await (const _ev of runBrain({ domain, goal: scopedGoal(needs), tools: ALL_TOOLS })) {
    void _ev; // headless: we don't stream here; side effects (persist) are what matter
  }

  // read back, prefer freshly-generated, match each slot by signature
  const after = await collectGeneratedAgents(domain);
  const fresh = after.filter((a) => !before.has(a.codeRef));
  const pool = fresh.length ? fresh : after; // fall back to full set if codeRef churned
  const filled: RegistryAgent[] = [];
  const used = new Set<string>();
  for (const slot of needs) {
    const hit = pool.find((a) => !used.has(a.codeRef) && fillsSlot(a, slot));
    if (hit) { filled.push(hit); used.add(hit.codeRef); }
  }
  return filled;
};

/** Dry-run dispatch: synthesize a node per slot WITHOUT calling the LLM. Lets the
 *  full orchestration loop (plan → dispatch → assemble → validate) be exercised
 *  end-to-end offline — proves the plumbing; does NOT generate real code. */
export const mockDispatch: GenerateDispatch = async (needs: NodeNeed[], domain: string): Promise<RegistryAgent[]> =>
  needs.map((n, i) => ({
    id: `dry-${i}`, name: n.action, source: "generated", domain,
    capability: `(dry-run 占位) ${n.action}`,
    triggerEvents: n.triggerEvents, emitEvents: n.emitEvents, tools: [],
    codeRef: `dry:${n.action}`, status: "draft", sandboxProven: false,
  }));
