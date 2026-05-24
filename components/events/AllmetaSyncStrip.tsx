"use client";
import React from "react";
import { Badge, Btn } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";
import { useEventCatalog } from "@/lib/hooks/useEventCatalog";

// Top-of-page strip on /events. Shows the Allmeta Ontology sync state +
// total event count + a manual refresh button that triggers the Neo4j
// sync worker on demand (POST /api/em/sync/event-definitions/run-now).
//
// Per spec 2026-05-24 §5.3.

export function AllmetaSyncStrip() {
  const { t } = useApp();
  const { events, lastSyncAt, staleness, refresh } = useEventCatalog();
  const [refreshing, setRefreshing] = React.useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/em/sync/event-definitions/run-now", { method: "POST" });
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const ago = lastSyncAt ? formatAgo(new Date(lastSyncAt).getTime()) : "—";

  const variant: "ok" | "warn" | "err" =
    staleness === "fresh" ? "ok" : staleness === "stale" ? "warn" : "err";
  const label =
    staleness === "fresh"
      ? t("allmeta_strip_fresh")
      : staleness === "stale"
        ? t("allmeta_strip_stale")
        : t("allmeta_strip_never");

  return (
    <div
      className="border-b border-line bg-surface flex items-center gap-3"
      style={{ padding: "10px 22px" }}
    >
      <Badge variant={variant}>{label}</Badge>
      <span className="text-[12px] text-ink-2">
        {t("config_event_engine_label")} · {events.length} events
      </span>
      <span className="text-[11.5px] text-ink-3 mono">
        {t("config_last_sync")}: {ago}
      </span>
      <div className="flex-1" />
      <Btn size="sm" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? "…" : t("config_manual_refresh")}
      </Btn>
    </div>
  );
}

function formatAgo(ms: number): string {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return `${diff}s 前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`;
  return `${Math.floor(diff / 86400)}d 前`;
}
