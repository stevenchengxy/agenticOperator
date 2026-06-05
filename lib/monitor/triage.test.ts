import { describe, it, expect } from 'vitest';
import { clusterFiring } from './triage';

describe('clusterFiring', () => {
  it('groups firing alerts by dedupe prefix + domain, summing counts', () => {
    const clusters = clusterFiring([
      { dedupeKey: 'run_stalled.r1', domain: '招聘-v1', source: '系统', severity: 'critical', count: 2 },
      { dedupeKey: 'run_stalled.r2', domain: '招聘-v1', source: '系统', severity: 'critical', count: 1 },
      { dedupeKey: 'sla_breach.x', domain: '招聘-v1', source: 'x', severity: 'warning', count: 3 },
    ]);
    expect(clusters.length).toBe(2);
    const stalled = clusters.find((c) => c.prefix === 'run_stalled');
    expect(stalled?.total).toBe(3);
    expect(stalled?.alerts.length).toBe(2);
  });

  it('separates the same prefix across domains', () => {
    const clusters = clusterFiring([
      { dedupeKey: 'cost.budget.招聘-v1', domain: '招聘-v1', source: '系统', severity: 'critical', count: 1 },
      { dedupeKey: 'cost.budget.能源调度-v1', domain: '能源调度-v1', source: '系统', severity: 'critical', count: 1 },
    ]);
    expect(clusters.length).toBe(2);
  });
});
