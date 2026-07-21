"use client";

import React, { Suspense } from "react";
import { Shell } from "@/components/shared/Shell";
import { useApp } from "@/lib/i18n";
import { FunnelContent } from "@/components/funnel/FunnelContent";

export default function Page() {
  const { t } = useApp();
  return (
    <Shell crumbs={[t("nav_group_observe"), t("nav_funnel")]} directionTag="流程追踪 · 端到端">
      <Suspense fallback={null}>
        <FunnelContent />
      </Suspense>
    </Shell>
  );
}
