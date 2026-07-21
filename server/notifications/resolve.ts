// Alert lifecycle exit — the shared "解除告警" path. Every resolver
// (human-decision、boot 崩溃清除、rule-check 续跑、ack 路由、monitor sweeper)
// must flip firing→resolved the SAME way:
//   1. delete any prior resolved row for the key — @@unique([dedupeKey,status])
//      otherwise collides on the SECOND incarnation of the same alert and the
//      P2002 gets swallowed (2026-06-11 审计:human_gate 卡永远清不掉的成因);
//   2. set readAt (only when unread) — a resolved alert no longer demands
//      attention, so it must stop inflating the unread/红点 counts.
// Never throws — resolution must not break the business flow doing it.

import { prisma } from '@/server/db';
import { dispatchExternal, RECOVERY_SIGNAL } from './channels';

/** 报警也报平安:critical 告警解除时往外部通道推一条恢复消息(企微侧由
 *  WECOM_SEND_RECOVERY 把关,默认开)。fire-and-forget。 */
export function notifyResolvedExternally(
  rows: Array<{ dedupeKey: string | null; title: string; severity: string }>,
): void {
  for (const r of rows) {
    if (r.severity !== 'critical') continue;
    void dispatchExternal({
      id: `recovery:${r.dedupeKey ?? r.title}`,
      kind: 'message',
      severity: 'info',
      category: 'system',
      source: '系统',
      title: `✅ 告警已解除:${r.title}`,
      body: '',
      runId: null,
      signal: RECOVERY_SIGNAL,
      shouldNotify: false,
    }).catch(() => {});
  }
}

export async function resolveAlerts(keys: string[], extra: Record<string, unknown> = {}): Promise<number> {
  if (keys.length === 0) return 0;
  try {
    const firing = await prisma.notification.findMany({
      where: { status: 'firing', dedupeKey: { in: keys } },
      select: { dedupeKey: true, title: true, severity: true },
    });
    await prisma.notification.deleteMany({
      where: { status: 'resolved', dedupeKey: { in: keys } },
    });
    await prisma.notification.updateMany({
      where: { status: 'firing', dedupeKey: { in: keys }, readAt: null },
      data: { readAt: new Date() },
    });
    const r = await prisma.notification.updateMany({
      where: { status: 'firing', dedupeKey: { in: keys } },
      data: { status: 'resolved', ...extra },
    });
    if (r.count > 0) notifyResolvedExternally(firing);
    return r.count;
  } catch (e) {
    console.warn(`[notifications] resolveAlerts failed: ${(e as Error).message}`);
    return 0;
  }
}

/** 按前缀解除(e.g. 'rule_check_parked.' — 续跑成功不知道具体 fail_reason)。 */
export async function resolveAlertsByPrefix(prefix: string, extra: Record<string, unknown> = {}): Promise<number> {
  try {
    const rows = await prisma.notification.findMany({
      where: { status: 'firing', dedupeKey: { startsWith: prefix } },
      select: { dedupeKey: true },
    });
    const keys = [...new Set(rows.map((r) => r.dedupeKey).filter((k): k is string => !!k))];
    return resolveAlerts(keys, extra);
  } catch (e) {
    console.warn(`[notifications] resolveAlertsByPrefix failed: ${(e as Error).message}`);
    return 0;
  }
}
