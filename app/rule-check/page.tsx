"use client";
import React, { Suspense } from "react";
import { Shell } from "@/components/shared/Shell";
import { RuleCheckAuditsContent } from "@/components/rule-check/RuleCheckAuditsContent";

export default function RuleCheckPage() {
  return (
    <Shell crumbs={["治理", "Rule Check 审计"]} directionTag="Rule Check 审计">
      <Suspense fallback={null}>
        <RuleCheckAuditsContent />
      </Suspense>
    </Shell>
  );
}
