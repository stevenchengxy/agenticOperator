import { describe, it, expect } from 'vitest';
import { summarizeDependencyHealth } from './summarize';
import { DEFAULT_THRESHOLDS } from '../monitor/monitor-types';
import type { DepFailure } from './types';

const T = DEFAULT_THRESHOLDS;

function dep(over: Partial<DepFailure>): DepFailure {
  return {
    provider: 'robohire',
    op: 'parseResume',
    reason: 'quota',
    domain: '招聘-v1',
    runId: null,
    ts: new Date('2026-06-05T10:00:00Z'),
    ...over,
  };
}

describe('summarizeDependencyHealth', () => {
  it('always reports both known providers, healthy when no failures', () => {
    const out = summarizeDependencyHealth([], T);
    expect(out.map((p) => p.provider).sort()).toEqual(['llm', 'robohire']);
    expect(out.every((p) => p.label === 'healthy' && p.severity === 'ok' && p.failureCount === 0)).toBe(true);
  });

  it('rolls a provider up to its judged label + affected ops/domains', () => {
    const out = summarizeDependencyHealth(
      [
        dep({ reason: 'quota', op: 'parseResume', domain: '招聘-v1' }),
        dep({ reason: 'quota', op: 'matchResume', domain: '招聘-v1' }),
      ],
      T,
    );
    const robo = out.find((p) => p.provider === 'robohire')!;
    expect(robo.label).toBe('out_of_funds');
    expect(robo.severity).toBe('critical');
    expect(robo.failureCount).toBe(2);
    expect(robo.affectedOps.sort()).toEqual(['matchResume', 'parseResume']);
    expect(robo.affectedDomains).toEqual(['招聘-v1']);
    expect(robo.lastReason).toBe('quota');
    expect(robo.sinceTs).toBe('2026-06-05T10:00:00.000Z');
  });

  it('sub-threshold failures show as watching (info), not an alert', () => {
    const out = summarizeDependencyHealth([dep({ reason: 'empty' })], T);
    const robo = out.find((p) => p.provider === 'robohire')!;
    expect(robo.label).toBe('watching');
    expect(robo.severity).toBe('info');
    expect(robo.failureCount).toBe(1);
  });

  it('keeps providers independent', () => {
    const out = summarizeDependencyHealth([dep({ provider: 'llm', op: 'ruleCheck', reason: 'quota' })], T);
    expect(out.find((p) => p.provider === 'llm')!.label).toBe('out_of_funds');
    expect(out.find((p) => p.provider === 'robohire')!.label).toBe('healthy');
  });
});
