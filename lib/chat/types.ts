// Shared chat types used by both server (route handler) and client.

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatSource = {
  tool: string;
  label: string;
  ref?: string;
  url?: string;
};

export type PageContext = {
  route: string;
  runId?: string;
  auditId?: string;
  entityType?: string;
  entityId?: string;
  agentShort?: string;
};

export type ToolDef = {
  name: string;
  schema: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
  execute: (input: unknown) => Promise<{
    result: unknown;
    sources?: ChatSource[];
  }>;
};

export type GlobalChatRequest = {
  messages: ChatMessage[];
  pageContext?: PageContext;
};

export type GlobalChatResponse = {
  reply: ChatMessage;
  sources: ChatSource[];
  modelUsed?: string;
  toolCallsExecuted?: number;
};

export type StreamEvent =
  | { type: "tool_call_start"; name: string; args: unknown }
  | { type: "tool_call_done"; name: string; ms: number; resultPreview?: string }
  | { type: "text_chunk"; content: string }
  | { type: "sources"; items: ChatSource[] }
  | { type: "done"; modelUsed?: string; toolCallsExecuted: number }
  | { type: "error"; message: string };
