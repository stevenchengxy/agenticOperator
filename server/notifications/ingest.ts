// Notification ingestion — persists a derived draft to the Notification table.
//
// Alerts upsert by (dedupeKey, status='firing') so repeated occurrences bump a
// count instead of flooding; messages insert one row each. This is called
// fire-and-forget from capture sites (LogEvent writes, the rule-check infra
// path, the Monitor agent) — it NEVER throws, so a notification failure can't
// break the business flow it observes.

import { prisma } from '@/server/db';
import {
  deriveNotification,
  type CaptureInput,
  type DeriveOptions,
  type NotificationDraft,
} from './derive';
import { dispatchExternal } from './channels';
import { summarizeAlert } from './summarize';

type NotifyRowLike = {
  id: string;
  severity?: string;
  category?: string;
  source?: string;
  title?: string;
  body?: string;
  runId?: string | null;
};

// Offer every persisted row to external channels (no-op by default).
// External send policy lives in each channel (severity gate / event whitelist /
// repeat suppression) — shouldNotify only drives the in-app red-dot semantics,
// so lifecycle messages (shouldNotify=false) can still reach e.g. 企业微信.
function dispatchToExternal(draft: NotificationDraft, row: NotifyRowLike): void {
  void dispatchExternal({
    id: row.id,
    kind: draft.kind,
    severity: draft.severity,
    category: draft.category,
    source: draft.source,
    title: draft.title,
    body: draft.body,
    runId: draft.runId,
    signal: draft.signal,
    agent: draft.agent,
    shouldNotify: draft.shouldNotify,
  }).catch(() => {});
}

function toRow(draft: NotificationDraft) {
  const notified = draft.shouldNotify;
  return {
    kind: draft.kind,
    severity: draft.severity,
    category: draft.category,
    source: draft.source,
    title: draft.title,
    body: draft.body,
    runId: draft.runId,
    traceId: draft.traceId,
    eventInstanceId: draft.eventInstanceId,
    agent: draft.agent,
    domain: draft.domain,
    anchorsJson: draft.anchorsJson,
    linkKind: draft.linkKind,
    linkId: draft.linkId,
    disposition: draft.disposition,
    managerAction: draft.managerAction,
    shouldNotify: draft.shouldNotify,
    notifiedAt: notified ? new Date() : null,
    notifyChannel: notified ? 'in_app' : null,
  };
}

export async function recordNotification(
  input: CaptureInput,
  opts: DeriveOptions = {},
): Promise<{ id: string } | null> {
  let draft: NotificationDraft | null;
  try {
    draft = deriveNotification(input, opts);
  } catch {
    return null;
  }
  if (!draft) return null;

  try {
    const data = toRow(draft);
    if (draft.kind === 'alert' && draft.dedupeKey) {
      const row = await prisma.notification.upsert({
        where: { dedupeKey_status: { dedupeKey: draft.dedupeKey, status: 'firing' } },
        create: { ...data, dedupeKey: draft.dedupeKey, status: 'firing' },
        update: {
          count: { increment: 1 },
          lastSeenAt: new Date(),
          // refresh the latest framing + (possibly re-escalated) severity/notify.
          // disposition 也要跟着升级 — warn→critical 升级如果不刷它,告警永远
          // 进不了 needs_human 待办(2026-06-11 审计:dep 监视器的说不准升级)。
          title: draft.title,
          body: draft.body,
          severity: draft.severity,
          shouldNotify: draft.shouldNotify,
          disposition: draft.disposition,
          // A deduped alert represents the latest occurrence. Keep its deep
          // link and correlation anchors fresh; otherwise the alert count and
          // title advance while clicking it still opens the first failed run.
          source: draft.source,
          runId: draft.runId,
          traceId: draft.traceId,
          eventInstanceId: draft.eventInstanceId,
          agent: draft.agent,
          domain: draft.domain,
          anchorsJson: draft.anchorsJson,
          linkKind: draft.linkKind,
          linkId: draft.linkId,
        },
      });
      // Eager-on-critical: the FIRST occurrence of a critical alert (count===1)
      // gets an AI summary immediately, so the center shows a business-language
      // line without waiting for the next view. Fire-and-forget; degrades to the
      // deterministic fallback when the gateway is down (summarizeAlert handles it).
      if (draft.severity === 'critical' && row.count === 1) {
        void summarizeAlert(row.id).catch(() => {});
      }
      // 长 firing 告警的 AI 摘要超龄重开:缓存的 aiSummary 会一直顶替 body 展示
      // ("停滞超过67小时"挂 8 天不变,2026-06-11 审计)。re-fire 且摘要超过
      // 1 小时 → 置 aiGeneratedAt=null,lazy 富化(summarizePendingAlerts)下次
      // 自然重写,≈每告警每小时至多 1 次 LLM。
      const STALE_MS = 60 * 60_000;
      if (row.count > 1 && row.aiGeneratedAt && Date.now() - row.aiGeneratedAt.getTime() > STALE_MS) {
        await prisma.notification
          .update({ where: { id: row.id }, data: { aiGeneratedAt: null } })
          .catch(() => {});
      }
      dispatchToExternal(draft, row);
      return { id: row.id };
    }
    const row = await prisma.notification.create({ data });
    dispatchToExternal(draft, row);
    return { id: row.id };
  } catch (e) {
    console.warn(`[notifications] recordNotification failed: ${(e as Error).message}`);
    return null;
  }
}
