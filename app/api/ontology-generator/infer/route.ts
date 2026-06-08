// POST /api/ontology-generator/infer
//
// Body:  { domainId: string }
// Reply: InferResult — { domainId, counts, candidates, danglingEvents }
//
// The "real ontology read" half of the Ontology Generator: inferAgents runs real
// dangling-event gap analysis over the live event catalog and returns the
// domain's (curated) candidate agents annotated with ontology grounding.

import { NextResponse } from "next/server";
import { inferAgents, buildInferResult } from "@/lib/ontology-generator/infer";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import { DEFAULT_DOMAIN_ID } from "@/lib/ontology-generator/profiles";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let domainId = DEFAULT_DOMAIN_ID;
  let domainName: string | undefined;
  try {
    const body = (await req.json()) as { domainId?: unknown; domainName?: unknown };
    if (typeof body?.domainId === "string" && body.domainId.trim()) {
      domainId = body.domainId.trim();
    }
    if (typeof body?.domainName === "string" && body.domainName.trim()) {
      domainName = body.domainName.trim();
    }
  } catch {
    // empty / invalid body → default domain
  }
  // Read the domain's RUNNABLE ontology: a snapshot-shipping domain (energy /
  // 费控) is a runnable pack whose snapshot is authoritative — infer must read
  // it, not the richer-but-non-runnable live Allmeta draft, so the candidates
  // line up 1:1 with what the generate step deploys (and what actually runs).
  // Domains with no snapshot read live Allmeta. Only a domain with no ontology
  // at all falls back to the legacy curated profile.
  const onto = await fetchRunnableOntology(domainId);
  if (onto.actions.length > 0) {
    return NextResponse.json(buildInferResult(onto));
  }
  return NextResponse.json(inferAgents(domainId, domainName));
}
