// Multi-harness API. Surfaces the new Tier-0/Tier-1 pieces so the UI + the
// Meta-Orchestrator (and you) can see + run them:
//   GET  /api/harness?domain=X&mode=registry → the unified Agent Registry
//   GET  /api/harness?domain=X&mode=plan      → the build-vs-reuse plan over the
//                                               domain's ontology
//   POST /api/harness {domain, dry?}          → run the FULL orchestration loop:
//        plan → dispatch generation for novel slots → compose → validate.
//        dry=true (default) uses a mock dispatch (no LLM) to prove the plumbing;
//        dry=false drives the real factory brain (live, slow).

import { listRegistryAgents } from "@/lib/agent-harness/registry";
import { orchestrate, runOrchestration, type NodeNeed } from "@/lib/agent-harness/orchestrator";
import { factoryDispatch, mockDispatch } from "@/lib/agent-harness/factory-dispatch";
import { fetchLiveOntologyStrict } from "@/lib/ontology-generator/ontology-source";

/** read the domain's required node-slots = its ontology's agent actions. */
async function ontologyNeeds(domain: string): Promise<NodeNeed[]> {
  const ont = await fetchLiveOntologyStrict(domain);
  return ont.actions
    .filter((a) => a.actor.includes("Agent"))
    .map((a) => ({ action: a.name, triggerEvents: a.trigger, emitEvents: a.triggered_event }));
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const domain = url.searchParams.get("domain") ?? "RAAS-v1";
  const mode = url.searchParams.get("mode") ?? "registry";

  if (mode === "registry") {
    const agents = await listRegistryAgents(domain);
    return Response.json({
      domain,
      count: agents.length,
      preset: agents.filter((a) => a.source === "handwritten").length,
      generated: agents.filter((a) => a.source === "generated").length,
      agents,
    });
  }

  if (mode === "plan") {
    // The orchestration plan needs the domain's required node-slots = the ontology's
    // agent actions (trigger → emit). Live Allmeta only (no snapshot), per the
    // fail-closed factory contract.
    try {
      const plan = await orchestrate(await ontologyNeeds(domain), domain);
      return Response.json({ domain, plan });
    } catch (e) {
      return Response.json({ domain, error: (e as Error).message, hint: "需要 ALLMETA_BASE_URL 可达且该域在 Neo4j 有本体" }, { status: 502 });
    }
  }

  return Response.json({ error: "mode must be 'registry' or 'plan'" }, { status: 400 });
}

/** POST /api/harness {domain, dry?} — run the full orchestration loop. */
export async function POST(req: Request): Promise<Response> {
  let body: { domain?: string; dry?: boolean };
  try { body = await req.json(); } catch { body = {}; }
  const domain = body.domain ?? "RAAS-v1";
  const dry = body.dry !== false; // default DRY (safe) — must opt in to drive the LLM
  try {
    const needs = await ontologyNeeds(domain);
    const result = await runOrchestration(needs, domain, dry ? mockDispatch : factoryDispatch);
    return Response.json({ domain, dry, result });
  } catch (e) {
    return Response.json({ domain, error: (e as Error).message, hint: "需要 ALLMETA_BASE_URL 可达且该域在 Neo4j 有本体；dry=false 还需 LLM 网关在线" }, { status: 502 });
  }
}
