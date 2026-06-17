// The autonomous Harness brain — a streaming ReAct loop.
//
// One LLM drives: it reasons, calls a tool, observes the result, loops — until
// it calls `finish` (or hits the budget). NOT a fixed pipeline; the brain
// decides every next action. Yields BrainEvents streamed live to the chatbot.

import { streamTurn, type ChatMsg, type ToolSchema } from "./stream-gateway";
import type { BrainEvent, BrainCtx, BrainTool } from "./types";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";

const MAX_TURNS = 24;
const MAX_TOKENS = 300_000;

function systemPrompt(domain: string): string {
  return [
    "你是一个自主的「Agent 工厂工程师」——一个会自己思考、推理、调用工具的大脑（像 Claude Code / Codex 那样）。",
    `你的任务：为业务域「${domain}」自主生成一组能真正运行、并能串联跑通的 agent。`,
    "",
    "工作方式（你自己决定每一步，不要等指令）：",
    "1. 先 read_ontology 读懂这个域有哪些动作(action)、每个动作消费什么事件(trigger)、发出什么事件(triggered_event)、用什么工具。",
    "2. 推理这个域需要哪些 agent——通常每个 Agent 动作对应一个 agent。看 triggered_event→trigger 怎么把它们串成事件链。",
    "3. generate_agents 生成这些 agent（传 action 名字数组）。",
    "4. validate_graph 校验事件图是否闭合（没有悬空 emit / 孤儿 trigger）。如果没闭合，推理原因、补生成缺的 agent，再校验。",
    "5. sandbox_run 把它们真实部署到 Inngest 并触发运行，确认事件链真的跑起来、到达终态。如果没跑通，推理为什么、修正、重试。",
    "6. 都跑通后 finish 给出中文总结。",
    "",
    "重要：每次调用工具，都要在 `reasoning` 字段用一句中文说清楚你为什么这么做——这是你展示给用户的思考。要真正地推理，不要机械执行。",
  ].join("\n");
}

export async function* runBrain(opts: {
  domain: string;
  goal: string;
  tools: BrainTool[];
}): AsyncGenerator<BrainEvent> {
  const buffer: BrainEvent[] = [];
  const ctx: BrainCtx = {
    domain: opts.domain,
    goal: opts.goal,
    emit: (e) => buffer.push(e),
    specs: [],
    ontology: null,
    registry: null,
    budget: { maxTokens: MAX_TOKENS, maxTurns: MAX_TURNS },
    spent: { tokens: 0, turns: 0 },
  };

  const toolSchemas: ToolSchema[] = opts.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  const messages: ChatMsg[] = [
    { role: "system", content: systemPrompt(opts.domain) },
    { role: "user", content: opts.goal },
  ];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      ctx.spent.turns = turn + 1;

      let pendingCalls: { id: string; name: string; args: string }[] | null = null;
      let assistantContent = "";

      for await (const ev of streamTurn(messages, toolSchemas)) {
        if (ev.t === "think") yield { t: "think", delta: ev.delta };
        else if (ev.t === "usage") ctx.spent.tokens += ev.promptTokens + ev.completionTokens;
        else if (ev.t === "tool_calls") { pendingCalls = ev.calls; assistantContent = ev.content; }
        else if (ev.t === "done") assistantContent = ev.content;
      }

      // No tool calls → the brain is talking; treat as final answer.
      if (!pendingCalls || pendingCalls.length === 0) {
        if (assistantContent.trim()) yield { t: "message", text: assistantContent.trim() };
        break;
      }

      // Append the assistant's tool-call message to history.
      messages.push({
        role: "assistant",
        content: assistantContent || null,
        tool_calls: pendingCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
      });

      let finished = false;
      for (const call of pendingCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.args || "{}"); } catch { args = {}; }
        const reasoning = typeof args.reasoning === "string" ? args.reasoning : "";
        if (reasoning) yield { t: "think", delta: (turn === 0 ? "" : "\n") + reasoning + "\n" };
        yield { t: "tool.call", id: call.id, name: call.name, reasoning, input: args };

        const tool = byName.get(call.name);
        let result;
        if (!tool) result = { ok: false, summary: `未知工具 ${call.name}` };
        else {
          try { result = await tool.execute(args, ctx); }
          catch (e) { result = { ok: false, summary: `工具 ${call.name} 出错：${(e as Error).message}` }; }
        }
        // drain any events the tool emitted (agent.created / validation / sandbox)
        while (buffer.length) yield buffer.shift()!;
        yield { t: "tool.result", id: call.id, name: call.name, ok: result.ok, summary: result.summary };
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.output ?? { ok: result.ok, summary: result.summary }).slice(0, 8000) });
        if (call.name === "finish") finished = true;
      }

      if (finished) break;
      if (ctx.spent.tokens >= MAX_TOKENS) { yield { t: "message", text: "已达 token 预算上限，停止。" }; break; }
    }
  } catch (e) {
    yield { t: "error", message: (e as Error).message };
  }

  yield { t: "done", tokensUsed: ctx.spent.tokens, turns: ctx.spent.turns };
}

// re-export so the route can warm the ontology cheaply if needed
export { fetchRunnableOntology };
