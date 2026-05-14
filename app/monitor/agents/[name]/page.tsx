"use client";
import React from "react";
import { useParams } from "next/navigation";
import { Shell } from "@/components/shared/Shell";
import { AgentDetailContent } from "@/components/monitor/AgentDetailContent";

export default function AgentDetailPage() {
  const params = useParams();
  const name = typeof params?.name === 'string' ? params.name : String(params?.name ?? '');
  return (
    <Shell crumbs={["Monitor", `Agent ${name}`]} directionTag="Monitor · Agent Detail">
      <AgentDetailContent name={name} />
    </Shell>
  );
}
