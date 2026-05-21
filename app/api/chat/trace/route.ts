// POST /api/chat/trace — global tracing chatbot endpoint.
//
// Tool-using LLM scoped to read-only data across runs / events / audits /
// entities / DLQ / event-chains. Sister to /api/agents/:short/chat (agent-
// scoped) and /api/runs/:id/chat (run-scoped); shares the tool-loop pattern.

import { NextResponse } from "next/server";
import OpenAI from "openai";
import { isGatewayConfigured, pickGateway } from "@/server/llm/gateway";
import { TOOL_SCHEMAS, findTool } from "@/lib/chat/global-chat-tools";
import { buildSystemPrompt } from "@/lib/chat/global-chat-system-prompt";
import type {
  ChatMessage,
  ChatSource,
  GlobalChatRequest,
  GlobalChatResponse,
  PageContext,
} from "@/lib/chat/types";

const MAX_TOOL_TURNS = 4;
const MAX_TOOL_RESULT_BYTES = 16_000;

export async function POST(req: Request): Promise<Response> {
  let body: GlobalChatRequest;
  try {
    body = (await req.json()) as GlobalChatRequest;
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST", message: "invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "BAD_REQUEST", message: "messages[] required" }, { status: 400 });
  }

  try {
    if (!isGatewayConfigured()) {
      return NextResponse.json<GlobalChatResponse>({
        reply: { role: "assistant", content: "LLM gateway 未配置 · 请联系管理员设置 OPENAI_API_KEY 或等价 env。" },
        sources: [],
      });
    }
    const result = await runToolLoop(body.messages, body.pageContext);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: "LLM_FAILED", message: (e as Error).message },
      { status: 502 },
    );
  }
}

async function runToolLoop(
  messages: ChatMessage[],
  pageContext?: PageContext,
): Promise<GlobalChatResponse> {
  const cfg = pickGateway();
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  const sources: ChatSource[] = [];
  let toolCallsExecuted = 0;

  // Build initial conversation: system + user-supplied history
  const conversation: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(pageContext) },
    ...messages.map((m) => ({ role: m.role, content: m.content }) as OpenAI.ChatCompletionMessageParam),
  ];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const completion = await client.chat.completions.create({
      model: cfg.model,
      messages: conversation,
      tools: TOOL_SCHEMAS as OpenAI.ChatCompletionTool[],
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 700,
    });
    const choice = completion.choices[0];
    if (!choice) break;
    const msg = choice.message;

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Final assistant message
      return {
        reply: { role: "assistant", content: msg.content ?? "" },
        sources,
        modelUsed: cfg.model,
        toolCallsExecuted,
      };
    }

    // Push assistant message with tool_calls
    conversation.push(msg as OpenAI.ChatCompletionMessageParam);

    // Dispatch each tool sequentially
    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const tool = findTool(tc.function.name);
      if (!tool) {
        conversation.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: `unknown tool: ${tc.function.name}` }),
        });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(tc.function.arguments || "{}");
      } catch {
        parsed = {};
      }
      try {
        const { result, sources: toolSources } = await tool.execute(parsed);
        toolCallsExecuted += 1;
        if (toolSources) sources.push(...toolSources);
        let serialized = JSON.stringify(result);
        if (serialized.length > MAX_TOOL_RESULT_BYTES) {
          serialized = serialized.slice(0, MAX_TOOL_RESULT_BYTES) + '"...truncated":true}';
        }
        conversation.push({ role: "tool", tool_call_id: tc.id, content: serialized });
      } catch (e) {
        conversation.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: (e as Error).message }),
        });
      }
    }
  }

  // Tool budget exhausted — make one final synthesis call
  const final = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      ...conversation,
      {
        role: "user",
        content: "(System: tool budget exceeded. Synthesize a final answer from what you've gathered.)",
      },
    ],
    temperature: 0.2,
    max_tokens: 500,
  });
  return {
    reply: {
      role: "assistant",
      content: final.choices[0]?.message?.content ?? "(已达到最大工具调用轮数,以下是部分结果)",
    },
    sources,
    modelUsed: cfg.model,
    toolCallsExecuted,
  };
}
