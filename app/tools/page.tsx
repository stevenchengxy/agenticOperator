"use client";
import { Shell } from "@/components/shared/Shell";
import { ToolsLibraryContent } from "@/components/tools/ToolsLibraryContent";

export default function ToolsPage() {
  return (
    <Shell crumbs={["Tool Library"]} directionTag="Build · Tool Library">
      <ToolsLibraryContent />
    </Shell>
  );
}
