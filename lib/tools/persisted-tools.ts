// Persistent, AI-fillable tool library (blueprint A1/A2). A tool the AI creates is
// NOT executable code — that would be a runtime code-eval attack surface (audit's #1
// safety principle: never eval AI-written code). Instead an AI-created tool is a
// DECLARATIVE API-call spec (method / url / headers / body / response-path), stored as
// JSON, and run by ONE fixed generic executor (runHttpTool). The AI fills the spec
// from a developer doc; a human approves it; only then does it load into the registry.
//
// Persistence mirrors skills-library: tools-library/<slug>/TOOL.json.

import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolRegistry, type ToolDescriptor, type ToolSideEffect, type ToolRunCtx } from "./registry";
import { safeFetch } from "./egress-guard";

const ROOT = path.join(process.cwd(), "tools-library");
export function toolsLibraryRoot(): string { return ROOT; }

/** The declarative HTTP contract — the ONLY thing a persisted tool can "do". No code. */
export interface HttpToolSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** url template; `{arg}` ← call args, `${ENV}` ← process.env (secrets stay in env). */
  url: string;
  headers?: Record<string, string>;
  /** request body template for POST/PUT (`{arg}` substituted recursively). */
  body?: unknown;
  /** dot-path into the JSON response to return (e.g. "data.items"); omit = whole body. */
  responsePath?: string;
}

export interface PersistedToolSpec {
  name: string;               // e.g. "robohire.matchResume"
  title: string;
  description: string;
  domain: string;             // owning domain or "*"
  sideEffect: ToolSideEffect; // read | write | dual-write
  parameters: Record<string, unknown>; // JSON schema (call args)
  returns: Record<string, unknown>;    // JSON schema (return shape)
  requiredEnv?: string[];
  http: HttpToolSpec;
  version: string;
  /** human-approval gate: only approved tools load into the registry. */
  approved: boolean;
  sourceDoc?: string;         // where the contract came from (url / "upload")
  createdAt: string;          // ISO (stamped by caller; no Date in pure layer)
}

export function slugifyTool(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "tool";
}

// ── the ONE generic executor (no code-eval) ─────────────────────────────────
function interpStr(t: string, args: Record<string, unknown>): string {
  return t
    .replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => String(process.env[k] ?? ""))
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => { const v = args[k]; return v == null ? "" : String(v); });
}
function interpAny(t: unknown, args: Record<string, unknown>): unknown {
  if (typeof t === "string") return interpStr(t, args);
  if (Array.isArray(t)) return t.map((x) => interpAny(x, args));
  if (t && typeof t === "object") return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, interpAny(v, args)]));
  return t;
}
function getPath(obj: unknown, dotPath: string): unknown {
  return dotPath.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export interface RunHttpOpts { fetch?: typeof fetch }

/** Run a declarative HTTP tool spec. The whole "AI-created tool executes" story is
 *  this one fixed function — args + env interpolated into a real fetch. */
export async function runHttpTool(http: HttpToolSpec, args: Record<string, unknown>, opts: RunHttpOpts = {}): Promise<unknown> {
  const fetchFn = opts.fetch ?? fetch;
  const url = interpStr(http.url, args);
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(http.headers ?? {})) headers[k] = interpStr(v, args);
  const init: RequestInit = { method: http.method, headers };
  if (http.body != null && http.method !== "GET") init.body = JSON.stringify(interpAny(http.body, args));
  // SSRF guard (fail-closed): an AI-authored tool URL must not reach internal /
  // loopback / cloud-metadata hosts. safeFetch validates + re-checks each redirect.
  const res = await safeFetch(url, init, fetchFn);
  if (!res.ok) throw new Error(`${http.method} ${url} → HTTP ${res.status}`);
  const json = await res.json().catch(() => ({}));
  return http.responsePath ? getPath(json, http.responsePath) : json;
}

/** Build a dry-run mock from a JSON-schema-ish returns shape (so test domains work). */
export function mockFromSchema(schema: unknown): unknown {
  const s = schema as { type?: string; properties?: Record<string, unknown>; items?: unknown; description?: string };
  if (!s || typeof s !== "object") return null;
  if (s.type === "object" && s.properties) return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, mockFromSchema(v)]));
  if (s.type === "array") return [mockFromSchema(s.items)];
  if (s.type === "number") return 0;
  if (s.type === "boolean") return true;
  return s.description ? `(mock:${s.description})` : "(mock)";
}

/** Turn a persisted spec into a runnable ToolDescriptor (dry-run aware). */
export function toolFromPersisted(spec: PersistedToolSpec, opts: RunHttpOpts = {}): ToolDescriptor {
  return {
    name: spec.name, title: spec.title, description: spec.description, domain: spec.domain,
    sideEffect: spec.sideEffect, parameters: spec.parameters, returns: spec.returns,
    requiredEnv: spec.requiredEnv, idempotent: spec.http.method === "GET",
    execute: async (args: Record<string, unknown>, ctx?: ToolRunCtx) => {
      if (ctx?.dryRun) return { __mock: true, tool: spec.name, ...(mockFromSchema(spec.returns) as object) };
      return runHttpTool(spec.http, args ?? {}, opts);
    },
  };
}

// ── folder persistence ──────────────────────────────────────────────────────
export async function saveTool(spec: PersistedToolSpec): Promise<string> {
  const slug = slugifyTool(spec.name);
  const dir = path.join(ROOT, slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "TOOL.json"), JSON.stringify(spec, null, 2), "utf8");
  return slug;
}
export async function readPersistedTool(slug: string): Promise<PersistedToolSpec | null> {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, slug, "TOOL.json"), "utf8")) as PersistedToolSpec; }
  catch { return null; }
}
export async function approveTool(slug: string): Promise<boolean> {
  const t = await readPersistedTool(slug);
  if (!t) return false;
  t.approved = true;
  await saveTool(t);
  return true;
}
/** Register approved persisted tools INTO a live registry (hand-written tools win on
 *  name collision). Returns the names added. Used by read_ontology (so the brain sees
 *  them) + the executor (so deployed agents can run them). */
export async function registerPersistedInto(registry: ToolRegistry, domain: string, opts: RunHttpOpts = {}): Promise<string[]> {
  const specs = await loadPersistedTools(domain);
  const added: string[] = [];
  for (const spec of specs) {
    if (registry.has(spec.name)) continue; // hand-written / earlier registration wins
    registry.register(toolFromPersisted(spec, opts));
    added.push(spec.name);
  }
  return added;
}

/** All persisted tool specs (optionally domain-filtered). `onlyApproved` defaults true. */
export async function loadPersistedTools(domain?: string, onlyApproved = true): Promise<PersistedToolSpec[]> {
  let slugs: string[];
  try { slugs = await fs.readdir(ROOT); } catch { return []; } // no library yet
  const out: PersistedToolSpec[] = [];
  for (const slug of slugs) {
    const t = await readPersistedTool(slug);
    if (!t) continue;
    if (onlyApproved && !t.approved) continue;
    if (domain && t.domain !== "*" && t.domain !== domain) continue;
    out.push(t);
  }
  return out;
}
