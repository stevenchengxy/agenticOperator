"use client";
import React from "react";
import Link from "next/link";
import { Ic } from "@/components/shared/Ic";
import type { FleetRow } from "./FleetContent";

// 智能体详情抽屉 — 从右侧滑出，盖在 /fleet 列表上（点击行打开，不跳转整页）。
// 苹果 sheet 风格：头像 + 标题、状态/阶段徽章、一句话职责、三张统计卡、近 24h
// 运行量曲线、最近运行列表、底部三个跳转。暂停/上线仍在列表行内，故抽屉不带。
// 数据：统计卡来自 FleetRow（与列表同源的实时 overlay）；曲线 + 最近运行来自
// GET /api/inngest-admin/agents/[slug]（真实数据，未部署则降级）。

const STAGE_KEYS: Record<string, string> = {
  system: "flx_stage_system",
  requirement: "flx_stage_requirement",
  jd: "flx_stage_jd",
  resume: "flx_stage_resume",
  match: "flx_stage_match",
  interview: "flx_stage_interview",
  eval: "flx_stage_eval",
  package: "flx_stage_package",
  submit: "flx_stage_submit",
};

// Shape consumed from GET /api/inngest-admin/agents/[slug].
type FlowRow = {
  flowId: string;
  latestStartedAt: string | null;
  status: string;
  durationMs: number | null;
  label: { candidateName?: string; jdTitle?: string };
  eventName: string | null;
  runs: { id: string; status: string; startedAt: string; durationMs: number | null }[];
};
type AgentDetailResp = {
  agent?: { triggers?: Array<{ value?: string; event?: string }> };
  stats?: { total: number; completed: number; failed: number; running: number; successRate: number | null };
  flows?: FlowRow[];
};

// P95 of finished-run durations (ms) — mirrors the fleet overlay's metric so
// the drawer's 执行时间 card uses the same definition over its own 24h window.
function percentile95(durations: number[]): number | null {
  const xs = durations.filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.min(xs.length - 1, Math.ceil(0.95 * xs.length) - 1);
  return xs[Math.max(0, idx)];
}

function tileHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

