// lib/manage/audit.ts
// Centralized audit writer for all Manage axis write operations.
// Every successful write op appends one AuditLog row.
// Failures are swallowed with a warning — audit is best-effort and must
// never block the actual operation.

import { prisma } from '@/server/db';
import { createHash } from 'node:crypto';

type WriteAuditOpts = {
  /** e.g. 'manage.run.restart', 'manage.run.cancel', 'manage.event.replay', 'manage.agent.config' */
  action: string;
  /** runId, eventId, or agent name — used as AuditLog.traceId */
  traceId: string;
  /** For v1, always 'operator-unknown'. TODO: replace with real session userId once auth is wired. */
  actor?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
};

export async function writeManageAudit(opts: WriteAuditOpts): Promise<void> {
  const payload = {
    actor: opts.actor ?? 'operator-unknown',
    reason: opts.reason ?? null,
    before: opts.before ?? null,
    after: opts.after ?? null,
  };
  const payloadStr = JSON.stringify(payload);
  const digest = createHash('sha256').update(payloadStr).digest('hex').slice(0, 16);
  try {
    await prisma.auditLog.create({
      data: {
        eventName: opts.action,
        traceId: opts.traceId,
        payload: payloadStr,
        payloadDigest: digest,
        source: 'manage-api',
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[writeManageAudit] failed to write audit log: ${(e as Error).message}`);
  }
}
