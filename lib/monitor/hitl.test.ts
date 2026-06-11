import { describe, it, expect } from 'vitest';
import { hitlStaleMonitor } from './hitl';
import { DEFAULT_THRESHOLDS, type MonitorReadPort, type StaleHumanItem } from './monitor-types';

function fakePort(stale: StaleHumanItem[]): MonitorReadPort {
  return {
    inflightRuns: async () => [],
    stepTimings: async () => [],
    recentRuns: async () => [],
    tokenUsageByRun: async () => ({}),
    toolStepCounts: async () => ({}),
    errorWindow: async () => ({ total: 0, byAgent: {} }),
    dependencyFailures: async () => [],
    staleNeedsHuman: async () => stale,
  };
}

describe('hitlStaleMonitor', () => {
  it('emits ONE digest (not per-item) when needs_human alerts go stale', async () => {
    const res = await hitlStaleMonitor(
      fakePort([
        { dedupeKey: 'energy_human_gate.manualConfirm.c1', title: '调度方案待人工确认', ageMs: 9 * 86_400_000 },
        { dedupeKey: 'feikong_human_gate.disposeRiskEvent.c2', title: '风险事件待处置', ageMs: 3 * 86_400_000 },
      ]),
      DEFAULT_THRESHOLDS,
    );
    expect(res.prefix).toBe('hitl_stale.');
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].level).toBe('warn'); // info_only — 催办不进待办,防自我繁殖
    expect(res.findings[0].dedupeHint).toBe('hitl_stale.digest');
    expect(res.findings[0].message).toContain('2 条人工待办');
    expect(res.findings[0].message).toContain('9 天');
    expect(res.activeKeys).toEqual(['hitl_stale.digest']);
  });

  it('stays silent (and lets resolveStale close the digest) when nothing is stale', async () => {
    const res = await hitlStaleMonitor(fakePort([]), DEFAULT_THRESHOLDS);
    expect(res.findings).toHaveLength(0);
    expect(res.activeKeys).toEqual([]);
  });
});
