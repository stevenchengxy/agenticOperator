"use client";
import React from "react";
import { useDomain } from "@/lib/domains";
import { isRecruitmentDomain } from "@/lib/domain-ids";
import { fetchJson } from "@/lib/api/client";
import {
  NODES,
  EDGES,
  GRAPH_WIDTH,
  GRAPH_HEIGHT,
  type WorkflowNode,
  type WorkflowEdge,
} from "@/lib/workflow-graph-meta";

// Stable empty references — returning a fresh [] each render would change
// `nodes`/`edges` identity every time and retrigger the consumer's
// positions/view reset effect in an infinite loop.
const EMPTY_NODES: WorkflowNode[] = [];
const EMPTY_EDGES: WorkflowEdge[] = [];

export type WorkflowGraphSource = "canonical" | "allmeta" | "snapshot";

export type WorkflowGraphState = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Pan/zoom WINDOW dims (aspect + scale baseline) for this domain's graph. */
  width: number;
  height: number;
  source: WorkflowGraphSource;
  isRecruitment: boolean;
  domain: string;
  loading: boolean;
  error: string | null;
};

type GraphResponse = {
  ok: true;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  width: number;
  height: number;
  source: WorkflowGraphSource;
  domain: string;
};

/**
 * The Workflow canvas graph for the active business domain.
 *
 *   - recruitment (招聘) → the authoritative hand-tuned graph, served straight
 *     from the static module import. No fetch, byte-identical to before.
 *   - any other domain → auto-laid-out from the domain ontology via
 *     /api/workflow/graph. Cleared while a new domain loads so the previous
 *     domain's graph never lingers.
 */
export function useWorkflowGraph(): WorkflowGraphState {
  const { domain } = useDomain();
  const recruitment = isRecruitmentDomain(domain);

  const [remote, setRemote] = React.useState<GraphResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (recruitment) {
      setRemote(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setRemote(null);
    setError(null);
    setLoading(true);
    fetchJson<GraphResponse>(
      `/api/workflow/graph?domain=${encodeURIComponent(domain)}`,
      { timeoutMs: 20000 },
    )
      .then((r) => {
        if (!cancelled) setRemote(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setRemote(null);
          setError((e as Error)?.message ?? "加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [domain, recruitment]);

  if (recruitment) {
    return {
      nodes: NODES,
      edges: EDGES,
      width: GRAPH_WIDTH,
      height: GRAPH_HEIGHT,
      source: "canonical",
      isRecruitment: true,
      domain,
      loading: false,
      error: null,
    };
  }

  return {
    nodes: remote?.nodes ?? EMPTY_NODES,
    edges: remote?.edges ?? EMPTY_EDGES,
    width: remote?.width ?? GRAPH_WIDTH,
    height: remote?.height ?? GRAPH_HEIGHT,
    source: remote?.source ?? "snapshot",
    isRecruitment: false,
    domain,
    loading,
    error,
  };
}
