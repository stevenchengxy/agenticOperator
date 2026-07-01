// GET /api/tools?domain=X — the pre-coded tool library for a domain, grouped by
// client family (robohire / partnerpg / minio / allmeta / llm / …). Read-only
// catalog: name · title · signature · read/write · required env. This is the
// HUMAN-authored I/O layer the Agent Factory composes from; agents only SELECT
// from it (they never synthesize tools).

import { NextResponse } from "next/server";
import { resolveRegistry, isForceDryRunDomain } from "@/lib/tools/resolve-registry";
import { toolFamily, toolSignature, toolParamSummary, toolReturnSummary } from "@/lib/tools/registry";
import { fetchRunnableOntology, type DomainOntology } from "@/lib/ontology-generator/ontology-source";
import { RECRUITMENT_DOMAIN_ID } from "@/lib/domain-ids";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const domain = url.searchParams.get("domain")?.trim() || RECRUITMENT_DOMAIN_ID;

  // Non-recruitment (declared-tool) domains build their registry from the
  // ontology's tool_use[]; recruitment ignores it (hand-coded library). Best-
  // effort fetch — a DB/Allmeta hiccup still yields the recruitment library.
  let ontology: DomainOntology | undefined;
  try {
    ontology = await fetchRunnableOntology(domain);
  } catch {
    ontology = undefined;
  }
  const reg = resolveRegistry(domain, ontology);

  const tools = reg.list().map((t) => ({
    name: t.name,
    family: toolFamily(t.name),
    title: t.title,
    description: t.description,
    sideEffect: t.sideEffect,
    signature: toolSignature(t),
    params: toolParamSummary(t),
    returns: toolReturnSummary(t),
    requiredEnv: t.requiredEnv ?? [],
    idempotent: !!t.idempotent,
  }));

  const byFamily = new Map<string, typeof tools>();
  for (const t of tools) {
    const arr = byFamily.get(t.family) ?? [];
    arr.push(t);
    byFamily.set(t.family, arr);
  }
  const families = [...byFamily.entries()]
    .map(([family, items]) => ({ family, items }))
    .sort((a, b) => a.family.localeCompare(b.family));

  return NextResponse.json({
    domain,
    dryRun: isForceDryRunDomain(domain),
    total: tools.length,
    families,
  });
}
