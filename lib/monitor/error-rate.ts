// error-rate monitor — windowed failure rate per agent (functionSlug). Flags an
// agent when errors/total exceeds errorRatePct AND total >= minVolume (the
// min-volume guard stops a single 1/1 failure reading as 100%). Complements the
// existing single-shot agent_error notification with a *rate* signal.

import type { CaptureInput } from '@/server/notifications/derive';
import {
  domainForRun,
  type MonitorReadPort,
  type MonitorResult,
  type MonitorThresholds,
} from './monitor-types';

const PREFIX = 'error_rate.';
const WINDOW_MS = 15 * 60_000;

export async function errorRateMonitor(
  port: MonitorReadPort,
  t: MonitorThresholds,
): Promise<MonitorResult> {
  const win = await port.errorWindow(WINDOW_MS);
  const findings: CaptureInput[] = [];
  const activeKeys: string[] = [];

  for (const [agent, stat] of Object.entries(win.byAgent)) {
    if (stat.total < t.minVolume) continue; // min-volume guard
    const pct = (stat.errors / stat.total) * 100;
    if (pct <= t.errorRatePct) continue;

    const key = `${PREFIX}${agent}`;
    activeKeys.push(key);
    findings.push({
      level: pct >= t.errorRatePct * 2 ? 'error' : 'warn',
      category: 'agent_lifecycle', // → categoryOf 'agent' (no eventName!)
      source: agent,
      agent,
      message: `错误率偏高:${agent} 近期 ${stat.errors}/${stat.total}(${Math.round(pct)}%)失败`,
      dedupeHint: key,
      domain: domainForRun({ functionSlug: agent, eventName: stat.eventName }),
    });
  }

  return { prefix: PREFIX, findings, activeKeys };
}
