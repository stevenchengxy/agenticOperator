"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { AnalyticsContent } from "@/components/analytics/AnalyticsContent";
import { useApp } from "@/lib/i18n";

export default function AnalyticsPage() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_observe"), t("nav_analytics")]} directionTag={t("nav_analytics")}>
      <AnalyticsContent />
    </Shell>
  );
}
