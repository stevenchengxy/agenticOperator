// The unified Runner — ONE way to invoke any agent, regardless of kind. Callers
// (the harness, or another agent) write `invoke(node, input)` and never branch on
// substrate; the Runner dispatches:
//   · tool       → call a single registry tool (synchronous, in-process)
//   · in-process → spawn a ReAct sub-brain (builder agents; ctx.spawn recursion)
//   · inngest    → emit the deployed agent's trigger event (product agents)
// Every substrate streams the SAME AgentInvokeEvent union, so one renderer covers
// all three. This is what makes "agents are uniform nodes" real at the run layer,
// not just the descriptor layer.

import { ToolRegistry } from "@/lib/tools/registry";
import type { BrainTool } from "@/lib/agent-factory-v3/brain/types";
import type { RegistryAgent, AgentNode, AgentInvokeEvent } from "./types";

/** Recursion bound: a sub-agent may spawn, but only so deep (prevents fractal
 *  blow-up). spawn() increments depth; invoke() refuses past the cap. */
export const MAX_SPAWN_DEPTH = 2;

/** Fill kind/spawns/exec defaults so any RegistryAgent becomes a runnable AgentNode.
 *  Products → inngest substrate (fire their trigger); builders → in-process sub-brain. */
export function asAgentNode(a: RegistryAgent): AgentNode {
  const kind = a.kind ?? "product";
  const spawns = a.spawns ?? kind === "harness";
  const exec = a.exec ?? (kind === "builder"
    ? { substrate: "in-process" as const, goalHint: a.capability }
    : { substrate: "inngest" as const, fnId: a.id });
  return { ...a, kind, spawns, exec };
}

export interface InvokeOpts {
  /** tool registry — required for the `tool` substrate. */
  registry?: ToolRegistry;
  /** tools handed to a spawned sub-brain — for the `in-process` substrate. */
  subBrainTools?: BrainTool[];
  /** the Inngest send fn — for the `inngest` substrate. Injectable so the Runner is
   *  testable without a live Inngest; defaults to the real client at call time. */
  send?: (e: { name: string; data: Record<string, unknown> }) => Promise<unknown>;
  dryRun?: boolean;
  /** current recursion depth (spawn increments). */
  depth?: number;
  signal?: AbortSignal;
}

/** Invoke any node uniformly. Streams AgentInvokeEvent; never throws (errors are
 *  yielded as invoke.error). */
export async function* invoke(
  node: RegistryAgent | AgentNode,
  input: unknown,
  opts: InvokeOpts = {},
): AsyncGenerator<AgentInvokeEvent> {
  const n: AgentNode = (node as AgentNode).exec ? (node as AgentNode) : asAgentNode(node);
  yield { t: "invoke.start", nodeId: n.id, substrate: n.exec.substrate };
  try {
    // ── tool substrate ──────────────────────────────────────────────────────
    if (n.exec.substrate === "tool") {
      const tool = opts.registry?.get(n.exec.toolRef);
      if (!tool?.execute) { yield { t: "invoke.error", message: `工具「${n.exec.toolRef}」不存在或不可执行` }; return; }
      const out = await tool.execute((input ?? {}) as Record<string, unknown>, { dryRun: opts.dryRun });
      yield { t: "invoke.tool", name: n.exec.toolRef, ok: true };
      yield { t: "invoke.done", ok: true, summary: `工具 ${n.exec.toolRef} 完成`, output: out };
      return;
    }
    // ── in-process substrate (ReAct sub-brain) ──────────────────────────────
    if (n.exec.substrate === "in-process") {
      const depth = opts.depth ?? 0;
      if (depth >= MAX_SPAWN_DEPTH) { yield { t: "invoke.error", message: `spawn 深度超限(${MAX_SPAWN_DEPTH})——子大脑不再向下派` }; return; }
      const { runBrain } = await import("@/lib/agent-factory-v3/brain/conductor");
      const goal = `${n.exec.goalHint ?? n.capability}\n\n【输入】${typeof input === "string" ? input : JSON.stringify(input ?? {})}`;
      let summary = ""; let lastFinish = ""; let toolCalls = 0;
      for await (const e of runBrain({ domain: n.domain, goal, tools: opts.subBrainTools ?? [], isSubAgent: true, signal: opts.signal })) {
        if (e.t === "think") yield { t: "invoke.delta", text: e.delta };
        else if (e.t === "message") summary = e.text;
        else if (e.t === "tool.call") toolCalls++;
        else if (e.t === "tool.result") { yield { t: "invoke.tool", name: e.name, ok: e.ok }; if (e.name === "finish") lastFinish = e.summary; }
      }
      const out = summary || lastFinish || `子大脑完成(${toolCalls} 次工具)`;
      yield { t: "invoke.done", ok: true, summary: out, output: { summary: out, toolCalls } };
      return;
    }
    // ── inngest substrate (fire a deployed product agent's trigger) ──────────
    const trigger = n.triggerEvents[0];
    if (!trigger) { yield { t: "invoke.error", message: `节点「${n.id}」没有触发事件,无法在 Inngest 上触发` }; return; }
    const send = opts.send ?? (await import("@/server/inngest/client")).inngest.send.bind((await import("@/server/inngest/client")).inngest);
    const eventName = `${n.domain}/${trigger}`;
    await send({ name: eventName, data: (input ?? {}) as Record<string, unknown> });
    yield { t: "invoke.done", ok: true, summary: `已向 Inngest 发事件 ${eventName} 触发 ${n.name}`, output: { eventName } };
  } catch (e) {
    yield { t: "invoke.error", message: (e as Error).message };
  }
}

/** ctx.spawn — the recursion primitive. ANY agent's execution can spawn a sub-agent
 *  via the SAME invoke, with depth bumped. Forces the in-process substrate (a
 *  sub-agent is always a ReAct sub-brain) and respects MAX_SPAWN_DEPTH. */
export function spawn(
  node: RegistryAgent,
  input: unknown,
  opts: InvokeOpts = {},
): AsyncGenerator<AgentInvokeEvent> {
  const child: AgentNode = asAgentNode({ ...node, kind: "builder", exec: { substrate: "in-process", goalHint: node.capability } });
  return invoke(child, input, { ...opts, depth: (opts.depth ?? 0) + 1 });
}
