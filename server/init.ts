// Server-side init — runs once per Next.js dev/prod boot.
// Imported by app/api/inngest/route.ts (which is loaded on first hit).

import { startRaasBridge } from "./inngest/raas-bridge";
import { startEventDefinitionSync } from "./em/sync/event-definition-sync";
import { checkEnv, printEnvCheck } from "./env-check";
import { ensureRecruitmentDeployed } from "./inngest/recruitment-deploy";

let _booted = false;

export function bootOnce(): void {
  if (_booted) return;
  _booted = true;
  // Env preflight — print a status table on first boot so partners can see
  // immediately which vars are missing. Doesn't throw on missing RECOMMENDED
  // vars; each subsystem (Inngest, Allmeta, MinIO…) handles its own absence.
  const result = checkEnv();
  if (!result.ok || result.recommended.some((r) => !r.present)) {
    printEnvCheck(result);
  }
  // Bridge is gated on RAAS_BRIDGE_ENABLED=1 — see raas-bridge.ts.
  startRaasBridge();
  // Neo4j → EventDefinition sync. Gated on NEO4J_SYNC_ENABLED=1 and
  // degrades gracefully when the host is unreachable (off-VPN).
  startEventDefinitionSync();
  // Seed the recruitment deploy panel with exactly the real recruitment agents
  // so it's DB-backed and the app stays defined by those agents across reboots /
  // redeploys. Idempotent + best-effort (never blocks boot).
  ensureRecruitmentDeployed().catch(() => {});
}
