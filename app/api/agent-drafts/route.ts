// GET /api/agent-drafts?domain=X            — manageable agents in a domain
// GET /api/agent-drafts?domain=X&recycled=1 — the recycle bin (archived) instead
//
// Returns BOTH ontology-generated shells AND the domain's REAL production agents
// merged with any lifecycle override, so the Fleet「部署智能体」store can manage
// all of them (deploy / online / offline / 放回草稿 / 删除→回收站 / 恢复).
// Soft-deleted agents (status='archived') live in the recycle bin.
//
// "Real production agents" = AGENT_MAP entries that map to a registered Inngest
// function (hasRealInngestFn → carry an inngestId). The legacy design-era roster
// (stub/unbuilt AGENT_MAP entries, e.g. ReqSync/Clarifier/…) is intentionally
// EXCLUDED so the panel reflects the agents we actually have, not the old DAG.

import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { AGENT_MAP, displayName as agentDisplayName, hasRealInngestFn } from "@/lib/agent-mapping";
import {
  ONTOLOGY_GEN_SOURCE,
  REAL_AGENT_SOURCE,
  realAgentId,
  rowToDraftRow,
  type ShellVersionRow,
} from "@/lib/ontology-generator/draft-store";
import type { AgentDraftRow, AgentDraftsResponse, DraftLifecycle } from "@/lib/ontology-generator/types";

export const dynamic = "force-dynamic";

const REAL_ICON_COLOR = "oklch(0.62 0.17 268)";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const domainParam = url.searchParams.get("domain")?.trim() || null;
  const recycled = url.searchParams.get("recycled") === "1";

  // All managed AgentVersion rows for the scope (shells + real-agent overrides).
  const versions = (await prisma.agentVersion.findMany({
    where: {
      capturedFrom: { in: [ONTOLOGY_GEN_SOURCE, REAL_AGENT_SOURCE] },
      domain: domainParam ? domainParam : { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, short: true, slug: true, domain: true, versionLabel: true,
      status: true, configJson: true, createdAt: true, archivedAt: true, capturedFrom: true,
    },
  })) as Array<ShellVersionRow & { archivedAt: Date | null; capturedFrom: string }>;

  // Newest override per (domain, short) for real agents.
  const overrideByKey = new Map<string, (typeof versions)[number]>();
  for (const v of versions) {
    if (v.capturedFrom === REAL_AGENT_SOURCE) {
      const key = `${v.domain}::${v.short}`;
      if (!overrideByKey.has(key)) overrideByKey.set(key, v);
    }
  }

  const wantArchived = (s: string) => (recycled ? s === "archived" : s !== "archived");

  const rows: AgentDraftRow[] = [];

  // 1. Ontology shells.
  for (const v of versions) {
    if (v.capturedFrom !== ONTOLOGY_GEN_SOURCE) continue;
    if (!wantArchived(v.status)) continue;
    rows.push({
      ...rowToDraftRow(v),
      kind: "shell",
      archivedAt: v.archivedAt ? v.archivedAt.toISOString() : null,
    });
  }

  // 2. Real production agents (AGENT_MAP) for the domain, merged with overrides.
  //    Only agents backed by a registered Inngest function (hasRealInngestFn) are
  //    listed — the legacy design-era roster (stub/unbuilt shorts) is skipped so
  //    the panel shows exactly the agents we actually have.
  for (const a of AGENT_MAP) {
    if (a.short === "Chatbot") continue;
    if (!hasRealInngestFn(a.short)) continue;
    if (domainParam && a.domain !== domainParam) continue;
    const ov = overrideByKey.get(`${a.domain}::${a.short}`);
    const status: DraftLifecycle = (ov?.status as DraftLifecycle) ?? "active"; // no override → live
    if (!wantArchived(status)) continue;
    // Prefer an operator-set display name (override configJson.nameZh) over the
    // built-in AGENT_MAP name, so a renamed real agent reads consistently here.
    let name = agentDisplayName(a.short);
    if (ov?.configJson) {
      try {
        const c = JSON.parse(ov.configJson) as { nameZh?: unknown };
        if (typeof c.nameZh === "string" && c.nameZh.trim()) name = c.nameZh.trim();
      } catch { /* keep default */ }
    }
    rows.push({
      id: ov?.id ?? realAgentId(a.domain, a.short),
      short: a.short,
      slug: ov?.slug ?? a.inngestName ?? a.short,
      domain: a.domain,
      versionLabel: ov?.versionLabel ?? a.version ?? "real",
      status,
      createdAt: (ov?.createdAt ? new Date(ov.createdAt) : new Date(0)).toISOString(),
      kind: "real",
      archivedAt: ov?.archivedAt ? ov.archivedAt.toISOString() : null,
      nameZh: name,
      nameEn: a.short,
      agentId: a.short,
      descZh: "",
      descEn: "",
      triggerEvent: a.triggersEvents?.[0] ?? "—",
      emitEvent: a.emitsEvents?.[0] ?? "—",
      confidence: 100,
      iconChar: name.slice(0, 1),
      iconColor: REAL_ICON_COLOR,
    });
  }

  const result: AgentDraftsResponse = { rows };
  return NextResponse.json(result);
}
