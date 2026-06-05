import { describe, it, expect } from 'vitest';
import { slaMonitor } from './sla';
import { DEFAULT_THRESHOLDS, type MonitorReadPort, type StepTiming } from './monitor-types';
import { ENERGY_DOMAIN_ID } from '@/lib/domain-ids';

function fakePort(steps: StepTiming[]): MonitorReadPort {
  return {
    inflightRuns: async () => [],
    stepTimings: async () => steps,
    recentRuns: async () => [],
    tokenUsageByRun: async () => ({}),
    toolStepCounts: async () => ({}),
    errorWindow: async () => ({ total: 0, byAgent: {} }),
  };
}

const t = { ...DEFAULT_THRESHOLDS, slaP95Ms: 1000 };

describe('slaMonitor', () => {
  it('flags an agent whose p95 step duration exceeds slaP95Ms', async () => {
    const steps: StepTiming[] = Array.from({ length: 10 }, (_, i) => ({
      runId: `r${i}`,
      functionSlug: 'match-resume',
      eventName: 'RESUME_PROCESSED',
      durationMs: i < 9 ? 500 : 5000,
    }));
    const res = await slaMonitor(fakePort(steps), t);
    expect(res.prefix).toBe('sla_breach.');
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].category).toBe('agent_lifecycle');
    expect(res.findings[0].dedupeHint).toBe('sla_breach.match-resume');
    expect(res.findings[0].level).toBe('warn');
    // critical contract: must NOT carry eventName, or categoryOf would map it to 'event'
    expect(res.findings[0].eventName ?? null).toBeNull();
    expect(res.activeKeys).toEqual(['sla_breach.match-resume']);
  });

  it('does not flag agents under the threshold', async () => {
    const steps: StepTiming[] = Array.from({ length: 10 }, (_, i) => ({
      runId: `r${i}`,
      functionSlug: 'fast',
      eventName: null,
      durationMs: 100,
    }));
    const res = await slaMonitor(fakePort(steps), t);
    expect(res.findings).toHaveLength(0);
    expect(res.activeKeys).toEqual([]);
  });

  it('tags the finding with the run domain', async () => {
    const steps: StepTiming[] = Array.from({ length: 5 }, (_, i) => ({
      runId: `e${i}`,
      functionSlug: 'energy-validate',
      eventName: 'energy/CONSTRAINT_VALIDATED',
      durationMs: 9000,
    }));
    const res = await slaMonitor(fakePort(steps), t);
    expect(res.findings[0].domain).toBe(ENERGY_DOMAIN_ID);
  });
});
