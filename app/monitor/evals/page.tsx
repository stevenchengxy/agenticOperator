"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { MonitorEvalsContent } from "@/components/monitor/MonitorEvalsContent";

export default function MonitorEvalsPage() {
  return (
    <Shell crumbs={["监控", "AI 事实审查"]} directionTag="AI 事实审查 · Monitor Evals">
      <MonitorEvalsContent />
    </Shell>
  );
}
