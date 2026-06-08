// React hook — fetches /api/agents once per mount and exposes a
// Map<short, realness> + Map<short, slug> for client components that
// previously called isReal()/isShell()/deploymentKind() at render time.
//
// Why: those sync helpers read a process-module cache (populated by
// fetchLiveRegistry() server-side). In the browser the cache is empty
// → every agent shows as 'unbuilt'. This hook bridges the gap.
//
// Per spec 2026-05-24 (post-implementation fix).

"use client";
import { useEffect, useState } from "react";
import type { AgentsResponse, AgentRow } from "@/lib/api/types";

type DeploymentMap = {
  realness: Map<string, "real" | "shell" | "unbuilt">;
  slug: Map<string, string | null>;
  paused: Map<string, boolean>;
  /** Full agent rows from /api/agents — domain-scoped consumers (e.g. the
   *  /overview health grid) enumerate the per-domain roster from here so
   *  non-recruitment domains' agents show up, not just AGENT_MAP entries. */
  rows: AgentRow[];
  loading: boolean;
};

const CACHE_TTL_MS = 30_000;
let cached: { ts: number; data: DeploymentMap } | null = null;
const subscribers = new Set<(d: DeploymentMap) => void>();

function buildMap(agents: AgentsResponse["agents"]): DeploymentMap {
  const realness = new Map<string, "real" | "shell" | "unbuilt">();
  const slug = new Map<string, string | null>();
  const paused = new Map<string, boolean>();
  for (const a of agents) {
    realness.set(a.short, a.realness);
    slug.set(a.short, a.slug);
    paused.set(a.short, a.paused);
  }
  return { realness, slug, paused, rows: agents, loading: false };
}

async function doFetch(): Promise<void> {
  try {
    const r = await fetch("/api/agents");
    if (!r.ok) return;
    const j = (await r.json()) as AgentsResponse;
    const next = buildMap(j.agents);
    cached = { ts: Date.now(), data: next };
    subscribers.forEach((fn) => fn(next));
  } catch {
    // keep prior cached data
  }
}

export function useDeploymentMap(): DeploymentMap {
  const [data, setData] = useState<DeploymentMap>(
    cached && Date.now() - cached.ts < CACHE_TTL_MS
      ? cached.data
      : { realness: new Map(), slug: new Map(), paused: new Map(), rows: [], loading: true }
  );

  useEffect(() => {
    subscribers.add(setData);
    if (!cached || Date.now() - cached.ts >= CACHE_TTL_MS) {
      void doFetch();
    }
    return () => {
      subscribers.delete(setData);
    };
  }, []);

  return data;
}
