"use client";
import React from "react";
import { useParams } from "next/navigation";
import { Shell } from "@/components/shared/Shell";
import { RunDetailContent } from "@/components/monitor/RunDetailContent";
import { useApp } from "@/lib/i18n";

export default function RunDetailPage() {
  const { t } = useApp();
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : String(params?.id ?? '');
  return (
    <Shell crumbs={[t("nav_monitor"), `${t("monitor_crumb_run")} ${id}`]} directionTag={t("monitor_direction_run_detail")}>
      <React.Suspense fallback={<div className="p-6 text-claude-ink-3">{t("monitor_loading")}</div>}>
        <RunDetailContent runId={id} />
      </React.Suspense>
    </Shell>
  );
}
