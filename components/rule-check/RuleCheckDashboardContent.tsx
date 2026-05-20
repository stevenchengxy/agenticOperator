"use client";
import React from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/api/client";

// Rule Check Dashboard (陈洋 macro view).
// Per Kenny / 2026-05-13 review:
//   - "一行一个场景,直接看 OK/Not OK,有 TP/FP/TN/FN 四象限分类"
//   - "马上可以计算 Coverage,Dead Rule 一目了然"
//
// And per 2026-05-19 user clarification: this should be the "image-like"
// grid — rules × audits cells with ✓ / ✗ / – symbols. Click any cell to
// drill into that audit's detail (in the 审计 layer).
//
// Hero KPI strip on top, then the rule × audit grid.

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

type Stats = {
  total: number;
  pass: number;
  fail: number;
  blocked_robohire_calls: number;
  avg_llm_duration_ms: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  estimated_robohire_savings_usd: number;
  by_client: Array<{ client: string; pass: number; fail: number }>;
  top_failure_rules: Array<{ rule_id: string; count: number }>;
  meta: { window_days: number; generated_at: string };
};

type AuditListRow = {
  audit_id: string;
  created_at: string;
  decision: string;
  client_name: string;
  business_group: string | null;
  job_requisition_id: string;
  rules_evaluated: number;
};

type Flag = {
  rule_id: string;
  rule_name_snapshot: string;
  severity: string;
  applicable: boolean;
  result: "PASS" | "FAIL" | "NOT_APPLICABLE" | "PENDING" | "INSUFFICIENT_INFO" | "NOT_EXECUTED" | string;
};

type AuditDetail = {
  audit_id: string;
  decision: string;
  created_at: string;
  client_name: string;
  flags: Flag[];
};

type MatrixRule = {
  rule_id: string;
  rule_name: string;
  total: number;
  pass: number;
  fail: number;
  not_applicable: number;
};

