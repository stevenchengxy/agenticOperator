import { describe, it, expect } from 'vitest';
import { costMonitor } from './cost';
import { DEFAULT_THRESHOLDS, type MonitorReadPort, type RunRef } from './monitor-types';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';

function fakePort(opts: {
  recentRuns: RunRef[];
  tokens: Record<string, number>;
  tools: Record<string, number>;
}): MonitorReadPort {
  return {
    inflightRuns: async () => [],
    stepTimings: async () => [],
    recentRuns: async () => opts.recentRuns,
    tokenUsageByRun: async () => opts.tokens,
    toolStepCounts: async () => opts.tools,
    errorWindow: async () => ({ total: 0, byAgent: {} }),
  };
}

const t = { ...DEFAULT_THRESHOLDS, budgetTokens: 1000, toolLoop: 5 };

describe('costMonitor', () => {
  it('flags a domain whose windowed token sum exceeds budgetTokens', async () => {
    const port = fakePort({
      recentRuns: [
        { runId: 'r1', functionSlug: 'match', eventName: 'RESUME_PROCESSED' },
        { runId: 'r2', functionSlug: 'match', eventName: 'RESUME_PROCESSED' },
      ],
      tokens: { r1: 800, r2: 700 },
      tools: {},
    });
    const res = await costMonitor(port, t);
    expect(res.prefix).toBe('cost.');
    const budget = res.findings.find((f) => f.dedupeHint?.startsWith('cost.budget.'));
    expect(budget).toBeTruthy();
    expect(budget!.dedupeHint).toBe(`cost.budget.${RECRUITMENT_DOMAIN_ID}`);
    expect(budget!.level).toBe('critical');
    expect(budget!.category).toBe('system');
  });

  it('flags a runaway run whose tool-step count exceeds toolLoop', async () => {
    const port = fakePort({
      recentRuns: [{ runId: 'rx', functionSlug: 'x', eventName: null }],
      tokens: { rx: 10 },
      tools: { rx: 9 },
    });
    const res = await costMonitor(port, t);
    const rw = res.findings.find((f) => f.dedupeHint === 'cost.runaway.rx');
    expect(rw).toBeTruthy();
    expect(rw!.level).toBe('critical');
    expect(rw!.runId).toBe('rx');
    expect(res.activeKeys).toContain('cost.runaway.rx');
  });

  it('emits nothing under budget and under toolLoop', async () => {
    const port = fakePort({
      recentRuns: [{ runId: 'r', functionSlug: 'x', eventName: null }],
      tokens: { r: 100 },
      tools: { r: 1 },
    });
    const res = await costMonitor(port, t);
    expect(res.findings).toHaveLength(0);
    expect(res.activeKeys).toEqual([]);
  });
});
