"use client";
import { Shell } from "@/components/shared/Shell";
import { LibraryCodegenContent } from "@/components/behavior/codegen/library/LibraryCodegenContent";

export default function BehaviorLibraryCodegenPage() {
  return (
    <Shell crumbs={["Behavior", "Codegen", "Library"]} directionTag="Behavior · Library Codegen">
      <LibraryCodegenContent />
    </Shell>
  );
}
