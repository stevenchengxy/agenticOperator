// Shared LLM gateway picker. Mirrors the logic that lives inside
// jd-generator.ts / robohire-shape.ts so callers that just need a chat
// completion don't have to copy the env-var dance.
//
// Two modes, in order of preference:
//   1. AI_BASE_URL + AI_API_KEY (+ optional AI_MODEL)  — internal gateway
//   2. OPENAI_API_KEY                                  — direct OpenAI
//
// Throws GatewayUnavailableError when neither is configured. Callers should
// catch that and fall back to a deterministic answer.

import OpenAI from "openai";
import type { LoggerLike } from "@/server/agent-logger";

export class GatewayUnavailableError extends Error {
  constructor() {
    super(
      "LLM gateway not configured (set AI_BASE_URL+AI_API_KEY or OPENAI_API_KEY)",
    );
    this.name = "GatewayUnavailableError";
  }
}

export type GatewayConfig = {
  baseURL: string;
  apiKey: string;
  /** Default model — callers may override per call. */
  model: string;
};

export function pickGateway(): GatewayConfig {
  if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
    return {
      baseURL: process.env.AI_BASE_URL,
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL || "google/gemini-3-flash-preview",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      baseURL: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      model: "gpt-4o-mini",
    };
  }
  throw new GatewayUnavailableError();
}

export function isGatewayConfigured(): boolean {
  return (
    !!(process.env.AI_BASE_URL && process.env.AI_API_KEY) ||
    !!process.env.OPENAI_API_KEY
  );
}

export type ChatCompleteResult = {
  text: string;
  modelUsed: string;
  durationMs: number;
  /** Token counts when the gateway returns a `usage` block; undefined otherwise. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** Number of tool-call rounds before final text. 0 when no tools, or model
   *  emitted content on the first response. */
  toolUseIterations: number;
};

export type ChatTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatToolDispatcher = (
  name: string,
  args: unknown,
) => Promise<unknown>;

export type ChatToolsOptions = {
  schema: ChatTool[];
  onToolCall: ChatToolDispatcher;
  /** Cap on tool-call rounds. Default 5. */
  maxIterations?: number;
};

/**
 * One-shot chat completion (or multi-turn tool-use loop when `tools` is set).
 * Returns the assistant's text content. Throws GatewayUnavailableError if
 * neither env pair is set.
 *
 * When `logger` is supplied, every call automatically writes a `tool`
 * AgentActivity row on success (with model / duration / token counts) and
 * an `anomaly` row on failure. This is how Workflow / Live log streams get
 * fine-grained LLM telemetry "for free" — agents just thread their logger.
 */
export async function chatComplete(opts: {
  system: string;
  user: string;
  /** Override default model from picked gateway. */
  model?: string;
  /** Default 0.2 — keep summaries deterministic. */
  temperature?: number;
  /** Default 800. */
  maxTokens?: number;
  /** Optional instrumentation. Pass an AgentLogger (it satisfies LoggerLike). */
  logger?: LoggerLike;
  /** Label used in the auto-log narrative. Default "LLM.<model>". */
  toolName?: string;
  /** Optional tools — when set, drives a multi-turn tool-use loop. */
  tools?: ChatToolsOptions;
}): Promise<ChatCompleteResult> {
  const cfg = pickGateway();
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  const modelUsed = opts.model || cfg.model;
  const toolLabel = opts.toolName ?? `LLM.${modelUsed}`;
  const started = Date.now();

  const messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  }> = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];

  const maxIterations = opts.tools?.maxIterations ?? 5;
  let iterations = 0;
  let text = '';
  let lastUsage:
    | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    | undefined;

  try {
    while (true) {
      const createArgs: Record<string, unknown> = {
        model: modelUsed,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 800,
        messages,
      };
      if (opts.tools) {
        createArgs.tools = opts.tools.schema;
        createArgs.tool_choice = 'auto';
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const completion = (await client.chat.completions.create(createArgs as any)) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: Array<{
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            }>;
          };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      lastUsage = completion.usage;
      const msg = completion.choices[0]?.message;
      const toolCalls = msg?.tool_calls ?? [];

      if (!opts.tools || toolCalls.length === 0) {
        text = (msg?.content ?? '').trim();
        break;
      }

      // Append the assistant message (with its tool_calls) to history.
      messages.push({
        role: 'assistant',
        content: msg?.content ?? null,
        tool_calls: toolCalls,
      });

      // Dispatch each tool call, append the tool result message.
      for (const call of toolCalls) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(call.function.arguments);
        } catch {
          parsed = {};
        }
        const result = await opts.tools.onToolCall(call.function.name, parsed);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result ?? null),
        });
      }

      iterations += 1;
      if (iterations >= maxIterations) {
        throw new Error(
          `tool-use loop exceeded ${maxIterations} iterations without final text`,
        );
      }
    }

    const durationMs = Date.now() - started;
    const usage = lastUsage
      ? {
          promptTokens: lastUsage.prompt_tokens,
          completionTokens: lastUsage.completion_tokens,
          totalTokens: lastUsage.total_tokens,
        }
      : undefined;
    if (opts.logger) {
      await opts.logger.tool(
        `${toolLabel} · ${usage?.totalTokens ?? '?'} tokens · ${durationMs}ms · ${iterations} tool rounds`,
        {
          model: modelUsed,
          durationMs,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          totalTokens: usage?.totalTokens,
          toolUseIterations: iterations,
          systemSummary: truncate(opts.system, 200),
          userSummary: truncate(opts.user, 400),
        },
      );
    }
    return { text, modelUsed, durationMs, usage, toolUseIterations: iterations };
  } catch (e) {
    const durationMs = Date.now() - started;
    if (opts.logger) {
      await opts.logger.anomaly(`${toolLabel} failed: ${(e as Error).message}`, {
        model: modelUsed,
        durationMs,
        error: (e as Error).message,
      });
    }
    throw e;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
