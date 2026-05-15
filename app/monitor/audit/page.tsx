"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { AuditContent } from "@/components/monitor/AuditContent";
import { useApp } from "@/lib/i18n";

export default function AuditPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_monitor"), t("monitor_audit_title")]} directionTag={t("monitor_direction_audit_log")}>
      <React.Suspense fallback={<div className="p-6 text-claude-ink-3">{t("monitor_loading")}</div>}>
        <AuditContent />
      </React.Suspense>
    </Shell>
  );
}
