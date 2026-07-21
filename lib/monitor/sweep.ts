// sweep orchestrator — the deterministic fan-out (NOT an LLM, NOT on the alert
// critical path). Runs every monitor concurrently, records each finding via the
// injected recordNotification, and resolves stale alerts per monitor. A throwing
// monitor is isolated (Promise.allSettled) so one failure can't blind the rest.
//
// Idempotency: recordNotification upserts alerts on (dedupeKey, status='firing'),
// so overlapping/concurrent sweeps bump a count instead of duplicating rows.

import type { CaptureInput } from '@/server/notifications/derive';
import type { MonitorReadPort, MonitorResult, MonitorThresholds } from './monitor-types';

export type Monitor = (port: MonitorReadPort, t: MonitorThresholds) => Promise<MonitorResult>;

export interface SweepDeps {
  port: MonitorReadPort;
  thresholds: MonitorThresholds;
  monitors: Monitor[];
  record: (input: CaptureInput) => Promise<unknown>;
  resolve: (prefix: string, activeKeys: Set<string>) => Promise<number>;
}

export interface SweepReport {
  recorded: number;
  resolved: number;
  errors: number;
}

export async function runSweep(deps: SweepDeps): Promise<SweepReport> {
  const results = await Promise.allSettled(
    deps.monitors.map((m) => m(deps.port, deps.thresholds)),
  );

  let recorded = 0;
  let resolved = 0;
  let errors = 0;

  for (const r of results) {
    if (r.status === 'rejected') {
      errors++;
      continue;
    }
    const { findings, activeKeys, prefix } = r.value;
    for (const f of findings) {
      await deps.record(f);
      recorded++;
    }
    resolved += await deps.resolve(prefix, new Set(activeKeys));
  }

  return { recorded, resolved, errors };
}
