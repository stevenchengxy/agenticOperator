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
  /** The real client this tool wraps — its module path + export name. Used by
   *  the agent code generator (specToAgentCode) to emit a native import +
   *  call (`import { parseResumeDirect } from '@/lib/robohire-client'`) instead
   *  of an opaque registry lookup, so generated code reads like a real agent. */
  impl?: { module: string; export: string };
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

// Generic stop-tokens that carry no disambiguating signal in a tool name. Kept
// small + verb/scaffolding-only so real nouns (resume/candidate/jd/match) stay.
const TOOL_STOP_TOKENS = new Set([
  "get", "fetch", "query", "read", "load", "run", "do", "check", "status",
  "record", "file", "content", "data", "info", "the", "by", "of", "to", "for",
  "value", "entity", "entities", "instance", "result", "results", "list",
]);

/** camelCase / snake / dot / space → lowercase NFKC tokens. Handles both
 *  camel boundaries ("generateJd"→"generate jd") and acronym→word boundaries
 *  ("JDContent"→"JD Content") so "generateJDContent" → [generate, jd, content]. */
function toTokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._\-/\s]+/g, " ")
    .normalize("NFKC")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

/** The meaningful tokens of a CATALOG tool name = tokens AFTER the family
 *  prefix (the part after the first dot), minus generic stop-tokens. The LLM
 *  almost never reproduces the namespace ("robohire."), so we match on the
 *  meaningful tail only. e.g. "robohire.parseResume" → ["parse","resume"]. */
function catalogContentTokens(name: string): string[] {
  const tail = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
  return toTokens(tail).filter((t) => !TOOL_STOP_TOKENS.has(t));
}

/** Resolve a raw ontology `tool_use[]` / LLM-authored tool name to a registry
 *  tool name. Exact → normalized-contains → conservative token-superset fuzzy.
 *
 *  The fuzzy fallback (Fix #2) only fires when a catalog tool's WHOLE meaningful
 *  name is contained in the query's tokens — so an LLM-invented variant like
 *  "parseResumeFile" resolves to "robohire.parseResume", but "checkBlacklist"
 *  (no blacklist tool exists) stays unresolved instead of binding a wrong tool.
 *  This is what stops generated agents from binding ZERO real tools. */
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
  if (best) return best;

  // Conservative token-superset fuzzy. Query tokens (all of them) must be a
  // SUPERSET of some catalog tool's meaningful tokens. Pick the most specific
  // (most content tokens) match; never bind on a single 1-3 char token.
  const queryTokens = new Set(toTokens(raw));
  if (!queryTokens.size) return undefined;
  let bestName: string | undefined;
  let bestLen = 0;
  for (const name of registry.names()) {
    const content = catalogContentTokens(name);
    if (!content.length) continue;
    const covered = content.every((t) => queryTokens.has(t));
    if (!covered) continue;
    // Guard against a single short token producing spurious matches.
    if (content.length === 1 && content[0].length < 4) continue;
    if (content.length > bestLen) { bestLen = content.length; bestName = name; }
  }
  return bestName;
}

/** Rank the real catalog against an ontology action, returning the top-N tool
 *  names most relevant to it (Fix #2 grounding). Used by read_ontology to hand
 *  the brain CONCRETE candidates (so it picks real namespaced names instead of
 *  inventing them) and by design_agent to floor an agent with real tools when
 *  the LLM's picks don't resolve. Domain-general: scores the action's name +
 *  target_objects token-overlap against each tool's full name + title +
 *  description. */
export function suggestToolsForAction(
  action: { name?: string; target_objects?: string[] },
  registry: ToolRegistry,
  limit = 5,
): string[] {
  const nameTokens = new Set(toTokens(action.name ?? "").filter((t) => !TOOL_STOP_TOKENS.has(t)));
  const objTokens = new Set((action.target_objects ?? []).flatMap((o) => toTokens(o)));
  const scored: Array<{ name: string; score: number }> = [];
  for (const t of registry.list()) {
    const toolNameTokens = new Set(toTokens(t.name)); // full name incl. family
    const haystack = `${t.name} ${t.title ?? ""} ${t.description ?? ""}`.toLowerCase();
    let score = 0;
    for (const tok of nameTokens) {
      if (toolNameTokens.has(tok)) score += 3;        // action verb/noun in tool name — strong
      else if (haystack.includes(tok)) score += 1;
    }
    for (const tok of objTokens) {
      if (toolNameTokens.has(tok)) score += 2;        // target object in tool name
      else if (tok.length >= 3 && haystack.includes(tok)) score += 1;
    }
    if (score > 0) scored.push({ name: t.name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

export interface ToolGrounding {
  /** picks that are exact real catalog names (the LLM used the real name) */
  exact: string[];
  /** picks that were a non-real name BRIDGED to a real tool (the LLM wrote a
   *  variant like "parseResumeFile" → "robohire.parseResume") */
  bridged: Array<{ raw: string; resolved: string }>;
  /** picks with no real tool at all — a capability gap, not a wrong bind */
  unresolved: string[];
}

/** P1 — De-Hallucinator grounding signal. Classify each LLM-authored tool pick as
 *  exact / bridged / unresolved against the live registry, so a bridged or missing
 *  bind becomes VISIBLE to the brain (it can confirm or re-pick) instead of the
 *  fuzzy resolver silently shipping a guessed binding. Reuses resolveToolName so it
 *  can never drift from the actual resolution. */
export function groundToolPicks(rawPicks: string[], registry: ToolRegistry): ToolGrounding {
  const exact: string[] = [];
  const bridged: Array<{ raw: string; resolved: string }> = [];
  const unresolved: string[] = [];
  for (const raw of rawPicks) {
    if (!raw) continue;
    const resolved = resolveToolName(raw, registry);
    if (!resolved) unresolved.push(raw);
    else if (resolved === raw) exact.push(resolved);
    else bridged.push({ raw, resolved });
  }
  return { exact, bridged, unresolved };
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
