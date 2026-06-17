// Streaming, tool-calling LLM turn against the OpenAI-compatible gateway.
//
// The shipped `chatComplete` (server/llm/gateway.ts) is NON-streaming and THROWS
// at maxIterations — unusable for an autonomous ReAct brain that must stream its
// thinking token-by-token and loop freely. This is the streaming primitive the
// brain's loop is built on: one assistant turn, yielding think deltas as they
// arrive, then either the tool calls the model wants or its final content.

import OpenAI from "openai";
import { pickGateway } from "@/server/llm/gateway";

export type ChatMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export type ToolSchema = {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
};

export type AccTool = { id: string; name: string; args: string };

export type TurnEvent =
  | { t: "think"; delta: string }
  | { t: "usage"; promptTokens: number; completionTokens: number }
  | { t: "tool_calls"; content: string; calls: AccTool[] }
  | { t: "done"; content: string };

/**
 * Stream a single assistant turn. Yields `think` deltas as the model emits
 * content, accumulates streamed tool-call fragments by index, and ends with
 * either `tool_calls` (the model wants to act) or `done` (final answer).
 */
export async function* streamTurn(
  messages: ChatMsg[],
  tools: ToolSchema[],
  opts: { model?: string; temperature?: number; maxTokens?: number } = {},
): AsyncGenerator<TurnEvent> {
  const gw = pickGateway();
  const client = new OpenAI({ baseURL: gw.baseURL, apiKey: gw.apiKey });

  const stream = await client.chat.completions.create({
    model: opts.model ?? gw.model,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 2000,
    messages: messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
    ...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
    stream: true,
    stream_options: { include_usage: true },
  });

  let content = "";
  const acc: Record<number, AccTool> = {};
  let prompt = 0;
  let completion = 0;

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta as
      | { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }
      | undefined;

    if (delta?.content) {
      content += delta.content;
      yield { t: "think", delta: delta.content };
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const a = (acc[idx] ??= { id: "", name: "", args: "" });
        if (tc.id) a.id = tc.id;
        if (tc.function?.name) a.name += tc.function.name;
        if (tc.function?.arguments) a.args += tc.function.arguments;
      }
    }
    if (chunk.usage) {
      prompt = chunk.usage.prompt_tokens ?? 0;
      completion = chunk.usage.completion_tokens ?? 0;
    }
  }

  if (prompt || completion) yield { t: "usage", promptTokens: prompt, completionTokens: completion };

  const calls = Object.values(acc).filter((c) => c.name && c.id);
  if (calls.length) yield { t: "tool_calls", content, calls };
  else yield { t: "done", content };
}
