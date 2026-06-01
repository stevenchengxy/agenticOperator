// Self-gate: is an ontology agent "deployed/active"?
//
// The energy agent functions are always registered (when ENERGY_AGENTS=1), but
// each one no-ops unless its AgentVersion row for (domain, short) is in status
// 'active'. The generator's deploy step flips that row to 'active' — so
// "deploy" is a real activation, and an undeployed agent genuinely ignores
// events. Results are cached briefly to avoid a DB hit per event.

import { prisma } from "@/server/db";

const TTL_MS = 5_000;
const cache = new Map<string, { active: boolean; at: number }>();

/** True when the newest AgentVersion for (domain, short) is status='active'. */
export async function isAgentActive(domain: string, short: string): Promise<boolean> {
  const key = `${domain}::${short}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.active;

  let active = false;
  try {
    const row = await prisma.agentVersion.findFirst({
      where: { domain, short },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    });
    active = row?.status === "active";
  } catch {
    // DB unavailable → fail closed (agent stays dormant) but don't throw.
    active = false;
  }
  cache.set(key, { active, at: now });
  return active;
}

/** Test/seed hook — clear the activation cache. */
export function clearActiveCache(): void {
  cache.clear();
}
