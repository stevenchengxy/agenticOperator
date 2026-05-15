"use client";
import { Shell } from "@/components/shared/Shell";
import { QueueContent } from "@/components/monitor/QueueContent";
import { useApp } from "@/lib/i18n";

export default function MonitorQueuePage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_monitor"), t("monitor_crumb_queue")]} directionTag={t("monitor_direction_event_queue")}>
      <QueueContent />
    </Shell>
  );
}
