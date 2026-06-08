// Deploy = activate. The energy functions are always registered (ENERGY_AGENTS=1)
// but self-gate on an active AgentVersion row for (domain, short). This ensures
// every derived energy agent has an `active` row so a demo run actually fires —
// the runnable equivalent of clicking "部署" in the generator.

import { prisma } from "@/server/db";
import { ENERGY_DOMAIN_ID } from "@/lib/domain-ids";
import { energySpecs } from "./index";
import { clearActiveCache } from "./is-active";

export async function ensureEnergyDeployed(): Promise<{ deployed: number; total: number }> {
  let deployed = 0;
  for (const spec of energySpecs) {
    const existing = await prisma.agentVersion.findFirst({
      where: { domain: ENERGY_DOMAIN_ID, short: spec.short },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    if (existing?.status === "active") continue;
    if (existing) {
      await prisma.agentVersion.update({ where: { id: existing.id }, data: { status: "active", deployedAt: new Date() } });
    } else {
      await prisma.agentVersion.create({
        data: {
          short: spec.short,
          slug: spec.slug,
          versionLabel: "energy-demo-1",
          status: "active",
          domain: ENERGY_DOMAIN_ID,
          capturedFrom: "ontology-gen",
          generatedBy: "energy-demo",
          configJson: JSON.stringify({ nameZh: spec.nameZh, kind: spec.kind, action: spec.actionName }),
          deployedAt: new Date(),
        },
      });
    }
    deployed++;
  }
  clearActiveCache();
  return { deployed, total: energySpecs.length };
}
