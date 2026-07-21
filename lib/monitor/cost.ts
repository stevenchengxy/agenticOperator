// cost / token monitor — two deterministic signals over a recent window:
//  (a) budget:  per-domain token sum exceeds budgetTokens
//  (b) runaway: a single run's tool-step count exceeds toolLoop (recursive loop
//      burning budget — Coralogix's canonical agent failure)
// Both emit a critical system alert. Single dedupe namespace 'cost.' with
// sub-keys cost.budget.<domain> / cost.runaway.<runId> so one resolve scope
// covers the monitor.

import type { CaptureInput } from '@/server/notifications/derive';
import {
  domainForRun,
  type MonitorReadPort,
  type MonitorResult,
  type MonitorThresholds,
} from './monitor-types';

const PREFIX = 'cost.';
const WINDOW_MS = 60 * 60_000; // 1h

export async function costMonitor(
  port: MonitorReadPort,
  t: MonitorThresholds,
): Promise<MonitorResult> {
  const runs = await port.recentRuns(WINDOW_MS);
  const ids = runs.map((r) => r.runId);
  const [tokens, tools] = await Promise.all([
    port.tokenUsageByRun(ids),
    port.toolStepCounts(ids),
  ]);

  const findings: CaptureInput[] = [];
  const activeKeys: string[] = [];

  // (a) budget per domain
  const byDomain = new Map<string, number>();
  for (const r of runs) {
    const d = domainForRun(r);
    byDomain.set(d, (byDomain.get(d) ?? 0) + (tokens[r.runId] ?? 0));
  }
  for (const [domain, sum] of byDomain) {
    if (sum <= t.budgetTokens) continue;
    const key = `${PREFIX}budget.${domain}`;
    activeKeys.push(key);
    findings.push({
      level: 'critical',
      category: 'system',
      source: '系统',
      message: `成本预警:${domain} 近期 token 用量 ${sum} 已超出预算`,
      dedupeHint: key,
      domain,
    });
  }

  // (b) runaway per run
  for (const r of runs) {
    const count = tools[r.runId] ?? 0;
    if (count <= t.toolLoop) continue;
    const key = `${PREFIX}runaway.${r.runId}`;
    activeKeys.push(key);
    findings.push({
      level: 'critical',
      category: 'system',
      source: '系统',
      message: `疑似失控循环:${r.runId} 工具调用 ${count} 次,超过阈值 ${t.toolLoop}`,
      dedupeHint: key,
      runId: r.runId,
    });
  }

  return { prefix: PREFIX, findings, activeKeys };
}
