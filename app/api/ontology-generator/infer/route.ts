// POST /api/ontology-generator/infer
//
// Body:  { domainId: string }
// Reply: InferResult — { domainId, counts, candidates, danglingEvents }
//
// The "real ontology read" half of the Ontology Generator: inferAgents runs real
// dangling-event gap analysis over the live event catalog and returns the
// domain's (curated) candidate agents annotated with ontology grounding.

import { NextResponse } from "next/server";
import { inferAgents, inferFromOntology, hasRealOntology } from "@/lib/ontology-generator/infer";
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
  // Domains backed by a real ontology (Allmeta domain id → in-repo snapshot /
  // live) derive candidates from the actual actions; legacy curated domains use
  // the profile-based inference.
  if (hasRealOntology(domainId)) {
    return NextResponse.json(await inferFromOntology(domainId));
  }
  return NextResponse.json(inferAgents(domainId, domainName));
}
