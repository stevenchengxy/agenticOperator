// Inngest live overlay hook.
//
// Polls /api/inngest-admin/{functions,runs,dlq} every 5s and exposes a Map
// keyed by workflow `wsId` (e.g. "9-1", "4", "10") for the 3 real PRA agents.
// Non-real (stub) nodes return undefined → consumers should render them as
// "蓝图 / blueprint" instead of pretending they're alive.
//
// Mapping wsId ↔ Inngest slug:
//   "4"   → agentic-operator-main-create-jd-agent      (JDGenerator)
//   "9-1" → agentic-operator-main-resume-parser-agent  (ResumeParser)
//   "10"  → agentic-operator-main-match-resume-agent   (Matcher)

'use client';

import { useEffect, useState } from 'react';

export const WSID_TO_INNGEST_SLUG: Record<string, string> = {
  '4': 'agentic-operator-main-create-jd-agent',
  '9-1': 'agentic-operator-main-resume-parser-agent',
  '10': 'agentic-operator-main-match-resume-agent',
};

export const INNGEST_SLUG_TO_WSID: Record<string, string> = Object.fromEntries(
  Object.entries(WSID_TO_INNGEST_SLUG).map(([k, v]) => [v, k]),
);

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
};

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
        const [fnRes, runRes] = await Promise.all([
          fetch('/api/inngest-admin/functions'),
          fetch('/api/inngest-admin/runs?limit=100'),
        ]);
        if (!fnRes.ok || !runRes.ok) return;
        const fnBody = await fnRes.json();
        const runBody = await runRes.json();
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