export function RuleCheckDashboardContent() {
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [audits, setAudits] = React.useState<AuditListRow[] | null>(null);
  const [details, setDetails] = React.useState<Record<string, AuditDetail | "error">>({});
  const [matrix, setMatrix] = React.useState<{ rules: MatrixRule[]; total_audits: number } | null>(null);
  const [windowDays, setWindowDays] = React.useState<7 | 30 | 90>(7);
  const [auditLimit, setAuditLimit] = React.useState(12);

  // Load top-level stats + audit list + per-rule matrix
  React.useEffect(() => {
    let cancel = false;
    fetchJson<Stats>(`/api/rule-check-audits/stats?window=${windowDays}d`)
      .then((s) => { if (!cancel) setStats(s); })
      .catch(() => { if (!cancel) setStats(null); });
    fetchJson<{ rules: MatrixRule[]; total_audits: number }>(`/api/rule-check-audits/matrix?window=${windowDays}d`)
      .then((m) => { if (!cancel) setMatrix(m); })
      .catch(() => { if (!cancel) setMatrix(null); });
    fetchJson<{ rows: AuditListRow[]; total: number }>(`/api/rule-check-audits?limit=${auditLimit}`)
      .then((d) => { if (!cancel) setAudits(d.rows); })
      .catch(() => { if (!cancel) setAudits(null); });
    return () => { cancel = true; };
  }, [windowDays, auditLimit]);

  // Fetch per-audit flags for the grid cells
  React.useEffect(() => {
    if (!audits) return;
    const missing = audits.filter((a) => !details[a.audit_id]);
    if (missing.length === 0) return;
    let cancel = false;
    (async () => {
      await Promise.all(missing.map(async (a) => {
        try {
          const res = await fetch(`/api/rule-check-audits/${encodeURIComponent(a.audit_id)}`);
          if (!res.ok) {
            if (!cancel) setDetails((d) => ({ ...d, [a.audit_id]: "error" }));
            return;
          }
          const body = await res.json();
          const detail = (body.detail ?? body) as AuditDetail;
          if (!cancel) setDetails((d) => ({ ...d, [a.audit_id]: detail }));
        } catch {
          if (!cancel) setDetails((d) => ({ ...d, [a.audit_id]: "error" }));
        }
      }));
    })();
    return () => { cancel = true; };
  }, [audits, details]);

  // Build the grid: rule_id × audit_id → result
  const grid = React.useMemo(() => {
    if (!audits || !matrix) return null;
    const ruleOrder = [...matrix.rules]
      .sort((a, b) => {
        if (a.fail !== b.fail) return b.fail - a.fail;
        return b.total - a.total;
      });
    const cellByRuleAudit = new Map<string, Map<string, string>>();
    for (const a of audits) {
      const d = details[a.audit_id];
      if (!d || d === "error") continue;
      for (const f of d.flags) {
        if (!cellByRuleAudit.has(f.rule_id)) cellByRuleAudit.set(f.rule_id, new Map());
        cellByRuleAudit.get(f.rule_id)!.set(a.audit_id, f.result);
      }
    }
    return { rules: ruleOrder, cells: cellByRuleAudit };
  }, [audits, matrix, details]);

  const passRate = stats && stats.total > 0 ? (stats.pass / stats.total) * 100 : null;
  const lowCoverage = (matrix?.rules ?? []).filter(
    (r) => r.total <= Math.max(1, Math.floor((matrix?.total_audits ?? 1) * 0.1)),
  );

  return (
    <div className="flex flex-col gap-6" style={{ padding: "20px 32px 40px" }}>
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 500, letterSpacing: "-0.01em" }}>
            总览
          </h2>
          <div className="text-ink-3 mt-1" style={{ fontSize: 12.5 }}>
            最近 {windowDays} 天 · {audits?.length ?? 0} 条审计 × {matrix?.rules.length ?? 0} 条规则 · 每个 cell 是该规则在该审计中的判定
          </div>
        </div>
        <WindowToggle value={windowDays} onChange={setWindowDays} />
      </div>

      {/* KPI strip */}
      <div className="grid gap-x-8 gap-y-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        <Kpi label="审计总数" value={stats?.total != null ? String(stats.total) : "—"} />
        <Kpi label="通过" value={stats?.pass != null ? String(stats.pass) : "—"} tone="ok" sub={passRate != null ? `${passRate.toFixed(1)}%` : undefined} />
        <Kpi label="失败" value={stats?.fail != null ? String(stats.fail) : "—"} tone={stats && stats.fail > 0 ? "err" : "muted"} />
        <Kpi label="拦截的 RoboHire 调用" value={stats?.blocked_robohire_calls != null ? String(stats.blocked_robohire_calls) : "—"} tone="ok" sub={stats ? `节省 $${stats.estimated_robohire_savings_usd.toFixed(2)}` : undefined} />
        <Kpi label="覆盖的 rules" value={matrix ? String(matrix.rules.length) : "—"} sub={lowCoverage.length > 0 ? `${lowCoverage.length} 条低覆盖` : undefined} />
      </div>

      {/* The hero grid — rules × audits */}
      <Section
        title="规则 × 审计 网格"
        hint={grid ? `${grid.rules.length} 条规则 × ${audits?.length ?? 0} 条审计` : "加载中…"}
        action={
          audits && audits.length === auditLimit && (
            <button onClick={() => setAuditLimit((n) => n + 12)} className="text-ink-3 hover:text-ink-1" style={{ fontSize: 12 }}>
              加载更多 →
            </button>
          )
        }
      >
        {grid && audits ? (
          <RuleAuditGrid grid={grid} audits={audits} />
        ) : (
          <div className="text-ink-3 py-6 text-center" style={{ fontSize: 12.5 }}>加载中…</div>
        )}
      </Section>

      {/* Legend */}
      <Legend />

      {/* Failure & coverage */}
      <div className="grid gap-6" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
        <Section title="失败次数最高的 rules">
          {stats?.top_failure_rules && stats.top_failure_rules.length > 0 ? (
            <div className="border-t border-line">
              {stats.top_failure_rules.map((r) => {
                const meta = matrix?.rules.find((m) => m.rule_id === r.rule_id);
                return (
                  <Link
                    key={r.rule_id}
                    href={`/rule-check?view=audits&ruleId=${encodeURIComponent(r.rule_id)}`}
                    className="grid items-center border-b border-line hover:bg-panel transition-colors"
                    style={{ gridTemplateColumns: "120px minmax(0, 1fr) 60px", padding: "10px 6px", textDecoration: "none" }}
                  >
                    <code className="text-ink-1 tabular-nums" style={{ fontFamily: "var(--f-mono)", fontSize: 12 }}>{r.rule_id}</code>
                    <span className="text-ink-2 truncate" style={{ fontSize: 12.5 }}>{meta?.rule_name ?? "—"}</span>
                    <span className="tabular-nums" style={{ textAlign: "right", fontSize: 13, color: "var(--c-err)" }}>✗ {r.count}</span>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="text-ink-3 py-6 text-center" style={{ fontSize: 12.5 }}>{stats ? "近期无失败" : "加载中…"}</div>
          )}
        </Section>

        <Section title="低覆盖率 rules" hint="触发次数 ≤ 10% — Dead Rule 候选">
          {lowCoverage.length > 0 ? (
            <div className="border-t border-line">
              {lowCoverage.slice(0, 8).map((r) => (
                <Link
                  key={r.rule_id}
                  href={`/rule-check?view=audits&ruleId=${encodeURIComponent(r.rule_id)}`}
                  className="grid items-center border-b border-line hover:bg-panel transition-colors"
                  style={{ gridTemplateColumns: "120px minmax(0, 1fr) 60px", padding: "10px 6px", textDecoration: "none" }}
                >
                  <code className="text-ink-1 tabular-nums" style={{ fontFamily: "var(--f-mono)", fontSize: 12 }}>{r.rule_id}</code>
                  <span className="text-ink-2 truncate" style={{ fontSize: 12.5 }}>{r.rule_name}</span>
                  <span className="tabular-nums" style={{ textAlign: "right", fontSize: 12, color: "var(--c-ink-3)" }}>{r.total} 次</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-ink-3 py-6 text-center" style={{ fontSize: 12.5 }}>{matrix ? "所有 rule 都达到阈值" : "加载中…"}</div>
          )}
        </Section>
      </div>
    </div>
  );
}

// ── The hero rule × audit grid ────────────────────────────────────────

const CELL_STYLE: Record<string, { bg: string; fg: string; symbol: string; label: string }> = {
  PASS:              { bg: "var(--c-ok-bg)",   fg: "var(--c-ok)",          symbol: "✓", label: "通过" },
  FAIL:              { bg: "var(--c-err-bg)",  fg: "var(--c-err)",         symbol: "✗", label: "失败" },
  NOT_APPLICABLE:    { bg: "var(--c-surface)", fg: "var(--c-ink-4)",       symbol: "·", label: "不适用" },
  NOT_EXECUTED:      { bg: "var(--c-panel)",   fg: "var(--c-ink-4)",       symbol: "⊘", label: "未执行" },
  PENDING:           { bg: "var(--c-warn-bg)", fg: "oklch(0.5 0.14 75)",   symbol: "⏸", label: "挂起" },
  INSUFFICIENT_INFO: { bg: "var(--c-warn-bg)", fg: "oklch(0.5 0.14 75)",   symbol: "?", label: "信息不足" },
};
const MISSING_CELL = { bg: "transparent", fg: "var(--c-ink-4)", symbol: "·", label: "无数据" };

function RuleAuditGrid({
  grid, audits,
}: {
  grid: { rules: MatrixRule[]; cells: Map<string, Map<string, string>> };
  audits: AuditListRow[];
}) {
  const cellSize = 22;
  const cellGap = 2;
  return (
    <div
      className="border border-line rounded"
      style={{ padding: "10px 12px", background: "var(--c-surface)", overflowX: "auto" }}
    >
      {/* column header — audit IDs (truncated) + decision dot */}
      <div
        className="grid items-end"
        style={{
          gridTemplateColumns: `minmax(220px, 280px) repeat(${audits.length}, ${cellSize}px)`,
          gap: cellGap,
          marginBottom: 6,
        }}
      >
        <div className="text-ink-3" style={{ fontSize: 11.5 }}>Rule \ Audit →</div>
        {audits.map((a, i) => (
          <Link
            key={a.audit_id}
            href={`/rule-check?view=audits&auditId=${encodeURIComponent(a.audit_id)}`}
            className="flex flex-col items-center gap-1 hover:opacity-80 transition-opacity"
            style={{ width: cellSize, textDecoration: "none" }}
            title={`审计 #${i + 1}\n${a.audit_id}\n决策 ${a.decision} · ${a.client_name} · ${fmtDate(a.created_at)}\n点击进 审计 详情`}
          >
            <span
              className="rounded-full"
              style={{
                width: 5, height: 5,
                background: a.decision === "PASS" ? "var(--c-ok)" : a.decision === "FAIL" ? "var(--c-err)" : "var(--c-ink-4)",
              }}
            />
            <span className="tabular-nums text-ink-3" style={{ fontSize: 9, lineHeight: 1 }}>
              {String(i + 1).padStart(2, "0")}
            </span>
          </Link>
        ))}
      </div>

      {/* rows: rule × cells */}
      {grid.rules.map((r) => (
        <div
          key={r.rule_id}
          className="grid items-center"
          style={{
            gridTemplateColumns: `minmax(220px, 280px) repeat(${audits.length}, ${cellSize}px)`,
            gap: cellGap,
            marginBottom: cellGap,
          }}
        >
          <Link
            href={`/rule-check?view=audits&ruleId=${encodeURIComponent(r.rule_id)}`}
            className="flex items-baseline gap-2 truncate hover:bg-panel transition-colors rounded"
            style={{ padding: "2px 6px", textDecoration: "none" }}
            title={r.rule_name}
          >
            <code className="text-ink-1 tabular-nums" style={{ fontFamily: "var(--f-mono)", fontSize: 11, minWidth: 48 }}>
              {r.rule_id}
            </code>
            <span className="text-ink-2 truncate" style={{ fontSize: 11.5 }}>{r.rule_name}</span>
          </Link>
          {audits.map((a) => {
            const cell = grid.cells.get(r.rule_id)?.get(a.audit_id);
            const style = cell ? CELL_STYLE[cell] ?? MISSING_CELL : MISSING_CELL;
            return (
              <Link
                key={a.audit_id}
                href={`/rule-check?view=audits&auditId=${encodeURIComponent(a.audit_id)}`}
                title={cell ? `${r.rule_id} · ${style.label} · audit ${a.audit_id.slice(-10)}` : "未加载"}
                className="grid place-items-center rounded transition-transform hover:scale-110"
                style={{
                  width: cellSize, height: cellSize,
                  background: style.bg,
                  color: style.fg,
                  fontSize: 12,
                  fontWeight: 500,
                  border: cell === "FAIL" ? "1px solid color-mix(in oklab, var(--c-err) 25%, transparent)" : "1px solid transparent",
                  textDecoration: "none",
                }}
              >
                {style.symbol}
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Legend() {
  const items = [
    { ...CELL_STYLE.PASS },
    { ...CELL_STYLE.FAIL },
    { ...CELL_STYLE.NOT_APPLICABLE },
    { ...CELL_STYLE.PENDING },
    { ...CELL_STYLE.INSUFFICIENT_INFO },
    { ...CELL_STYLE.NOT_EXECUTED },
  ];
  return (
    <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
      <span className="text-ink-3" style={{ fontSize: 11.5 }}>图例</span>
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5 text-ink-2" style={{ fontSize: 11.5 }}>
          <span
            className="grid place-items-center rounded"
            style={{
              width: 18, height: 18,
              background: it.bg, color: it.fg,
              fontSize: 11, fontWeight: 500,
              border: "1px solid var(--c-line)",
            }}
          >
            {it.symbol}
          </span>
          {it.label}
        </span>
      ))}
    </div>
  );
}

// ── small components ────────────────────────────────────────────

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "err" | "muted" }) {
  const color =
    tone === "ok"   ? "var(--c-ok)" :
    tone === "warn" ? "oklch(0.5 0.14 75)" :
    tone === "err"  ? "var(--c-err)" :
    "var(--c-ink-1)";
  return (
    <div>
      <div className="text-ink-3" style={{ fontSize: 12 }}>{label}</div>
      <div className="mt-1.5">
        <span
          className="tabular-nums"
          style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 500, letterSpacing: "-0.02em", color, lineHeight: 1.05 }}
        >
          {value}
        </span>
      </div>
      {sub && <div className="text-ink-3 mt-1" style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="flex items-baseline gap-2.5">
          <h3 className="m-0 text-ink-1" style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em" }}>
            {title}
          </h3>
          {hint && <span className="text-ink-3" style={{ fontSize: 12 }}>{hint}</span>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function WindowToggle({ value, onChange }: { value: 7 | 30 | 90; onChange: (v: 7 | 30 | 90) => void }) {
  const opts: { id: 7 | 30 | 90; label: string }[] = [
    { id: 7, label: "近 7d" },
    { id: 30, label: "近 30d" },
    { id: 90, label: "近 90d" },
  ];
  return (
    <div className="flex items-center gap-1">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className="transition-colors rounded"
          style={{
            padding: "3px 9px",
            color: value === o.id ? "var(--c-ink-1)" : "var(--c-ink-3)",
            background: value === o.id ? "var(--c-panel)" : "transparent",
            fontWeight: value === o.id ? 500 : 400,
            fontSize: 12.5,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch { return iso.slice(0, 16); }
}
