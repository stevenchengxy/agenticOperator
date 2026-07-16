// lib/manage/audit.ts
// Centralized audit writer for all Manage axis write operations.
// Every successful write op appends one AuditLog row.
// Failures are swallowed with a warning — audit is best-effort and must
// never block the actual operation.

import { prisma } from '@/server/db';
import { createHash } from 'node:crypto';
import { recordLogEvent } from '@/server/log/log-event';
import { recordNotification } from '@/server/notifications/ingest';

// 运维动作 → 业务语言标签(通知中心展示用;UI 侧 AuditContent 另有 i18n 映射)。
const ACTION_LABEL: Record<string, string> = {
  'manage.run.cancel': '取消运行',
  'manage.run.pause': '暂停运行',
  'manage.run.resume': '恢复运行',
  'manage.run.restart': '重启运行',
  'manage.run.replay': '重放运行',
  'manage.event.replay': '重放事件',
  'manage.event.replay.batch': '批量重放事件',
  'manage.runs.batch': '批量操作运行',
  'manage.agent.config': '修改智能体配置',
  'manage.agent.throttle': '调整智能体限流',
  'manage.agent.enable': '上线智能体',
  'manage.agent.disable': '下线智能体',
};

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
  // 同步进统一审计日志 + 消息通知中心(spec 2026-06-01 钦定 manage_action 为
  // 消息类;之前全仓库零生产者 — 下线一个 agent 全域停摆而通知中心毫无痕迹,
  // 2026-06-11 审计)。fire-and-forget,失败不影响运维操作本身。
  const label = ACTION_LABEL[opts.action] ?? opts.action;
  const actor = opts.actor ?? 'operator-unknown';
  const line = `${label}:${opts.traceId} · 操作者 ${actor}${opts.reason ? ` · ${opts.reason}` : ''}`;
  void recordLogEvent({
    type: 'manage_action',
    source: 'manage',
    message: line,
    traceId: opts.traceId,
    payloadJson: payloadStr.slice(0, 4000),
  }).catch(() => {});
  void recordNotification({
    level: 'info',
    category: 'manage_action',
    source: '运维操作',
    message: line,
  }).catch(() => {});
}
