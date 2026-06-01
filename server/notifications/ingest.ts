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
      return { id: row.id };
    }
    const row = await prisma.notification.create({ data });
    return { id: row.id };
  } catch (e) {
    console.warn(`[notifications] recordNotification failed: ${(e as Error).message}`);
    return null;
  }
}
