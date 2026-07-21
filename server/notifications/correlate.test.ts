import { describe, it, expect } from 'vitest';
import { buildLogQuery, type CorrelationInput } from './correlate';

const base = (over: Partial<CorrelationInput> = {}): CorrelationInput => ({
  runId: null,
  traceId: null,
  agent: null,
  firstSeenAt: new Date('2026-06-01T12:00:00Z'),
  lastSeenAt: new Date('2026-06-01T12:05:00Z'),
  ...over,
});

describe('buildLogQuery', () => {
  it('prefers runId over everything', () => {
    const q = buildLogQuery(base({ runId: 'R1', traceId: 'T1', agent: 'ruleCheck' }));
    expect(q.where).toEqual({ runId: 'R1' });
    expect(q.orderBy).toEqual({ ts: 'asc' });
  });

  it('falls back to traceId when no runId', () => {
    const q = buildLogQuery(base({ traceId: 'T1', agent: 'ruleCheck' }));
    expect(q.where).toEqual({ traceId: 'T1' });
  });

  it('uses agent + time window when no run/trace', () => {
    const q = buildLogQuery(base({ agent: 'ruleCheck' }), 10 * 60 * 1000);
    expect(q.where.agent).toBe('ruleCheck');
    const ts = q.where.ts as { gte: Date; lte: Date };
    expect(ts.gte).toEqual(new Date('2026-06-01T11:50:00Z'));
    expect(ts.lte).toEqual(new Date('2026-06-01T12:15:00Z'));
  });

  it('system notification with no anchor → windowed error-level scan', () => {
    const q = buildLogQuery(base());
    expect(q.where.agent).toBeUndefined();
    expect(q.where.level).toEqual({ in: ['warn', 'error', 'critical'] });
    const ts = q.where.ts as { gte: Date; lte: Date };
    expect(ts.gte).toEqual(new Date('2026-06-01T11:50:00Z'));
    expect(ts.lte).toEqual(new Date('2026-06-01T12:15:00Z'));
  });

  it('caps the result count', () => {
    expect(buildLogQuery(base({ runId: 'R1' })).take).toBe(100);
  });
});
