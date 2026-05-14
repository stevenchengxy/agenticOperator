"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { AuditContent } from "@/components/monitor/AuditContent";

export default function AuditPage() {
  return (
    <Shell crumbs={["Monitor", "Audit Log"]} directionTag="Monitor · Audit Log">
      <React.Suspense fallback={<div className="p-6 text-claude-ink-3">Loading...</div>}>
        <AuditContent />
      </React.Suspense>
    </Shell>
  );
}
