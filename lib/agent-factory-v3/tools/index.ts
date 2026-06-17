// The Harness brain's tool/action space (P1). Each is a deterministic, reliable
// capability the autonomous brain decides when to call. The brain provides the
// intelligence (what to build, when to validate/run, how to react to failures);
// these tools provide the reliable execution.

import { fetchRunnableOntology, type OntologyAction } from "@/lib/ontology-generator/ontology-source";
import { resolveRegistry } from "@/lib/tools/resolve-registry";
import { selectToolsForAction, type ToolRegistry } from "@/lib/tools/registry";
import { kebab, pascal, slugifyDomain, inferRetries } from "@/lib/agent-factory-gen/generate";
import { validateSpecs } from "@/lib/agent-factory-v2/builders/validator";
import { shipAgents, fireAndObserve } from "@/lib/agent-factory-v2/deploy";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import type { BrainTool, BrainCtx, AgentCardLite } from "../brain/types";

const REASONING = {
  reasoning: { type: "string", description: "一句话说明你为什么现在调用这个工具(会作为你的思考展示给用户)" },
} as const;
function params(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties: { ...REASONING, ...props }, required: ["reasoning", ...required] };
}

function cardOf(s: GeneratedAgentSpec): AgentCardLite {
  return { slug: s.slug, short: s.short, nameZh: s.nameZh, trigger: s.trigger, emit: s.emit, tools: s.tools };
}

/** Build a runnable GeneratedAgentSpec from an ontology action — deterministic,
 *  no LLM. Uses the action's own system/user prompt + tool_use bindings. */
export function buildSpecFromAction(action: OntologyAction, domain: string, registry: ToolRegistry): GeneratedAgentSpec {
  const { tools, unresolved } = selectToolsForAction(action, registry);
  const sys =
    action.system_prompt ||
    `你是「${action.name}」agent。当收到事件 ${action.trigger.join(" / ") || "(入口)"} 时执行 ${action.name}，` +
      `完成后发出 ${action.triggered_event.join(" 或 ") || "(终态)"}。`;
  const usr = action.user_prompt || `处理当前案例的数据并产出结果，按业务规则决定发出哪个事件。`;
  const steps = (tools.length ? tools : ["process"]).map((tool, i) => ({
    name: tool.split(".").pop() || `step${i + 1}`,
    description: tools.includes(tool) ? `调用 ${tool}` : "处理",
    tool: tools.includes(tool) ? tool : undefined,
  }));
  return {
    key: action.name,
    actionName: action.name,
    slug: `${slugifyDomain(domain)}-${kebab(action.name)}`,
    short: `${pascal(action.name)}Agent`,
    domainId: domain,
    nameZh: action.name,
    kind: action.actor.includes("Human") ? "simulated-human" : "llm",
    trigger: action.trigger,
    emit: action.triggered_event,
    tools,
    unresolvedTools: unresolved,
    objects: action.target_objects,
    systemPrompt: sys,
    userPrompt: usr,
    steps,
    ruleRefs: [],
    retries: inferRetries(tools),
    hitl: action.actor.includes("Human"),
    confidence: action.system_prompt ? 0.85 : 0.6,
    promptSource: action.system_prompt ? "ontology" : "fallback",
    toolFlow: "parallel",
  };
}

const read_ontology: BrainTool = {
  name: "read_ontology",
  description:
    "读取业务域的本体：对象、动作(actions，每个含 trigger 消费事件 / triggered_event 发出事件 / tool_use 工具)、事件、规则。先调用它来理解这个域需要造哪些 agent、怎么串联。",
  parameters: params({ kind: { type: "string", enum: ["all", "actions"], description: "读哪部分，默认 all" } }),
  async execute(_args, ctx) {
    const ont = ctx.ontology ?? (await fetchRunnableOntology(ctx.domain));
    ctx.ontology = ont;
    ctx.registry = ctx.registry ?? resolveRegistry(ctx.domain, ont);
    const agentActions = ont.actions.filter((a) => a.actor.includes("Agent"));
    const actions = agentActions.map((a) => ({
      name: a.name,
      trigger: a.trigger,
      emit: a.triggered_event,
      tools: a.tool_use,
      has_prompt: !!a.system_prompt,
    }));
    return {
      ok: true,
      summary: `本体 ${ctx.domain}（来自 ${ont.source}）：${ont.objects.length} 对象 · ${ont.actions.length} 动作（${agentActions.length} 个 Agent 动作）· ${ont.events.length} 事件 · ${ont.rules.length} 规则`,
      output: { domain: ctx.domain, source: ont.source, agentActions: actions },
    };
  },
};

