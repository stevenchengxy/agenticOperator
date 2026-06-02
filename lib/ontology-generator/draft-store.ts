// Shared helpers for the Fleet「部署智能体」draft store. These operate ONLY on
// ontology-generated shell AgentVersion rows (capturedFrom='ontology-gen'), so
// nothing here can ever read or mutate a real production agent.

import type { AgentDraftRow, DraftLifecycle, ShellCardData } from "./types";
import { RECRUITMENT_DOMAIN_ID } from "@/lib/domain-ids";

export const ONTOLOGY_GEN_SOURCE = "ontology-gen";

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
