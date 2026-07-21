"use client";
import React, { Suspense } from "react";
import { Shell } from "@/components/shared/Shell";
import { MonitorContent } from "@/components/monitor/MonitorContent";
import { useApp } from "@/lib/i18n";

export default function MonitorPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_monitor")]} directionTag={t("monitor_direction_runtime_view")}>
      <Suspense fallback={null}>
        <MonitorContent />
      </Suspense>
    </Shell>
  );
}
