import type { MonitorFilter } from './types';

export const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes (spec §2.1)
const MIN_WINDOW_MS = 60 * 1000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function parseFilter(url: URL): MonitorFilter {
  const raw = Number(url.searchParams.get('windowMs') ?? DEFAULT_WINDOW_MS);
  const sinceMs = Number.isFinite(raw)
    ? Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, raw))
    : DEFAULT_WINDOW_MS;
  return {
    sinceMs,
    since: new Date(Date.now() - sinceMs).toISOString(),
    client: url.searchParams.get('client') ?? undefined,
    triggerEvent: url.searchParams.get('triggerEvent') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  };
}
