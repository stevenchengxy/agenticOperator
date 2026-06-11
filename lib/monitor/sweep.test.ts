import { describe, it, expect } from 'vitest';
import { runSweep } from './sweep';
import { DEFAULT_THRESHOLDS, type MonitorReadPort } from './monitor-types';
import type { CaptureInput } from '@/server/notifications/derive';

const port: MonitorReadPort = {
  inflightRuns: async () => [],
  stepTimings: async () => [],
  recentRuns: async () => [],
  tokenUsageByRun: async () => ({}),
  toolStepCounts: async () => ({}),
  errorWindow: async () => ({ total: 0, byAgent: {} }),
  dependencyFailures: async () => [],
    staleNeedsHuman: async () => [],
};

describe('runSweep', () => {
  it('records each finding and resolves stale keys per monitor', async () => {
    const recorded: CaptureInput[] = [];
    const resolveCalls: Array<{ prefix: string; keys: string[] }> = [];
    const monitor = async () => ({
      prefix: 'run_stalled.',
      findings: [
        { level: 'critical' as const, category: 'system', message: 'x', dedupeHint: 'run_stalled.r1' },
      ],
      activeKeys: ['run_stalled.r1'],
    });

    const report = await runSweep({
      port,
      thresholds: DEFAULT_THRESHOLDS,
      monitors: [monitor],
      record: async (f) => {
        recorded.push(f);
      },
      resolve: async (prefix, keys) => {
        resolveCalls.push({ prefix, keys: [...keys] });
        return 0;
      },
    });

    expect(recorded).toHaveLength(1);
    expect(report.recorded).toBe(1);
    expect(report.errors).toBe(0);
    expect(resolveCalls).toEqual([{ prefix: 'run_stalled.', keys: ['run_stalled.r1'] }]);
  });

  it('isolates a throwing monitor so the others still run', async () => {
    const recorded: CaptureInput[] = [];
    const bad = async () => {
      throw new Error('boom');
    };
    const good = async () => ({
      prefix: 'p.',
      findings: [{ level: 'warn' as const, category: 'agent_lifecycle', message: 'y', dedupeHint: 'p.k' }],
      activeKeys: ['p.k'],
    });

    const report = await runSweep({
      port,
      thresholds: DEFAULT_THRESHOLDS,
      monitors: [bad, good],
      record: async (f) => {
        recorded.push(f);
      },
      resolve: async () => 0,
    });

    expect(report.errors).toBe(1);
    expect(recorded).toHaveLength(1);
    expect(report.recorded).toBe(1);
  });
});
