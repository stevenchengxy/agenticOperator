// Inngest live overlay hook.
//
// Polls /api/inngest-admin/{functions,runs,dlq} every 5s and exposes a Map
// keyed by workflow `wsId` for whatever Inngest functions are CURRENTLY
// registered. Non-registered agents return undefined → consumers should
// render them as "blueprint / unbuilt" instead of pretending they're alive.
//
// wsId ↔ Inngest slug mapping is now derived from /api/agents (which itself
// reads lib/inngest-registry.ts). Per spec 2026-05-24 §3.4 — no more static
// 4-entry hardcode that goes stale when reals change.

'use client';

import { useEffect, useState } from 'react';

// Mutable exports — keys are rebuilt from /api/agents on every hook fetch.
// We mutate the existing object reference so callers `import {WSID_TO_INNGEST_SLUG}`
// always see latest keys without needing to re-subscribe.
export const WSID_TO_INNGEST_SLUG: Record<string, string> = {};
export const INNGEST_SLUG_TO_WSID: Record<string, string> = {};

function rebuildSlugMaps(agents: Array<{ wsId: string; slug: string | null }>): void {
  for (const k of Object.keys(WSID_TO_INNGEST_SLUG)) delete WSID_TO_INNGEST_SLUG[k];
  for (const k of Object.keys(INNGEST_SLUG_TO_WSID)) delete INNGEST_SLUG_TO_WSID[k];
  for (const a of agents) {
    if (!a.slug) continue;
    WSID_TO_INNGEST_SLUG[a.wsId] = a.slug;
    INNGEST_SLUG_TO_WSID[a.slug] = a.wsId;
  }
}

export type LiveAgentState = {
  wsId: string;
  slug: string;
  name: string;
  triggers: string[];
  paused: boolean;
  total: number;
  completed: number;
  failed: number;
  running: number;
  successRate: number | null;
  latestStatus: 'Completed' | 'Failed' | 'Running' | 'Cancelled' | null;
  latestRunId: string | null;
  latestStartedAt: string | null;
  latestDurationMs: number | null;
  /** P95 of finished-run durations in the sampled window (last ≤100 runs). */
  p95Ms: number | null;
};

// P95 of a list of durations (ms). Returns null when there's no sample.
function percentile95(durations: number[]): number | null {
  const xs = durations.filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.min(xs.length - 1, Math.ceil(0.95 * xs.length) - 1);
  return xs[Math.max(0, idx)];
}

const REFRESH_MS = 5000;

export function useInngestLiveOverlay(): {
  byWsId: Map<string, LiveAgentState>;
  loading: boolean;
  lastRefresh: string | null;
} {
  const [byWsId, setByWsId] = useState<Map<string, LiveAgentState>>(new Map());
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function load() {
      try {
        const [fnRes, runRes, agentsRes] = await Promise.all([
          fetch('/api/inngest-admin/functions'),
          fetch('/api/inngest-admin/runs?limit=100'),
          fetch('/api/agents'),
        ]);
        if (!fnRes.ok || !runRes.ok) return;
        const fnBody = await fnRes.json();
        const runBody = await runRes.json();
        if (agentsRes.ok) {
          const agentsBody = await agentsRes.json();
          rebuildSlugMaps(agentsBody.agents ?? []);
        }
        if (cancelled) return;

        const next = new Map<string, LiveAgentState>();
        for (const fn of fnBody.functions ?? []) {
          const wsId = INNGEST_SLUG_TO_WSID[fn.slug];
          if (!wsId) continue;

          const fnRuns = (runBody.runs ?? []).filter(
            (r: { function: { slug: string } }) => r.function?.slug === fn.slug,
          );
          const completed = fnRuns.filter((r: { status: string }) => r.status === 'Completed').length;
          const failed = fnRuns.filter((r: { status: string }) => r.status === 'Failed').length;
          const running = fnRuns.filter((r: { status: string }) => r.status === 'Running').length;
          const total = fnRuns.length;
          const latest = fnRuns[0];
          const p95Ms = percentile95(
            fnRuns.map((r: { durationMs?: number | null }) => r.durationMs ?? 0),
          );

          next.set(wsId, {
            wsId,
            slug: fn.slug,
            name: fn.name,
            triggers: (fn.triggers ?? []).map((t: { value: string }) => t.value),
            paused: fn.paused ?? false,
            total,
            completed,
            failed,
            running,
            successRate: total > 0 ? Math.round((completed / total) * 100) : null,
            latestStatus: latest?.status ?? null,
            latestRunId: latest?.id ?? null,
            latestStartedAt: latest?.startedAt ?? null,
            latestDurationMs: latest?.durationMs ?? null,
            p95Ms,
          });
        }
        setByWsId(next);
        setLastRefresh(new Date().toLocaleTimeString());
        setLoading(false);
      } catch {
        // soft-fail
      }
    }

    load();
    timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  return { byWsId, loading, lastRefresh };
}
