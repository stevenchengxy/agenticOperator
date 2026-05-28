// LLM gateway picker — same pattern as server/llm/jd-generator.ts so AO
// only needs one set of env vars across codegen + existing LLM consumers.
//
// Modes:
//   ① AI_BASE_URL + AI_API_KEY (+ AI_CODEGEN_MODEL || AI_MODEL) → custom gateway
//   ② OPENAI_API_KEY → direct api.openai.com with gpt-4o-mini default
//
// AI_CODEGEN_MODEL lets you point codegen at a stronger model
// (e.g. gpt-4o or claude-3-5-sonnet via a gateway) without disturbing
// the JD-gen pipeline.

import OpenAI from 'openai';

export type GatewayConfig = {
  baseURL: string;
  apiKey: string;
  model: string;
};

export function pickCodegenGateway(): GatewayConfig {
  if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
    return {
      baseURL: process.env.AI_BASE_URL,
      apiKey: process.env.AI_API_KEY,
      model:
        process.env.AI_CODEGEN_MODEL ||
        process.env.AI_MODEL ||
        'google/gemini-3-flash-preview',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      baseURL: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.AI_CODEGEN_MODEL || 'gpt-4o-mini',
    };
  }
  throw new Error(
    'LLM gateway not configured for codegen (set AI_BASE_URL+AI_API_KEY or OPENAI_API_KEY)',
  );
}

export function makeClient(g: GatewayConfig): OpenAI {
  return new OpenAI({ baseURL: g.baseURL, apiKey: g.apiKey, timeout: 300_000 });
}

// PromptGen prefers a stronger model than codegen (synthesis benefits from
// reasoning); falls back to the codegen model, then AI_MODEL.
export function pickPromptGenGateway(): GatewayConfig {
  const base = pickCodegenGateway();
  return { ...base, model: process.env.AI_PROMPTGEN_MODEL || base.model };
}
