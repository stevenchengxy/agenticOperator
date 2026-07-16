"use client";

import React, { Suspense, use } from "react";
import { Shell } from "@/components/shared/Shell";
import { InstanceTrailContent } from "@/components/events/InstanceTrailContent";
import { useApp } from "@/lib/i18n";

// Canonical notification target for an EventInstance. The older route embeds
// the event name in the URL; notifications only persist the instance id, so
// this id-only route lets the detail API resolve the authoritative name.
export default function EventInstanceByIdPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useApp();
  return (
    <Shell
      crumbs={[t("nav_group_operate"), t("nav_events"), id.slice(0, 8) + "…"]}
      directionTag="事件实例 · 故障证据"
    >
      <Suspense fallback={null}>
        <InstanceTrailContent eventName="" instanceId={decodeURIComponent(id)} />
      </Suspense>
    </Shell>
  );
}

