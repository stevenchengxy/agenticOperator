// GET /api/workflow/graph?domain=<id>
//
// Returns the workflow DAG for a business domain, in the shape the Workflow
// canvas (components/workflow/WorkflowContent.tsx) renders:
//   { nodes: WorkflowNode[], edges: WorkflowEdge[], width, height, source }
//
//   - recruitment (招聘) → the authoritative hand-tuned graph from
//     workflow-graph-meta (identical to what the page imports statically and
//     what the Monitor subsystem uses). Served here too so the endpoint is
//     domain-complete, but the page short-circuits recruitment client-side.
//   - any other domain (费控 / 能源调度 / …) → auto-laid-out from that domain's
//     ontology actions + events. Snapshot-shipping domains are runnable packs:
//     we read their authoritative snapshot (which the registered functions +
//     curated Chinese labels are keyed to), not the richer-but-non-runnable
//     live Allmeta draft. Snapshot-less domains read live Allmeta.

import { NextResponse } from "next/server";
import { isRecruitmentDomain } from "@/lib/domain-ids";
import {
  NODES,
  EDGES,
  GRAPH_WIDTH,
  GRAPH_HEIGHT,
  type WorkflowNode,
  type WorkflowEdge,
} from "@/lib/workflow-graph-meta";
import { fetchRunnableOntology } from "@/lib/ontology-generator/ontology-source";
import { buildWorkflowGraph } from "@/lib/workflow-graph-build";

export const dynamic = "force-dynamic";

type GraphResponse = {
  ok: true;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  width: number;
  height: number;
  source: "canonical" | "allmeta" | "snapshot";
  domain: string;
};
type Failure = { ok: false; error: string };

export async function GET(req: Request): Promise<Response> {
  const domain = new URL(req.url).searchParams.get("domain")?.trim() ?? "";
  try {
    if (isRecruitmentDomain(domain)) {
      return NextResponse.json<GraphResponse>({
        ok: true,
        nodes: NODES,
        edges: EDGES,
        width: GRAPH_WIDTH,
        height: GRAPH_HEIGHT,
        source: "canonical",
        domain,
      });
    }

    const onto = await fetchRunnableOntology(domain);
    const graph = buildWorkflowGraph(onto);
    return NextResponse.json<GraphResponse>({
      ok: true,
      nodes: graph.nodes,
      edges: graph.edges,
      width: graph.width,
      height: graph.height,
      source: onto.source,
      domain,
    });
  } catch (e) {
    return NextResponse.json<Failure>(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