// Compact "3.1s" / "850ms" for the stat card.
function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// Timer "00:00:03.2" for each recent-run row (matches the reference).
function fmtTimer(ms: number | null): string {
  if (ms == null) return "—";
  const total = ms / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${pad2(h)}:${pad2(m)}:${s.toFixed(1).padStart(4, "0")}`;
}

// iOS-style compact relative time: "刚刚" / "3m" / "2h" / "1d".
function relTime(iso: string | null | undefined, t: (k: string) => string): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 60) return t("flx_just_now");
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function statusColor(s: string | null | undefined): string {
  if (s === "Completed") return "var(--c-ok)";
  if (s === "Failed" || s === "Cancelled") return "var(--c-err)";
  if (s === "Running") return "var(--c-accent)";
  return "var(--c-ink-4)";
}

export function AgentDetailDrawer({
  row,
  onClose,
  t,
}: {
  row: FleetRow | null;
  onClose: () => void;
  t: (k: string) => string;
}) {
  const [detail, setDetail] = React.useState<AgentDetailResp | null>(null);
  const slug = row?.slug ?? null;
  const stub = row?.realness === "unbuilt";
  // Only "real" agents are registered Inngest functions with run history.
  // Shells (deployed placeholders) and unbuilt blueprints have none — the
  // agents/[slug] endpoint 404s for them, so we skip the fetch entirely.
  const real = row?.realness === "real";

  // Fetch run history (chart + recent runs) for real agents only. Any non-OK
  // response resolves to an empty result (NOT null) so we never get stuck in
  // the loading state.
  React.useEffect(() => {
    if (!row || !real || !slug) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    fetch(`/api/inngest-admin/agents/${encodeURIComponent(slug)}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<AgentDetailResp>) : { flows: [] }))
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail({ flows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [row, slug, real]);

  // Esc to close.
  React.useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [row, onClose]);

  if (!row) return null;

  const roleLabel = t(row.roleK) || row.name;
  const hue = tileHue(row.short);
  const glyph = [...roleLabel.trim()][0] ?? "·";
  const descKey = `${row.roleK}_desc`;
  const desc = t(descKey);
  const hasDesc = desc && desc !== descKey;

  const flows = detail?.flows ?? [];
  const loading = real && detail === null;

  // The drawer is a single-agent deep view → all three cards + the chart + the
  // recent-runs list read the SAME 24h window (the agents/[slug] fetch) so they
  // always agree. Until that fetch lands we fall back to the list's live-overlay
  // values, so the cards render instantly without a spinner.
  const runDurations = flows
    .flatMap((f) => (f.runs ?? []).map((r) => r.durationMs))
    .filter((d): d is number => typeof d === "number" && d > 0);
  const cardTotal = detail?.stats?.total ?? row.liveTotal;
  const cardSuccess = detail?.stats?.successRate ?? row.successRate;
  const cardP95 = (detail ? percentile95(runDurations) : null) ?? row.p95Ms;

  // Event name for the "查看事件" deep-link — prefer a real recent event, fall
  // back to the registered trigger, else link to the unfiltered events stream.
  const evName =
    flows.find((f) => f.eventName)?.eventName ??
    detail?.agent?.triggers?.[0]?.value ??
    detail?.agent?.triggers?.[0]?.event ??
    null;
  const eventsHref = evName ? `/events?name=${encodeURIComponent(evName)}` : "/events";

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div
        className="absolute inset-0 ao-backdrop-in"
        style={{ background: "color-mix(in oklab, var(--c-ink-1) 30%, transparent)" }}
        aria-hidden
      />
      <aside
        className="relative h-full w-full max-w-[480px] bg-surface border-l border-line shadow-sh-3 flex flex-col ao-drawer-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={roleLabel}
      >
        {/* ── header ── */}
        <div className="flex items-start gap-3.5 border-b border-line" style={{ padding: "22px 24px 18px" }}>
          <span
            className="rounded-2xl grid place-items-center flex-none font-semibold"
            style={{
              width: 56,
              height: 56,
              fontSize: 22,
              color: `oklch(0.98 0.02 ${hue})`,
              background: `linear-gradient(145deg, oklch(0.62 0.16 ${hue}), oklch(0.52 0.17 ${(hue + 28) % 360}))`,
              opacity: stub ? 0.55 : 1,
            }}
          >
            {glyph}
          </span>
          <div className="min-w-0 flex-1" style={{ marginTop: 2 }}>
            <div className="text-ink-1 truncate" style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>
              {roleLabel}
            </div>
            <div className="mono text-ink-3 truncate" style={{ fontSize: 12.5, marginTop: 3 }}>
              {row.name} · {row.version}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-none w-8 h-8 grid place-items-center rounded-lg text-ink-3 hover:bg-panel hover:text-ink-1 transition-colors"
            aria-label={t("flx_close")}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ── scroll body ── */}
        <div className="flex-1 overflow-y-auto" style={{ padding: "18px 24px 24px" }}>
          {/* badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={row.status} t={t} />
            <Badge>{stageLabel(row.stage, t)}</Badge>
            <Link
              href={`/fleet/${row.short}?tab=versions`}
              className="ml-auto inline-flex items-center gap-1 text-ink-3 hover:text-ink-1 transition-colors"
              style={{ fontSize: 12 }}
            >
              {t("fd_versions_link")} <span style={{ fontSize: 11 }}>↗</span>
            </Link>
          </div>

          {/* description */}
          {hasDesc && (
            <p className="text-ink-2 m-0" style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 14 }}>
              {desc}
            </p>
          )}

          {/* stat cards */}
          <div className="grid grid-cols-3 gap-3" style={{ marginTop: 18 }}>
            <StatCard
              value={cardTotal != null ? cardTotal.toLocaleString() : "—"}
              label={t("fd_stat_runs")}
            />
            <StatCard
              value={cardSuccess != null ? `${cardSuccess.toFixed(1)}%` : "—"}
              label={t("fd_stat_success")}
              valueColor={
                cardSuccess == null
                  ? undefined
                  : cardSuccess >= 95
                    ? "var(--c-ink-1)"
                    : cardSuccess >= 90
                      ? "oklch(0.5 0.14 75)"
                      : "var(--c-err)"
              }
            />
            <StatCard value={fmtDuration(cardP95)} label={t("fd_stat_duration")} />
          </div>

          {stub ? (
            <div
              className="text-ink-2 leading-relaxed"
              style={{
                fontSize: 13,
                marginTop: 18,
                padding: "14px 16px",
                background: "var(--c-panel)",
                border: "1px solid var(--c-line)",
                borderRadius: 12,
              }}
            >
              {t("fd_not_deployed_hint")}
            </div>
          ) : (
            <>
              {/* 24h run-volume chart */}
              <SectionLabel style={{ marginTop: 24 }}>{t("fd_runs_24h")}</SectionLabel>
              <div
                className="border border-line rounded-xl overflow-hidden"
                style={{ marginTop: 10, padding: "14px 14px 8px" }}
              >
                <RunVolumeChart flows={flows} loading={loading} />
              </div>

              {/* recent runs */}
              <SectionLabel style={{ marginTop: 24 }}>{t("fd_recent_runs")}</SectionLabel>
              <div style={{ marginTop: 6 }}>
                {loading ? (
                  <div className="text-ink-4 text-center" style={{ fontSize: 12.5, padding: "20px 0" }}>
                    …
                  </div>
                ) : flows.length === 0 ? (
                  <div
                    className="text-ink-4 text-center rounded-xl border border-dashed border-line"
                    style={{ fontSize: 12.5, padding: "20px 0", marginTop: 4 }}
                  >
                    {t("fd_no_runs")}
                  </div>
                ) : (
                  flows.slice(0, 6).map((f) => <RecentRunRow key={f.flowId} flow={f} t={t} />)
                )}
              </div>
            </>
          )}
        </div>

        {/* ── footer action bar ── */}
        <div className="border-t border-line flex items-center gap-2.5" style={{ padding: "14px 24px" }}>
          <ActionLink href={`/workflow?node=${encodeURIComponent(row.short)}`} icon={<Ic.workflow />}>
            {t("fd_btn_workflow")}
          </ActionLink>
          <ActionLink href="/chat" icon={<Ic.chat />}>
            {t("fd_btn_trace")}
          </ActionLink>
          <ActionLink href={eventsHref} icon={<Ic.bolt />} primary>
            {t("fd_btn_events")}
          </ActionLink>
        </div>
      </aside>
    </div>
  );
}

