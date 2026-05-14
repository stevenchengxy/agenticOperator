"use client";
import { Shell } from "@/components/shared/Shell";
import { MonitorContent } from "@/components/monitor/MonitorContent";

export default function MonitorPage() {
  return (
    <Shell crumbs={["Monitor"]} directionTag="Monitor · Agent Runtime View">
      <MonitorContent />
    </Shell>
  );
}
