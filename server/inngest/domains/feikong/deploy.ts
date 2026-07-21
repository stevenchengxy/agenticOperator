// Deploy = activate. The 费控 functions are always built (in domain-app.ts) but
// self-gate on an active AgentVersion row for (domain, short). This ensures every
// derived 费控 agent has an `active` row so a demo run actually fires — the
// runnable equivalent of clicking "部署" in the generator. Mirrors energy/deploy.ts.

import { prisma } from "@/server/db";
import { COST_CONTROL_DOMAIN_ID } from "@/lib/domain-ids";
import { costControlSpecs } from "./index";
import { clearActiveCache } from "../energy/is-active";

export async function ensureCostControlDeployed(): Promise<{ deployed: number; total: number }> {
  let deployed = 0;
  for (const spec of costControlSpecs) {
    const existing = await prisma.agentVersion.findFirst({
      where: { domain: COST_CONTROL_DOMAIN_ID, short: spec.short },
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
          versionLabel: "feikong-demo-1",
          status: "active",
          domain: COST_CONTROL_DOMAIN_ID,
          capturedFrom: "ontology-gen",
          generatedBy: "feikong-demo",
          configJson: JSON.stringify({ nameZh: spec.nameZh, kind: spec.kind, action: spec.actionName }),
          deployedAt: new Date(),
        },
      });
    }
    deployed++;
  }
  clearActiveCache();
  return { deployed, total: costControlSpecs.length };
}