function stageLabel(stage: string, t: (k: string) => string): string {
  const k = STAGE_KEYS[stage];
  return k ? t(k) : stage;
}

function SectionLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="text-ink-3 font-medium" style={{ fontSize: 12, ...style }}>
      {children}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center rounded-full border border-line text-ink-2"
      style={{ fontSize: 12, padding: "3px 10px" }}
    >
      {children}
    </span>
  );
}

function StatusBadge({ status, t }: { status: FleetRow["status"]; t: (k: string) => string }) {
  const { color, label, bg } =
    status === "not_deployed"
      ? { color: "var(--c-err)", label: t("flx_status_not_deployed"), bg: "transparent" }
      : status === "paused"
        ? { color: "var(--c-ink-4)", label: t("flx_status_paused"), bg: "transparent" }
        : { color: "var(--c-ok)", label: t("flx_status_deployed"), bg: "var(--c-ok-bg)" };
  const online = status === "deployed";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border"
      style={{
        fontSize: 12,
        padding: "3px 10px",
        color,
        background: bg,
        borderColor: online ? "color-mix(in oklab, var(--c-ok) 25%, transparent)" : "var(--c-line)",
      }}
    >
      <span
        className={online ? "rounded-full anim-pulse" : "rounded-full"}
        style={{ width: 6, height: 6, background: color }}
      />
      {label}
    </span>
  );
}

