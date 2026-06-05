import { describe, it, expect } from 'vitest';
import { parseDependencyRow } from './parse-signal';

const ts = new Date('2026-06-05T10:00:00Z');

describe('parseDependencyRow', () => {
  it('reconstructs a DepFailure from a well-formed dependency LogEvent row', () => {
    const row = {
      runId: 'run_1',
      ts,
      payloadJson: JSON.stringify({
        provider: 'robohire',
        op: 'parseResume',
        reason: 'quota',
        domain: '招聘-v1',
        anchors: { candidate_id: 'c1' },
      }),
    };
    expect(parseDependencyRow(row)).toEqual({
      provider: 'robohire',
      op: 'parseResume',
      reason: 'quota',
      domain: '招聘-v1',
      runId: 'run_1',
      ts,
      anchors: { candidate_id: 'c1' },
    });
  });

  it('falls back to recruitment domain when payload omits domain', () => {
    const row = {
      runId: null,
      ts,
      payloadJson: JSON.stringify({ provider: 'llm', op: 'ruleCheck', reason: 'empty' }),
    };
    expect(parseDependencyRow(row)).toMatchObject({ provider: 'llm', reason: 'empty', domain: '招聘-v1' });
  });

  it('returns null for malformed / unparseable / incomplete payloads', () => {
    expect(parseDependencyRow({ runId: null, ts, payloadJson: null })).toBeNull();
    expect(parseDependencyRow({ runId: null, ts, payloadJson: '{ broken' })).toBeNull();
    expect(parseDependencyRow({ runId: null, ts, payloadJson: JSON.stringify({ provider: 'x', op: 'y', reason: 'quota' }) })).toBeNull();
    expect(parseDependencyRow({ runId: null, ts, payloadJson: JSON.stringify({ provider: 'robohire', op: 'parseResume', reason: 'bogus' }) })).toBeNull();
  });
});
