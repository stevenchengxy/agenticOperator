"use client";
import { Shell } from "@/components/shared/Shell";
import { BehaviorContent } from "@/components/behavior/BehaviorContent";

export default function BehaviorPage() {
  return (
    <Shell crumbs={["Behavior"]} directionTag="Behavior · Autonomous Response">
      <BehaviorContent />
    </Shell>
  );
}
