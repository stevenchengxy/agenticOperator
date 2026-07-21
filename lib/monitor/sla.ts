// sla / latency monitor — groups completed steps by functionSlug (agent),
// computes p95 step duration, and flags agents whose p95 exceeds slaP95Ms.
// Emits a warning per breaching agent. Output classifies as 'agent' (category
// 'agent_lifecycle', NO eventName — passing eventName would make categoryOf
// return 'event'), and carries the run's business domain.

import type { CaptureInput } from '@/server/notifications/derive';
import {
  domainForRun,
  type MonitorReadPort,
  type MonitorResult,
  type MonitorThresholds,
  type StepTiming,
} from './monitor-types';

const PREFIX = 'sla_breach.';

/** Nearest-rank p95 of a non-empty number array. */
function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx];
}

export async function slaMonitor(
  port: MonitorReadPort,
  t: MonitorThresholds,
): Promise<MonitorResult> {
  const steps = await port.stepTimings(t.stallMs); // window ~= stallMs; port owns the cutoff
  const byAgent = new Map<string, StepTiming[]>();
  for (const s of steps) {
    const arr = byAgent.get(s.functionSlug);
    if (arr) arr.push(s);
    else byAgent.set(s.functionSlug, [s]);
  }

  const findings: CaptureInput[] = [];
  const activeKeys: string[] = [];

  for (const [slug, group] of byAgent) {
    const value = p95(group.map((s) => s.durationMs));
    if (value <= t.slaP95Ms) continue;

    const key = `${PREFIX}${slug}`;
    activeKeys.push(key);
    findings.push({
      level: 'warn',
      category: 'agent_lifecycle', // → categoryOf 'agent' (no eventName!)
      source: slug,
      agent: slug,
      message: `处理超时:${slug} 的 p95 步骤耗时 ${Math.round(value / 1000)}s,超过阈值`,
      dedupeHint: key,
      domain: domainForRun(group[0]),
    });
  }

  return { prefix: PREFIX, findings, activeKeys };
}
