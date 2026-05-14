"use client";
import React from "react";
import { useParams } from "next/navigation";
import { Shell } from "@/components/shared/Shell";
import { RunDetailContent } from "@/components/monitor/RunDetailContent";

export default function RunDetailPage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : String(params?.id ?? '');
  return (
    <Shell crumbs={["Monitor", `Run ${id}`]} directionTag="Monitor · Run Detail">
      <React.Suspense fallback={<div className="p-6 text-claude-ink-3">Loading...</div>}>
        <RunDetailContent runId={id} />
      </React.Suspense>
    </Shell>
  );
}
