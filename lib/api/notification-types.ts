// Shared shapes for the 消息通知中心 — mirror the /api/notifications response
// (server: app/api/notifications/route.ts). Lifted out of NotificationsContent
// so the /overview「待我处理」panel and the full notification center agree on
// one definition (2026-06-08).

export type NotifKind = "message" | "alert";
export type NotifSeverity = "info" | "warning" | "critical";
export type NotifCategory = "system" | "agent" | "event" | "candidate" | "job";

export type NotificationRow = {
  id: string;
  ts: string;
  kind: NotifKind;
  severity: NotifSeverity;
  category: NotifCategory;
  source: string;
  title: string;
  body: string;
  aiSource: string | null;
  count: number;
  disposition: "needs_human" | "auto_handled" | "info_only";
  managerAction: string | null;
  status: string | null;
  readAt: string | null;
  anchors: Record<string, string> | null;
  href: string | null;
  // Present in the API response; consumed by the overview deep-link / scoping.
  domain?: string | null;
  runId?: string | null;
  traceId?: string | null;
};

export type NotificationsResponse = {
  notifications: NotificationRow[];
  nextCursor: string | null;
  counts: {
    byCategory: Partial<Record<NotifCategory, number>>;
    byKind: Partial<Record<NotifKind, number>>;
    needsHuman: number;
    unread: number;
  } | null;
};
