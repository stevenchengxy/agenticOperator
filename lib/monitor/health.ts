// health / liveness monitor — flags running runs whose latest step is older
// than stallMs (no progress = stalled). Heartbeat = newest step time, falling
// back to the run's startedAt when no step has landed yet. Emits a critical
// system alert per stalled run; dedupeHint 'run_stalled.<runId>' is already a
// broad-impact prefix in derive.ts (→ critical, → notify).

import type { CaptureInput } from '@/server/notifications/derive';
import type { MonitorReadPort, MonitorResult, MonitorThresholds } from './monitor-types';

const PREFIX = 'run_stalled.';

// 人工闸口 agent 的 slug 片段 — 这些函数用 step.waitForEvent 挂起等人工决策,
// 合法地 Running 数天,绝不能按"无新步骤=停滞"判定(2026-06-11 审计:5 条
// run_stalled critical 各 bump 3300+ 次的成因;且非终态 run 没有 step 归档,
// heartbeat 永远是 startedAt)。列表 = server/inngest/human-decision.ts 的
// GATE_DECISIONS gateKey kebab 化(闸口 agent 函数 slug 按约定含该片段);
// 新增域闸口时同步这里。人工响应慢有专门的 hitl-stale 催办监视器,不归这。
const HITL_GATE_SLUG_PARTS = [
  'manual-confirm', // energy manualConfirm
  'handle-flood-control',
  'handle-grid-security',
  'handle-equipment-fault',
  'handle-renewable-curtailment',
  'finalize-plan',
  'manual-review', // feikong manualReview
  'dispose-risk-event', // feikong disposeRiskEvent
];

export function isHitlGateSlug(functionSlug: string): boolean {
  return HITL_GATE_SLUG_PARTS.some((p) => functionSlug.includes(p));
}

export async function healthMonitor(
  port: MonitorReadPort,
  t: MonitorThresholds,
  now: Date = new Date(),
): Promise<MonitorResult> {
  const runs = await port.inflightRuns();
  const findings: CaptureInput[] = [];
  const activeKeys: string[] = [];

  for (const r of runs) {
    if (isHitlGateSlug(r.functionSlug)) continue; // 人工闸口挂起 ≠ 停滞
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
