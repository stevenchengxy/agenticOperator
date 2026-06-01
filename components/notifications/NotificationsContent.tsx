"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Ic, IcName } from "@/components/shared/Ic";
import { fetchJson } from "@/lib/api/client";

// ── shapes (mirror /api/notifications) ──────────────────────────────────────
type Kind = "message" | "alert";
type Severity = "info" | "warning" | "critical";
type Category = "system" | "agent" | "event" | "candidate" | "job";

type NotificationRow = {
  id: string;
  ts: string;
  kind: Kind;
  severity: Severity;
  category: Category;
  source: string;
  title: string;
  body: string;
  aiSource: string | null;
  count: number;
  disposition: "needs_human" | "auto_handled" | "info_only";
  managerAction: string | null;
  status: string | null;
  readAt: string | null;
  anchors: Record<string, string> | null;
  href: string | null;
};

type NotificationsResponse = {
  notifications: NotificationRow[];
  nextCursor: string | null;
  counts: {
    byCategory: Partial<Record<Category, number>>;
    byKind: Partial<Record<Kind, number>>;
    needsHuman: number;
    unread: number;
  } | null;
};

const CATEGORIES: Category[] = ["system", "agent", "event", "candidate", "job"];
const CAT_ICON: Record<Category, IcName> = {
  system: "shield",
  agent: "cpu",
  event: "bolt",
  candidate: "user",
  job: "branch",
};

// Severity → label key + OKLCH ink (tokens auto-respond to theme; the warn
// shade is copied from the design references per the CLAUDE.md design note).
const SEV: Record<Severity, { key: string; ink: string; bg: string }> = {
  critical: { key: "ntf_sev_critical", ink: "var(--c-err)", bg: "color-mix(in oklch, var(--c-err) 14%, transparent)" },
  warning: { key: "ntf_sev_warning", ink: "oklch(0.62 0.15 70)", bg: "color-mix(in oklch, oklch(0.62 0.15 70) 16%, transparent)" },
  info: { key: "ntf_sev_info", ink: "var(--c-accent)", bg: "var(--c-accent-bg)" },
};

