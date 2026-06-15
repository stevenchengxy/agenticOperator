import { randomUUID } from "crypto";
import { prisma } from "@/server/db";
import { createAgentLogger } from "@/server/agent-logger";
import type { ChatRole, PageContext } from "@/lib/chat/types";

type ChatbotLogKind = "message" | "compact" | "tool";

export type ChatbotLogInput = {
  sessionId?: string;
  role?: ChatRole | "tool";
  kind?: ChatbotLogKind;
  content: string;
  pageContext?: PageContext;
  metadata?: Record<string, unknown>;
};

type StoredLogEntry = {
  id: string;
  at: string;
  kind: ChatbotLogKind;
  role?: ChatRole | "tool";
  content: string;
  pageContext?: PageContext;
  metadata?: Record<string, unknown>;
};

const MAX_STORED_ENTRIES = 500;
const logger = createAgentLogger({ agent: "Chatbot", nodeId: "chatbot" });

export async function recordChatbotLog(input: ChatbotLogInput): Promise<void> {
  const sessionId = normalizeSessionId(input.sessionId);
  const kind = input.kind ?? "message";
  const entry: StoredLogEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    kind,
    role: input.role,
    content: input.content,
    pageContext: input.pageContext,
    metadata: input.metadata,
  };

  await Promise.all([
    appendSessionLog(sessionId, entry),
    logger.log(activityType(kind, input.role), activityNarrative(entry), {
      sessionId,
      kind,
      role: input.role ?? null,
      pageContext: input.pageContext ?? null,
      ...(input.metadata ?? {}),
    }),
  ]);
}

function normalizeSessionId(id: string | undefined): string {
  const s = (id ?? "").trim();
  if (!s) return `chat_${randomUUID()}`;
  return s.slice(0, 120);
}

async function appendSessionLog(sessionId: string, entry: StoredLogEntry): Promise<void> {
  try {
    const current = await prisma.chatbotSession.findUnique({
      where: { id: sessionId },
      select: { conversationLog: true },
    });
    const previous = parseLog(current?.conversationLog);
    const next = [...previous, entry].slice(-MAX_STORED_ENTRIES);
    await prisma.chatbotSession.upsert({
      where: { id: sessionId },
      create: {
        id: sessionId,
        sessionType: "global-copilot",
        status: "open",
        correlationId: sessionId,
        questions: "[]",
        collectedAnswers: "{}",
        conversationLog: JSON.stringify(next),
      },
      update: {
        conversationLog: JSON.stringify(next),
      },
    });
  } catch (e) {
    // Logging should never break the chat loop; AgentActivity still records the failure surface.
    await logger.anomaly("Chatbot session log write failed", {
      sessionId,
      error: (e as Error).message.slice(0, 300),
    });
  }
}

function parseLog(raw: string | null | undefined): StoredLogEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function activityType(kind: ChatbotLogKind, role: ChatbotLogInput["role"]): string {
  if (kind === "compact") return "chat.compact";
  if (kind === "tool") return "chat.tool";
  if (role === "user") return "chat.user_prompt";
  if (role === "assistant") return "chat.assistant_reply";
  return "chat.message";
}

function activityNarrative(entry: StoredLogEntry): string {
  const who =
    entry.kind === "compact"
      ? "压缩"
      : entry.role === "user"
        ? "用户"
        : entry.role === "assistant"
          ? "助手"
          : "工具";
  const text = entry.content.replace(/\s+/g, " ").trim();
  return `${who}: ${text.slice(0, 240)}${text.length > 240 ? "..." : ""}`;
}

