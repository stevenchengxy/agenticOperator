import { describe, it, expect } from 'vitest';
import {
  pickNodeStatus,
  sumTokensFromActivities,
  buildEdgeAggregates,
  buildHourlyBuckets,
} from './aggregations';

describe('pickNodeStatus', () => {
  it('returns failing when error rate > 0.2', () => {
    expect(pickNodeStatus({ running: 0, completedInWindow: 10, failedInWindow: 3, queueDepth: 0 })).toBe('failing');
  });
  it('returns degraded when queue depth > 50 or error rate > 0.05', () => {
    expect(pickNodeStatus({ running: 5, completedInWindow: 100, failedInWindow: 6, queueDepth: 0 })).toBe('degraded');
    expect(pickNodeStatus({ running: 5, completedInWindow: 100, failedInWindow: 0, queueDepth: 60 })).toBe('degraded');
  });
  it('returns healthy when running > 0 and no signals trip', () => {
    expect(pickNodeStatus({ running: 3, completedInWindow: 50, failedInWindow: 1, queueDepth: 5 })).toBe('healthy');
  });
  it('returns idle when no running and no completions', () => {
    expect(pickNodeStatus({ running: 0, completedInWindow: 0, failedInWindow: 0, queueDepth: 0 })).toBe('idle');
  });
});

describe('sumTokensFromActivities', () => {
  it('parses promptTokens/completionTokens/totalTokens from AgentActivity.metadata json', () => {
    const rows = [
      { metadata: JSON.stringify({ promptTokens: 100, completionTokens: 30, totalTokens: 130 }) },
      { metadata: JSON.stringify({ promptTokens: 50, completionTokens: 10, totalTokens: 60 }) },
      { metadata: null },                              // ignored
      { metadata: '{ malformed' },                     // ignored, no throw
      { metadata: JSON.stringify({ note: 'no tokens here' }) }, // ignored
    ];
    const s = sumTokensFromActivities(rows as any);
    expect(s).toEqual({ prompt: 150, completion: 40, total: 190 });
  });
});

describe('buildEdgeAggregates', () => {
  it('counts events flowing from one agent name to the next event consumer', () => {
    // Two events between sync and analyze
    const eventInstances = [
      { name: 'REQUIREMENT_SYNCED', source: 'rpa.ReqSync', ts: new Date('2026-05-14T10:00:00Z'), status: 'accepted' },
      { name: 'REQUIREMENT_SYNCED', source: 'rpa.ReqSync', ts: new Date('2026-05-14T10:01:00Z'), status: 'accepted' },
      { name: 'ANALYSIS_COMPLETED', source: 'rpa.ReqAnalyzer', ts: new Date('2026-05-14T10:05:00Z'), status: 'accepted' },
    ];
    const edges = [
      { from: 'sync',    to: 'analyze', eventName: 'REQUIREMENT_SYNCED' },
      { from: 'analyze', to: 'clarify', eventName: 'ANALYSIS_COMPLETED' },
    ];
    const out = buildEdgeAggregates(edges, eventInstances as any);
    expect(out[0].countInWindow).toBe(2);
    expect(out[0].lastEventAt).toBe('2026-05-14T10:01:00.000Z');
    expect(out[1].countInWindow).toBe(1);
  });
});

describe('buildHourlyBuckets', () => {
  it('returns exactly 24 buckets for a since point inside the 24h window', () => {
    const since = new Date(Date.now() - 23 * 60 * 60 * 1000);
    const out = buildHourlyBuckets(since, () => 0);
    expect(out).toHaveLength(24);
  });

  it('pad path produces distinct timestamps stepping backward by an hour', () => {
    // Force the pad path by passing a near-present since.
    const since = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    const out = buildHourlyBuckets(since, () => 0);
    expect(out).toHaveLength(24);
    // Padded buckets MUST have distinct timestamps (the bug was reusing one).
    const stamps = new Set(out.map(b => b.bucket));
    expect(stamps.size).toBe(24);
  });

  it('compute callback receives bucketStart and bucketEnd one HOUR apart', () => {
    const since = new Date(Date.now() - 23 * 60 * 60 * 1000);
    let firstPair: [Date, Date] | null = null;
    buildHourlyBuckets(since, (s, e) => {
      if (!firstPair) firstPair = [s, e];
      return 0;
    });
    expect(firstPair).not.toBeNull();
    expect(firstPair![1].getTime() - firstPair![0].getTime()).toBe(60 * 60 * 1000);
  });
});
