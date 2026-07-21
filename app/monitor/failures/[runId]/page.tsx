"use client";
import { useParams } from "next/navigation";
import { Shell } from "@/components/shared/Shell";
import { FailureDetailContent } from "@/components/monitor/FailureDetailContent";
import { useApp } from "@/lib/i18n";

export default function FailureDetailPage() {
  const { t } = useApp();
  const params = useParams();
  const id = typeof params?.runId === 'string' ? params.runId : String(params?.runId ?? '');
  return (
    <Shell crumbs={[t("nav_monitor"), t("monitor_crumb_failure")]} directionTag={t("monitor_direction_failure_detail")}>
      <FailureDetailContent runId={id} />
    </Shell>
  );
}
