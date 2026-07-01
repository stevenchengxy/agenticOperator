// Agent Registry (blueprint P1 — the geological foundation).
//
// ONE catalog of every agent the system can wire into a chain, from BOTH sources:
//   · generated  — the factory's output, persisted as AgentVersion rows (rich
//                   specJson carries the full event signature + I/O schema).
//   · handwritten — the preset library (server/inngest/agents/*.ts), declared in
//                   the curated PRESET_AGENTS manifest below (hand-written agents
//                   are curated anyway, so a curated descriptor is the honest way;
//                   the signatures here are read from the real createFunction
//                   triggers + their emitted events).
//
// The Selection Harness queries this; the Meta-Orchestrator reads it to decide
// build-vs-reuse; the factory writes into it (via AgentVersion) when it ships.

import { prisma } from "@/server/db";
import { AGENT_MAP, displayName } from "@/lib/agent-mapping";
import { extractAgentTools } from "./agent-source-scan";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import type { RegistryAgent } from "./types";

/** The preset (hand-written) library — DERIVED from AGENT_MAP, the authoritative
 *  registry of the real production agents + their event signatures. NOT a
 *  hand-maintained manifest: that drifts (the manual one had RESUME_LOCKED_CONFLICT
 *  and JD_GENERATION_REQUESTED, both wrong vs the real agents). Reading AGENT_MAP
 *  means the preset signatures are always exactly what the deployed agents declare.
 *
 *  We include only entries with a real `inngestId` — those are deployable, proven
 *  agents that can genuinely be REUSED. Declared-but-unimplemented shells (no
 *  inngestId) are excluded: binding one would wire a non-existent implementation. */
export const PRESET_AGENTS: RegistryAgent[] = AGENT_MAP
  .filter((a) => a.inngestId && ((a.triggersEvents?.length ?? 0) + (a.emitsEvents?.length ?? 0) > 0))
  .map((a) => ({
    id: a.inngestId!,
    name: displayName(a.short),
    source: "handwritten" as const,
    domain: a.domain,
    capability: `${displayName(a.short)}（${a.stage} 阶段${a.auditOnly ? " · 审计" : ""}）`,
    triggerEvents: a.triggersEvents ?? [],
    emitEvents: a.emitsEvents ?? [],
    // reverse-engineered from the real agent source, so a reused real agent carries
    // its actual tools (and scores real tool-coverage against the gold standard).
    tools: extractAgentTools(a.inngestId!, a.short),
    codeRef: `@/server/inngest (${a.inngestId})`,
    status: "preset",
    sandboxProven: true, // production-deployed → proven
  }));

/** normalize a domain id for loose matching across the split ids (招聘-v1 /
 *  recruit-gen-v1 / Agents-generation / RAAS-v1 are "the same" recruitment). */
function normDomain(d: string): string {
  return (d || "").toLowerCase().replace(/[^a-z0-9一-龥]/g, "");
}
const RECRUIT_ALIASES = ["招聘-v1", "recruit-gen-v1", "agents-generation", "raas-v1"].map(normDomain);
export function domainMatches(agentDomain: string, want: string): boolean {
  if (!want) return true;
  const a = normDomain(agentDomain), w = normDomain(want);
  if (a === w || a.includes(w) || w.includes(a)) return true;
  // recruitment family: any recruitment alias matches any other
  return RECRUIT_ALIASES.includes(a) && RECRUIT_ALIASES.includes(w);
}

/** Pull the factory's generated agents from AgentVersion (latest version per slug). */
export async function collectGeneratedAgents(domain?: string): Promise<RegistryAgent[]> {
  let rows: Array<{ id: string; short: string; slug: string; domain: string | null; status: string; versionLabel: string; specJson: string | null; capturedFrom: string | null }>;
  try {
    rows = await prisma.agentVersion.findMany({
      where: { ...(domain ? { domain } : {}), status: { in: ["draft", "active", "offline"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, short: true, slug: true, domain: true, status: true, versionLabel: true, specJson: true, capturedFrom: true },
      take: 500,
    });
  } catch {
    return []; // DB unreachable / table missing → registry still serves presets
  }
  const out: RegistryAgent[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.slug)) continue; // keep latest version per slug
    seen.add(r.slug);
    // The hand-written agents are ALSO mirrored into AgentVersion as override rows
    // (capturedFrom='real-agent', versionLabel='override:…') for monitoring — but they
    // carry a different specJson shape with no event signature. They're already in
    // PRESET_AGENTS, so skip them here to avoid duplicate, signatureless registry nodes.
    if (r.capturedFrom === "real-agent" || r.versionLabel?.startsWith("override:")) continue;
    let spec: Partial<GeneratedAgentSpec> = {};
    try { spec = r.specJson ? (JSON.parse(r.specJson) as Partial<GeneratedAgentSpec>) : {}; } catch { /* keep empty */ }
    const trigger = spec.trigger ?? [];
    const emit = spec.emit ?? [];
    // A registry node with no event signature can't be selected or composed into a
    // chain — drop it rather than surface a useless "→" node.
    if (trigger.length === 0 && emit.length === 0) continue;
    out.push({
      id: r.id,
      name: spec.nameZh || r.short,
      source: "generated",
      domain: r.domain || spec.domainId || "",
      capability: (spec.systemPrompt || "").replace(/\s+/g, " ").slice(0, 90) || r.short,
      triggerEvents: trigger,
      emitEvents: emit,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      tools: spec.tools ?? [],
      codeRef: r.id,
      version: r.versionLabel,
      status: r.status,
      // Sedimentation: the factory only persists (capturedFrom='ontology-gen') AFTER
      // the behavioral finish gate proved the chain ran end-to-end — so a persisted
      // generated agent is sandbox-proven and a valid REUSE candidate next run. The
      // closed loop: generate → gate → AgentVersion → registry → selection reuses it.
      sandboxProven: r.status === "active" || r.capturedFrom === "ontology-gen",
    });
  }
  return out;
}

/** The full catalog: preset (domain-filtered) ∪ generated. */
export async function listRegistryAgents(domain?: string): Promise<RegistryAgent[]> {
  const generated = await collectGeneratedAgents(domain);
  const preset = domain ? PRESET_AGENTS.filter((p) => domainMatches(p.domain, domain)) : PRESET_AGENTS;
  return [...preset, ...generated];
}
