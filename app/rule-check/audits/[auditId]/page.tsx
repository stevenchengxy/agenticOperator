"use client";

import React, { Suspense, use } from "react";
import { Shell } from "@/components/shared/Shell";
import { RuleCheckAuditDetailBody } from "@/components/rule-check/RuleCheckAuditDetailDrawer";

// Fullscreen rule-check audit detail.
// Replaces the right-side drawer per user request — opening an audit now
// navigates to a dedicated route (back button / browser history work as
// expected, URL is shareable, audit detail can use full viewport).

export default function Page({ params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = use(params);
  return (
    <Shell crumbs={["Rule Check", "Audit", auditId]}>
      <Suspense fallback={null}>
        <RuleCheckAuditDetailBody auditId={auditId} chrome="page" />
      </Suspense>
    </Shell>
  );
}
