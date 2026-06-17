// Per-domain tool-registry resolver. The factory used to hard-wire the
// recruitment registry for EVERY domain (buildRecruitmentRegistry at the
// generate + executor call sites), so a non-recruitment domain either matched
// the wrong tools or matched none. This resolves the right registry by domain:
//
//   recruitment domains (招聘-v1 / raas) + the recruit-gen-v1 test domain
//        → the hand-coded recruitment tool library (buildRecruitmentRegistry)
//   any other domain
//        → a generic registry built from the ontology's DECLARED tool_use[]
//          (dry-run-only mock executors) so generation still validates and the
//          generated agent is honestly tool-bound, instead of silently empty.
//
// The declared/generic tools are dry-run mocks ONLY — they never touch an
// external system. A real new domain that needs real side effects must add its
// own hand-coded registry here (same trust boundary as recruitment-tools.ts).

import { isRecruitmentDomain } from "@/lib/domain-ids";
import { ToolRegistry, type ToolDescriptor } from "./registry";
import { buildRecruitmentRegistry } from "./recruitment-tools";

/** The recruit-gen-v1 test domain deliberately reuses the recruitment ontology,
 *  so it composes from the same recruitment tool library. */
export const RECRUIT_GEN_DOMAIN = "recruit-gen-v1";

/** Domains whose ontology IS the recruitment 6-agent set (so they compose from
 *  the hand-coded recruitment tool library). "agents-generation" is the real
 *  Allmeta/Neo4j domain holding the recruitment ontology (the de-mocked source);
 *  its actions carry no tool_use, so the factory's ToolSmith reasons tools from
 *  this catalog. (canonical = trim+lowercase.) */
const RECRUIT_CONTENT_DOMAINS = new Set([RECRUIT_GEN_DOMAIN, "agents-generation"]);

/** Domains hard-pinned to dry-run regardless of any live flag (test domains that
 *  reuse real event names + demo payloads). agents-generation also reuses real
 *  recruitment event names, so it stays dry-run until explicitly made live. */
export const FORCE_DRYRUN_DOMAINS = new Set([RECRUIT_GEN_DOMAIN, "agents-generation"]);

/** Canonicalize an ASCII test/domain id for comparison (trim + lowercase). Only
 *  applied to the dry-run / test-domain checks — NEVER to recruitment CJK ids
 *  (招聘-v1), which `isRecruitmentDomain` matches exactly. Closes the case/
 *  whitespace bypass of the recruit-gen-v1 dry-run pin. */
export function canonicalDomain(d: string): string {
  return d.trim().toLowerCase();
}

/** True when the domain must run dry-run no matter what (case/space-insensitive). */
export function isForceDryRunDomain(d: string): boolean {
  return FORCE_DRYRUN_DOMAINS.has(canonicalDomain(d));
}

function isRecruitGenDomain(d: string): boolean {
  return RECRUIT_CONTENT_DOMAINS.has(canonicalDomain(d));
}

function inferSideEffect(name: string): ToolDescriptor["sideEffect"] {
  return /save|write|sync|invite|post|create|update|emit|delete|send/i.test(name) ? "write" : "read";
}

/** Build a generic registry from the ontology's declared tool_use[] entries.
 *  Each distinct name becomes a permissive, dry-run-only mock tool — enough for
 *  the factory to bind + validate without a hand-coded library for the domain. */
export function buildDeclaredRegistry(ontology?: { actions?: Array<{ tool_use?: string[] }> }): ToolRegistry {
  const reg = new ToolRegistry();
  const seen = new Set<string>();
  for (const a of ontology?.actions ?? []) {
    for (const t of a.tool_use ?? []) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      reg.register({
        name: t,
        title: t,
        description: `声明式工具 ${t}(按本体 tool_use 生成,dry-run mock)`,
        domain: "*",
        sideEffect: inferSideEffect(t),
        parameters: { type: "object", additionalProperties: true },
        returns: { type: "object", additionalProperties: true },
        idempotent: true,
        execute: async () => ({ __mock: true, tool: t, declared: true }),
      });
    }
  }
  return reg; // empty ontology → empty-but-valid registry (validate() then honestly flags emptyToolAgents)
}

/** Build a registry seeded from an already-bound spec's tool names. Used by the
 *  executor, which has the spec but no ontology — so dry-run tool calls still
 *  resolve for any domain without re-reading the ontology. */
export function registryFromSpecTools(toolNames: string[]): ToolRegistry {
  return buildDeclaredRegistry({ actions: [{ tool_use: toolNames }] });
}

/** Resolve the tool registry for a domain (generation-time entry point). */
export function resolveRegistry(domainId: string, ontology?: { actions?: Array<{ tool_use?: string[] }> }): ToolRegistry {
  if (isRecruitmentDomain(domainId) || isRecruitGenDomain(domainId)) return buildRecruitmentRegistry();
  return buildDeclaredRegistry(ontology);
}

/** Resolve the registry for the EXECUTOR (runtime). Recruitment uses the real
 *  library; any other domain reconstructs a dry-run registry from the spec's
 *  own bound tool names (self-contained — no ontology read at run time). */
export function resolveExecutorRegistry(domainId: string, specToolNames: string[]): ToolRegistry {
  if (isRecruitmentDomain(domainId) || isRecruitGenDomain(domainId)) return buildRecruitmentRegistry();
  return registryFromSpecTools(specToolNames);
}
