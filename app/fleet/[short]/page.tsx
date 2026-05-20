"use client";
import React, { Suspense, use } from "react";
import { Shell } from "@/components/shared/Shell";
import { AgentDetailContent } from "@/components/fleet/AgentDetailContent";
import { useApp } from "@/lib/i18n";

export default function AgentDetailPage({ params }: { params: Promise<{ short: string }> }) {
  const { short } = use(params);
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_operate"), t("nav_fleet"), short]} directionTag={t("dirA") + " · Agent"}>
      <Suspense fallback={null}>
        <AgentDetailContent short={short} />
      </Suspense>
    </Shell>
  );
}
