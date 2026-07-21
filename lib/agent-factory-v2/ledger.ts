import { chatComplete, isGatewayConfigured } from "@/server/llm/gateway";
import type { BuilderCtx } from "./types";

// ── LLM call reliability ─────────────────────────────────────────────────────
// The builders fan out (4 facet analysts at once, then every target agent's
// ToolSmith→PromptWriter→Critic via Promise.all). Firing dozens of concurrent
// requests trips the proxy's rate limit; with no retry, each failure silently
// collapsed to a DETERMINISTIC FALLBACK (degraded=true) — i.e. fake reasoning.
// Two guards make calls actually reach the LLM: a concurrency cap + retry.

const MAX_CONCURRENT_LLM = 4;
let activeLlm = 0;
const llmWaiters: Array<() => void> = [];

/** Run `fn` holding one of MAX_CONCURRENT_LLM slots (FIFO queue when full). */
async function withLlmSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeLlm >= MAX_CONCURRENT_LLM) {
    await new Promise<void>((resolve) => llmWaiters.push(resolve));
  }
  activeLlm++;
  try {
    return await fn();
  } finally {
    activeLlm--;
    const next = llmWaiters.shift();
    if (next) next();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** chatComplete with retry + backoff. Returns the result, or null only after
 *  every attempt fails (the caller then — and only then — uses the fallback).
 *  Transient rate-limit / network failures are what used to fake the reasoning. */
async function chatCompleteRetry(
  args: Parameters<typeof chatComplete>[0],
  attempts = 3,
): Promise<Awaited<ReturnType<typeof chatComplete>> | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await chatComplete(args);
    } catch {
      if (i < attempts - 1) await sleep(500 * (i + 1) + Math.floor(Math.random() * 250));
    }
  }
  return null;
}

export interface LlmCallRow {
  runId: string; builder: string; target: string | null; purpose: string;
  systemPrompt: string; userPrompt: string; responseText: string;
  model: string | null; promptTokens: number; completionTokens: number; latencyMs: number; degraded: boolean;
}
export type PersistLlmCall = (row: LlmCallRow) => Promise<void>;

interface Args {
  builder: string; target: string | null; purpose: string;
  system: string; user: string;
  persist: PersistLlmCall;
  maxTokens?: number;
}

/** The ONLY way a builder calls the LLM. **NO fallback by design**: every call is
 *  a real LLM call or it THROWS — so nothing deterministic is ever dressed up as
 *  LLM reasoning. Bounded concurrency + retry absorb transient rate-limit/network
 *  blips; a genuine failure surfaces as a build error (the user asked for this).
 *  Records the FULL input+output, emits an `llm` BuildEvent, charges budget. */
export async function recordLlmCall(ctx: BuilderCtx, a: Args): Promise<{ text: string }> {
  if (!isGatewayConfigured()) {
    throw new Error(`LLM 网关未配置(AI_BASE_URL/AI_API_KEY 缺失)——无降级,${a.builder}/${a.purpose} 直接报错`);
  }
  if (ctx.spent.calls >= ctx.budget.maxLlmCalls) {
    throw new Error(`LLM 调用数超预算(${ctx.budget.maxLlmCalls})—— ${a.builder}/${a.purpose}`);
  }
  if (ctx.spent.tokens >= ctx.budget.maxTokens) {
    throw new Error(`LLM token 超预算(${ctx.budget.maxTokens})—— ${a.builder}/${a.purpose}`);
  }

  const started = Date.now();
  const r = await withLlmSlot(() =>
    chatCompleteRetry({ system: a.system, user: a.user, maxTokens: a.maxTokens ?? 900, toolName: `factory2.${a.builder}` }),
  );
  if (!r) {
    throw new Error(`LLM 调用失败(重试 3 次仍失败)—— ${a.builder}/${a.purpose}`);
  }
  const text = (r.text ?? "").trim();
  if (!text) {
    throw new Error(`LLM 返回空响应 —— ${a.builder}/${a.purpose}`);
  }

  const model = (r as { modelUsed?: string }).modelUsed ?? null;
  // Support both snake_case (test mocks) and camelCase (real gateway) usage fields
  const u = r.usage as {
    prompt_tokens?: number; completion_tokens?: number;
    promptTokens?: number; completionTokens?: number;
  } | undefined;
  const pt = u?.prompt_tokens ?? u?.promptTokens ?? 0;
  const ct = u?.completion_tokens ?? u?.completionTokens ?? 0;
  const latencyMs = Date.now() - started;

  ctx.spent.calls += 1;
  ctx.spent.tokens += pt + ct;
  await a.persist({
    runId: ctx.runId, builder: a.builder, target: a.target, purpose: a.purpose,
    systemPrompt: a.system, userPrompt: a.user, responseText: text,
    model, promptTokens: pt, completionTokens: ct, latencyMs, degraded: false,
  });
  // Emit the FULL input+output (generously capped) so the 推理 panel shows the
  // exact prompt/response of every builder call — always a real LLM call now.
  const cap = (s: string, n = 12000): string => (s.length > n ? `${s.slice(0, n)}\n…[+${s.length - n} chars]` : s);
  ctx.emit({
    t: "llm", builder: a.builder, target: a.target, purpose: a.purpose, degraded: false,
    promptChars: a.system.length + a.user.length, responseChars: text.length, latencyMs,
    system: cap(a.system), user: cap(a.user), response: cap(text), model,
  });
  return { text };
}
