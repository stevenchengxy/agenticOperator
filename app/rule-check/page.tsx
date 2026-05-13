"use client";

import { Shell } from "@/components/shared/Shell";
import { RuleCheckContent } from "@/components/rule-check/RuleCheckContent";

export default function Page() {
  return (
    <Shell crumbs={["Rule Check", "matchResume"]}>
      <RuleCheckContent />
    </Shell>
  );
}