function useRelativeTime() {
  const { lang } = useApp();
  return (iso: string): string => {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
    const z = lang === "zh";
    if (sec < 60) return z ? "刚刚" : "just now";
    const min = Math.round(sec / 60);
    if (min < 60) return z ? `${min}m 前` : `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return z ? `${hr}h 前` : `${hr}h ago`;
    const d = Math.round(hr / 24);
    return z ? `${d}d 前` : `${d}d ago`;
  };
}

export function NotificationsContent() {
  const { t } = useApp();
  const rel = useRelativeTime();

  const [tab, setTab] = React.useState<"notify" | "todo" | "oncall">("notify");
  const [kind, setKind] = React.useState<"all" | Kind>("all");
  const [category, setCategory] = React.useState<"all" | Category>("all");
  const [onlyMine, setOnlyMine] = React.useState(false);
  const [data, setData] = React.useState<NotificationsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  const needsHumanFilter = tab === "todo" || onlyMine;

  const load = React.useCallback(async () => {
    const qs = new URLSearchParams();
    if (kind !== "all") qs.set("kind", kind);
    if (category !== "all") qs.set("category", category);
    if (needsHumanFilter) qs.set("needsHuman", "1");
    qs.set("limit", "60");
    try {
      const res = await fetchJson<NotificationsResponse>(`/api/notifications?${qs.toString()}`);
      setData(res);
    } catch {
      setData({ notifications: [], nextCursor: null, counts: null });
    } finally {
      setLoading(false);
    }
  }, [kind, category, needsHumanFilter]);

  React.useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  const markAllRead = async () => {
    try {
      await fetchJson(`/api/notifications`, { method: "POST", body: JSON.stringify({ action: "read_all" }) });
      load();
    } catch {
      /* ignore */
    }
  };

  const counts = data?.counts;
  const rows = data?.notifications ?? [];
  const autoHandled = rows.filter((r) => r.disposition === "auto_handled").length;

  return (
    <div className="px-8 py-6 max-w-[1100px] mx-auto">
      {/* header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <div className="text-[11px] tracking-wider text-ink-3 uppercase mb-1">
            {t("ntf_title")} · NOTIFICATIONS
          </div>
          <h1 className="text-2xl font-semibold text-ink-1">{t("ntf_title")}</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-[640px]">{t("ntf_sub")}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={markAllRead}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-line text-ink-2 hover:bg-raised"
          >
            <Ic.check />
            {t("ntf_mark_all_read")}
          </button>
          <button className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-line text-ink-2 hover:bg-raised">
            <Ic.bell />
            {t("ntf_settings")}
          </button>
        </div>
      </div>

      {/* tabs */}
      <div className="flex items-center gap-6 border-b border-line mb-4">
        {([
          ["notify", t("ntf_tab_notify"), counts?.unread],
          ["todo", t("ntf_tab_todo"), counts?.needsHuman],
          ["oncall", t("ntf_tab_oncall"), undefined],
        ] as const).map(([id, label, n]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`relative pb-2.5 text-sm flex items-center gap-1.5 ${
              tab === id ? "text-ink-1 font-medium" : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {label}
            {typeof n === "number" && n > 0 && (
              <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-accent-bg text-accent">{n}</span>
            )}
            {tab === id && <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-accent rounded-full" />}
          </button>
        ))}
      </div>

      {tab === "oncall" ? (
        <div className="text-sm text-ink-3 py-16 text-center">{t("ntf_oncall_todo")}</div>
      ) : (
        <>
          {/* kind segment + summary + only-mine */}
          <div className="flex items-center justify-between gap-4 mb-3 flex-wrap">
            {tab === "notify" ? (
              <div className="inline-flex rounded-lg border border-line p-0.5 bg-surface">
                {([
                  ["all", t("ntf_kind_all")],
                  ["message", t("ntf_kind_message")],
                  ["alert", t("ntf_kind_alert")],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setKind(id)}
                    className={`text-xs px-3 py-1 rounded-md ${
                      kind === id ? "bg-accent-bg text-accent font-medium" : "text-ink-3 hover:text-ink-1"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-sm text-ink-2">
                <span className="font-semibold text-ink-1">{counts?.needsHuman ?? 0}</span> {t("ntf_need_handle")}
              </div>
            )}

            <div className="flex items-center gap-4">
              {tab === "notify" && (
                <div className="text-xs text-ink-3">
                  <span className="text-err font-medium">{counts?.needsHuman ?? 0}</span> {t("ntf_need_handle")} ·{" "}
                  <span className="text-ink-2">{autoHandled}</span> {t("ntf_auto_handled_n")}
                </div>
              )}
              <label className="flex items-center gap-2 text-xs text-ink-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="accent-[var(--c-accent)]"
                  checked={onlyMine}
                  onChange={(e) => setOnlyMine(e.target.checked)}
                  disabled={tab === "todo"}
                />
                {t("ntf_only_mine")}
              </label>
            </div>
          </div>

          {/* category chips */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <Chip active={category === "all"} onClick={() => setCategory("all")} icon="grid" label={t("ntf_cat_all")} />
            {CATEGORIES.map((c) => (
              <Chip
                key={c}
                active={category === c}
                onClick={() => setCategory(c)}
                icon={CAT_ICON[c]}
                label={t(`ntf_cat_${c}`)}
                count={counts?.byCategory?.[c]}
              />
            ))}
          </div>

          {/* list */}
          {loading && !data ? (
            <div className="text-sm text-ink-3 py-16 text-center">…</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-ink-3 py-16 text-center">{t("ntf_empty")}</div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {rows.map((n) => (
                <NotifCard key={n.id} n={n} rel={rel} t={t} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: IcName;
  label: string;
  count?: number;
}) {
  const CIcon = Ic[icon];
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border ${
        active ? "border-accent bg-accent-bg text-accent" : "border-line text-ink-3 hover:text-ink-1"
      }`}
    >
      <span className="opacity-70">
        <CIcon />
      </span>
      {label}
      {typeof count === "number" && count > 0 && <span className="opacity-60">{count}</span>}
    </button>
  );
}

function NotifCard({
  n,
  rel,
  t,
}: {
  n: NotificationRow;
  rel: (iso: string) => string;
  t: (k: string) => string;
}) {
  const sev = SEV[n.severity];
  const CatIcon = Ic[CAT_ICON[n.category]];
  const isCritical = n.kind === "alert" && n.severity === "critical";
  const inner = (
    <div
      className={`rounded-xl border border-line bg-surface px-4 py-3 transition-colors ${
        n.href ? "hover:bg-raised cursor-pointer" : ""
      }`}
      style={isCritical ? { borderColor: "color-mix(in oklch, var(--c-err) 35%, var(--c-line))" } : undefined}
    >
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 h-7 w-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: sev.bg, color: sev.ink }}
        >
          <CatIcon />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-ink-1 truncate">{n.title}</span>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
              style={{ background: sev.bg, color: sev.ink }}
            >
              {t(sev.key)}
            </span>
            {n.count > 1 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-raised text-ink-3">×{n.count}</span>
            )}
            <span className="text-[11px] text-ink-3 ml-auto shrink-0">{rel(n.ts)}</span>
          </div>
          <p className="text-[13px] text-ink-2 mt-1 line-clamp-2">{n.body}</p>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-raised text-ink-3">{t(`ntf_cat_${n.category}`)}</span>
            <span className="text-[11px] text-ink-3 font-mono">{n.source}</span>
            {n.aiSource === "fallback" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-line text-ink-3">{t("ntf_ai_fallback")}</span>
            )}
            <span className="ml-auto text-[11px] flex items-center gap-1">
              {n.disposition === "auto_handled" ? (
                <span className="flex items-center gap-1 text-ok">
                  <Ic.sparkle />
                  {t("ntf_disp_auto_handled")}
                </span>
              ) : n.disposition === "needs_human" ? (
                <span className="flex items-center gap-1 text-err">
                  <Ic.user />
                  {t("ntf_disp_needs_human")}
                </span>
              ) : null}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
  return n.href ? (
    <a href={n.href} className="block">
      {inner}
    </a>
  ) : (
    inner
  );
}
