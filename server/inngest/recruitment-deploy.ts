// Ensure the recruitment domain's real production agents are seeded as managed
// AgentVersion rows, so the Fleet「部署智能体」deploy panel is DB-backed and the
// recruitment app is durably defined by exactly these agents — not the legacy
// design-era roster and never the energy-dispatch agents.
//
// Mirrors server/inngest/domains/energy/deploy.ts (ensureEnergyDeployed), but for
// the real recruitment agents (the AGENT_MAP entries that carry an inngestId).
// The rows use capturedFrom='real-agent' + versionLabel='override:招聘-v1', the
// same lifecycle-override shape the Fleet panel reads/writes (see
// lib/ontology-generator/draft-store.ts, app/api/agent-drafts/*).
//
// Idempotent + non-destructive to operator state:
//   • create a row (status 'active') only when one is missing — an existing row's
//     status (offline / draft / archived in the recycle bin) is preserved, so a
//     boot re-seed never clobbers a deliberate online/offline/删除 choice;
//   • prune any recruitment real-agent override whose `short` is NOT one of the
//     real agents (stale rows like a legacy `ReqSync` override) so the panel and
//     DB reflect only the agents we actually have.

import { prisma } from "@/server/db";
import { AGENT_MAP, displayName } from "@/lib/agent-mapping";
import { RECRUITMENT_DOMAIN_ID } from "@/lib/domain-ids";
import { REAL_AGENT_SOURCE, realOverrideLabel } from "@/lib/ontology-generator/draft-store";

/** The real recruitment agents = AGENT_MAP entries in the recruitment domain that
 *  map to a registered Inngest function (carry an inngestId). */
export function realRecruitmentAgents() {
  return AGENT_MAP.filter((a) => a.domain === RECRUITMENT_DOMAIN_ID && Boolean(a.inngestId));
}

export async function ensureRecruitmentDeployed(): Promise<{ ensured: number; pruned: number; total: number }> {
  const reals = realRecruitmentAgents();
  const keep = new Set(reals.map((a) => a.short));
  const versionLabel = realOverrideLabel(RECRUITMENT_DOMAIN_ID); // 'override:招聘-v1'

  let ensured = 0;
  for (const a of reals) {
    const existing = await prisma.agentVersion.findUnique({
      where: { short_versionLabel: { short: a.short, versionLabel } },
      select: { id: true },
    });
    if (existing) continue; // preserve the operator's current lifecycle status
    await prisma.agentVersion.create({
      data: {
        short: a.short,
        slug: a.inngestId!, // the registered Inngest function id
        versionLabel,
        status: "active",
        domain: RECRUITMENT_DOMAIN_ID,
        capturedFrom: REAL_AGENT_SOURCE,
        generatedBy: "recruitment-seed",
        configJson: JSON.stringify({ nameZh: displayName(a.short), kind: "real", inngestId: a.inngestId }),
        deployedAt: new Date(),
        notes: `real-agent lifecycle override (${a.short})`,
      },
    });
    ensured++;
  }

  // Prune stale recruitment real-agent overrides that are NOT one of the real
  // agents (e.g. a legacy ReqSync override) — the recruitment app is defined by
  // exactly the real agents.
  const stale = await prisma.agentVersion.findMany({
    where: {
      capturedFrom: REAL_AGENT_SOURCE,
      domain: RECRUITMENT_DOMAIN_ID,
      short: { notIn: [...keep] },
    },
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.agentVersion.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }

  return { ensured, pruned: stale.length, total: reals.length };
}
