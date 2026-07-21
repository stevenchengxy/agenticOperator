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
  | { t: "model"; model: string } // #7 — which model actually served this turn (after fallback)
  | { t: "done"; content: string };

/**
 * Stream a single assistant turn. Yields `think` deltas as the model emits
 * content, accumulates streamed tool-call fragments by index, and ends with
 * either `tool_calls` (the model wants to act) or `done` (final answer).
 */
/** Tiered factory models. Everything runs on gemini-3-flash by default (budget
 *  reality). The mechanism is configurable so the HIGH-VALUE reasoning steps (the
 *  main brain's design/codegen/plan loop, the review judge, test-case authoring) can
 *  be flipped to a frontier model the moment there's budget — set FACTORY_STRONG_MODEL
 *  (e.g. `anthropic/claude-sonnet-4-6`). Mechanical / runtime steps (sub-agents,
 *  compaction summary, the deployed product agent) stay on FLASH regardless.
 *    · FACTORY_FLASH_MODEL  — cheap tier (default for all)
 *    · FACTORY_STRONG_MODEL — high-value tier (defaults to flash until budget) */
export const FACTORY_FLASH_MODEL = process.env.FACTORY_AI_MODEL || "google/gemini-3-flash-preview";
export const FACTORY_STRONG_MODEL = process.env.FACTORY_STRONG_MODEL || FACTORY_FLASH_MODEL;
const FACTORY_MODEL = FACTORY_FLASH_MODEL;

export async function* streamTurn(
  messages: ChatMsg[],
  tools: ToolSchema[],
  opts: { model?: string; models?: string[]; temperature?: number; maxTokens?: number | null; signal?: AbortSignal } = {},
): AsyncGenerator<TurnEvent> {
  const gw = pickGateway();
  const client = new OpenAI({ baseURL: gw.baseURL, apiKey: gw.apiKey });

  // Per-turn output cap. Default = UNLIMITED (we omit `max_tokens` so the model
  // uses its full output budget). The old 4000-token ceiling was truncating the
  // brain's reasoning mid-thought — a long design_agent prompt + analysis +
  // tool-call args can blow past 4000, and the turn got cut off, degrading the
  // generated agent. Pass an explicit `opts.maxTokens` (number), or set
  // FACTORY_BRAIN_MAX_TOKENS, to re-impose a ceiling if a gateway ever requires
  // one. `null` forces unlimited even when the env var is set.
  const envCap = Number(process.env.FACTORY_BRAIN_MAX_TOKENS);
  // Default UNCAPPED (user vetoed our caps). `effectiveMaxTokens` is only lowered
  // below if the PROVIDER itself refuses with a 402 "you can only afford N" — that
  // is the provider's limit, not a guardrail we impose.
  let effectiveMaxTokens =
    opts.maxTokens !== undefined ? opts.maxTokens
    : Number.isFinite(envCap) && envCap > 0 ? envCap
    : null;

  // The proxy gateway intermittently 5xx's under load ("system memory
  // overloaded"). Without a retry, ONE flaky upstream turn kills the whole run
  // mid-design — losing half the agents. Retry transient 5xx (NOT 4xx, those
  // are our bugs) with a short backoff. Aborts pass through immediately.
  // #7: a fallback CHAIN of models (preferred first). On a model the gateway can't serve, or any
  // persistent failure, fall through to the next model before giving up. opts.models (from the
  // tiered router) wins; else a single model (opts.model) or the factory default.
  const models = opts.models && opts.models.length ? opts.models : [opts.model ?? FACTORY_MODEL];
  const create = async (model: string) => client.chat.completions.create(
    {
      model,
      temperature: opts.temperature ?? 0.4,
      ...(effectiveMaxTokens != null ? { max_tokens: effectiveMaxTokens } : {}),
      messages: messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
      ...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
      stream: true,
      stream_options: { include_usage: true },
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );
  let stream;
  let lastErr: unknown;
  let usedModel = models[0]!;
  const MAX_ATTEMPTS = 5;
  modelLoop: for (let mi = 0; mi < models.length; mi++) {
    usedModel = models[mi]!;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (opts.signal?.aborted) throw new Error("aborted");
      try { stream = await create(usedModel); break modelLoop; }
      catch (e) {
        lastErr = e;
        const code = (e as { status?: number }).status;
        const msg = String((e as { message?: string }).message ?? "").toLowerCase();
        // PROVIDER credit limit (402): adapt by retrying ONCE with the affordable budget.
        const afford = code === 402 ? msg.match(/can only afford (\d+)/) : null;
        if (afford && (effectiveMaxTokens == null || effectiveMaxTokens > Number(afford[1]))) {
          effectiveMaxTokens = Math.max(1024, Math.floor(Number(afford[1]) * 0.9));
          continue; // retry immediately with the provider-affordable budget
        }
        // Transient = an upstream gateway hiccup (5xx / overload / rate-limit / timeout): retry
        // the SAME model with backoff.
        const transient =
          (typeof code === "number" && code >= 500 && code < 600) ||
          /overload|\b50[234]\b|temporarily|unavailable|timeout|timed out|too many requests|rate.?limit|econn|socket hang/.test(msg);
        // A model the gateway doesn't serve (404 / unknown model) → fall straight to the NEXT
        // model in the chain; any other persistent failure also falls through before giving up.
        const badModel = code === 404 || /no such model|model.*not found|does not exist|unknown model|unsupported model/.test(msg);
        if ((badModel || !transient || attempt === MAX_ATTEMPTS - 1) && mi < models.length - 1) continue modelLoop;
        if (!transient || attempt === MAX_ATTEMPTS - 1) throw e;
        // Exponential backoff 2s→4s→8s→16s so a transient overload is ridden out.
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  }
  if (!stream) throw lastErr ?? new Error("stream init failed");
  yield { t: "model", model: usedModel };

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
