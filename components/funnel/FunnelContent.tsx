"use client";
import React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/i18n";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, Card, CardHead, EmptyState } from "@/components/shared/atoms";
import { fetchJson } from "@/lib/api/client";
import type { FunnelJobsResponse, FunnelJobRow, FunnelStageCount } from "@/app/api/funnel/jobs/route";
import type {
  FunnelCandidatesResponse,
  FunnelCandidateRow,
  FunnelCandidateStatus,
} from "@/app/api/funnel/candidates/route";
import type { FunnelTimelineResponse } from "@/app/api/funnel/timeline/route";
import type { EventAnalysisResponse } from "@/app/api/funnel/event-analysis/route";
import type { JobAnalysisResponse } from "@/app/api/funnel/job-analysis/route";
import type { BatchAnalysisResponse } from "@/app/api/funnel/event-analysis/batch/route";
import type { FunnelCandidateDetailResponse } from "@/app/api/funnel/candidate/route";
import type { FunnelJobRequisitionResponse } from "@/app/api/funnel/job-requisition/route";
import type { JobIntakeResponse } from "@/app/api/funnel/job-intake/route";
import { STAGE_META } from "@/lib/events/pipeline-stages";

// ── 双栏：左实体栏 + 右详情。URL query 驱动，可深链/前进后退。 ──
//   ?dim=candidate        左栏列候选人(否则列岗位)
//   ?job=<id>             选中岗位 → 右栏显示该岗位流程 + 名单
//   ?candidate=<id>       选中候选人 → 右栏【按事件】重建的端到端时间线

type Dim = "job" | "candidate";
const STATUS_FILTERS: ("all" | FunnelCandidateStatus)[] = [
  "all",
  "active",
  "review",
  "blocked",
  "failed",
  "submitted",
];

export function FunnelContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const dim: Dim = sp.get("dim") === "candidate" ? "candidate" : "job";
  const job = sp.get("job");
  const candidate = sp.get("candidate");

  const setQuery = React.useCallback(
    (next: Record<string, string | null>) => {
      const p = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v === null) p.delete(k);
        else p.set(k, v);
      }
      router.push(`/funnel${p.toString() ? `?${p}` : ""}`);
    },
    [router, sp],
  );

  // 左栏数据：岗位列表（按岗位维度）+ 候选人花名册（按候选人维度）。
  const jobs = useJobs();

  return (
    <div className="flex-1 flex min-h-0">
      <LeftRail
        dim={dim}
        jobs={jobs.data}
        loading={jobs.loading}
        selectedJob={job}
        selectedCandidate={candidate}
        onDim={(d) => setQuery({ dim: d === "job" ? null : d, job: null, candidate: null, event: null })}
        onSelectJob={(id) => setQuery({ job: id, candidate: null, event: null })}
        onSelectCandidate={(id) => setQuery({ candidate: id, event: null })}
      />
      <RightPane
        dim={dim}
        candidate={candidate}
        jobId={job}
        selectedJob={job ? jobs.data?.jobs.find((j) => j.jobId === job) ?? null : null}
        kpi={jobs.data?.kpi ?? null}
        onBack={() => setQuery({ candidate: null, event: null })}
        onSelectCandidate={(id) => setQuery({ candidate: id, event: null })}
      />
    </div>
  );
}

// ─────────────────────────── data hooks ───────────────────────────

function useJobs() {
  const [data, setData] = React.useState<FunnelJobsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    let live = true;
    fetchJson<FunnelJobsResponse>("/api/funnel/jobs")
      .then((r) => live && setData(r))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);
  return { data, loading };
}

function useRoster(enabled: boolean) {
  const [data, setData] = React.useState<FunnelCandidatesResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    fetchJson<FunnelCandidatesResponse>("/api/funnel/candidates?byCandidate=1")
      .then((r) => live && setData(r))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [enabled]);
  return { data, loading };
}

function useCohort(jobId: string | null) {
  const [data, setData] = React.useState<FunnelCandidatesResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    if (!jobId) return;
    let live = true;
    setLoading(true);
    fetchJson<FunnelCandidatesResponse>(`/api/funnel/candidates?job=${encodeURIComponent(jobId)}`)
      .then((r) => live && setData(r))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [jobId]);
  return { data, loading };
}

// ─────────────────────────── left rail ───────────────────────────

