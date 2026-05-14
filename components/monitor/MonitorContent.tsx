"use client";
import React from "react";
import { ClaudeCard, ClaudeMetric, ClaudeBadge, ClaudeButton, ClaudeSectionTitle } from "./atoms";

export function MonitorContent() {
  return (
    <div className="p-6 max-w-[1620px] mx-auto">
      <h1 className="text-[28px] font-medium mb-2">Monitor</h1>
      <p className="text-claude-ink-3 mb-6">
        Runtime view of the workflow agents. Coming online — Task 3 wires the data.
      </p>
      <div className="grid grid-cols-5 gap-4 mb-6">
        <ClaudeMetric label="Active runs" value="—" />
        <ClaudeMetric label="Pending HITL" value="—" />
        <ClaudeMetric label="Failures" value="—" emphasis="err" />
        <ClaudeMetric label="Tokens" value="—" />
        <ClaudeMetric label="Queue p95" value="—" />
      </div>
      <ClaudeCard>
        <ClaudeSectionTitle>Atoms preview</ClaudeSectionTitle>
        <div className="flex gap-2 items-center">
          <ClaudeBadge tone="ok">healthy</ClaudeBadge>
          <ClaudeBadge tone="warn">degraded</ClaudeBadge>
          <ClaudeBadge tone="err">failing</ClaudeBadge>
          <ClaudeBadge tone="accent">pinned</ClaudeBadge>
          <ClaudeButton variant="primary">Primary</ClaudeButton>
          <ClaudeButton>Secondary</ClaudeButton>
          <ClaudeButton variant="ghost">Ghost</ClaudeButton>
        </div>
      </ClaudeCard>
    </div>
  );
}
