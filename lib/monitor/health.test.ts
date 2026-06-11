import { describe, it, expect } from 'vitest';
import { healthMonitor } from './health';
import { DEFAULT_THRESHOLDS, type MonitorReadPort, type RunHeartbeat } from './monitor-types';

function fakePort(inflight: RunHeartbeat[]): MonitorReadPort {
  return {
    inflightRuns: async () => inflight,
    stepTimings: async () => [],
    recentRuns: async () => [],
    tokenUsageByRun: async () => ({}),
    toolStepCounts: async () => ({}),
    errorWindow: async () => ({ total: 0, byAgent: {} }),
    dependencyFailures: async () => [],
    staleNeedsHuman: async () => [],
  };
}

const now = new Date('2026-06-05T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('healthMonitor', () => {
  it('flags a run whose latest step is older than stallMs', async () => {
    const port = fakePort([
      {
        runId: 'r1',
        functionSlug: 'match-resume',
        eventName: 'RESUME_PROCESSED',
        startedAt: ago(10 * 60_000),
        lastStepAt: ago(6 * 60_000),
      },
    ]);
    const res = await healthMonitor(port, DEFAULT_THRESHOLDS, now);
    expect(res.prefix).toBe('run_stalled.');
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].level).toBe('critical');
    expect(res.findings[0].category).toBe('system');
    expect(res.findings[0].dedupeHint).toBe('run_stalled.r1');
    expect(res.findings[0].runId).toBe('r1');
    expect(res.activeKeys).toEqual(['run_stalled.r1']);
  });

  it('skips HITL gate runs (waitForEvent 挂起等人工 ≠ 停滞)', async () => {
    const port = fakePort([
      {
        runId: 'r3',
        functionSlug: 'agentic-operator-main-energy-manual-confirm',
        eventName: null,
        startedAt: ago(9 * 86_400_000), // 挂 9 天也不算停滞
        lastStepAt: null,
      },
      {
        runId: 'r4',
        functionSlug: 'agentic-operator-费控-v1-feikong-dispose-risk-event',
        eventName: null,
        startedAt: ago(86_400_000),
        lastStepAt: null,
      },
    ]);
    const res = await healthMonitor(port, DEFAULT_THRESHOLDS, now);
    expect(res.findings).toHaveLength(0);
    expect(res.activeKeys).toEqual([]);
  });

  it('does not flag a run with a recent step', async () => {
    const port = fakePort([
      {
        runId: 'r2',
        functionSlug: 'x',
        eventName: null,
        startedAt: ago(2 * 60_000),
        lastStepAt: ago(1 * 60_000),
      },
    ]);
    const res = await healthMonitor(port, DEFAULT_THRESHOLDS, now);
    expect(res.findings).toHaveLength(0);
    expect(res.activeKeys).toEqual([]);
  });

  it('uses startedAt as the heartbeat when no step has landed yet', async () => {
    const port = fakePort([
      { runId: 'r3', functionSlug: 'x', eventName: null, startedAt: ago(7 * 60_000), lastStepAt: null },
    ]);
    const res = await healthMonitor(port, DEFAULT_THRESHOLDS, now);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].dedupeHint).toBe('run_stalled.r3');
  });
});