function LeftRail({
  dim,
  jobs,
  loading,
  selectedJob,
  selectedCandidate,
  onDim,
  onSelectJob,
  onSelectCandidate,
}: {
  dim: Dim;
  jobs: FunnelJobsResponse | null;
  loading: boolean;
  selectedJob: string | null;
  selectedCandidate: string | null;
  onDim: (d: Dim) => void;
  onSelectJob: (id: string) => void;
  onSelectCandidate: (id: string) => void;
}) {
  const { t } = useApp();
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState<"all" | FunnelCandidateStatus>("all");
  const roster = useRoster(dim === "candidate");

  const jobRows = (jobs?.jobs ?? []).filter((j) =>
    `${j.title} ${j.client}`.toLowerCase().includes(q.toLowerCase()),
  );
  const candRows = (roster.data?.candidates ?? [])
    .filter((c) => status === "all" || c.status === status)
    .filter((c) => `${c.candidateId} ${c.client ?? ""}`.toLowerCase().includes(q.toLowerCase()));

  const count = dim === "job" ? jobRows.length : candRows.length;
  const isLoading = dim === "job" ? loading : roster.loading;

  return (
    <aside
      className="flex flex-col min-h-0 border-r border-line bg-surface"
      style={{ width: 312, flexShrink: 0 }}
    >
      <div style={{ padding: "16px 16px 10px" }}>
        <div className="text-[15px] font-semibold tracking-tight">{t("fn_title")}</div>
        <div className="text-ink-3 text-[11.5px] mt-0.5 leading-snug">{t("fn_subtitle")}</div>
      </div>

      <div className="px-4 pb-2 flex flex-col gap-2.5">
        <DimToggle dim={dim} onDim={onDim} />
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none">
            <Ic.search />
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("fn_search_ph")}
            className="h-8 w-full border border-line bg-panel rounded-md text-[12px] text-ink-1 outline-none focus:border-accent-line"
            style={{ padding: "0 8px 0 28px" }}
          />
        </div>
        {dim === "candidate" && (
          <div className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map((s) => (
              <Chip key={s} active={status === s} onClick={() => setStatus(s)}>
                {s === "all" ? t("fn_all") : t(statusKey(s))}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div className="px-4 pb-1.5 text-ink-3 text-[10.5px] mono uppercase tracking-wide">
        {t("fn_objects_n").replace("{n}", String(count))}
      </div>

      <div className="flex-1 overflow-auto px-2.5 pb-3 flex flex-col gap-1">
        {isLoading ? (
          <RailSkeleton />
        ) : count === 0 ? (
          <div className="text-ink-3 text-[11.5px] text-center py-8">{t("fn_empty_title")}</div>
        ) : dim === "job" ? (
          jobRows.map((j) => (
            <JobRailRow
              key={j.jobId}
              job={j}
              selected={j.jobId === selectedJob}
              onClick={() => onSelectJob(j.jobId)}
            />
          ))
        ) : (
          candRows.map((c) => (
            <CandidateRailRow
              key={c.candidateId}
              c={c}
              selected={c.candidateId === selectedCandidate}
              onClick={() => c.hasLineage && onSelectCandidate(c.candidateId)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function DimToggle({ dim, onDim }: { dim: Dim; onDim: (d: Dim) => void }) {
  const { t } = useApp();
  return (
    <div className="flex p-0.5 rounded-md border border-line bg-panel">
      {(["job", "candidate"] as const).map((d) => (
        <button
          key={d}
          onClick={() => onDim(d)}
          className="flex-1 h-6 rounded-sm text-[11.5px] transition-colors"
          style={
            dim === d
              ? { background: "var(--c-accent-bg)", color: "var(--c-accent)", fontWeight: 600 }
              : { color: "var(--c-ink-3)" }
          }
        >
          {d === "job" ? t("fn_by_job") : t("fn_by_candidate")}
        </button>
      ))}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="h-6 px-2 rounded-full text-[11px] border transition-colors"
      style={
        active
          ? { background: "var(--c-accent-bg)", color: "var(--c-accent)", borderColor: "var(--c-accent-line)" }
          : { color: "var(--c-ink-3)", borderColor: "var(--c-line)" }
      }
    >
      {children}
    </button>
  );
}

function JobRailRow({
  job,
  selected,
  onClick,
}: {
  job: FunnelJobRow;
  selected: boolean;
  onClick: () => void;
}) {
  const rc = job.stages.find((s) => s.key === "rule_check");
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 rounded-lg text-left transition-colors"
      style={{
        padding: "9px 10px",
        background: selected ? "var(--c-accent-bg)" : "transparent",
        boxShadow: selected ? "inset 0 0 0 1px var(--c-accent-line)" : "none",
      }}
    >
      <Tile seed={job.jobId} label={firstChar(job.title)} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-ink-1 font-medium truncate">{job.title}</div>
        <div className="text-ink-3 text-[11px] truncate">{job.client || "—"}</div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-[12px] font-semibold tabular-nums">{job.candidateTotal}</div>
        {rc && (rc.dropped ?? 0) > 0 && (
          <div className="text-[10px] mono" style={{ color: "var(--c-err)" }}>
            −{rc.dropped}
          </div>
        )}
      </div>
    </button>
  );
}

function CandidateRailRow({
  c,
  selected,
  onClick,
}: {
  c: FunnelCandidateRow;
  selected: boolean;
  onClick: () => void;
}) {
  const clickable = c.hasLineage;
  return (
    <button
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      className="w-full flex items-center gap-2.5 rounded-lg text-left transition-colors disabled:cursor-default"
      style={{
        padding: "9px 10px",
        background: selected ? "var(--c-accent-bg)" : "transparent",
        boxShadow: selected ? "inset 0 0 0 1px var(--c-accent-line)" : "none",
        opacity: clickable ? 1 : 0.6,
      }}
    >
      <Tile
        seed={c.candidateId}
        label={c.candidateName ? firstChar(c.candidateName) : c.candidateId.slice(0, 2).toUpperCase()}
      />
      <div className="min-w-0 flex-1">
        <div
          className="text-[12px] text-ink-1 font-medium truncate"
          style={c.candidateName ? undefined : { fontFamily: "var(--f-mono)" }}
        >
          {c.candidateName ?? c.candidateId.slice(0, 10)}
        </div>
        <div className="text-ink-3 text-[11px] truncate">
          {c.candidateName ? `${c.candidateId.slice(0, 8)} · ` : ""}
          {c.client || "—"}
        </div>
      </div>
      <StatusBadge status={c.status} />
    </button>
  );
}

function RailSkeleton() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5" style={{ padding: "9px 10px" }}>
          <div className="w-8 h-8 rounded-md bg-panel animate-pulse" />
          <div className="flex-1">
            <div className="h-3 w-2/3 bg-panel rounded animate-pulse" />
            <div className="h-2.5 w-1/3 bg-panel rounded mt-1.5 animate-pulse" />
          </div>
        </div>
      ))}
    </>
  );
}

// ─────────────────────────── right pane ───────────────────────────

function RightPane({
  dim,
  candidate,
  jobId,
  selectedJob,
  kpi,
  onBack,
  onSelectCandidate,
}: {
  dim: Dim;
  candidate: string | null;
  jobId: string | null;
  selectedJob: FunnelJobRow | null;
  kpi: FunnelJobsResponse["kpi"] | null;
  onBack: () => void;
  onSelectCandidate: (id: string) => void;
}) {
  const { t } = useApp();

  if (candidate) {
    // 按候选人维度 → 候选人画像（岗位 + 流程 + 事件）；按岗位下钻 → 纯时间线。
    if (dim === "candidate" && !jobId) {
      return <CandidateDetail candidateId={candidate} onBack={onBack} />;
    }
    return <EventTimeline candidateId={candidate} jobId={jobId} onBack={onBack} />;
  }

  if (dim === "job" && selectedJob) {
    return <JobDetail job={selectedJob} onSelectCandidate={onSelectCandidate} />;
  }

  // 总览/空态
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-bg overflow-auto">
      {dim === "job" && kpi && (
        <div style={{ padding: "22px 22px 0" }}>
          <KpiStrip kpi={kpi} />
        </div>
      )}
      {dim === "job" && (
        <div style={{ padding: "16px 22px 0" }}>
          <JobIntakeFunnel />
        </div>
      )}
      <div className="flex-1 flex items-center justify-center">
        <EmptyState icon={<Ic.search />} title={t("fn_pick_hint_title")} hint={t("fn_pick_hint")} />
      </div>
    </div>
  );
}

// #7 岗位入口漏斗：需求录入→澄清→JD就绪→发布→关闭（与候选人漏斗正交）。
function JobIntakeFunnel() {
  const { t } = useApp();
  const [data, setData] = React.useState<JobIntakeResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    let live = true;
    fetchJson<JobIntakeResponse>("/api/funnel/job-intake")
      .then((r) => live && setData(r))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);
  if (loading && !data) return null;
  const stages = data?.stages ?? [];
  const max = Math.max(1, ...stages.map((s) => s.count));
  return (
    <Card>
      <CardHead>
        <span className="text-[12px] font-semibold">{t("fn_intake_title")}</span>
        <span className="text-ink-3 text-[11px]">{t("fn_intake_total").replace("{n}", String(data?.total ?? 0))}</span>
      </CardHead>
      <div style={{ padding: "12px 16px" }}>
        {data && data.total === 0 ? (
          <div className="text-ink-3 text-[11.5px] text-center py-2">{t("fn_intake_empty")}</div>
        ) : (
          <div className="flex flex-col gap-2">
            {stages.map((s) => (
              <div key={s.status} className="flex items-center gap-3">
                <span className="text-[11.5px] text-ink-1 flex-shrink-0" style={{ width: 72 }}>{t(`fn_life_${lifecycleKeyForStatus(s.status)}` as Parameters<typeof t>[0])}</span>
                <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: "var(--c-panel)" }}>
                  <div className="h-full rounded-full" style={{ width: `${(s.count / max) * 100}%`, background: "var(--c-accent)" }} />
                </div>
                <span className="text-[11px] mono text-ink-2 tabular-nums flex-shrink-0" style={{ width: 28, textAlign: "right" }}>{s.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function lifecycleKeyForStatus(status: string): string {
  const map: Record<string, string> = {
    pending_clarification: "logged",
    clarified: "clarified",
    jd_ready: "jd_ready",
    published: "published",
    closed: "closed",
  };
  return map[status] ?? "logged";
}

// ── L3：按【事件】重建的端到端时间线（按天分组 + 富卡片 + 详情抽屉）──
type TLEvent = FunnelTimelineResponse["events"][number];

// 按候选人维度：候选人画像 = 申请岗位 + 经历流程 + 端到端事件时间线。
function CandidateDetail({ candidateId, onBack }: { candidateId: string; onBack: () => void }) {
  const { t } = useApp();
  const router = useRouter();
  const sp = useSearchParams();
  const [data, setData] = React.useState<FunnelCandidateDetailResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    setData(null);
    fetchJson<FunnelCandidateDetailResponse>(`/api/funnel/candidate?id=${encodeURIComponent(candidateId)}`)
      .then((r) => live && setData(r))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [candidateId]);

  const name = data?.candidateName ?? null;
  const jobs = data?.jobs ?? [];
  const passedJobs = jobs.filter((j) => j.decision === "PASS").length;

  const openJobFunnel = (jid: string) => {
    const p = new URLSearchParams(sp.toString());
    p.set("job", jid);
    p.delete("candidate");
    p.delete("event");
    p.delete("dim");
    router.push(`/funnel?${p}`);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-bg overflow-auto">
      {/* header */}
      <div className="border-b border-line bg-surface" style={{ padding: "12px 22px" }}>
        <div className="flex items-center gap-3">
          <Btn size="sm" variant="ghost" onClick={onBack}>
            <span aria-hidden>←</span> {t("fn_back_to_funnel")}
          </Btn>
          <Tile seed={candidateId} label={name ? firstChar(name) : candidateId.slice(0, 2).toUpperCase()} big />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-tight truncate">{name ?? candidateId.slice(0, 18)}</div>
            <div className="text-ink-3 text-[11px] mono truncate">{candidateId}</div>
          </div>
          <div className="flex-1" />
          <Metric label={t("fn_cand_jobs")} value={String(jobs.length)} />
          <Metric label={t("fn_pass_word")} value={String(passedJobs)} />
          <Metric label={t("fn_events_word")} value={String(data?.totalEvents ?? 0)} />
        </div>
        {/* 经历流程 */}
        {data && data.stagesReached.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
            <span className="text-ink-3 text-[11px]">{t("fn_cand_stages")}</span>
            {data.stagesReached.map((s) => (
              <span key={s.key} className="h-5 px-2 rounded-full text-[10.5px] flex items-center" style={{ color: STAGE_META[s.key].color, background: `color-mix(in oklab, ${STAGE_META[s.key].color} 12%, transparent)` }}>
                {s.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 申请岗位 */}
      <div style={{ padding: "16px 22px 8px" }}>
        <SectionLabel>{t("fn_cand_applied")} · {jobs.length}</SectionLabel>
        {loading && !data ? (
          <div className="text-ink-3 text-[12px] py-6 text-center">{t("fn_loading")}</div>
        ) : jobs.length === 0 ? (
          <div className="text-ink-3 text-[12px] py-6 text-center">{t("fn_empty_title")}</div>
        ) : (
          <div className="grid gap-2 mt-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {jobs.map((j) => (
              <button
                key={j.jobId}
                onClick={() => openJobFunnel(j.jobId)}
                className="text-left rounded-lg border bg-surface transition-all hover:border-accent-line"
                style={{ padding: "10px 12px", borderColor: "var(--c-line)" }}
              >
                <div className="flex items-center gap-2.5">
                  <Tile seed={j.jobId} label={firstChar(j.jobTitle)} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-ink-1 truncate">{j.jobTitle}</div>
                    <div className="text-ink-3 text-[11px] truncate">{j.client || "—"}</div>
                  </div>
                  <Badge variant={j.decision === "FAIL" ? "err" : "ok"}>
                    {j.decision === "FAIL" ? t("fn_block_word") : t("fn_pass_word")}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-ink-3 text-[10.5px]">
                  <span>{t("fn_cand_audits").replace("{n}", String(j.auditCount))}</span>
                  <div className="flex-1" />
                  <span className="text-accent flex items-center gap-0.5">{t("fn_link_job_funnel")} <Ic.arrowR /></span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 端到端事件时间线 */}
      <div style={{ padding: "10px 22px 24px" }}>
        <SectionLabel>{t("fn_event_timeline")}</SectionLabel>
        <div className="mt-2">
          <EventTimeline candidateId={candidateId} jobId={null} onBack={onBack} embedded />
        </div>
      </div>
    </div>
  );
}

function EventTimeline({
  candidateId,
  jobId,
  onBack,
  embedded = false,
}: {
  candidateId: string;
  jobId: string | null;
  onBack: () => void;
  embedded?: boolean;
}) {
  const { t } = useApp();
  const router = useRouter();
  const sp = useSearchParams();
  const [data, setData] = React.useState<FunnelTimelineResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const setEventParam = React.useCallback(
    (id: string | null) => {
      const p = new URLSearchParams(sp.toString());
      if (id) p.set("event", id);
      else p.delete("event");
      router.push(`/funnel${p.toString() ? `?${p}` : ""}`, { scroll: false });
    },
    [router, sp],
  );

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    const q = new URLSearchParams({ candidate: candidateId });
    if (jobId) q.set("job", jobId);
    fetchJson<FunnelTimelineResponse>(`/api/funnel/timeline?${q}`)
      .then((r) => {
        if (!live) return;
        setData(r);
        setError(r.meta.error ?? null);
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [candidateId, jobId]);

  const events = data?.events ?? [];
  const name = data?.candidateName ?? null;
  const pass = events.filter((e) => e.decision === "PASS").length;
  const fail = events.filter((e) => e.decision === "FAIL").length;
  const span =
    events.length > 0
      ? `${dayLabel(events[0].ts)} – ${dayLabel(events[events.length - 1].ts)}`
      : "—";
  const groups = groupByDay(events);
  const sel = events.find((e) => e.id === sp.get("event")) ?? null;
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  return (
    <div className={embedded ? "relative" : "flex-1 flex flex-col min-h-0 bg-bg relative"}>
      {/* header (standalone only — embedded 由 CandidateDetail 提供头部) */}
      {!embedded && (
        <div className="border-b border-line bg-surface flex items-center" style={{ padding: "12px 22px", gap: 12 }}>
          <Btn size="sm" variant="ghost" onClick={onBack}>
            <span aria-hidden>←</span> {t("fn_back_to_cohort")}
          </Btn>
          <Tile seed={candidateId} label={name ? firstChar(name) : candidateId.slice(0, 2).toUpperCase()} />
          <div className="min-w-0">
            <div className="text-[14px] font-semibold tracking-tight truncate">{name ?? candidateId.slice(0, 18)}</div>
            <div className="text-ink-3 text-[11px] mono truncate">
              {candidateId.slice(0, 20)} · {t("fn_event_timeline")}
            </div>
          </div>
          <div className="flex-1" />
          <Badge variant="info">{t("fn_events_n").replace("{n}", String(events.length))}</Badge>
        </div>
      )}

      {/* digest */}
      {!embedded && events.length > 0 && (
        <div className="flex items-center gap-5 border-b border-line bg-surface/60" style={{ padding: "8px 22px" }}>
          <DigestStat color="var(--c-ok)" label={t("fn_pass_word")} value={pass} />
          <DigestStat color="var(--c-err)" label={t("fn_block_word")} value={fail} />
          <div className="flex items-center gap-1.5 text-[11.5px]">
            <span className="text-ink-3">{t("fn_span_label")}</span>
            <span className="text-ink-1 mono">{span}</span>
          </div>
        </div>
      )}

      {/* body */}
      {loading && !data ? (
        <div className={embedded ? "text-ink-3 text-[12px] py-6 text-center" : "flex-1 flex items-center justify-center text-ink-3 text-[12px]"}>{t("fn_loading")}</div>
      ) : error && !data ? (
        <div className={embedded ? "py-4" : "flex-1 flex items-center justify-center"}>
          <EmptyState icon={<Ic.alert />} title={t("fn_load_failed")} hint={error} variant="warn" />
        </div>
      ) : events.length === 0 ? (
        <div className={embedded ? "py-4" : "flex-1 flex items-center justify-center"}>
          <EmptyState icon={<Ic.bolt />} title={t("fn_timeline_empty_title")} hint={t("fn_timeline_empty_hint")} />
        </div>
      ) : (
        <div className={embedded ? "" : "flex-1 overflow-auto"} style={{ padding: embedded ? "4px 2px" : "14px 24px 24px" }}>
          {groups.map(([day, evs]) => (
            <section key={day} className="mb-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11.5px] font-semibold text-ink-2">{day}</span>
                <span className="text-ink-3 text-[10.5px]">{t("fn_events_n").replace("{n}", String(evs.length))}</span>
                <span className="flex-1 h-px" style={{ background: "var(--c-line)" }} />
              </div>
              <div className="relative flex flex-col gap-1.5" style={{ paddingLeft: 18 }}>
                <span className="absolute top-2 bottom-2 left-[5px] w-px" style={{ background: "var(--c-line)" }} aria-hidden />
                {collapseRuns(evs).map((run, ri) =>
                  run.type === "single" ? (
                    <EventCard key={run.e.id} e={run.e} active={sel?.id === run.e.id} onClick={() => setEventParam(run.e.id)} />
                  ) : (
                    <CollapsedRun
                      key={run.key}
                      items={run.items}
                      expanded={expanded.has(run.key)}
                      onToggle={() =>
                        setExpanded((prev) => {
                          const n = new Set(prev);
                          n.has(run.key) ? n.delete(run.key) : n.add(run.key);
                          return n;
                        })
                      }
                      selId={sel?.id ?? null}
                      onPick={(id) => setEventParam(id)}
                    />
                  ),
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {sel && <EventDetailDrawer e={sel} candidateName={name} onClose={() => setEventParam(null)} />}
    </div>
  );
}

// #3 把连续相同(name+decision)的事件折叠成一组（≥3 才折叠）。
type Run = { type: "single"; e: TLEvent } | { type: "group"; key: string; items: TLEvent[] };
function collapseRuns(evs: TLEvent[]): Run[] {
  const out: Run[] = [];
  let i = 0;
  while (i < evs.length) {
    const k = `${evs[i].name}|${evs[i].decision}`;
    let j = i + 1;
    while (j < evs.length && `${evs[j].name}|${evs[j].decision}` === k) j++;
    if (j - i >= 3) out.push({ type: "group", key: `${k}-${i}`, items: evs.slice(i, j) });
    else for (let x = i; x < j; x++) out.push({ type: "single", e: evs[x] });
    i = j;
  }
  return out;
}

function CollapsedRun({
  items,
  expanded,
  onToggle,
  selId,
  onPick,
}: {
  items: TLEvent[];
  expanded: boolean;
  onToggle: () => void;
  selId: string | null;
  onPick: (id: string) => void;
}) {
  const { t } = useApp();
  const e = items[0];
  const dotColor = e.decision === "FAIL" ? "var(--c-err)" : e.decision === "PASS" ? "var(--c-ok)" : STAGE_META[e.stage]?.color ?? "var(--c-ink-3)";
  return (
    <div className="relative">
      <span className="absolute w-2.5 h-2.5 rounded-full z-10" style={{ left: -17, top: 13, background: dotColor, boxShadow: "0 0 0 3px var(--c-bg)" }} aria-hidden />
      <button
        onClick={onToggle}
        className="w-full text-left rounded-lg border bg-surface transition-all"
        style={{ padding: "9px 12px", borderColor: "var(--c-line)", borderStyle: "dashed" }}
      >
        <div className="flex items-center gap-2.5">
          <span className="text-[10px] px-1.5 py-px rounded-sm flex-shrink-0" style={{ color: STAGE_META[e.stage]?.color, background: `color-mix(in oklab, ${STAGE_META[e.stage]?.color} 12%, transparent)` }}>
            {e.stageLabelZh}
          </span>
          <span className="text-[12.5px] font-medium text-ink-1 truncate">{friendlyTitle(e, t)}</span>
          <Badge variant={e.decision === "FAIL" ? "err" : "ok"}>×{items.length}</Badge>
          <div className="flex-1" />
          <span className="text-ink-3 text-[10.5px]">{expanded ? t("fn_collapse") : t("fn_expand_n").replace("{n}", String(items.length))}</span>
          <span className="text-ink-3 flex-shrink-0" aria-hidden>{expanded ? "▾" : "▸"}</span>
        </div>
      </button>
      {expanded && (
        <div className="flex flex-col gap-1.5 mt-1.5" style={{ paddingLeft: 14 }}>
          {items.map((it) => (
            <EventCard key={it.id} e={it} active={selId === it.id} onClick={() => onPick(it.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function DigestStat({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5 text-[11.5px]">
      <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
      <span className="text-ink-3">{label}</span>
      <span className="text-ink-1 font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function EventCard({ e, active, onClick }: { e: TLEvent; active: boolean; onClick: () => void }) {
  const { t } = useApp();
  const dotColor =
    e.decision === "FAIL" ? "var(--c-err)" : e.decision === "PASS" ? "var(--c-ok)" : STAGE_META[e.stage]?.color ?? "var(--c-ink-3)";
  const time = new Date(e.ts).toLocaleTimeString(undefined, { hour12: false });
  return (
    <div className="relative">
      <span
        className="absolute w-2.5 h-2.5 rounded-full z-10"
        style={{ left: -17, top: 13, background: dotColor, boxShadow: "0 0 0 3px var(--c-bg)" }}
        aria-hidden
      />
      <button
        onClick={onClick}
        className="w-full text-left rounded-lg border bg-surface transition-all group"
        style={{
          padding: "9px 12px",
          borderColor: active ? "var(--c-accent-line)" : "var(--c-line)",
          boxShadow: active ? "0 0 0 1px var(--c-accent-line)" : undefined,
        }}
      >
        <div className="flex items-center gap-2.5">
          <span
            className="text-[10px] px-1.5 py-px rounded-sm flex-shrink-0"
            style={{ color: STAGE_META[e.stage]?.color, background: `color-mix(in oklab, ${STAGE_META[e.stage]?.color} 12%, transparent)` }}
          >
            {e.stageLabelZh}
          </span>
          <span className="text-[12.5px] font-medium text-ink-1 truncate">{friendlyTitle(e, t)}</span>
          {e.decision && (
            <Badge variant={e.decision === "FAIL" ? "err" : "ok"}>
              {e.decision === "FAIL" ? t("fn_block_word") : t("fn_pass_word")}
            </Badge>
          )}
          <div className="flex-1" />
          <span className="text-ink-3 text-[10.5px] mono flex-shrink-0">{time}</span>
          <span className="text-ink-3 group-hover:text-accent transition-colors flex-shrink-0">
            <Ic.arrowR />
          </span>
        </div>
      </button>
    </div>
  );
}

function EventDetailDrawer({
  e,
  candidateName,
  onClose,
}: {
  e: TLEvent;
  candidateName: string | null;
  onClose: () => void;
}) {
  const { t } = useApp();
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const candId = typeof p.candidate_id === "string" ? p.candidate_id : "";
  const kv: Array<[string, string | null]> = [
    [t("fn_f_stage"), e.stageLabelZh],
    [t("fn_f_decision"), e.decision],
    [t("fn_f_status"), e.status],
    [t("fn_f_time"), new Date(e.ts).toLocaleString(undefined, { hour12: false })],
    [t("fn_f_candidate"), candidateName ? `${candidateName} · ${candId.slice(0, 8)}` : candId || null],
    [t("fn_f_job"), e.jobId],
    [t("fn_f_source"), e.source],
    ["trace_id", typeof p.trace_id === "string" ? p.trace_id : null],
    ["run_id", typeof p.run_id === "string" ? p.run_id : null],
    ["audit_id", e.auditId],
  ];
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0" style={{ background: "color-mix(in oklab, black 45%, transparent)" }} onClick={onClose} />
      <aside
        className="absolute right-0 top-0 h-full flex flex-col bg-surface border-l border-line shadow-sh-2"
        style={{ width: 440 }}
      >
        <div className="flex items-center border-b border-line" style={{ padding: "14px 18px", gap: 10 }}>
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ background: e.decision === "FAIL" ? "var(--c-err)" : e.decision === "PASS" ? "var(--c-ok)" : STAGE_META[e.stage]?.color }}
          />
          <div className="min-w-0">
            <div className="text-[14px] font-semibold tracking-tight truncate">{friendlyTitle(e, t)}</div>
            <div className="text-ink-3 text-[11px] mono truncate">{e.name}</div>
          </div>
          <div className="flex-1" />
          <button onClick={onClose} className="text-ink-3 hover:text-ink-1 transition-colors" aria-label={t("fn_close")}>
            <Ic.cross />
          </button>
        </div>

        <div className="flex-1 overflow-auto flex flex-col gap-4" style={{ padding: "16px 18px" }}>
          <EventAnalysisPanel e={e} />

          <div>
            {kv
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-3 py-1.5 border-b border-line">
                  <span className="text-ink-3 text-[11.5px] flex-shrink-0">{k}</span>
                  <span className="text-ink-1 text-[11.5px] mono text-right break-all">{v}</span>
                </div>
              ))}
          </div>

          {e.payload && (
            <div>
              <div className="text-ink-3 text-[10.5px] font-semibold uppercase tracking-wide mb-1.5">{t("fn_f_payload")}</div>
              <pre
                className="rounded-md mono text-[10.5px] overflow-auto"
                style={{ background: "var(--c-panel)", border: "1px solid var(--c-line)", padding: 10, maxHeight: 260, color: "var(--c-ink-2)" }}
              >
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// 岗位漏斗 AI 诊断卡。
function JobAnalysisPanel({ jobId }: { jobId: string }) {
  const { t } = useApp();
  const [resp, setResp] = React.useState<JobAnalysisResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [generating, setGenerating] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    setResp(null);
    fetchJson<JobAnalysisResponse>(`/api/funnel/job-analysis?job=${encodeURIComponent(jobId)}`)
      .then((r) => live && setResp(r))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [jobId]);

  const generate = (force = false) => {
    setGenerating(true);
    fetchJson<JobAnalysisResponse>(`/api/funnel/job-analysis?job=${encodeURIComponent(jobId)}${force ? "&force=1" : ""}`, { method: "POST" })
      .then((r) => setResp(r))
      .catch((e) => setResp({ ok: false, reason: "error", error: (e as Error).message }))
      .finally(() => setGenerating(false));
  };

  const a = resp && resp.ok ? resp.analysis : null;
  const failReason = resp && !resp.ok ? resp.reason : null;

  return (
    <section className="rounded-lg border" style={{ borderColor: "var(--c-accent-line)", background: "var(--c-accent-bg)" }}>
      <div className="flex items-center gap-2" style={{ padding: "9px 12px" }}>
        <Ic.sparkle />
        <span className="text-[12.5px] font-semibold" style={{ color: "var(--c-accent)" }}>{t("fn_job_ai_title")}</span>
        <div className="flex-1" />
        {a && (
          <button onClick={() => generate(true)} disabled={generating} className="text-[11px] transition-colors disabled:opacity-50" style={{ color: "var(--c-accent)" }}>
            {t("fn_ai_regenerate")}
          </button>
        )}
      </div>
      <div className="bg-surface rounded-b-lg" style={{ margin: 1, marginTop: 0 }}>
        {loading ? (
          <div className="text-ink-3 text-[11.5px] text-center py-5">{t("fn_loading")}</div>
        ) : generating ? (
          <div className="flex items-center justify-center gap-2 py-5 text-[11.5px]" style={{ color: "var(--c-accent)" }}>
            <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: "var(--c-accent)" }} />
            {t("fn_ai_analyzing")}
          </div>
        ) : a ? (
          <JobAnalysisBody a={a} model={resp && resp.ok ? resp.model : undefined} />
        ) : failReason ? (
          <div className="py-4 px-3 text-center">
            <div className="text-ink-2 text-[11.5px] mb-2">
              {failReason === "gateway_unavailable" ? t("fn_ai_unavailable") : t("fn_ai_failed")}
              {resp && !resp.ok && resp.error ? ` (${resp.error})` : ""}
            </div>
            <Btn size="sm" onClick={() => generate(false)}>{t("fn_ai_generate")}</Btn>
          </div>
        ) : (
          <div className="py-4 px-3 text-center">
            <div className="text-ink-3 text-[11px] mb-2 leading-relaxed">{t("fn_job_ai_cta_hint")}</div>
            <Btn size="sm" onClick={() => generate(false)}><Ic.sparkle /> {t("fn_ai_generate")}</Btn>
          </div>
        )}
      </div>
    </section>
  );
}

function JobAnalysisBody({ a, model }: { a: NonNullable<Extract<JobAnalysisResponse, { ok: true }>["analysis"]>; model?: string }) {
  const { t } = useApp();
  const maxCount = Math.max(1, ...a.failureClusters.map((c) => c.count));
  return (
    <div className="flex flex-col gap-3" style={{ padding: "12px 13px" }}>
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide mb-1 text-ink-3">{t("fn_job_sec_diagnosis")}</div>
        <div className="text-[12px] text-ink-1 leading-relaxed">{a.diagnosis || "—"}</div>
      </div>
      {a.failureClusters.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: "var(--c-err)" }}>{t("fn_job_sec_clusters")}</div>
          <div className="flex flex-col gap-1.5">
            {a.failureClusters.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-[11.5px] text-ink-1 truncate" style={{ width: 140, flexShrink: 0 }}>{c.reason}</span>
                <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "var(--c-panel)" }}>
                  <div className="h-full rounded-full" style={{ width: `${(c.count / maxCount) * 100}%`, background: "var(--c-err)" }} />
                </div>
                <span className="text-[11px] mono text-ink-2 tabular-nums" style={{ width: 22, textAlign: "right" }}>{c.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {a.highlights && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--c-ok)" }}>{t("fn_job_sec_highlights")}</div>
          <div className="text-[12px] text-ink-1 leading-relaxed">{a.highlights}</div>
        </div>
      )}
      {a.recommendations.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-1 text-ink-3">{t("fn_job_sec_reco")}</div>
          <ul className="flex flex-col gap-1">
            {a.recommendations.map((r, i) => (
              <li key={i} className="flex gap-1.5 text-[12px] text-ink-1">
                <span style={{ color: "var(--c-accent)" }}>→</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {model && <div className="text-ink-3 text-[10px] mono pt-1 border-t border-line">{t("fn_ai_by").replace("{model}", model)}</div>}
    </div>
  );
}

// 后台预生成本岗位拦截事件的 AI 分析（开抽屉即得）。
function BatchPregenButton({ jobId }: { jobId: string }) {
  const { t } = useApp();
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<string | null>(null);
  const run = () => {
    setBusy(true);
    setDone(null);
    fetchJson<BatchAnalysisResponse>(`/api/funnel/event-analysis/batch?job=${encodeURIComponent(jobId)}&decision=FAIL&limit=20`, { method: "POST" })
      .then((r) =>
        setDone(
          r.meta.reason === "gateway_unavailable"
            ? t("fn_ai_unavailable")
            : t("fn_pregen_result").replace("{gen}", String(r.generated)).replace("{cached}", String(r.cached)),
        ),
      )
      .catch(() => setDone(t("fn_ai_failed")))
      .finally(() => setBusy(false));
  };
  return (
    <button onClick={run} disabled={busy} className="text-[11px] transition-colors disabled:opacity-50" style={{ color: "var(--c-accent)" }} title={t("fn_pregen_hint")}>
      {busy ? t("fn_ai_analyzing") : done ?? `✨ ${t("fn_pregen_fail")}`}
    </button>
  );
}

// 岗位生命周期 + 需求/JD 画像（按 job_requisition_id 串原始需求→解析→JD）。
const LIFECYCLE_KEYS = ["logged", "clarified", "jd_ready", "published", "closed"] as const;

function JobRequisitionSection({ jobId }: { jobId: string }) {
  const { t } = useApp();
  const [data, setData] = React.useState<FunnelJobRequisitionResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    setData(null);
    setOpen(false);
    fetchJson<FunnelJobRequisitionResponse>(`/api/funnel/job-requisition?id=${encodeURIComponent(jobId)}`)
      .then((r) => live && setData(r))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [jobId]);

  const lifecycle = data?.lifecycle ?? LIFECYCLE_KEYS.map((k) => ({ key: k, reached: false, current: false }));
  const hasContent = !!(data?.found || data?.rawRequirement);

  return (
    <div style={{ padding: "18px 22px 0" }}>
      <SectionLabel>{t("fn_job_lifecycle")}</SectionLabel>
      <div className="flex items-center mt-3">
        {lifecycle.map((s, i) => (
          <React.Fragment key={s.key}>
            <div className="flex flex-col items-center" style={{ minWidth: 56 }}>
              <span
                className="rounded-full"
                style={
                  s.reached
                    ? { width: s.current ? 13 : 10, height: s.current ? 13 : 10, background: "var(--c-accent)", boxShadow: s.current ? "0 0 0 4px var(--c-accent-bg)" : undefined }
                    : { width: 9, height: 9, background: "var(--c-surface)", border: "1.5px solid var(--c-ink-3)", opacity: 0.55 }
                }
              />
              <span className="text-[10.5px] mt-1.5 whitespace-nowrap" style={{ color: s.reached ? "var(--c-ink-1)" : "var(--c-ink-3)", fontWeight: s.current ? 600 : 400 }}>
                {t(`fn_life_${s.key}` as Parameters<typeof t>[0])}
              </span>
            </div>
            {i < lifecycle.length - 1 && (
              <div className="flex-1 h-px mb-4" style={{ background: lifecycle[i + 1].reached ? "var(--c-accent)" : "var(--c-line)" }} />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* 需求 & JD 画像 */}
      <div className="mt-3 rounded-lg border border-line overflow-hidden">
        <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 bg-surface" style={{ padding: "8px 12px" }}>
          <span className="text-[11.5px] font-medium">{t("fn_reqjd_title")}</span>
          {data?.rawSource && (
            <Badge variant={data.rawSource === "postgres" ? "ok" : "info"}>{data.rawSource === "postgres" ? "Postgres" : "RAAS"}</Badge>
          )}
          {!hasContent && !loading && <Badge variant="default">{t("fn_data_not_wired")}</Badge>}
          <div className="flex-1" />
          <span className="text-ink-3 text-[10.5px]">{open ? t("fn_collapse") : t("fn_show")}</span>
          <span className="text-ink-3" aria-hidden>{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div className="bg-bg border-t border-line" style={{ padding: "12px 14px" }}>
            {loading ? (
              <div className="text-ink-3 text-[12px] text-center py-3">{t("fn_loading")}</div>
            ) : !hasContent ? (
              <div className="text-ink-3 text-[11.5px] text-center py-3 leading-relaxed">{t("fn_reqjd_empty")}</div>
            ) : (
              <RequisitionBody data={data!} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RequisitionBody({ data }: { data: FunnelJobRequisitionResponse }) {
  const { t } = useApp();
  const r = data.requisition;
  const jd = data.jds[0];
  const kv = (label: string, v: React.ReactNode) =>
    v ? (
      <div className="flex gap-2 py-1 text-[11.5px]">
        <span className="text-ink-3 flex-shrink-0" style={{ width: 76 }}>{label}</span>
        <span className="text-ink-1">{v}</span>
      </div>
    ) : null;
  return (
    <div className="flex flex-col gap-3">
      {r && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-1 text-ink-3">{t("fn_req_section")}</div>
          {kv(t("fn_req_headcount"), r.headcount != null ? String(r.headcount) : null)}
          {kv(t("fn_req_salary"), r.salaryRangeMin != null || r.salaryRangeMax != null ? `${r.salaryRangeMin ?? "?"} – ${r.salaryRangeMax ?? "?"}` : null)}
          {kv(t("fn_req_source"), r.source)}
          {kv(t("fn_req_responsibilities"), r.responsibilities ? r.responsibilities.slice(0, 200) : null)}
          {kv(t("fn_req_requirements"), r.requirements ? r.requirements.slice(0, 200) : null)}
        </div>
      )}
      {jd && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-1 text-ink-3">{t("fn_jd_section")}</div>
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            {jd.qualityScore != null && (
              <Badge variant="ok">{t("fn_jd_quality")} {Math.round(jd.qualityScore * 100)}</Badge>
            )}
            {jd.degreeRequirement && <span className="text-[11px] text-ink-2">{jd.degreeRequirement}</span>}
            {jd.workYears != null && <span className="text-[11px] text-ink-2">{jd.workYears}{t("fn_jd_years")}</span>}
            {jd.generatorModel && <span className="text-ink-3 text-[10px] mono">{jd.generatorMode}/{jd.generatorModel}</span>}
          </div>
          {jd.mustHaveSkills.length > 0 && (
            <div className="flex items-start gap-2 py-0.5">
              <span className="text-ink-3 text-[11px] flex-shrink-0" style={{ width: 60 }}>{t("fn_jd_must")}</span>
              <div className="flex flex-wrap gap-1">
                {jd.mustHaveSkills.map((s, i) => (
                  <span key={i} className="h-5 px-1.5 rounded-sm text-[10.5px] flex items-center" style={{ color: "var(--c-accent)", background: "var(--c-accent-bg)" }}>{s}</span>
                ))}
              </div>
            </div>
          )}
          {jd.niceToHaveSkills.length > 0 && (
            <div className="flex items-start gap-2 py-0.5">
              <span className="text-ink-3 text-[11px] flex-shrink-0" style={{ width: 60 }}>{t("fn_jd_nice")}</span>
              <div className="flex flex-wrap gap-1">
                {jd.niceToHaveSkills.map((s, i) => (
                  <span key={i} className="h-5 px-1.5 rounded-sm text-[10.5px] flex items-center text-ink-2" style={{ background: "var(--c-panel)" }}>{s}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {data.rawRequirement != null && (
        <details>
          <summary className="text-ink-3 text-[10.5px] cursor-pointer">{t("fn_jd_raw")}</summary>
          <pre className="rounded-md mono text-[10px] overflow-auto mt-1.5" style={{ background: "var(--c-panel)", border: "1px solid var(--c-line)", padding: 8, maxHeight: 200, color: "var(--c-ink-2)" }}>
            {JSON.stringify(data.rawRequirement, null, 2).slice(0, 3000)}
          </pre>
        </details>
      )}
    </div>
  );
}

// 事件 AI 分析：开抽屉先取缓存，没有则按钮触发生成（串联查库 → LLM）。
function EventAnalysisPanel({ e }: { e: TLEvent }) {
  const { t } = useApp();
  const router = useRouter();
  const sp = useSearchParams();
  const eventId = e.id;
  const [resp, setResp] = React.useState<EventAnalysisResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [generating, setGenerating] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    setResp(null);
    fetchJson<EventAnalysisResponse>(`/api/funnel/event-analysis?event=${encodeURIComponent(eventId)}`)
      .then((r) => live && setResp(r))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [eventId]);

  const generate = (force = false) => {
    setGenerating(true);
    fetchJson<EventAnalysisResponse>(
      `/api/funnel/event-analysis?event=${encodeURIComponent(eventId)}${force ? "&force=1" : ""}`,
      { method: "POST" },
    )
      .then((r) => setResp(r))
      .catch((err) => setResp({ ok: false, reason: "error", error: (err as Error).message }))
      .finally(() => setGenerating(false));
  };

  // 深链：跳到该岗位漏斗（保留 dim，切到 job 视图、清候选人/事件）。
  const openJobFunnel = () => {
    if (!e.jobId) return;
    const p = new URLSearchParams(sp.toString());
    p.set("job", e.jobId);
    p.delete("candidate");
    p.delete("event");
    p.delete("dim");
    router.push(`/funnel?${p}`);
  };
  // #11 双向血缘：跳到该候选人画像（按候选人维度）。
  const candId = typeof (e.payload as Record<string, unknown> | null)?.candidate_id === "string" ? ((e.payload as Record<string, unknown>).candidate_id as string) : null;
  const openCandidate = () => {
    if (!candId) return;
    router.push(`/funnel?dim=candidate&candidate=${encodeURIComponent(candId)}`);
  };

  const analysis = resp && resp.ok ? resp.analysis : null;
  const failReason = resp && !resp.ok ? resp.reason : null;

  return (
    <section className="rounded-lg border" style={{ borderColor: "var(--c-accent-line)", background: "var(--c-accent-bg)" }}>
      <div className="flex items-center gap-2" style={{ padding: "9px 12px" }}>
        <Ic.sparkle />
        <span className="text-[12.5px] font-semibold" style={{ color: "var(--c-accent)" }}>
          {t("fn_ai_title")}
        </span>
        <div className="flex-1" />
        {analysis && (
          <button
            onClick={() => generate(true)}
            disabled={generating}
            className="text-[11px] transition-colors disabled:opacity-50"
            style={{ color: "var(--c-accent)" }}
          >
            {t("fn_ai_regenerate")}
          </button>
        )}
      </div>

      <div className="bg-surface rounded-b-lg" style={{ margin: 1, marginTop: 0 }}>
        {loading ? (
          <div className="text-ink-3 text-[11.5px] text-center py-5">{t("fn_loading")}</div>
        ) : generating ? (
          <div className="flex items-center justify-center gap-2 py-5 text-[11.5px]" style={{ color: "var(--c-accent)" }}>
            <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: "var(--c-accent)" }} />
            {t("fn_ai_analyzing")}
          </div>
        ) : analysis ? (
          <AnalysisBody a={analysis} model={resp && resp.ok ? resp.model : undefined} />
        ) : failReason ? (
          <div className="py-4 px-3 text-center">
            <div className="text-ink-2 text-[11.5px] mb-2">
              {failReason === "gateway_unavailable" ? t("fn_ai_unavailable") : t("fn_ai_failed")}
              {resp && !resp.ok && resp.error ? ` (${resp.error})` : ""}
            </div>
            <Btn size="sm" onClick={() => generate(false)}>
              {t("fn_ai_generate")}
            </Btn>
          </div>
        ) : (
          <div className="py-4 px-3 text-center">
            <div className="text-ink-3 text-[11px] mb-2 leading-relaxed">{t("fn_ai_cta_hint")}</div>
            <Btn size="sm" onClick={() => generate(false)}>
              <Ic.sparkle /> {t("fn_ai_generate")}
            </Btn>
          </div>
        )}

        {/* 深链：相关操作（双向血缘） */}
        {(e.auditId || e.jobId || candId) && (
          <div className="flex flex-wrap gap-1.5 border-t border-line" style={{ padding: "8px 12px" }}>
            {e.auditId && (
              <Link href={`/rule-check/audits/${encodeURIComponent(e.auditId)}`} className="no-underline">
                <LinkChip>{t("fn_ev_view_rulecheck")}</LinkChip>
              </Link>
            )}
            {e.jobId && (
              <button onClick={openJobFunnel}>
                <LinkChip>{t("fn_link_job_funnel")}</LinkChip>
              </button>
            )}
            {candId && (
              <button onClick={openCandidate}>
                <LinkChip>{t("fn_link_candidate")}</LinkChip>
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function LinkChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] transition-colors"
      style={{ color: "var(--c-accent)", border: "1px solid var(--c-accent-line)", background: "var(--c-surface)" }}
    >
      {children} <Ic.arrowR />
    </span>
  );
}

function AnalysisBody({ a, model }: { a: NonNullable<Extract<EventAnalysisResponse, { ok: true }>["analysis"]>; model?: string }) {
  const { t } = useApp();
  const Section = ({ label, children, accent }: { label: string; children: React.ReactNode; accent?: string }) => (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: accent ?? "var(--c-ink-3)" }}>
        {label}
      </div>
      <div className="text-[12px] text-ink-1 leading-relaxed">{children}</div>
    </div>
  );
  return (
    <div className="flex flex-col gap-3" style={{ padding: "12px 13px" }}>
      <Section label={t("fn_ai_sec_summary")}>{a.summary || "—"}</Section>
      <Section label={t("fn_ai_sec_chain")}>{a.chainRole || "—"}</Section>
      <Section label={t("fn_ai_sec_reasoning")} accent="var(--c-accent)">
        {a.reasoning || "—"}
      </Section>
      {a.risks.length > 0 && (
        <Section label={t("fn_ai_sec_risks")} accent="var(--c-warn)">
          <ul className="flex flex-col gap-1">
            {a.risks.map((r, i) => (
              <li key={i} className="flex gap-1.5">
                <span style={{ color: "var(--c-warn)" }}>•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {a.nextStep && <Section label={t("fn_ai_sec_next")}>{a.nextStep}</Section>}
      {model && (
        <div className="text-ink-3 text-[10px] mono pt-1 border-t border-line">
          {t("fn_ai_by").replace("{model}", model)}
        </div>
      )}
    </div>
  );
}

function friendlyTitle(e: TLEvent, t: ReturnType<typeof useApp>["t"]): string {
  if (e.name.startsWith("MATCH_RULE_CHECK")) {
    return `${e.stageLabelZh} · ${e.decision === "FAIL" ? t("fn_block_word") : t("fn_pass_word")}`;
  }
  return e.decision ? `${e.stageLabelZh} · ${e.decision}` : e.stageLabelZh;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function groupByDay(events: TLEvent[]): Array<[string, TLEvent[]]> {
  const map = new Map<string, TLEvent[]>();
  for (const e of events) {
    const key = dayLabel(e.ts);
    let arr = map.get(key);
    if (!arr) map.set(key, (arr = []));
    arr.push(e);
  }
  return Array.from(map.entries());
}

function KpiStrip({ kpi }: { kpi: FunnelJobsResponse["kpi"] }) {
  const { t } = useApp();
  const items = [
    { label: t("fn_kpi_open_jobs"), value: String(kpi.openJobs) },
    { label: t("fn_kpi_candidates"), value: kpi.candidatesInFunnel.toLocaleString() },
    { label: t("fn_kpi_pass_rate"), value: kpi.ruleCheckPassRate === null ? "—" : `${kpi.ruleCheckPassRate}%` },
  ];
  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map((it) => (
        <Card key={it.label}>
          <div style={{ padding: "12px 16px" }}>
            <div className="text-ink-3 text-[11px]">{it.label}</div>
            <div className="text-[22px] font-semibold tracking-tight mt-0.5 tabular-nums">{it.value}</div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function JobDetail({
  job,
  onSelectCandidate,
}: {
  job: FunnelJobRow;
  onSelectCandidate: (id: string) => void;
}) {
  const { t } = useApp();
  const cohort = useCohort(job.jobId);
  const rc = job.stages.find((s) => s.key === "rule_check");
  const passRate =
    rc && (rc.passed ?? 0) + (rc.dropped ?? 0) > 0
      ? Math.round(((rc.passed ?? 0) / ((rc.passed ?? 0) + (rc.dropped ?? 0))) * 100)
      : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-bg overflow-auto">
      {/* header */}
      <div className="border-b border-line bg-surface" style={{ padding: "16px 22px" }}>
        <div className="flex items-center gap-3">
          <Tile seed={job.jobId} label={firstChar(job.title)} big />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-tight truncate">{job.title}</div>
            <div className="text-ink-3 text-[12px] truncate">
              {job.client || "—"}
              {job.city ? ` · ${job.city}` : ""}
            </div>
          </div>
          <div className="flex-1" />
          <Metric label={t("fn_kpi_candidates")} value={String(job.candidateTotal)} />
          <Metric label={t("fn_kpi_pass_rate")} value={passRate === null ? "—" : `${passRate}%`} />
        </div>
      </div>

      {/* 岗位生命周期 + 需求/JD 画像 */}
      <JobRequisitionSection jobId={job.jobId} />

      {/* 候选人漏斗 */}
      <div style={{ padding: "16px 22px 8px" }}>
        <SectionLabel>{t("fn_process_candidate")}</SectionLabel>
        <ProcessStepper stages={job.stages} />
      </div>

      {/* AI 漏斗诊断 */}
      <div style={{ padding: "12px 22px 0" }}>
        <JobAnalysisPanel jobId={job.jobId} />
      </div>

      {/* cohort */}
      <div style={{ padding: "12px 22px 22px" }} className="flex-1">
        <div className="flex items-center gap-2">
          <SectionLabel>
            {t("fn_cohort")} · {cohort.data?.candidates.length ?? job.candidateTotal}
          </SectionLabel>
          <div className="flex-1" />
          <BatchPregenButton jobId={job.jobId} />
        </div>
        <Card className="mt-2">
          {cohort.loading && !cohort.data ? (
            <div className="text-ink-3 text-[12px] text-center py-8">{t("fn_loading")}</div>
          ) : !cohort.data || cohort.data.candidates.length === 0 ? (
            <div className="text-ink-3 text-[12px] text-center py-8">{t("fn_empty_title")}</div>
          ) : (
            cohort.data.candidates.map((c, i) => (
              <CohortRow
                key={`${c.candidateId}-${c.jobId}`}
                c={c}
                first={i === 0}
                onClick={() => c.hasLineage && onSelectCandidate(c.candidateId)}
              />
            ))
          )}
        </Card>
      </div>
    </div>
  );
}

function CohortRow({
  c,
  first,
  onClick,
}: {
  c: FunnelCandidateRow;
  first: boolean;
  onClick: () => void;
}) {
  const { t } = useApp();
  const ts = new Date(c.lastActivityAt);
  const time = `${ts.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} ${ts.toLocaleTimeString(undefined, { hour12: false })}`;
  const clickable = c.hasLineage;
  return (
    <button
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      className="w-full flex items-center gap-3 text-left transition-colors hover:bg-panel disabled:hover:bg-transparent disabled:cursor-default"
      style={{
        padding: "10px 14px",
        borderTop: first ? "none" : "1px solid var(--c-line)",
        opacity: clickable ? 1 : 0.65,
      }}
    >
      <Tile
        seed={c.candidateId}
        label={c.candidateName ? firstChar(c.candidateName) : c.candidateId.slice(0, 2).toUpperCase()}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="text-[12px] text-ink-1 truncate"
            style={c.candidateName ? { fontWeight: 500 } : { fontFamily: "var(--f-mono)" }}
          >
            {c.candidateName ?? c.candidateId.slice(0, 12)}
          </span>
          <StatusBadge status={c.status} />
        </div>
        <div className="text-ink-3 text-[10.5px] mono mt-0.5 truncate">
          {c.candidateName ? `${c.candidateId.slice(0, 8)} · ` : ""}
          {c.hasLineage ? c.traceId ?? `run ${c.runId.slice(0, 12)}` : t("fn_no_lineage")}
        </div>
      </div>
      <span className="text-ink-3 text-[10.5px] mono flex-shrink-0">{time}</span>
      {clickable && (
        <span className="text-accent flex-shrink-0">
          <Ic.arrowR />
        </span>
      )}
    </button>
  );
}

// ── 流程 stepper：预筛环为彩色主角，未接入环收成浅色 ghost。 ──
function ProcessStepper({ stages }: { stages: FunnelStageCount[] }) {
  const { t } = useApp();
  return (
    <div className="mt-3">
      <div className="flex items-stretch">
        {stages.map((s, i) => (
          <StepCol key={s.key} stage={s} isFirst={i === 0} isLast={i === stages.length - 1} />
        ))}
      </div>
      <div className="text-ink-3 text-[10.5px] mt-2.5 flex items-center gap-1.5">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: "var(--c-line)", border: "1px solid var(--c-ink-3)" }}
        />
        {t("fn_data_not_wired_hint")}
      </div>
    </div>
  );
}

function StepCol({
  stage,
  isFirst,
  isLast,
}: {
  stage: FunnelStageCount;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { t } = useApp();
  const wired = stage.available;
  const passed = stage.passed ?? 0;
  const dropped = stage.dropped ?? 0;
  const total = passed + dropped;
  const passPct = total > 0 ? Math.round((passed / total) * 100) : 0;
  return (
    <div className="flex-1 min-w-0 px-0.5">
      {/* label */}
      <div
        className="text-center text-[11px] truncate mb-1.5"
        style={{ color: wired ? "var(--c-ink-1)" : "var(--c-ink-3)", fontWeight: wired ? 600 : 400 }}
      >
        {t(`fn_stage_${stage.key}` as Parameters<typeof t>[0])}
      </div>
      {/* pipeline line + node */}
      <div className="relative flex items-center justify-center" style={{ height: 12 }}>
        <span className="absolute left-0 top-1/2 -translate-y-1/2" style={{ height: 2, width: "50%", background: "var(--c-line)", display: isFirst ? "none" : undefined }} />
        <span className="absolute right-0 top-1/2 -translate-y-1/2" style={{ height: 2, width: "50%", background: "var(--c-line)", display: isLast ? "none" : undefined }} />
        <span
          className="relative z-10 rounded-full"
          style={
            wired
              ? { width: 11, height: 11, background: "var(--c-ok)", boxShadow: "0 0 0 4px var(--c-ok-bg)" }
              : { width: 8, height: 8, background: "var(--c-surface)", border: "1.5px solid var(--c-ink-3)", opacity: 0.6 }
          }
        />
      </div>
      {/* 漏斗转化条：绿=通过、红=拦截；不再裸数字 */}
      <div className="mt-3">
        {wired ? (
          <>
            <div className="h-2 rounded-full overflow-hidden flex" style={{ background: "var(--c-panel)" }} title={`${t("fn_pass_word")} ${passed} · ${t("fn_block_word")} ${dropped} · ${passPct}%`}>
              <div style={{ width: `${passPct}%`, background: "var(--c-ok)" }} />
              <div style={{ width: `${100 - passPct}%`, background: dropped > 0 ? "var(--c-err)" : "transparent" }} />
            </div>
            <div className="flex items-center justify-center gap-2.5 mt-1.5 text-[10.5px]">
              <span style={{ color: "var(--c-ok)" }}>✓ {passed}</span>
              {dropped > 0 && <span style={{ color: "var(--c-err)" }}>✕ {dropped}</span>}
            </div>
          </>
        ) : (
          <>
            <div className="h-2 rounded-full" style={{ background: "var(--c-panel)", opacity: 0.4, border: "1px dashed var(--c-line)" }} />
            <div className="text-center mt-1.5 text-[10.5px] text-ink-3">—</div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────── atoms ───────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-ink-3 text-[10.5px] font-semibold uppercase tracking-wide">{children}</div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right flex-shrink-0 px-2">
      <div className="text-ink-3 text-[10px]">{label}</div>
      <div className="text-[16px] font-semibold tabular-nums leading-tight">{value}</div>
    </div>
  );
}

function Tile({ seed, label, big }: { seed: string; label: string; big?: boolean }) {
  const hue = hashHue(seed);
  const size = big ? 38 : 32;
  return (
    <div
      className="rounded-md grid place-items-center text-white font-semibold flex-shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: big ? 14 : 12,
        background: `linear-gradient(135deg, oklch(0.62 0.13 ${hue}), oklch(0.5 0.15 ${(hue + 40) % 360}))`,
      }}
    >
      {label}
    </div>
  );
}

function StatusBadge({ status }: { status: FunnelCandidateStatus }) {
  const { t } = useApp();
  const map: Record<FunnelCandidateStatus, "ok" | "warn" | "err" | "info" | "default"> = {
    active: "info",
    review: "warn",
    blocked: "err",
    failed: "err",
    submitted: "ok",
  };
  return <Badge variant={map[status]}>{t(statusKey(status))}</Badge>;
}

function statusKey(s: FunnelCandidateStatus): Parameters<ReturnType<typeof useApp>["t"]>[0] {
  return `fn_status_${s}` as Parameters<ReturnType<typeof useApp>["t"]>[0];
}

function firstChar(s: string): string {
  const c = s.trim()[0];
  return c ? c.toUpperCase() : "·";
}

function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}
