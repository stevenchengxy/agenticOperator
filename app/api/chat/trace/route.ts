// POST /api/chat/trace — global tracing chatbot endpoint (SSE streaming).
//
// Returns a text/event-stream response. Each SSE line is a JSON-encoded
// StreamEvent. Validation errors (400) still return plain JSON.
//
// Tool-using LLM scoped to read-only data across runs / events / audits /
// entities / DLQ / event-chains. Sister to /api/agents/:short/chat (agent-
// scoped) and /api/runs/:id/chat (run-scoped); shares the tool-loop pattern.

import { NextResponse } from "next/server";
import OpenAI from "openai";
import { isGatewayConfigured, pickGateway } from "@/server/llm/gateway";
import { TOOL_SCHEMAS, findTool } from "@/lib/chat/global-chat-tools";
import { buildSystemPrompt } from "@/lib/chat/global-chat-system-prompt";
import { recordChatbotLog } from "@/server/chat/chatbot-log";
import type {
  ChatMessage,
  ChatSource,
  GlobalChatRequest,
  PageContext,
  StreamEvent,
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

  const sessionId = body.sessionId;
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  if (lastUser) {
    await recordChatbotLog({
      sessionId,
      role: "user",
      content: lastUser.content,
      pageContext: body.pageContext,
      metadata: { messageCount: body.messages.length },
    });
  }

  if (!isGatewayConfigured()) {
    return makeSseResponse(async (emit) => {
      const content = "LLM gateway 未配置 · 请联系管理员设置 OPENAI_API_KEY 或等价 env。";
      emit({ type: "text_chunk", content });
      emit({ type: "done", toolCallsExecuted: 0 });
      await recordChatbotLog({
        sessionId,
        role: "assistant",
        content,
        pageContext: body.pageContext,
        metadata: { gatewayConfigured: false, toolCallsExecuted: 0 },
      });
    });
  }

  return makeSseResponse(async (emit) => {
    try {
      const result = await runStreamingToolLoop(body.messages, body.pageContext, sessionId, emit);
      await recordChatbotLog({
        sessionId,
        role: "assistant",
        content: result.assistantContent || "(empty assistant response)",
        pageContext: body.pageContext,
        metadata: {
          modelUsed: result.modelUsed ?? null,
          toolCallsExecuted: result.toolCallsExecuted,
          sources: result.sources,
        },
      });
    } catch (e) {
      const message = (e as Error).message;
      emit({ type: "error", message });
      await recordChatbotLog({
        sessionId,
        role: "assistant",
        content: `ERROR: ${message}`,
        pageContext: body.pageContext,
        metadata: { error: true },
      });
    }
  });
}

