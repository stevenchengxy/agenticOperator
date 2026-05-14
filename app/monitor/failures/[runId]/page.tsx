"use client";
import { useParams } from "next/navigation";
import { Shell } from "@/components/shared/Shell";
import { FailureDetailContent } from "@/components/monitor/FailureDetailContent";

export default function FailureDetailPage() {
  const params = useParams();
  const id = typeof params?.runId === 'string' ? params.runId : String(params?.runId ?? '');
  return (
    <Shell crumbs={["Monitor", "Failure"]} directionTag="Monitor · Failure Detail">
      <FailureDetailContent runId={id} />
    </Shell>
  );
}
