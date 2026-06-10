import { describe, it, expect } from 'vitest';
import {
  normalizeStatsParams,
  bucketStart,
  makeBuckets,
  aggregateRuns,
  aggregateApiCalls,
} from './stats';

describe('normalizeStatsParams', () => {
  const now = new Date('2026-06-10T15:30:00');

  it('defaults to 24h/hour', () => {
    const p = normalizeStatsParams(null, null, now);
    expect(p.window).toBe('24h');
    expect(p.bucket).toBe('hour');
    expect(now.getTime() - p.since.getTime()).toBe(24 * 3600_000);
  });

  it('rejects invalid window and bucket combos', () => {
    expect(normalizeStatsParams('99d', 'week', now).window).toBe('24h');
    // hour 不允许配 30d → 回落默认 day
    expect(normalizeStatsParams('30d', 'hour', now).bucket).toBe('day');
    expect(normalizeStatsParams('7d', 'hour', now).bucket).toBe('hour');
    expect(normalizeStatsParams('30d', 'week', now).bucket).toBe('week');
  });
});

describe('bucketStart / makeBuckets', () => {
  it('truncates to hour / day / Monday-week in local time', () => {
    const d = new Date('2026-06-10T15:42:31'); // Wednesday
    expect(bucketStart(d, 'hour').toISOString()).toBe(new Date('2026-06-10T15:00:00').toISOString());
    expect(bucketStart(d, 'day').getHours()).toBe(0);
    const wk = bucketStart(d, 'week');
    expect(wk.getDay()).toBe(1); // Monday
    expect(wk.getDate()).toBe(8); // 2026-06-08 is the Monday of that week
  });

  it('produces a contiguous bucket sequence covering both ends', () => {
    const since = new Date('2026-06-10T03:30:00');
    const now = new Date('2026-06-10T06:10:00');
    const buckets = makeBuckets(since, now, 'hour');
    expect(buckets).toHaveLength(4); // 03,04,05,06
    expect(new Date(buckets[0]).getHours()).toBe(3);
    expect(new Date(buckets[3]).getHours()).toBe(6);
  });
});

describe('aggregateRuns', () => {
  const since = new Date('2026-06-10T00:00:00');
  const now = new Date('2026-06-10T02:59:00');
  const buckets = makeBuckets(since, now, 'hour'); // 00,01,02

  it('buckets per-agent counts and failure split', () => {
    const rows = [
      { functionSlug: 'a', functionName: 'Agent A', status: 'Completed', startedAt: new Date('2026-06-10T00:10:00') },
      { functionSlug: 'a', functionName: 'Agent A', status: 'Failed', startedAt: new Date('2026-06-10T00:50:00') },
      { functionSlug: 'a', functionName: 'Agent A', status: 'Completed', startedAt: new Date('2026-06-10T02:01:00') },
      { functionSlug: 'b', functionName: null, status: 'Cancelled', startedAt: new Date('2026-06-10T01:30:00') },
      { functionSlug: 'c', functionName: 'C', status: 'Completed', startedAt: null }, // dropped
      { functionSlug: 'c', functionName: 'C', status: 'Completed', startedAt: new Date('2026-06-09T23:59:00') }, // out of window... still in bucket 0? No: bucketStart=23:00 not in list → dropped
    ];
    const agg = aggregateRuns(rows, buckets, 'hour');
    expect(agg.agents[0]).toMatchObject({ slug: 'a', name: 'Agent A', total: 3, failed: 1 });
    expect(agg.agents[0].series).toEqual([2, 0, 1]);
    expect(agg.agents[0].failedSeries).toEqual([1, 0, 0]);
    const b = agg.agents.find((x) => x.slug === 'b')!;
    expect(b.name).toBe('b'); // functionName null → slug fallback
    // c 的两行都被丢弃(null startedAt / 窗口外),不计入任何 totals
    expect(agg.totalsByStatus).toEqual({ Completed: 2, Failed: 1, Cancelled: 1 });
    expect(agg.totalSeries).toEqual([2, 1, 1]);
  });
});

describe('aggregateApiCalls', () => {
  const since = new Date('2026-06-10T00:00:00');
  const now = new Date('2026-06-10T01:59:00');
  const buckets = makeBuckets(since, now, 'hour'); // 00,01

  it('aggregates providers, operations and per-agent counts', () => {
    const rows = [
      { ts: new Date('2026-06-10T00:05:00'), source: 'robohire', agent: 'resumeParser', eventName: 'RoboHire.parseResume', level: 'info' },
      { ts: new Date('2026-06-10T00:06:00'), source: 'robohire', agent: 'resumeParser', eventName: 'RoboHire.parseResume', level: 'error' },
      { ts: new Date('2026-06-10T01:00:00'), source: 'robohire', agent: 'matchResume', eventName: 'RoboHire.matchResume', level: 'info' },
      { ts: new Date('2026-06-10T01:01:00'), source: 'partner-pg', agent: null, eventName: 'pg.SELECT candidate', level: 'info' },
    ];
    const agg = aggregateApiCalls(rows, buckets, 'hour');
    const rh = agg.providers.find((p) => p.provider === 'robohire')!;
    expect(rh).toMatchObject({ total: 3, errors: 1 });
    expect(rh.series).toEqual([2, 1]);
    expect(agg.operations[0]).toMatchObject({ op: 'RoboHire.parseResume', count: 2, errors: 1 });
    expect(agg.byAgent.find((a) => a.agent === 'resumeParser')).toMatchObject({ provider: 'robohire', count: 2 });
    expect(agg.byAgent.find((a) => a.agent === null)).toMatchObject({ provider: 'partner-pg', count: 1 });
  });
});