const generate_agents: BrainTool = {
  name: "generate_agents",
  description:
    "为指定的 action 们生成可运行的 agent（从本体确定性构建：绑定 tool_use 工具 + 系统/用户 prompt + 触发/发出事件）。传入 action 名字数组（通常每个 Agent 动作一个 agent）。可多次调用增量补充。",
  parameters: params({ actions: { type: "array", items: { type: "string" }, description: "要生成 agent 的 action 名字（来自 read_ontology 的 agentActions[].name）" } }, ["actions"]),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先调用 read_ontology 理解本体。" };
    const reg = ctx.registry ?? resolveRegistry(ctx.domain, ctx.ontology);
    ctx.registry = reg;
    const names = (Array.isArray(args.actions) ? args.actions : []) as string[];
    const created: string[] = [];
    const missing: string[] = [];
    for (const name of names) {
      const action = ctx.ontology.actions.find((a) => a.name === name);
      if (!action) { missing.push(name); continue; }
      const spec = buildSpecFromAction(action, ctx.domain, reg);
      ctx.specs = ctx.specs.filter((s) => s.actionName !== name);
      ctx.specs.push(spec);
      ctx.emit({ t: "agent.created", spec: cardOf(spec) });
      created.push(spec.short);
    }
    return {
      ok: created.length > 0,
      summary: `已生成 ${created.length} 个 agent：${created.join(", ")}${missing.length ? `（找不到动作：${missing.join(", ")}）` : ""}`,
      output: { created, missing, totalSoFar: ctx.specs.length },
    };
  },
};

const validate_graph: BrainTool = {
  name: "validate_graph",
  description: "静态校验目前已生成的所有 agent 的事件图是否闭合：有没有悬空 emit（发出但无人消费）或孤儿 trigger（消费但无人产出）。生成后、跑沙箱前调用。",
  parameters: params({}),
  async execute(_args, ctx) {
    const v = validateSpecs(ctx.specs);
    const issues = [
      ...v.danglingEmits.map((e) => `悬空 emit：${e}`),
      ...v.orphanTriggers.map((e) => `孤儿 trigger（可能是入口事件）：${e}`),
      ...v.emptyToolAgents.map((a) => `无工具的 agent：${a}`),
    ];
    ctx.emit({ t: "validation", ok: v.ok, issues });
    return {
      ok: v.ok,
      summary: v.ok ? "事件图闭合 ✓" : `事件图未完全闭合：${issues.slice(0, 4).join("；")}`,
      output: v,
    };
  },
};

const sandbox_run: BrainTool = {
  name: "sandbox_run",
  description:
    "把目前生成的所有 agent 部署到隔离的 Inngest 测试域（agents-generation / 当前域）并真实触发运行，观察事件链是否真的串起来跑通、到达终态。这是真实执行（部署到 Inngest + 发事件 + 看运行），不是模拟。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.specs.length) return { ok: false, summary: "还没有 agent 可跑，请先 generate_agents。" };
    const ship = await shipAgents(ctx.domain, ctx.specs);
    if (!ship.appRegistered) {
      return { ok: false, summary: `上架到 Inngest 失败：${ship.error ?? "未注册"}`, output: ship };
    }
    const run = await fireAndObserve(ctx.domain, ctx.specs, { timeoutMs: 30_000 });
    const agents = [...new Set(run.runs.map((r) => r.fn.replace(`agentic-operator-${ctx.domain}-`, "")))];
    ctx.emit({ t: "sandbox", ran: agents.length, reachedTerminal: run.reachedTerminal, agents, events: run.events });
    return {
      ok: run.runs.length > 0,
      summary: `真实运行：${agents.length} 个 agent 跑起来（${ship.deployed.length} 已上架）· 事件链 ${run.events.length} 个 · ${run.reachedTerminal ? "到达终态 ✓" : "未到终态"}`,
      output: { deployed: ship.deployed, ranAgents: agents, events: run.events, reachedTerminal: run.reachedTerminal },
    };
  },
};

const finish: BrainTool = {
  name: "finish",
  description: "完成任务并给出总结。当你已经读懂本体、生成 agent、校验图闭合、并在沙箱真实跑通后调用它结束。",
  parameters: params({ summary: { type: "string", description: "给用户的中文总结：造了哪些 agent、是否跑通" } }, ["summary"]),
  async execute(args, _ctx) {
    return { ok: true, summary: String(args.summary || "完成"), output: { done: true } };
  },
};

export const P1_TOOLS: BrainTool[] = [read_ontology, generate_agents, validate_graph, sandbox_run, finish];
