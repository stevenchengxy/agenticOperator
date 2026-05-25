"use client";
import { Shell } from "@/components/shared/Shell";
import { CodegenContent } from "@/components/behavior/codegen/CodegenContent";

export default function BehaviorCodegenPage() {
  return (
    <Shell crumbs={["Behavior", "Codegen"]} directionTag="Behavior · Codegen">
      <CodegenContent />
    </Shell>
  );
}
