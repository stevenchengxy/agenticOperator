"use client";
import React from "react";
import Link from "next/link";
import { byShort } from "@/lib/agent-mapping";
import { nodeById } from "@/lib/workflow-graph-meta";
import { ClaudeBadge } from "./atoms";
import { useApp } from "@/lib/i18n";

type ActivityRow = {
  ts: string;
  type: string;
  narrative: string;
};

type Props = {
  nodeId: string | null;
  onClose: () => void;
};

export function AgentDetailPanel({ nodeId, onClose }: Props) {
  const { t } = useApp();

  if (!nodeId) return null;
  const node = nodeById(nodeId);
  if (!node) return null;

  const canonicalShort = node.agentName ?? node.title;
  const meta = byShort(canonicalShort);

  const [activity, setActivity] = React.useState<ActivityRow[]>([]);

  React.useEffect(() => {
    const ac = new AbortController();
    fetch(
      `/api/agent-activity?agent=${encodeURIComponent(canonicalShort)}&limit=10`,
      { signal: ac.signal, cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { rows?: Array<{ createdAt: string; type: string; narrative: string }> } | null) => {
        if (j?.rows) {
          setActivity(
            j.rows.map((it) => ({
              ts: it.createdAt,
              type: it.type,
              narrative: it.narrative,
            })),
          );
        }
      })
      .catch(() => {
        /* no-op — panel degrades gracefully if DB unavailable */
      });
    return () => ac.abort();
  }, [canonicalShort]);

  // Close on Escape
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <aside className="fixed top-0 right-0 h-full w-[420px] bg-claude-surface border-l border-claude-line shadow-lg overflow-y-auto z-30">
      <div className="p-6">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.08em] text-claude-ink-4 mb-1">
              {meta?.stage ?? node.kind}
            </div>
            <h2 className="text-[20px] font-medium leading-tight">
              {node.title}
            </h2>
            <div className="text-[12px] text-claude-ink-3 mt-1">
              {canonicalShort}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close panel"
            className="text-claude-ink-3 hover:text-claude-ink-1 text-[20px] leading-none mt-1"
          >
            ×
          </button>
        </div>

        <p className="text-[13px] text-claude-ink-2 leading-relaxed mb-4">
          {node.sub}
        </p>

        {meta && (
          <>
            <Section title={t("monitor_agent_triggers")}>
              {meta.triggersEvents.length > 0 ? (
                <ul className="text-[12px] text-claude-ink-2 space-y-0.5">
                  {meta.triggersEvents.map((e) => (
                    <li key={e}>
                      <Link
                        href={`/events/${encodeURIComponent(e)}`}
                        className="font-mono text-claude-accent no-underline hover:underline"
                      >
                        {e}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>none</Empty>
              )}
            </Section>

            <Section title={t("monitor_agent_emits")}>
              {meta.emitsEvents.length > 0 ? (
                <ul className="text-[12px] text-claude-ink-2 space-y-0.5">
                  {meta.emitsEvents.map((e) => (
                    <li key={e}>
                      <Link
                        href={`/events/${encodeURIComponent(e)}`}
                        className="font-mono text-claude-accent no-underline hover:underline"
                      >
                        {e}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>none</Empty>
              )}
            </Section>

            <Section title={t("monitor_agent_kind")}>
              <ClaudeBadge
                tone={
                  meta.kind === "hitl"
                    ? "warn"
                    : meta.kind === "hybrid"
                      ? "accent"
                      : "neutral"
                }
              >
                {meta.kind}
              </ClaudeBadge>
              <span className="text-[12px] text-claude-ink-3 ml-2">
                owned by {meta.ownerTeam} · {meta.version}
              </span>
            </Section>
          </>
        )}

        <Section title={t("monitor_agent_recent_activity")}>
          {activity.length === 0 ? (
            <Empty>No recent activity.</Empty>
          ) : (
            <ul className="space-y-1.5 text-[12px]">
              {activity.map((a, i) => (
                <li key={i} className="border-l-2 border-claude-line pl-2">
                  <div className="text-claude-ink-4 tabular-nums text-[10.5px]">
                    {new Date(a.ts).toLocaleTimeString()}
                  </div>
                  <div>
                    <span className="text-claude-ink-1 font-medium">
                      {a.type}
                    </span>
                    :{" "}
                    <span className="text-claude-ink-3">{a.narrative}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="mt-4">
          <Link
            href={`/monitor/agents/${encodeURIComponent(node.id)}`}
            className="text-claude-accent text-[13px] no-underline hover:underline"
          >
            {t("monitor_agent_open_detail")}
          </Link>
        </div>
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-claude-ink-4 mb-1.5">
        {title}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] text-claude-ink-4">{children}</div>;
}
