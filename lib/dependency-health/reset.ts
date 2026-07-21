// Manual "I topped up" reset. Operators can't see the vendor's balance, so after
// a top-up they click reset; we drop a `dependency_reset` marker (a LogEvent,
// zero-migration) and ignore every degraded-call signal at/before it. If the
// dependency is still dead, the NEXT failed call (ts after the reset) re-raises
// the alert within a sweep — so reset is immediate but can't hide a real outage.

import type { DepFailure, DepProvider } from './types';

const PROVIDERS: ReadonlySet<string> = new Set<DepProvider>(['robohire', 'llm']);

export interface DepReset {
  provider: DepProvider;
  ts: Date;
}

export function parseResetRow(row: { ts: Date; payloadJson: string | null }): DepReset | null {
  if (!row.payloadJson) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof p.provider !== 'string' || !PROVIDERS.has(p.provider)) return null;
  return { provider: p.provider as DepProvider, ts: row.ts };
}

/** Drop failures at/before the latest reset for their provider. Pure. */
export function applyResets(failures: DepFailure[], resets: DepReset[]): DepFailure[] {
  if (resets.length === 0) return failures;
  const latest = new Map<DepProvider, number>();
  for (const r of resets) {
    const ms = r.ts.getTime();
    const prev = latest.get(r.provider);
    if (prev === undefined || ms > prev) latest.set(r.provider, ms);
  }
  return failures.filter((f) => {
    const cutoff = latest.get(f.provider);
    return cutoff === undefined || f.ts.getTime() > cutoff;
  });
}
