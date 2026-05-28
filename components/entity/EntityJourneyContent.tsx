"use client";
import React from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { fetchJson } from "@/lib/api/client";
import type { EntityType } from "@/lib/entity-types";
import type {
  JourneyResponse,
  JourneyAgentRollup,
} from "@/app/api/entities/[type]/[id]/journey/route";
import type { EntitySummaryResponse } from "@/app/api/entities/[type]/[id]/route";
import type { CandidateTrackingResponse } from "@/app/api/events/candidates/route";
import { EntityHeader } from "./EntityHeader";
import { EntityTimeline } from "./EntityTimeline";
import { PipelineRibbon } from "@/components/events/PipelineRibbon";
import { type PipelineStage } from "@/lib/events/pipeline-stages";
import { useApp } from "@/lib/i18n";

type Density = "compact" | "full";

export function EntityJourneyContent({
  type,
  id,
}: {
  type: EntityType;
  id: string;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { t, lang } = useApp();
  const density: Density = (searchParams.get("density") as Density) ?? "compact";
  const days = clamp(
    Number.parseInt(searchParams.get("days") ?? "", 10) || 30,
    1,
    365,
  );

  const [summary, setSummary] = React.useState<EntitySummaryResponse | null>(null);
  const [journey, setJourney] = React.useState<JourneyResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [candidateEvents, setCandidateEvents] = React.useState<{
    events_by_name: Record<string, number>;
    latest_stage: PipelineStage;
  } | null>(null);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    Promise.all([
      fetchJson<EntitySummaryResponse>(
        `/api/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
      ),
      fetchJson<JourneyResponse>(
        `/api/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}/journey?days=${days}`,
        { timeoutMs: 20_000 },
      ),
    ])
      .then(([s, j]) => {
        if (!alive) return;
        setSummary(s);
        setJourney(j);
      })
      .catch((e) => {
        if (!alive) return;
        setErr((e as Error).message ?? t("enx_request_failed"));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [type, id, days]);

  React.useEffect(() => {
    if (type !== "Candidate") return;
    let alive = true;
    fetchJson<CandidateTrackingResponse>(`/api/events/candidates?windowHours=${days * 24}&limit=200`)
      .then((r) => {
        if (!alive) return;
        const mine = r.candidates.find((c) => c.candidate_id === id);
        if (mine) {
          setCandidateEvents({ events_by_name: mine.events_by_name, latest_stage: mine.latest_stage });
        } else {
          setCandidateEvents({ events_by_name: {}, latest_stage: "other" });
        }
      })
      .catch(() => { /* silent — ribbon just won't render */ });
    return () => { alive = false; };
  }, [type, id, days]);

  const setQuery = React.useCallback(
    (next: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      router.replace(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname],
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <EntityHeader
        type={type}
        id={id}
        summary={summary}
        days={days}
        density={density}
        onDaysChange={(d) => setQuery({ days: String(d) })}
        onDensityChange={(d) => setQuery({ density: d })}
      />
      {type === "Candidate" && candidateEvents && Object.keys(candidateEvents.events_by_name).length > 0 && (
        <div className="border-b border-line bg-surface" style={{ padding: "16px 32px" }}>
          <div
            className="uppercase tracking-wide mb-3"
            style={{ fontSize: 11.5, fontWeight: 500, letterSpacing: "0.05em", color: "var(--c-ink-3)" }}
          >
            {t("entity_journey_pipeline_title")}
          </div>
          <PipelineRibbon
            current={candidateEvents.latest_stage}
            eventsByName={candidateEvents.events_by_name}
            lang={lang}
          />
        </div>
      )}
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "240px 1fr" }}>
        <aside className="border-r border-line bg-surface overflow-auto">
          <AgentSidebar agents={journey?.agentSummary ?? []} loading={loading} />
        </aside>
        <main className="overflow-auto bg-panel">
          {err && (
            <div
              className="m-4 border rounded-md text-[12.5px]"
              style={{
                padding: "10px 14px",
                background: "var(--c-warn-bg)",
                borderColor: "color-mix(in oklab, var(--c-warn) 40%, transparent)",
                color: "oklch(0.45 0.14 75)",
              }}
            >
              {t("enx_load_failed")}{err}
            </div>
          )}
          {loading && !journey && (
            <div className="p-6 text-ink-3 text-sm">{t("enx_loading_journey")}</div>
          )}
          {journey && (
            <EntityTimeline
              type={type}
              id={id}
              journey={journey}
              density={density}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function AgentSidebar({
  agents,
  loading,
}: {
  agents: JourneyAgentRollup[];
  loading: boolean;
}) {
  const { t } = useApp();
  if (loading && agents.length === 0) {
    return <div className="p-3 text-ink-3 text-[12px]">…</div>;
  }
  if (agents.length === 0) {
    return (
      <div className="p-3 text-ink-3 text-[12px]">
        {t("enx_sidebar_empty")}
      </div>
    );
  }
  return (
    <div style={{ padding: "12px 10px" }}>
      <div className="text-[10.5px] tracking-[0.06em] uppercase text-ink-4 font-semibold mb-2 px-1">
        {t("enx_handled_agents")}
      </div>
      <div className="flex flex-col gap-1">
        {agents.map((a) => (
          <div
            key={a.short}
            className="rounded-sm border border-line bg-surface"
            style={{ padding: "6px 8px" }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[12px] font-semibold flex-1 truncate">
                {a.short}
              </span>
              {a.errorCount > 0 && (
                <span className="mono text-[9.5px]" style={{ color: "var(--c-err)" }}>
                  {a.errorCount} err
                </span>
              )}
            </div>
            <div className="mono text-[10px] text-ink-3 flex items-center gap-1.5">
              <span>{a.activityCount} {t("enx_unit_rows")}</span>
              <span>·</span>
              <span>{a.eventEmittedCount} emit</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
