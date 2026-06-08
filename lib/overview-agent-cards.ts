// Overview「智能体健康」roster builder.
//
// The /overview health grid used to enumerate its agents from the hardcoded
// AGENT_MAP (recruitment-only), so non-recruitment business domains — energy
// (能源调度-v1), cost-control (费控-v1) — rendered an EMPTY grid even though
// their agents are registered on Inngest as their own apps
// (agentic-operator-<domain>) and already surface in /api/agents with the
// right `domain`.
//
// This helper builds the per-domain card roster from the live /api/agents rows
// (same source Fleet uses), so every business domain's agents show up and stay
// in sync with what's actually registered on Inngest. Pure + server-safe so it
// can be unit-tested without the React tree.

import type { AgentRow } from "@/lib/api/types";
import type { AgentHealth } from "@/app/api/agents/health/route";
import type { Stage } from "@/lib/agent-mapping";

export type OverviewAgentCard = {
  short: string;
  /** Already-localized business name (resolver result, with ontology fallback). */
  name: string;
  stage: Stage;
  kind: "real" | "shell" | "unbuilt";
  paused: boolean;
  health: AgentHealth | null;
};

/** online (0) < paused (1) < unbuilt/offline (2) — drives sort + status pill. */
export function statusOrder(c: Pick<OverviewAgentCard, "kind" | "paused">): number {
  if (c.kind === "unbuilt") return 2;
  if (c.paused) return 1;
  return 0;
}

export function agentStatus(
  c: Pick<OverviewAgentCard, "kind" | "paused">,
): "online" | "offline" | "paused" {
  if (c.kind === "unbuilt") return "offline";
  if (c.paused) return "paused";
  return "online";
}

/**
 * Build the sorted health-card roster for a business domain from the
 * /api/agents rows. Filters to the domain (Chatbot — the UI assistant — is
 * never a pipeline agent, so it's dropped), resolves a display name (falling
 * back to the row's own `displayName` for ontology-generated agents the
 * bilingual resolver doesn't know), and sorts online → paused → offline, then
 * by recent activity within each band.
 */
export function buildOverviewAgentCards(
  rows: AgentRow[],
  domain: string,
  healthByShort: Map<string, AgentHealth>,
  resolveName: (short: string) => string,
): OverviewAgentCard[] {
  return rows
    .filter((a) => a.domain === domain && a.short !== "Chatbot")
    .map((a) => {
      // resolveName knows the recruitment roster; for ontology agents
      // (energy / feikong) it echoes the short back, so fall back to the
      // row's own business name rather than show a raw camelCase short.
      const resolved = resolveName(a.short);
      const name = resolved && resolved !== a.short ? resolved : a.displayName || a.short;
      return {
        short: a.short,
        name,
        stage: a.stage,
        kind: a.realness,
        paused: a.paused,
        health: healthByShort.get(a.short) ?? null,
      };
    })
    .sort((x, y) => {
      // online > paused > unbuilt; within a band, more recent runs first.
      const rx = statusOrder(x);
      const ry = statusOrder(y);
      if (rx !== ry) return rx - ry;
      return (y.health?.counts.started ?? 0) - (x.health?.counts.started ?? 0);
    });
}
