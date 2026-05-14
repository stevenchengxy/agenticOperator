"use client";
import React from "react";
import Link from "next/link";
import { ClaudeCard, ClaudeSectionTitle, ClaudeBadge } from "./atoms";

export function FailureDetailContent({ runId }: { runId: string }) {
  const [data, setData] = React.useState<any>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    fetch(`/api/monitor/failures/${encodeURIComponent(runId)}`)
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(setData)
      .catch(e => setError(String(e)));
  }, [runId]);
  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="mb-4">
        <Link href={`/monitor/runs/${runId}`} className="text-claude-accent text-[12.5px] no-underline">← Run {runId.slice(0, 8)}</Link>
      </div>
      <h1 className="text-[24px] font-medium mb-4">Failure detail</h1>
      {error && <p className="text-claude-err">{error}</p>}
      {data && (
        <>
          <ClaudeCard className="mb-3">
            <ClaudeSectionTitle>Failed steps</ClaudeSectionTitle>
            {data.steps.length === 0 ? (
              <div className="text-claude-ink-4 text-[12.5px]">No failed steps recorded.</div>
            ) : (
              <ul className="flex flex-col divide-y divide-claude-line">
                {data.steps.map((s: any) => (
                  <li key={s.id} className="py-2 text-[12.5px]">
                    <div className="flex items-center gap-2">
                      <ClaudeBadge tone="err" size="xs">{s.nodeId}</ClaudeBadge>
                      <span className="text-claude-ink-1 font-medium">{s.stepName}</span>
                    </div>
                    {s.error && (
                      <pre className="bg-claude-panel rounded p-2 mt-1 text-[11.5px] overflow-auto whitespace-pre-wrap">{s.error}</pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </ClaudeCard>
          <ClaudeCard>
            <ClaudeSectionTitle>Retry history</ClaudeSectionTitle>
            {data.retries.length === 0 ? (
              <div className="text-claude-ink-4 text-[12.5px]">No retry activity.</div>
            ) : (
              <ul className="text-[12.5px]">
                {data.retries.map((a: any) => (
                  <li key={a.id}>
                    <span className="text-claude-ink-4 tabular-nums mr-2">{new Date(a.createdAt).toLocaleTimeString()}</span>
                    <span className="text-claude-ink-1">{a.agentName}</span>
                    <span className="text-claude-ink-3 ml-1">{a.type}: {a.narrative}</span>
                  </li>
                ))}
              </ul>
            )}
          </ClaudeCard>
        </>
      )}
    </div>
  );
}
