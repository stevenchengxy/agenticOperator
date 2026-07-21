// POST /api/chat/compact — summarize an AO Copilot conversation for local compaction.

import { NextResponse } from "next/server";
import { chatComplete, isGatewayConfigured } from "@/server/llm/gateway";
import { recordChatbotLog } from "@/server/chat/chatbot-log";
import type { ChatMessage, PageContext } from "@/lib/chat/types";

type CompactRequest = {
  sessionId?: string;
  messages?: ChatMessage[];
  pageContext?: PageContext;
};

export async function POST(req: Request): Promise<Response> {
  let body: CompactRequest;
  try {
    body = (await req.json()) as CompactRequest;
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST", message: "invalid JSON" }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return NextResponse.json({ ok: true, summary: "空会话，无需压缩。", removedMessages: 0 });
  }

  const keepTail = 8;
  const compacted = messages.slice(0, Math.max(0, messages.length - keepTail));
  const removedMessages = compacted.length;
  const summary = await summarize(compacted.length > 0 ? compacted : messages);

  await recordChatbotLog({
    sessionId: body.sessionId,
    kind: "compact",
    content: summary,
    pageContext: body.pageContext,
    metadata: {
      totalMessages: messages.length,
      removedMessages,
    },
  });

  return NextResponse.json({ ok: true, summary, removedMessages });
}

async function summarize(messages: ChatMessage[]): Promise<string> {
  const fallback = deterministicSummary(messages);
  if (!isGatewayConfigured() || messages.length === 0) return fallback;
  try {
    const transcript = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n")
      .slice(0, 18_000);
    const res = await chatComplete({
      system:
        "你是 Agentic Operator 的对话压缩器。把历史对话压缩为后续 agent 可继续使用的上下文摘要。不要加入新事实，不要暴露隐藏推理，只保留目标、约束、已查证事实、工具结果、待办和用户偏好。输出中文，最多 900 字。",
      user: transcript,
      temperature: 0.1,
      maxTokens: 900,
    });
    const text = res.text.trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

function deterministicSummary(messages: ChatMessage[]): string {
  const userPrompts = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-8);
  const assistantFacts = messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-4);
  return [
    "【已压缩的历史上下文】",
    userPrompts.length ? `用户近期目标: ${userPrompts.join(" / ").slice(0, 900)}` : null,
    assistantFacts.length ? `已给出的回答要点: ${assistantFacts.join(" / ").slice(0, 900)}` : null,
    "后续回答应延续这些上下文，并在需要事实时继续调用工具核验。",
  ]
    .filter(Boolean)
    .join("\n");
}

