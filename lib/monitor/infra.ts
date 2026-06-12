import { getInfraStatus, infraFindingsFromSnapshot, INFRA_ALERT_PREFIX } from "@/server/ops/infra-status";
import type { MonitorReadPort, MonitorResult, MonitorThresholds } from "./monitor-types";

export async function infraMonitor(
  _port: MonitorReadPort,
  _t: MonitorThresholds,
): Promise<MonitorResult> {
  const snapshot = await getInfraStatus();
  const findings = infraFindingsFromSnapshot(snapshot);
  const activeKeys = findings
    .map((f) => f.dedupeHint)
    .filter((k): k is string => Boolean(k));
  return { prefix: INFRA_ALERT_PREFIX, findings, activeKeys };
}
