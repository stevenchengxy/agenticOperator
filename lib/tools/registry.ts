// Typed tool registry — the hand-coded tools library the agent factory composes
// from. Each tool wraps an existing client method with a machine-readable JSON
// schema + side-effect metadata. One schema serves three jobs: (a) the grammar
// for schema-constrained LLM tool-calling, (b) the retrieval document for
// tool-RAG, (c) the registry index + generation-time scoping unit.
//
// The factory SELECTS/COMPOSES tools from here; it never synthesizes the I/O
// layer. Real external calls live behind `execute` (lazy import, dry-run aware),
// so importing the registry has no side effects and pulls in no heavy clients.

import type { ChatTool } from "@/server/llm/gateway";

export type ToolSideEffect = "read" | "write" | "dual-write";

export interface ToolRunCtx {
  /** When true, `execute` returns a schema-shaped mock and never touches a real
   *  external system (used by tests / shadow runs). */
  dryRun?: boolean;
  traceId?: string;
}

export interface ToolDescriptor {
  /** Stable id, e.g. "robohire.parseResume". `family` = the part before the dot. */
  name: string;
  /** Chinese display title. */
  title: string;
  /** Retrieval doc + LLM-facing description. */
  description: string;
  /** Owning domain, or "*" for cross-domain. */
  domain: string;
  /** read | write | dual-write — the gating signal for shadow suppression. */
  sideEffect: ToolSideEffect;
  /** JSON Schema for the call args (also the constrained-decoding grammar). */
  parameters: Record<string, unknown>;
  /** JSON-Schema-ish description of the return shape. */
  returns: Record<string, unknown>;
  requiredEnv?: string[];
  idempotent?: boolean;
  /** Lazy, dry-run-aware executor. */
  execute?: (args: Record<string, unknown>, ctx?: ToolRunCtx) => Promise<unknown>;
}

export function toolFamily(name: string): string {
  return name.includes(".") ? name.slice(0, name.indexOf(".")) : name;
}

type JsonSchemaish = {
  type?: string;
  properties?: Record<string, { type?: string; description?: string }>;
  required?: string[];
};

/** "candidate_id*:string, job_id:string" from a tool's parameters schema
 *  (* marks required). Used to teach the prompt + show the real call shape. */
export function toolParamSummary(t: ToolDescriptor): string {
  const s = t.parameters as JsonSchemaish;
  const props = s?.properties ?? {};
  const req = new Set(s?.required ?? []);
  const keys = Object.keys(props);
  if (!keys.length) return "—";
  return keys.map((k) => `${k}${req.has(k) ? "*" : ""}:${props[k]?.type ?? "any"}`).join(", ");
}

/** "score:number, reason:string" from a tool's returns schema. */
export function toolReturnSummary(t: ToolDescriptor): string {
  const s = t.returns as JsonSchemaish;
  const props = s?.properties ?? {};
  const keys = Object.keys(props);
  if (!keys.length) return "object";
  return keys.map((k) => `${k}:${props[k]?.type ?? "any"}`).join(", ");
}

/** "robohire.matchResume(resume*:string, jd*:string) → score:number, reason:string" */
export function toolSignature(t: ToolDescriptor): string {
  return `${t.name}(${toolParamSummary(t)}) → ${toolReturnSummary(t)}`;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDescriptor>();

  register(t: ToolDescriptor): this {
    if (this.tools.has(t.name)) throw new Error(`tool already registered: ${t.name}`);
    this.tools.set(t.name, t);
    return this;
  }
  registerAll(ts: ToolDescriptor[]): this {
    ts.forEach((t) => this.register(t));
    return this;
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }
  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }
  names(): string[] {
    return [...this.tools.keys()];
  }
  list(domain?: string): ToolDescriptor[] {
    const all = [...this.tools.values()];
    if (!domain) return all;
    return all.filter((t) => t.domain === "*" || t.domain === domain);
  }
  /** OpenAI-protocol ChatTool for one tool, for chatComplete({ tools }). */
  toChatTool(name: string): ChatTool | undefined {
    const t = this.tools.get(name);
    if (!t) return undefined;
    return {
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    };
  }
  toChatTools(names: string[]): ChatTool[] {
    return names.map((n) => this.toChatTool(n)).filter((x): x is ChatTool => !!x);
  }
}

// Unicode-aware: keep letters/numbers from ANY script (CJK included), drop only
// separators/punctuation. The /u flag is load-bearing for \p{L}\p{N}; NFKC folds
// fullwidth/compat forms. ASCII results are byte-identical to the old regex
// ("robohire.parseResume"→"robohireparseresume"), so existing matches are
// preserved — but a purely-CJK tool name no longer collapses to "".
const normalize = (s: string): string => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");

/** Resolve a raw ontology `tool_use[]` entry to a registry tool name. Exact
 *  match first, then a normalized contains-match (so "RoboHire 解析简历" or
 *  "robohire_parse" still hit "robohire.parseResume"). */
export function resolveToolName(raw: string, registry: ToolRegistry): string | undefined {
  if (registry.has(raw)) return raw;
  const nr = normalize(raw);
  if (!nr) return undefined;
  let best: string | undefined;
  for (const name of registry.names()) {
    const nn = normalize(name);
    if (nn === nr) return name;
    if (!best && (nn.includes(nr) || nr.includes(nn))) best = name;
  }
  return best;
}

export interface ToolSelection {
  /** Registry tool names the agent is equipped with (its scoped toolbox). */
  tools: string[];
  /** tool_use[] entries that did not resolve — flagged for human review. */
  unresolved: string[];
}

/** Generation-time tool scoping: map an ontology action's declared tool_use[]
 *  to concrete registry tools. This is where the factory equips a generated
 *  agent with exactly the domain-scoped toolbox (not the global catalog). */
export function selectToolsForAction(
  action: { tool_use?: string[] },
  registry: ToolRegistry,
): ToolSelection {
  const tools = new Set<string>();
  const unresolved: string[] = [];
  for (const raw of action.tool_use ?? []) {
    if (!raw) continue;
    const hit = resolveToolName(raw, registry);
    if (hit) tools.add(hit);
    else unresolved.push(raw);
  }
  return { tools: [...tools], unresolved };
}