function StatCard({ value, label, valueColor }: { value: string; label: string; valueColor?: string }) {
  return (
    <div className="rounded-xl" style={{ background: "var(--c-panel)", padding: "14px 14px 12px" }}>
      <div
        className="tabular-nums"
        style={{ fontSize: 25, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.1, color: valueColor ?? "var(--c-ink-1)" }}
      >
        {value}
      </div>
      <div className="text-ink-3" style={{ fontSize: 12, marginTop: 5 }}>
        {label}
      </div>
    </div>
  );
}

function RecentRunRow({ flow, t }: { flow: FlowRow; t: (k: string) => string }) {
  const businessLabel = flow.label.jdTitle || flow.label.candidateName || null;
  const primary = businessLabel ?? relTime(flow.latestStartedAt, t);
  const secondary = businessLabel ? relTime(flow.latestStartedAt, t) : null;
  return (
    <div className="flex items-center gap-3 border-b border-line" style={{ padding: "11px 2px" }}>
      <span className="rounded-full flex-none" style={{ width: 7, height: 7, background: statusColor(flow.status) }} />
      <div className="min-w-0 flex-1">
        <div className="text-ink-1 truncate" style={{ fontSize: 13 }}>
          {primary}
        </div>
        {secondary && (
          <div className="text-ink-3" style={{ fontSize: 11.5, marginTop: 1 }}>
            {secondary}
          </div>
        )}
      </div>
      <span className="mono text-ink-3 tabular-nums flex-none" style={{ fontSize: 12 }}>
        {fmtTimer(flow.durationMs)}
      </span>
    </div>
  );
}

function ActionLink({
  href,
  icon,
  children,
  primary,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl transition-colors"
      style={
        primary
          ? { height: 42, fontSize: 13, fontWeight: 500, color: "#fff", background: "var(--c-accent)" }
          : { height: 42, fontSize: 13, fontWeight: 500, color: "var(--c-ink-1)", background: "var(--c-surface)", border: "1px solid var(--c-line)" }
      }
    >
      <span className="grid place-items-center" style={{ width: 15, height: 15 }}>
        {icon}
      </span>
      {children}
    </Link>
  );
}

// 24h run-volume area chart — buckets each run's startedAt into 24 hourly bins
// ending "now". Pure SVG, accent-tinted fill. Flat baseline when no runs.
function RunVolumeChart({ flows, loading }: { flows: FlowRow[]; loading: boolean }) {
  const W = 420;
  const H = 88;
  const PAD = 5;

  const buckets = React.useMemo(() => {
    const now = Date.now();
    const b = new Array(24).fill(0);
    for (const f of flows) {
      for (const r of f.runs ?? []) {
        const ts = new Date(r.startedAt).getTime();
        if (Number.isNaN(ts)) continue;
        const hoursAgo = (now - ts) / 3_600_000;
        if (hoursAgo < 0 || hoursAgo >= 24) continue;
        b[23 - Math.floor(hoursAgo)] += 1;
      }
    }
    return b;
  }, [flows]);

  if (loading) {
    return <div className="text-ink-4 text-center" style={{ fontSize: 12.5, padding: "26px 0" }}>…</div>;
  }

  const max = Math.max(...buckets, 1);
  const pts = buckets.map((v, i) => {
    const x = PAD + (i / (buckets.length - 1)) * (W - 2 * PAD);
    const y = H - PAD - (v / max) * (H - 2 * PAD - 6);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${H} L${pts[0][0].toFixed(1)} ${H} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id="ao-runvol" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--c-accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--c-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#ao-runvol)" />
      <path d={line} fill="none" stroke="var(--c-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
