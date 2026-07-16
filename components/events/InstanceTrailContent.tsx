"use client";
import React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Ic } from "@/components/shared/Ic";
import { Badge, Btn, EmptyState } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";
import { fetchJson } from "@/lib/api/client";
import { getInngestUrlClient } from "@/lib/inngest-url-client";
import type { EventInstanceDetail } from "@/app/api/em/event-instances/[id]/route";
import { useDeepLinkFocus } from "@/lib/hooks/useDeepLinkFocus";

// /events/:name/instances/:id
//
// Two columns:
//   left  — em.publish trail (the 5 steps the library actually ran)
//   right — causality (parent above + children below)
//
// Inngest run output (function-level steps inside subscriber agents) is
// out of scope for now — it lives in Inngest's own SQLite and we'd have
// to query http://localhost:8288/v1/runs?event_id=... to surface it.
// That's a follow-up; the EM-side trail alone already gives ops a much
// better picture than what we had before (zero rows on this page existed).

export function InstanceTrailContent({
  eventName,
  instanceId,
}: {
  eventName: string;
  instanceId: string;
}) {
  const { t } = useApp();
  const router = useRouter();
  const sp = useSearchParams();
  const [data, setData] = React.useState<EventInstanceDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const focusKey = sp.get("focus");
  useDeepLinkFocus(focusKey, data != null);

  React.useEffect(() => {
    setLoading(true);
    fetchJson<EventInstanceDetail>(`/api/em/event-instances/${instanceId}`)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [instanceId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-ink-3 text-[12px]">{t("evx_loading")}</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<Ic.alert />}
          title={t("evx_load_failed")}
          hint={error}
          variant="warn"
          action={
            <Btn size="sm" onClick={() => router.refresh()}>
              {t("evx_retry")}
            </Btn>
          }
        />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          icon={<Ic.search />}
          title={t("evx_instance_not_found")}
          hint={`id ${instanceId} ${t("evx_instance_not_found_hint")}`}
          action={
            <Link href={`/events?event=${encodeURIComponent(eventName)}`}>
              <Btn size="sm">{t("evx_back_to")} {eventName}</Btn>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <Header data={data} t={t} focusKey={`event:${data.id}`} />
      <div
        className="flex-1 grid min-h-0"
        style={{ gridTemplateColumns: "1fr 360px" }}
      >
        <Trail data={data} t={t} />
        <Causality data={data} t={t} />
      </div>
    </div>
  );
}

function Header({ data, t, focusKey }: { data: EventInstanceDetail; t: (k: string) => string; focusKey: string }) {
  const ts = new Date(data.ts);
  return (
    <div
      data-focus-key={focusKey}
      className="border-b border-line bg-surface flex items-center"
      style={{ padding: "14px 22px", gap: 18 }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <Link
            href={`/events?event=${encodeURIComponent(data.name)}`}
            className="mono text-[14px] font-semibold text-ink-1 no-underline hover:underline"
          >
            {data.name}
          </Link>
          <span className="text-ink-3 text-[11.5px]">/</span>
          <span className="mono text-[11.5px] text-ink-3 truncate">
            {data.id.slice(0, 8)}…
          </span>
          <StatusBadge status={data.status} t={t} />
          {data.schemaVersionUsed && (
            <Badge variant="info">v{data.schemaVersionUsed}</Badge>
          )}
        </div>
        <div className="text-[11.5px] text-ink-3 mono">
          {ts.toLocaleString(undefined, { hour12: false })} · {t("evx_source")} {data.source}
          {data.externalEventId && (
            <>
              {" · "}external{" "}
              <span className="text-ink-2">{data.externalEventId}</span>
            </>
          )}
        </div>
      </div>
      <Link href={`/events?subtab=instances&q=${encodeURIComponent(data.name)}`}>
        <Btn size="sm" variant="ghost">
          <Ic.chev /> {t("evx_back_to_list")}
        </Btn>
      </Link>
    </div>
  );
}

// ── Trail (the em.publish 5 steps) ────────────────────────────────────────

type StepStatus = "ok" | "skip" | "fail" | "pending";

type Step = {
  id: string;
  title: string;
  status: StepStatus;
  detail?: React.ReactNode;
};

function buildSteps(data: EventInstanceDetail, t: (k: string) => string): Step[] {
  const isAccepted = data.status === "accepted";
  const rejectedSchema = data.status === "rejected_schema";
  const rejectedFilter = data.status === "rejected_filter";
  const duplicate = data.status === "duplicate";
  const meta = data.status === "meta_rejection";

  // Step 1: filter
  const filterStep: Step = {
    id: "filter",
    title: t("evx_step_filter"),
    status: rejectedFilter ? "fail" : "ok",
    detail: rejectedFilter ? (
      <Plain>{data.rejectionReason ?? "—"}</Plain>
    ) : (
      <Muted>{t("evx_step_filter_detail")}</Muted>
    ),
  };

  // Step 2: schema validate
  const schemaStep: Step = {
    id: "schema",
    title: t("evx_step_schema"),
    status: rejectedFilter ? "skip" : rejectedSchema ? "fail" : "ok",
    detail: rejectedSchema ? (
      <div>
        <Plain>{data.rejectionReason}</Plain>
        {Array.isArray(data.schemaErrors) && data.schemaErrors.length > 0 && (
          <ul className="mono text-[10.5px] text-ink-2 leading-relaxed mt-2">
            {(data.schemaErrors as Array<{ path: string; message: string }>)
              .slice(0, 8)
              .map((e, i) => (
                <li key={i}>
                  <span className="text-ink-3">{e.path || "(root)"}</span>{" "}
                  · {e.message}
                </li>
              ))}
          </ul>
        )}
        {data.triedVersions && data.triedVersions.length > 0 && (
          <Muted>{t("evx_tried_versions")}{data.triedVersions.join(", ")}</Muted>
        )}
      </div>
    ) : data.schemaVersionUsed ? (
      <Muted>{t("evx_passed_schema")} v{data.schemaVersionUsed}</Muted>
    ) : null,
  };

  // Step 3: dedup
  const dedupStep: Step = {
    id: "dedup",
    title: t("evx_step_dedup"),
    status: rejectedSchema || rejectedFilter ? "skip" : duplicate ? "fail" : "ok",
    detail: duplicate ? (
      <Plain>{t("evx_step_dedup_dup")}</Plain>
    ) : (
      <Muted>
        idempotency key ={" "}
        <span className="mono">{data.externalEventId ?? data.id}</span>
      </Muted>
    ),
  };

  // Step 4: persist
  const persistStep: Step = {
    id: "persist",
    title: t("evx_step_persist"),
    status:
      rejectedSchema || rejectedFilter
        ? "ok" // Even rejected events get an EventInstance row (but no audit row)
        : duplicate
          ? "skip"
          : isAccepted
            ? "ok"
            : "skip",
    detail: <Muted>EventInstance.id = {data.id}</Muted>,
  };

  // Step 5: send to Inngest
  const sendStep: Step = {
    id: "send",
    title: "⑤ inngest.send",
    status: isAccepted
      ? "ok"
      : meta
        ? "ok" // EVENT_REJECTED was sent; that's how we got a meta_rejection row
        : "skip",
    detail: isAccepted ? (
      <Muted>{t("evx_step_send_delivered")}</Muted>
    ) : meta ? (
      <Muted>{t("evx_step_send_meta")}</Muted>
    ) : (
      <Muted>{t("evx_step_send_skipped")}</Muted>
    ),
  };

  return [filterStep, schemaStep, dedupStep, persistStep, sendStep];
}

function Trail({ data, t }: { data: EventInstanceDetail; t: (k: string) => string }) {
  const steps = buildSteps(data, t);
  return (
    <div className="overflow-auto" style={{ padding: "16px 22px" }}>
      <div className="text-[10.5px] uppercase tracking-[0.12em] font-medium mb-3 text-ink-4">
        {t("evx_publish_pipeline")}
      </div>
      <ol className="flex flex-col gap-2">
        {steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
      </ol>

      {data.payloadSummary && (
        <div className="mt-6">
          <div className="text-[10.5px] uppercase tracking-[0.12em] font-medium mb-2 text-ink-4">
            {t("evx_payload_summary_overline")}
          </div>
          <pre
            className="mono text-[10.5px] text-ink-2 bg-panel border border-line rounded-md overflow-auto"
            style={{ padding: 10, maxHeight: 320 }}
          >
            {prettyJson(data.payloadSummary)}
          </pre>
          <Muted className="mt-1">
            {t("evx_full_payload_in_inngest_pre")}
            <a
              href={`${getInngestUrlClient()}/stream/${encodeURIComponent(data.externalEventId ?? data.id)}`}
              target="_blank"
              rel="noreferrer"
              className="text-ink-3 underline hover:text-ink-1"
            >
              {t("evx_view_in_inngest")}
            </a>
            {t("evx_full_payload_in_inngest_post")}
          </Muted>
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const palette: Record<StepStatus, { color: string; icon: React.ReactNode }> = {
    ok: { color: "var(--c-ok)", icon: "✓" },
    fail: { color: "var(--c-err)", icon: "✗" },
    skip: { color: "var(--c-ink-4)", icon: "—" },
    pending: { color: "var(--c-ink-3)", icon: "·" },
  };
  const p = palette[step.status];
  return (
    <li className="flex gap-3" style={{ padding: "10px 12px", borderRadius: 6, background: "var(--c-surface)", border: "1px solid var(--c-line)" }}>
      <span
        className="w-5 h-5 rounded-full grid place-items-center mono text-[11px] font-semibold flex-shrink-0"
        style={{
          color: "white",
          background: p.color,
        }}
      >
        {p.icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-ink-1">{step.title}</div>
        {step.detail && <div className="mt-1">{step.detail}</div>}
      </div>
    </li>
  );
}

// ── Causality (parent + children + jump-to-correlation) ──────────────────

function Causality({ data, t }: { data: EventInstanceDetail; t: (k: string) => string }) {
  return (
    <aside
      className="border-l border-line bg-surface overflow-auto flex flex-col gap-3"
      style={{ padding: 16 }}
    >
      <div className="text-[10.5px] uppercase tracking-[0.12em] font-medium text-ink-4">
        {t("evx_causality_chain")}
      </div>

      {/* Parent */}
      <div>
        <div className="hint mb-1">{t("evx_upstream")}</div>
        {data.parent ? (
          <RelLink instance={data.parent} t={t} />
        ) : (
          <Muted>{t("evx_causality_root")}</Muted>
        )}
      </div>

      {/* Self */}
      <div>
        <div className="hint mb-1">{t("evx_this_event")}</div>
        <div
          className="mono text-[11px] text-ink-1 px-2 py-1.5 border border-line rounded-sm"
          style={{ background: "color-mix(in oklab, var(--c-accent) 5%, transparent)" }}
        >
          {data.name} · {data.id.slice(0, 8)}…
        </div>
      </div>

      {/* Children */}
      <div>
        <div className="hint mb-1">{t("evx_downstream")} {data.children.length > 0 && `(${data.children.length})`}</div>
        {data.children.length === 0 ? (
          <Muted>{t("evx_no_downstream")}</Muted>
        ) : (
          <div className="flex flex-col gap-1">
            {data.children.map((c) => (
              <RelLink key={c.id} instance={c} t={t} />
            ))}
          </div>
        )}
      </div>

      {/* Jump out */}
      <Muted className="mt-2">
        {t("evx_want_cross_system_timeline")}
        {data.externalEventId && (
          <Link
            href={`/correlations/${encodeURIComponent(data.externalEventId)}`}
            className="ml-1 text-ink-2 underline hover:text-ink-1 no-underline"
          >
            {t("evx_open_correlations")}/correlations/{data.externalEventId.slice(0, 8)}…
          </Link>
        )}
      </Muted>
    </aside>
  );
}

function RelLink({ instance, t }: { instance: { id: string; name: string; status: string }; t: (k: string) => string }) {
  const url = `/events/${encodeURIComponent(instance.name)}/instances/${encodeURIComponent(instance.id)}`;
  return (
    <Link
      href={url}
      className="block px-2 py-1.5 border border-line rounded-sm hover:bg-panel no-underline"
    >
      <div className="flex items-center gap-2">
        <span className="mono text-[11px] text-ink-1 flex-1 min-w-0 truncate">
          {instance.name}
        </span>
        <StatusBadge status={instance.status} compact t={t} />
      </div>
      <div className="mono text-[10px] text-ink-3 mt-0.5">{instance.id.slice(0, 12)}…</div>
    </Link>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function StatusBadge({ status, compact, t }: { status: string; compact?: boolean; t: (k: string) => string }) {
  const map: Record<string, { variant: "ok" | "warn" | "err" | "info" | "default"; label: string }> = {
    accepted: { variant: "ok", label: "accepted" },
    rejected_schema: { variant: "err", label: t("evx_status_schema_fail") },
    rejected_filter: { variant: "warn", label: t("evx_status_filter_reject") },
    duplicate: { variant: "info", label: "duplicate" },
    meta_rejection: { variant: "warn", label: "meta-rejection" },
    em_degraded: { variant: "warn", label: "em degraded" },
  };
  const m = map[status] ?? { variant: "default" as const, label: status };
  return <Badge variant={m.variant}>{compact ? m.label.split(" ")[0] : m.label}</Badge>;
}

function Plain({ children }: { children: React.ReactNode }) {
  return <div className="text-[11.5px] text-ink-2 leading-relaxed">{children}</div>;
}
function Muted({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[10.5px] text-ink-3 ${className ?? ""}`}>{children}</div>
  );
}
function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
