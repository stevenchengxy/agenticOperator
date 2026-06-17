// Autonomous Harness Brain — shared types.
//
// The brain is a streaming ReAct loop: it reasons, calls tools, observes, loops.
// These are the streamed events (rendered live in the chatbot) + the tool
// contract (deterministic capabilities the brain orchestrates).

import type { DomainOntology } from "@/lib/ontology-generator/ontology-source";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import type { ToolRegistry } from "@/lib/tools/registry";

/** A generated agent, trimmed for the UI card. */
export type AgentCardLite = {
  slug: string;
  short: string;
  nameZh: string;
  trigger: string[];
  emit: string[];
  tools: string[];
};

/** Streamed to the chatbot — the full live trace of the brain's reasoning + acts. */
export type BrainEvent =
  | { t: "think"; delta: string } // streamed reasoning token
  | { t: "tool.call"; id: string; name: string; reasoning: string; input: unknown }
  | { t: "tool.result"; id: string; name: string; ok: boolean; summary: string }
  | { t: "agent.created"; spec: AgentCardLite }
  | { t: "skill.created"; name: string; purpose: string }
  | { t: "web.result"; query: string; results: Array<{ title: string; url: string; snippet: string }> }
  | { t: "validation"; ok: boolean; issues: string[] }
  | { t: "sandbox"; ran: number; reachedTerminal: boolean; agents: string[]; events: string[] }
  | { t: "gate"; reason: string }
  | { t: "message"; text: string } // the brain's narration / final answer
  | { t: "done"; tokensUsed: number; turns: number }
  | { t: "error"; message: string };

export type BrainEmit = (e: BrainEvent) => void;

export interface BrainToolResult {
  ok: boolean;
  /** one-line result the model sees + the UI shows */
  summary: string;
  /** structured payload fed back to the model as the tool result */
  output?: unknown;
}

export interface BrainCtx {
  domain: string;
  goal: string;
  emit: BrainEmit;
  /** accumulated generated specs (write_agent appends here) */
  specs: GeneratedAgentSpec[];
  /** cached after read_ontology */
  ontology: DomainOntology | null;
  registry: ToolRegistry | null;
  budget: { maxTokens: number; maxTurns: number };
  spent: { tokens: number; turns: number };
}

export interface BrainTool {
  name: string;
  description: string;
  /** JSON schema for the args. MUST include a `reasoning` string so the model
   *  articulates WHY before acting (gemini emits no content before tool calls,
   *  so this is how the chatbot shows visible reasoning). */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: BrainCtx): Promise<BrainToolResult>;
}
