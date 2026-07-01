// The unified Runner: one invoke over three substrates. Deterministic coverage of
// asAgentNode derivation + the tool & inngest substrates + the spawn depth guard.
// (The in-process substrate spawns a real LLM sub-brain — verified live, not here.)

import { describe, it, expect } from "vitest";
import { asAgentNode, invoke, spawn, MAX_SPAWN_DEPTH } from "./runner";
import { ToolRegistry, type ToolDescriptor } from "@/lib/tools/registry";
import type { RegistryAgent, AgentInvokeEvent } from "./types";

async function collect(gen: AsyncGenerator<AgentInvokeEvent>): Promise<AgentInvokeEvent[]> {
  const out: AgentInvokeEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
const baseAgent = (over: Partial<RegistryAgent>): RegistryAgent => ({
  id: "a", name: "A", source: "generated", domain: "招聘-v1", capability: "do a thing",
  triggerEvents: ["TRIG"], emitEvents: ["DONE"], tools: [], codeRef: "x", status: "draft", sandboxProven: false, ...over,
});

describe("asAgentNode — derive kind/spawns/exec defaults", () => {
  it("a registry agent defaults to a product on the inngest substrate", () => {
    const n = asAgentNode(baseAgent({ id: "match-resume-agent" }));
    expect(n.kind).toBe("product");
    expect(n.spawns).toBe(false);
    expect(n.exec).toEqual({ substrate: "inngest", fnId: "match-resume-agent" });
  });
  it("a builder defaults to the in-process substrate", () => {
    const n = asAgentNode(baseAgent({ kind: "builder", capability: "write a tool" }));
    expect(n.exec.substrate).toBe("in-process");
  });
  it("explicit exec is preserved", () => {
    const n = asAgentNode(baseAgent({ kind: "builder", exec: { substrate: "tool", toolRef: "robohire.parseResume" } }));
    expect(n.exec).toEqual({ substrate: "tool", toolRef: "robohire.parseResume" });
  });
});

describe("invoke — tool substrate", () => {
  const tool: ToolDescriptor = {
    name: "demo.echo", title: "echo", description: "echo", domain: "招聘-v1", sideEffect: "read",
    parameters: { type: "object", properties: {}, required: [] }, returns: { type: "object" },
    execute: async (args) => ({ echoed: args }),
  } as unknown as ToolDescriptor;
  const registry = new ToolRegistry().registerAll([tool]);

  it("calls the tool and streams start → tool → done with its output", async () => {
    const node = baseAgent({ kind: "builder", exec: { substrate: "tool", toolRef: "demo.echo" } });
    const ev = await collect(invoke(node, { x: 1 }, { registry }));
    expect(ev[0]).toMatchObject({ t: "invoke.start", substrate: "tool" });
    expect(ev.some((e) => e.t === "invoke.tool" && e.name === "demo.echo")).toBe(true);
    const done = ev.find((e) => e.t === "invoke.done") as Extract<AgentInvokeEvent, { t: "invoke.done" }>;
    expect(done.ok).toBe(true);
    expect(done.output).toEqual({ echoed: { x: 1 } });
  });

  it("errors (not throws) when the tool is missing", async () => {
    const node = baseAgent({ kind: "builder", exec: { substrate: "tool", toolRef: "nope.missing" } });
    const ev = await collect(invoke(node, {}, { registry }));
    expect(ev.some((e) => e.t === "invoke.error")).toBe(true);
  });
});

describe("invoke — inngest substrate (injected send)", () => {
  it("fires the deployed agent's trigger as a domain-scoped event", async () => {
    const sent: Array<{ name: string; data: unknown }> = [];
    const node = baseAgent({ id: "match-resume-agent", domain: "Agents-generation", triggerEvents: ["MATCH_RULE_CHECK_PASSED"] });
    const ev = await collect(invoke(node, { candidate_id: "c1" }, { send: async (e) => { sent.push(e); return {}; } }));
    expect(sent[0].name).toBe("Agents-generation/MATCH_RULE_CHECK_PASSED");
    expect(sent[0].data).toEqual({ candidate_id: "c1" });
    expect(ev.some((e) => e.t === "invoke.done")).toBe(true);
  });
});

describe("spawn — recursion depth guard", () => {
  it("refuses to run past MAX_SPAWN_DEPTH (without touching the LLM)", async () => {
    const node = baseAgent({ kind: "builder" });
    // already at the cap → spawn bumps to cap+1 → invoke refuses immediately
    const ev = await collect(spawn(node, {}, { depth: MAX_SPAWN_DEPTH }));
    expect(ev.some((e) => e.t === "invoke.error" && /深度超限/.test(e.message))).toBe(true);
    expect(ev.some((e) => e.t === "invoke.tool")).toBe(false); // never ran anything
  });
});
