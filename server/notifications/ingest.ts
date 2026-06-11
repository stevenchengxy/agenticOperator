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
          // refresh the latest framing + (possibly re-escalated) severity/notify
          title: draft.title,
          body: draft.body,
          severity: draft.severity,
          shouldNotify: draft.shouldNotify,
        },
      });
      // Eager-on-critical: the FIRST occurrence of a critical alert (count===1)
      // gets an AI summary immediately, so the center shows a business-language
      // line without waiting for the next view. Fire-and-forget; degrades to the
      // deterministic fallback when the gateway is down (summarizeAlert handles it).
      if (draft.severity === 'critical' && row.count === 1) {
        void summarizeAlert(row.id).catch(() => {});
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
