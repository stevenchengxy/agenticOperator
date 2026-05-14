"use client";
import { Shell } from "@/components/shared/Shell";
import { QueueContent } from "@/components/monitor/QueueContent";

export default function MonitorQueuePage() {
  return (
    <Shell crumbs={["Monitor", "Queue"]} directionTag="">
      <QueueContent />
    </Shell>
  );
}
