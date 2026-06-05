// health / liveness monitor — flags running runs whose latest step is older
// than stallMs (no progress = stalled). Heartbeat = newest step time, falling
// back to the run's startedAt when no step has landed yet. Emits a critical
// system alert per stalled run; dedupeHint 'run_stalled.<runId>' is already a
// broad-impact prefix in derive.ts (→ critical, → notify).

import type { CaptureInput } from '@/server/notifications/derive';
import type { MonitorReadPort, MonitorResult, MonitorThresholds } from './monitor-types';

const PREFIX = 'run_stalled.';

export async function healthMonitor(
  port: MonitorReadPort,
  t: MonitorThresholds,
  now: Date = new Date(),
): Promise<MonitorResult> {
  const runs = await port.inflightRuns();
  const findings: CaptureInput[] = [];
  const activeKeys: string[] = [];

  for (const r of runs) {
    const heartbeat = r.lastStepAt ?? r.startedAt;
    if (!heartbeat) continue; // can't judge liveness without any timestamp
    const idleMs = now.getTime() - heartbeat.getTime();
    if (idleMs <= t.stallMs) continue;

    const key = `${PREFIX}${r.runId}`;
    activeKeys.push(key);
    const minutes = Math.round(idleMs / 60_000);
    findings.push({
      level: 'critical',
      category: 'system',
      source: '系统',
      message: `运行已停滞:${r.runId} 已 ${minutes} 分钟无新步骤`,
      dedupeHint: key,
      runId: r.runId,
    });
  }

  return { prefix: PREFIX, findings, activeKeys };
}
