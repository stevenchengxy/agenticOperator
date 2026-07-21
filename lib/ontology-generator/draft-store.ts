// Shared helpers for the Fleet「部署智能体」draft store. These operate ONLY on
// ontology-generated shell AgentVersion rows (capturedFrom='ontology-gen'), so
// nothing here can ever read or mutate a real production agent.

import type { AgentDraftRow, DraftLifecycle, ShellCardData } from "./types";
import { RECRUITMENT_DOMAIN_ID } from "@/lib/domain-ids";

export const ONTOLOGY_GEN_SOURCE = "ontology-gen";
// A lifecycle override for a REAL production agent (AGENT_MAP). The agent's
// definition stays in code; this row only carries its managed status (draft /
// offline / archived) so the Fleet can manage + recycle-bin it without ever
// touching the registered Inngest function.
export const REAL_AGENT_SOURCE = "real-agent";
// Both are operator-manageable (deploy/draft/archive/restore). A real production
// CONFIG snapshot (capturedFrom='current-config'/'manual'/'codegen') is NOT.
export const MANAGED_SOURCES: string[] = [ONTOLOGY_GEN_SOURCE, REAL_AGENT_SOURCE];

/** Synthetic drafts-row id for a real agent that has no override row yet. The
 *  management endpoints recognize it and create the override on first action. */
export function realAgentId(domain: string, short: string): string {
  return `real:${domain}:${short}`;
}

/** Parse a synthetic real-agent id → {domain, short}, or null for a normal id. */
export function parseRealAgentId(id: string): { domain: string; short: string } | null {
  if (!id.startsWith("real:")) return null;
  const rest = id.slice("real:".length);
  const i = rest.lastIndexOf(":"); // short has no ':'; domain (招聘-v1) has none either
  if (i < 0) return null;
  return { domain: rest.slice(0, i), short: rest.slice(i + 1) };
}

/** Stable versionLabel for a real agent's lifecycle override (one per short+domain). */
export function realOverrideLabel(domain: string): string {
  return `override:${domain}`;
}

const FALLBACK_CARD: ShellCardData = {
  nameZh: "未命名智能体",
  nameEn: "Unnamed agent",
  agentId: "Agent",
  descZh: "",
  descEn: "",
  triggerEvent: "—",
  emitEvent: "—",
  confidence: 0,
  iconChar: "智",
  iconColor: "oklch(0.62 0.17 285)",
};

function parseCard(configJson: string | null): ShellCardData {
  if (!configJson) return FALLBACK_CARD;
  try {
    const c = JSON.parse(configJson) as Partial<ShellCardData>;
    return { ...FALLBACK_CARD, ...c };
  } catch {
    return FALLBACK_CARD;
  }
}

function normalizeStatus(status: string): DraftLifecycle {
  return status === "active" || status === "offline" ? status : "draft";
}

/** The minimal AgentVersion shape this module reads. */
export type ShellVersionRow = {
  id: string;
  short: string;
  slug: string;
  domain: string | null;
  versionLabel: string;
  status: string;
  configJson: string | null;
  createdAt: Date;
};

export function rowToDraftRow(row: ShellVersionRow): AgentDraftRow {
  const card = parseCard(row.configJson);
  return {
    ...card,
    id: row.id,
    short: row.short,
    slug: row.slug,
    domain: row.domain ?? RECRUITMENT_DOMAIN_ID,
    versionLabel: row.versionLabel,
    status: normalizeStatus(row.status),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Allowed lifecycle transitions for a shell agent (control-plane only). */
export function isValidTransition(to: unknown): to is DraftLifecycle {
  return to === "draft" || to === "active" || to === "offline";
}