function makeSseResponse(handler: (emit: (e: StreamEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: StreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      try {
        await handler(emit);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

type AccumulatedToolCall = {
  id?: string;
  name?: string;
  args: string;
};

async function runStreamingToolLoop(
  messages: ChatMessage[],
  pageContext: PageContext | undefined,
  sessionId: string | undefined,
  emit: (e: StreamEvent) => void,
): Promise<{ assistantContent: string; modelUsed?: string; toolCallsExecuted: number; sources: ChatSource[] }> {
  const cfg = pickGateway();
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, timeout: 300_000 });
  const sources: ChatSource[] = [];
  let toolCallsExecuted = 0;
  let modelUsed: string | undefined;

  const conversation: any[] = [
    { role: "system", content: buildSystemPrompt(pageContext) },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  let allAssistantContent = "";

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const stream = await client.chat.completions.create({
      model: cfg.model,
      messages: conversation,
      tools: TOOL_SCHEMAS as any,
      tool_choice: "auto",
      stream: true,
      temperature: 0.2,
      max_tokens: 700,
    });

    let assistantContent = "";
    const toolCallsAcc = new Map<number, AccumulatedToolCall>();

    for await (const part of stream) {
      modelUsed = (part as any).model ?? modelUsed;
      const delta = (part.choices?.[0]?.delta) as any;
      if (!delta) continue;

      if (typeof delta.content === "string" && delta.content.length > 0) {
        assistantContent += delta.content;
        allAssistantContent += delta.content;
        emit({ type: "text_chunk", content: delta.content });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0;
          let acc = toolCallsAcc.get(idx);
          if (!acc) {
            acc = { args: "" };
            toolCallsAcc.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
        }
      }
    }

    if (toolCallsAcc.size === 0) {
      // Done — final assistant message already streamed via text_chunk events.
      // If we ran out of turns without getting a text response, emit synthesis message.
      if (!assistantContent && turn === MAX_TOOL_TURNS - 1) {
        const fallback = "(已达到最大工具调用轮数,以下是部分结果)";
        allAssistantContent += fallback;
        emit({ type: "text_chunk", content: fallback });
      }
      break;
    }

    // We had tool calls. Push assistant message with tool_calls to conversation.
    const toolCallsArr = Array.from(toolCallsAcc.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => ({
        id: acc.id ?? `call_${Math.random().toString(36).slice(2, 8)}`,
        type: "function" as const,
        function: { name: acc.name ?? "", arguments: acc.args },
      }));

    conversation.push({
      role: "assistant",
      content: assistantContent || null,
      tool_calls: toolCallsArr,
    });

    // Execute each tool, push result back
    for (const call of toolCallsArr) {
      const parsedArgs = safeJsonParse(call.function.arguments);
      emit({ type: "tool_call_start", name: call.function.name, args: parsedArgs });
      await recordChatbotLog({
        sessionId,
        role: "tool",
        kind: "tool",
        content: `tool.start ${call.function.name}`,
        pageContext,
        metadata: { phase: "start", tool: call.function.name, args: parsedArgs },
      });
      const tool = findTool(call.function.name);
      if (!tool) {
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: `unknown tool: ${call.function.name}` }),
        });
        emit({ type: "tool_call_done", name: call.function.name, ms: 0, resultPreview: "(unknown tool)" });
        await recordChatbotLog({
          sessionId,
          role: "tool",
          kind: "tool",
          content: `tool.done ${call.function.name}: unknown tool`,
          pageContext,
          metadata: { phase: "done", tool: call.function.name, ms: 0, error: "unknown_tool" },
        });
        continue;
      }
      const start = Date.now();
      try {
        const parsed = parsedArgs ?? {};
        const { result, sources: toolSources } = await tool.execute(parsed);
        toolCallsExecuted += 1;
        if (toolSources) sources.push(...toolSources);
        let serialized = JSON.stringify(result);
        if (serialized.length > MAX_TOOL_RESULT_BYTES) serialized = serialized.slice(0, MAX_TOOL_RESULT_BYTES);
        conversation.push({ role: "tool", tool_call_id: call.id, content: serialized });
        emit({
          type: "tool_call_done",
          name: call.function.name,
          ms: Date.now() - start,
          resultPreview: summarizeResult(result),
        });
        await recordChatbotLog({
          sessionId,
          role: "tool",
          kind: "tool",
          content: `tool.done ${call.function.name}: ${summarizeResult(result)}`,
          pageContext,
          metadata: {
            phase: "done",
            tool: call.function.name,
            ms: Date.now() - start,
            sources: toolSources ?? [],
          },
        });
      } catch (e) {
        console.error(`[chat/trace] tool ${call.function.name} failed:`, (e as Error).message);
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: `tool execution failed: ${call.function.name}` }),
        });
        emit({ type: "tool_call_done", name: call.function.name, ms: Date.now() - start, resultPreview: "(failed)" });
        await recordChatbotLog({
          sessionId,
          role: "tool",
          kind: "tool",
          content: `tool.done ${call.function.name}: failed`,
          pageContext,
          metadata: { phase: "done", tool: call.function.name, ms: Date.now() - start, error: (e as Error).message.slice(0, 300) },
        });
      }
    }
    // Loop continues — next iteration gets the tool results in conversation.
  }

  if (sources.length > 0) {
    emit({ type: "sources", items: sources });
  }
  emit({ type: "done", modelUsed, toolCallsExecuted });
  return { assistantContent: allAssistantContent, modelUsed, toolCallsExecuted, sources };
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function summarizeResult(r: unknown): string {
  if (r == null) return "";
  if (typeof r === "object") {
    const obj = r as Record<string, unknown>;
    if (typeof obj.total === "number") return `${obj.total} rows`;
    if (Array.isArray(obj.runs)) return `${obj.runs.length} runs`;
    if (Array.isArray(obj.audits)) return `${obj.audits.length} audits`;
    if (Array.isArray(obj.events)) return `${obj.events.length} events`;
    if (Array.isArray(obj.entities)) return `${obj.entities.length} entities`;
  }
  return "(ok)";
}
