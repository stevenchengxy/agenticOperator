"use client";
import React from "react";
import Link from "next/link";
import { useApp } from "@/lib/i18n";
import { fetchJson } from "@/lib/api/client";
import { STAGE_META, eventToStage, type PipelineStage } from "@/lib/events/pipeline-stages";
import type { CandidateTrackingResponse } from "@/app/api/events/candidates/route";
import { PipelineRibbon } from "./PipelineRibbon";

const POLL_MS = 4000;
const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

export function CandidateTrackingTab() {
  const { t, lang } = useApp();
  const [data, setData] = React.useState<CandidateTrackingResponse | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [windowHours, setWindowHours] = React.useState<number>(24);
  const [stageFilter, setStageFilter] = React.useState<PipelineStage | "all">("all");
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const r = await fetchJson<CandidateTrackingResponse>(`/api/events/candidates?windowHours=${windowHours}&limit=100`);
        if (!cancel) {
          setData(r);
          setErr(null);
        }
      } catch (e) {
        if (!cancel) setErr((e as Error).message);
      }
    }
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { cancel = true; clearInterval(timer); };
  }, [windowHours]);

  const candidates = data?.candidates ?? [];

  // Apply filters
  const visible = React.useMemo(() => {
    return candidates.filter((c) => {
      if (stageFilter !== "all" && c.latest_stage !== stageFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (!c.candidate_id.toLowerCase().includes(q) && !(c.candidate_name ?? "").toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [candidates, stageFilter, query]);

  // Auto-select first candidate if none selected
  React.useEffect(() => {
    if (!selectedId && visible.length > 0) setSelectedId(visible[0].candidate_id);
  }, [visible, selectedId]);

  const selected = visible.find((c) => c.candidate_id === selectedId) ?? null;

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* Left: candidate list */}
      <aside
        className="border-r border-line bg-surface flex flex-col"
        style={{ width: 320, flexShrink: 0 }}
      >
        <div className="border-b border-line" style={{ padding: "12px 14px" }}>
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-[12.5px] font-semibold text-ink-1">
              {t("em_candidates_title")}
              <span className="text-ink-3 font-normal ml-1.5">· {visible.length}</span>
            </span>
            <WindowSelect value={windowHours} onChange={setWindowHours} t={t} />
          </div>
          <input
            type="text"
            placeholder={t("em_candidates_search_placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-panel border border-line rounded text-[12px] text-ink-1 outline-none focus:border-[color:var(--c-accent)]"
            style={{ padding: "5px 9px" }}
          />
          <StageFilterChips value={stageFilter} onChange={setStageFilter} t={t} lang={lang} />
        </div>
        <div className="flex-1 overflow-auto" style={{ padding: "8px" }}>
          {err && (
            <div className="text-[11px] text-err mono" style={{ padding: "8px" }}>{err}</div>
          )}
          {visible.length === 0 && !err && (
            <div className="text-[11.5px] text-ink-3 text-center" style={{ padding: "24px 12px" }}>
              {t("em_candidates_empty")}
            </div>
          )}
          <div className="flex flex-col gap-1">
            {visible.map((c) => (
              <CandidateRow
                key={c.candidate_id}
                summary={c}
                active={c.candidate_id === selectedId}
                onClick={() => setSelectedId(c.candidate_id)}
                lang={lang}
              />
            ))}
          </div>
        </div>
      </aside>

      {/* Right: timeline */}
      <div className="flex-1 min-w-0 overflow-auto bg-bg">
        {selected ? (
          <CandidateDetail summary={selected} t={t} lang={lang} />
        ) : (
          <div className="flex items-center justify-center h-full text-ink-3 text-[12.5px]">
            {t("em_candidates_pick_one")}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function CandidateRow({
  summary, active, onClick, lang,
}: {
  summary: CandidateTrackingResponse["candidates"][number];
  active: boolean;
  onClick: () => void;
  lang: "zh" | "en";
}) {
  const stage = STAGE_META[summary.latest_stage];
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left cursor-pointer rounded-lg transition-colors"
      style={{
        padding: "8px 10px",
        background: active ? "var(--c-accent-bg)" : "transparent",
        borderLeft: active ? "2.5px solid var(--c-accent)" : "2.5px solid transparent",
        border: "none",
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--c-panel)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className={`text-[12.5px] truncate ${active ? "font-semibold text-ink-1" : "text-ink-1"}`}>
          {summary.candidate_name ?? `候选人 ${summary.candidate_id.slice(0, 8)}`}
        </div>
        <span
          className="rounded-full flex-shrink-0"
          style={{
            padding: "1px 7px",
            fontSize: 9.5,
            color: stage.color,
            background: "color-mix(in oklab, " + stage.color + " 12%, transparent)",
            border: "1px solid color-mix(in oklab, " + stage.color + " 30%, transparent)",
          }}
        >
          {lang === "zh" ? stage.zh : stage.en}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 mt-1">
        <div className="text-[10.5px] text-ink-3 mono truncate">{summary.candidate_id}</div>
        <div className="text-[10.5px] text-ink-4 mono">{relTime(summary.last_event_ts, lang)}</div>
      </div>
      {summary.jr_ids.length > 0 && (
        <div className="text-[10px] text-ink-3 mono truncate" style={{ marginTop: 2 }}>
          {summary.jr_ids.length} JR · {summary.event_count} events
        </div>
      )}
    </button>
  );
}

function CandidateDetail({
  summary, t, lang,
}: {
  summary: CandidateTrackingResponse["candidates"][number];
  t: (k: string) => string;
  lang: "zh" | "en";
}) {
  return (
    <div style={{ padding: "20px 26px" }}>
      {/* Header */}
      <div className="flex items-baseline justify-between gap-4 mb-1">
        <h2 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 500, letterSpacing: "-0.015em" }}>
          {summary.candidate_name ?? `候选人 ${summary.candidate_id.slice(0, 8)}`}
        </h2>
        <Link
          href={`/entities/candidate/${encodeURIComponent(summary.candidate_id)}`}
          className="text-[12px] text-accent hover:underline"
        >
          {t("em_candidates_view_journey")} →
        </Link>
      </div>
      <div className="text-[11.5px] text-ink-3 mono mb-4">{summary.candidate_id}</div>

      {/* Stage pipeline */}
      <div className="mb-5">
        <PipelineRibbon current={summary.latest_stage} eventsByName={summary.events_by_name} lang={lang} />
      </div>

      {/* JR list */}
      <Section title={t("em_candidates_section_jrs")} count={summary.jr_ids.length}>
        {summary.jr_ids.length === 0 ? (
          <div className="text-[11.5px] text-ink-3" style={{ padding: "8px 4px" }}>
            {t("em_candidates_no_jrs")}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {summary.jr_ids.map((jr) => (
              <span
                key={jr}
                className="mono text-[10.5px] rounded"
                style={{
                  padding: "3px 8px",
                  background: "var(--c-panel)",
                  border: "1px solid var(--c-line)",
                  color: "var(--c-ink-2)",
                }}
              >
                {jr}
              </span>
            ))}
          </div>
        )}
      </Section>

      {/* Events by name */}
      <Section title={t("em_candidates_section_events")} count={summary.event_count}>
        <div className="border border-line rounded" style={{ background: "var(--c-surface)" }}>
          {Object.entries(summary.events_by_name)
            .sort(([, a], [, b]) => b - a)
            .map(([name, count]) => {
              const stage = STAGE_META[eventToStage(name)];
              return (
                <div
                  key={name}
                  className="flex items-center justify-between gap-2 border-b border-line last:border-b-0"
                  style={{ padding: "8px 12px" }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="rounded-full flex-shrink-0"
                      style={{ width: 6, height: 6, background: stage.color }}
                      aria-hidden="true"
                    />
                    <code className="text-[11.5px] text-ink-1 truncate" style={{ fontFamily: "var(--f-mono)" }}>
                      {name}
                    </code>
                  </div>
                  <span className="text-[11px] text-ink-3 mono">×{count}</span>
                </div>
              );
            })}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontSize: 14, fontWeight: 500 }}>
          {title}
        </h3>
        {typeof count === "number" && <span className="text-[11px] text-ink-3 mono">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function StageFilterChips({
  value, onChange, t, lang,
}: {
  value: PipelineStage | "all";
  onChange: (v: PipelineStage | "all") => void;
  t: (k: string) => string;
  lang: "zh" | "en";
}) {
  const stages: Array<PipelineStage | "all"> = ["all", "intake", "parse", "rule_check", "match", "interview", "evaluate", "submit"];
  return (
    <div className="flex flex-wrap gap-1" style={{ marginTop: 8 }}>
      {stages.map((s) => {
        const active = value === s;
        const label = s === "all" ? t("em_candidates_filter_all") : (lang === "zh" ? STAGE_META[s].zh : STAGE_META[s].en);
        return (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            className="cursor-pointer rounded-full transition-colors"
            style={{
              padding: "2px 8px",
              fontSize: 10,
              border: "1px solid",
              borderColor: active ? "var(--c-accent)" : "var(--c-line)",
              background: active ? "var(--c-accent-bg)" : "transparent",
              color: active ? "var(--c-accent)" : "var(--c-ink-3)",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function WindowSelect({
  value, onChange, t,
}: { value: number; onChange: (v: number) => void; t: (k: string) => string }) {
  const opts: { v: number; key: string }[] = [
    { v: 1, key: "em_candidates_window_1h" },
    { v: 24, key: "em_candidates_window_24h" },
    { v: 72, key: "em_candidates_window_3d" },
    { v: 168, key: "em_candidates_window_7d" },
  ];
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="text-[11px] text-ink-2 bg-panel border border-line rounded outline-none"
      style={{ padding: "2px 6px" }}
    >
      {opts.map((o) => <option key={o.v} value={o.v}>{t(o.key)}</option>)}
    </select>
  );
}

function relTime(iso: string, lang: "zh" | "en"): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const min = Math.floor((now - then) / 60_000);
  if (min < 1) return lang === "zh" ? "刚刚" : "just now";
  if (min < 60) return lang === "zh" ? `${min}分钟前` : `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return lang === "zh" ? `${h}小时前` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return lang === "zh" ? `${d}天前` : `${d}d ago`;
}
