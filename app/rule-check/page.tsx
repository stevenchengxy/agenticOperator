"use client";

import React, { Suspense } from "react";
import { Shell } from "@/components/shared/Shell";
import { RuleCheckPageContent } from "@/components/rule-check/RuleCheckPageContent";

export default function Page() {
  return (
    <Shell crumbs={["Rule Check", "matchResume"]}>
      <Suspense fallback={null}>
        <RuleCheckPageContent />
      </Suspense>
    </Shell>
  );
}
