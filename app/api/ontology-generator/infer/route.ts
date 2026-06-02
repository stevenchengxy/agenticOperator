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
import { fetchDomainOntology } from "@/lib/ontology-generator/ontology-source";
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
  // Read the domain's REAL ontology (live Allmeta/Neo4j → snapshot). If it has
  // actions, derive candidates from them — so selecting any deployed domain
  // shows ITS real ontology. Only domains with no ontology at all fall back to
  // the legacy curated profile.
  const onto = await fetchDomainOntology(domainId);
  if (onto.actions.length > 0) {
    return NextResponse.json(buildInferResult(onto));
  }
  return NextResponse.json(inferAgents(domainId, domainName));
}
