import { describe, it, expect } from 'vitest';
import { errorRateMonitor } from './error-rate';
import { DEFAULT_THRESHOLDS, type MonitorReadPort, type ErrorWindow } from './monitor-types';

function fakePort(win: ErrorWindow): MonitorReadPort {
  return {
    inflightRuns: async () => [],
    stepTimings: async () => [],
    recentRuns: async () => [],
    tokenUsageByRun: async () => ({}),
    toolStepCounts: async () => ({}),
    errorWindow: async () => win,
  };
}

const t = { ...DEFAULT_THRESHOLDS, errorRatePct: 30, minVolume: 5 };

describe('errorRateMonitor', () => {
  it('flags an agent over the error-rate threshold with enough volume', async () => {
    const port = fakePort({
      total: 10,
      byAgent: { 'match-resume': { errors: 5, total: 10, eventName: 'RESUME_PROCESSED' } },
    });
    const res = await errorRateMonitor(port, t);
    expect(res.prefix).toBe('error_rate.');
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].dedupeHint).toBe('error_rate.match-resume');
    expect(res.findings[0].category).toBe('agent_lifecycle');
    expect(res.findings[0].eventName ?? null).toBeNull();
    expect(res.activeKeys).toEqual(['error_rate.match-resume']);
  });

  it('suppresses low-volume agents (no 1/1 = 100% noise)', async () => {
    const port = fakePort({ total: 1, byAgent: { x: { errors: 1, total: 1, eventName: null } } });
    const res = await errorRateMonitor(port, t);
    expect(res.findings).toHaveLength(0);
    expect(res.activeKeys).toEqual([]);
  });

  it('does not flag agents under the rate threshold', async () => {
    const port = fakePort({ total: 100, byAgent: { y: { errors: 10, total: 100, eventName: null } } });
    const res = await errorRateMonitor(port, t);
    expect(res.findings).toHaveLength(0);
  });
});
