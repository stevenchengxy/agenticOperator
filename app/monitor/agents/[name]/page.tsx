"use client";
import React from "react";
import { useParams } from "next/navigation";
import { Shell } from "@/components/shared/Shell";
import { AgentDetailContent } from "@/components/monitor/AgentDetailContent";
import { useApp } from "@/lib/i18n";

export default function AgentDetailPage() {
  const { t } = useApp();
  const params = useParams();
  const name = typeof params?.name === 'string' ? params.name : String(params?.name ?? '');
  return (
    <Shell crumbs={[t("nav_monitor"), `${t("monitor_crumb_agent")} ${name}`]} directionTag={t("monitor_direction_agent_detail")}>
      <AgentDetailContent name={name} />
    </Shell>
  );
}
