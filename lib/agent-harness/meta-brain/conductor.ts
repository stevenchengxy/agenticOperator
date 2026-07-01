// Meta-Orchestrator conductor — the streaming ReAct loop. Reuses the factory's LLM
// gateway (streamTurn). The brain reasons, calls a meta-tool, observes the result,
// and decides the next step — autonomous, not a fixed pipeline.

import { streamTurn, type ChatMsg, type ToolSchema } from "@/lib/agent-factory-v3/brain/stream-gateway";
import { META_TOOLS } from "./tools";
import type { MetaCtx, MetaEvent, MetaTool } from "./types";

const MAX_TURNS = 30;

function systemPrompt(domain: string): string {
  return [
    "你是【元编排大脑】——多套 harness 协同的顶层调度者(conductor of conductors)。",
    `当前业务域:「${domain}」。`,
    "",
    "你的使命:为这个域装配一条端到端、事件连通的 agent 链。对每个本体动作槽,智能决定:",
    "  · 复用现成 agent(选择 Harness 已验证的,免费、可靠),还是",
    "  · 调用生成 Harness(工厂自主大脑)临场真生成一个新的。",
    "然后校验组装后的链路;出现断点时,你要【自己判断】是『注入事件适配(remap)』还是『放弃复用、重造一个签名严格匹配的(generate)』。",
    "",
    "★ 北极星:招聘-v1 的 6 个真生产 agent 是【黄金标准】。工厂读的是同一套 Neo4j 本体,目标是让重造出来的 agent 在签名/决策分支/工具上尽量逼近真 agent。用 compare_to_standard 量这个差距。",
    "",
    "工作方式(自主循环,不是固定脚本):先想清楚再动手 → 调一个工具 → 看结果 → 决定下一步。典型起步:inspect_domain → plan_orchestration → generate_agents(真造未覆盖的) → validate_chain → 有断点就 resolve_gap 再 validate → compare_to_standard → finish。但顺序由你根据观察到的结果决定,可以反复 plan/generate/resolve。",
    "",
    "硬约束:",
    "  · 每次调工具前,先用普通文字写出你的思考(为什么这一步)。",
    "  · 不要臆测本体或注册表内容——用 inspect_domain 拿真数据。",
    "  · finish 有确定性门槛(全槽绑定 + 链路连通),不达标会被拒绝并告诉你缺什么;别空喊完成。",
    "  · 默认 generate_agents 用真工厂(dryRun=false);只有你明确要验证管路时才 dryRun=true。",
  ].join("\n");
}

function toSchemas(tools: MetaTool[]): ToolSchema[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export async function* runMetaBrain(opts: { domain: string; goal?: string; signal?: AbortSignal }): AsyncGenerator<MetaEvent> {
  const buffer: MetaEvent[] = [];
  const ctx: MetaCtx = {
    domain: opts.domain,
    goal: opts.goal ?? `为「${opts.domain}」装配端到端连通的 agent 链,尽量复用、对标 招聘-v1 黄金标准。`,
    emit: (e) => buffer.push(e),
    slots: [], registry: [], goldStandard: [], remaps: [], internalEvents: [], entryEvents: [], lastGaps: [], lastComparison: null,
    spent: { turns: 0 },
  };
  const byName = new Map(META_TOOLS.map((t) => [t.name, t]));
  const schemas = toSchemas(META_TOOLS);

  const messages: ChatMsg[] = [
    { role: "system", content: systemPrompt(opts.domain) },
    { role: "user", content: ctx.goal },
  ];

  let finishedComplete = false;
  let errored = false;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (opts.signal?.aborted) break;
      ctx.spent.turns = turn + 1;

      let pendingCalls: { id: string; name: string; args: string }[] | null = null;
      let assistantContent = "";
      for await (const ev of streamTurn(messages, schemas, { signal: opts.signal })) {
        if (ev.t === "think") yield { t: "think", delta: ev.delta };
        else if (ev.t === "tool_calls") { pendingCalls = ev.calls; assistantContent = ev.content; }
        else if (ev.t === "done") assistantContent = ev.content;
      }

      // no tool calls → brain is talking; final answer.
      if (!pendingCalls || pendingCalls.length === 0) {
        if (assistantContent.trim()) yield { t: "message", text: assistantContent.trim() };
        break;
      }

      messages.push({
        role: "assistant",
        content: assistantContent || null,
        tool_calls: pendingCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
      });

      for (const call of pendingCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.args || "{}"); } catch { args = {}; }
        const reasoning = typeof args.reasoning === "string" ? args.reasoning : "";
        yield { t: "tool.call", id: call.id, name: call.name, reasoning, input: args };

        const tool = byName.get(call.name);
        let result;
        if (!tool) result = { ok: false, summary: `未知工具 ${call.name}` };
        else {
          try { result = await tool.execute(args, ctx); }
          catch (e) { result = { ok: false, summary: `工具 ${call.name} 出错:${(e as Error).message}` }; }
        }
        // drain meta-events the tool emitted
        while (buffer.length) yield buffer.shift()!;
        yield { t: "tool.result", id: call.id, name: call.name, ok: result.ok, summary: result.summary };

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: result.ok, summary: result.summary, ...(result.output ? { output: result.output } : {}) }).slice(0, 60_000),
        });

        if (call.name === "finish" && result.ok) finishedComplete = true;
      }

      if (finishedComplete) break;
    }
  } catch (e) {
    errored = true;
    yield { t: "error", message: (e as Error).message };
  }

  const status = errored ? "errored" : finishedComplete ? "complete" : ctx.spent.turns >= MAX_TURNS ? "turns_exhausted" : "incomplete";
  yield { t: "done", status, turns: ctx.spent.turns, complete: finishedComplete };
}
