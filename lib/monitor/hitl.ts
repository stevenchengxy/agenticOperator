// hitl-stale monitor — 人工待办催办。needs_human 的 firing 告警挂超过
// hitlStaleMs(默认 48h)没人处理 → 发一条 digest 提醒(不是每条一发,防刷屏;
// 2026-06-11 审计:human-gate critical 挂 8-9 天零催办)。条件消失(都处理了)
// 由 sweeper 的 resolveStale 按前缀自动解除。

import type { CaptureInput } from '@/server/notifications/derive';
import type { MonitorReadPort, MonitorResult, MonitorThresholds } from './monitor-types';

const PREFIX = 'hitl_stale.';
const DIGEST_KEY = `${PREFIX}digest`;

const fmtAge = (ms: number): string => {
  const h = Math.round(ms / 3600_000);
  return h >= 48 ? `${Math.round(h / 24)} 天` : `${h} 小时`;
};

export async function hitlStaleMonitor(
  port: MonitorReadPort,
  t: MonitorThresholds,
): Promise<MonitorResult> {
  const stale = await port.staleNeedsHuman(t.hitlStaleMs);
  if (stale.length === 0) return { prefix: PREFIX, findings: [], activeKeys: [] };

  const oldest = stale[0];
  const sample = stale
    .slice(0, 3)
    .map((s) => `「${s.title.slice(0, 40)}」`)
    .join('、');
  const findings: CaptureInput[] = [
    {
      // warning → info_only,催办本身不进待办(否则自我繁殖)。
      level: 'warn',
      category: 'system',
      source: '系统',
      message:
        `${stale.length} 条人工待办已超过 ${fmtAge(t.hitlStaleMs)} 未处理` +
        `(最久 ${fmtAge(oldest.ageMs)}):${sample}${stale.length > 3 ? ' 等' : ''} — 请到消息通知「待我处理」处理或确认`,
      dedupeHint: DIGEST_KEY,
    },
  ];
  return { prefix: PREFIX, findings, activeKeys: [DIGEST_KEY] };
}
