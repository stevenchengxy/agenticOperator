// Front-desk / intent-routing tools. The factory is NOT only an agent GENERATOR —
// a user often asks an INFORMATIONAL question ("业务定义里有几个域?", "这个域有哪些
// 规则/动作/事件/对象?") or something simple. These tools let the brain ANSWER such
// questions directly (read the ontology, then reply with text — which ends the turn)
// WITHOUT running the heavy read_ontology→plan→design→sandbox→finish pipeline.
//
// The ROUTING decision (answer / query / generate) lives in the brain's system
// prompt; these are the query lane's capabilities. A "Harness decides where to
// start" front desk, per the Difficulty-Aware-Orchestration line of papers.

import type { BrainTool } from "../brain/types";
import { listDomains, fetchLiveOntologyStrict } from "@/lib/ontology-generator/ontology-source";

const REASONING = { reasoning: { type: "string", description: "一句话说明为什么查这个(展示给用户)" } } as const;
function params(props: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties: { ...REASONING, ...props }, required: ["reasoning", ...required] };
}

const nameOf = (x: unknown): string => {
  if (typeof x === "string") return x;
  const o = x as { name?: string; id?: string };
  return o?.name ?? o?.id ?? String(x);
};
const isAgentActor = (actor: unknown): boolean =>
  typeof actor === "string" ? actor.includes("Agent") : Array.isArray(actor) ? actor.some((a) => String(a).includes("Agent")) : false;

export const list_domains: BrainTool = {
  name: "list_domains",
  description:
    "列出业务定义(本体)里【所有业务域】及数量。用户问「有几个域 / 都有哪些域 / 还有什么域」这类信息性问题时用——查到就【直接用文字回答】,【不要】去跑 read_ontology→design 整条生成流水线。",
  parameters: params(),
  async execute(_args, _ctx) {
    // NOTE: deliberately NO canned ctx.emit message. We return the data and let the
    // BRAIN compose the user-facing answer in its own words, tailored to what the user
    // actually asked — a fixed "🗂 共 N 个域" template every time reads robotic.
    const domains = await listDomains();
    const names = domains.map((d) => d.name || d.id);
    return { ok: domains.length > 0, summary: `共 ${domains.length} 个业务域：${names.join("、") || "(空)"}`, output: { count: domains.length, domains } };
  },
};

export const describe_domain: BrainTool = {
  name: "describe_domain",
  description:
    "概览一个业务域里有多少/哪些【对象、动作、事件、规则】(以及其中几个是会生成智能体的 Agent 动作)。用户问「这个域有哪些规则/动作/事件/对象」这类信息性问题时用——查到就【直接用文字回答】,【不要】跑生成流水线。不传 domain 用当前域。",
  parameters: params({ domain: { type: "string", description: "域 id,可空(默认当前域)" } }),
  async execute(args, ctx) {
    const d = (typeof args.domain === "string" && args.domain.trim()) || ctx.domain;
    let ont;
    try {
      ont = await fetchLiveOntologyStrict(d);
    } catch (e) {
      return { ok: false, summary: `读不到域「${d}」的业务定义：${(e as Error).message}` };
    }
    const agentActions = ont.actions.filter((a) => isAgentActor((a as { actor?: unknown }).actor));
    // NOTE: no canned ctx.emit — return the structured data and let the BRAIN write the
    // user-facing analysis in its own words, tailored to the question (vs a fixed template).
    return {
      ok: true,
      summary: `域「${d}」:对象 ${ont.objects.length}、动作 ${ont.actions.length}(Agent 动作 ${agentActions.length})、事件 ${ont.events.length}、规则 ${ont.rules.length}`,
      output: {
        domain: d,
        counts: { objects: ont.objects.length, actions: ont.actions.length, agentActions: agentActions.length, events: ont.events.length, rules: ont.rules.length },
        objects: ont.objects.map(nameOf),
        actions: ont.actions.map(nameOf),
        agentActions: agentActions.map(nameOf),
        events: ont.events.map(nameOf),
        rules: ont.rules.map(nameOf),
      },
    };
  },
};

// #4 — ask_user HITL. The brain proactively asks the user a question (optionally with options)
// mid-run and PARKS until answered, instead of guessing when info is incomplete or a choice is
// genuinely the user's to make. The conductor's ask-user gate polls the mailbox for the reply.
export const ask_user: BrainTool = {
  name: "ask_user",
  description:
    "运行中【反问用户并暂停等待回答】(HITL):当信息不全要用户补充、外部平台 API 的输入/输出查不到要问用户、或要在几个方案里让用户拍板时,调它——给 question(问题)和可选 options([{label,value}]让用户点选)。调用后【停下,不要继续调别的工具】,等用户在对话框回答或点选项,我会把回答作为消息发给你再继续。比自己瞎猜/默默降级强。",
  parameters: params(
    {
      question: { type: "string", description: "要问用户的问题(清楚、具体)" },
      options: { type: "array", description: "可选项(让用户点选),每项 {label,value};纯开放问题可不给", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] } },
      context: { type: "string", description: "为什么现在问(背景)、你已知/未知什么,可空" },
    },
    ["question"],
  ),
  async execute(args, ctx) {
    const question = String(args.question ?? "").trim();
    if (!question) return { ok: false, summary: "ask_user 需要一个 question。" };
    const rawOpts = Array.isArray(args.options) ? args.options : [];
    const options = rawOpts
      .map((o) => { const r = (o ?? {}) as Record<string, unknown>; return { label: String(r.label ?? r.value ?? ""), value: String(r.value ?? r.label ?? "") }; })
      .filter((o) => o.label);
    const id = "ask_" + Math.random().toString(36).slice(2, 10);
    ctx.pendingAsk = { id, question, options: options.length ? options : undefined };
    ctx.awaitingAsk = true;
    ctx.emit({ t: "ask_user", id, question, options: options.length ? options : undefined, context: typeof args.context === "string" ? args.context : undefined, awaitingAnswer: true });
    return {
      ok: true,
      summary: `已向用户提问并暂停等待回答：「${question}」${options.length ? `(选项: ${options.map((o) => o.label).join(" / ")})` : ""}。【现在停下,等用户回答,不要继续调别的工具】。`,
      output: { id, question, options },
    };
  },
};

export const FRONT_DESK_TOOLS: BrainTool[] = [list_domains, describe_domain, ask_user];
