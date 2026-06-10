import { describe, it, expect } from 'vitest';
import { apiLogToLogEvent } from './api-call-mirror';
import type { ApiLogEntry } from '@/lib/external-api-log';

const base: ApiLogEntry = {
  category: 'robohire',
  label: 'RoboHire.parseResume',
  url: 'https://api.robohire.io/parse-resume',
  method: 'POST',
  trace_id: 'trace-1',
  status: 200,
  duration_ms: 423,
  request: { filename: 'r.pdf' },
  response: { success: true },
  agent: 'resumeParser',
  run_id: 'run-abc',
};

describe('apiLogToLogEvent', () => {
  it('maps a successful call to an info row on the api lane', () => {
    const row = apiLogToLogEvent(base);
    expect(row.level).toBe('info');
    expect(row.category).toBe('api');
    expect(row.source).toBe('robohire');
    expect(row.eventName).toBe('RoboHire.parseResume');
    expect(row.agent).toBe('resumeParser');
    expect(row.runId).toBe('run-abc');
    expect(row.traceId).toBe('trace-1');
    expect(row.durationMs).toBe(423);
    expect(row.message).toContain('→ 200');
    expect(JSON.parse(row.payloadJson!)).toMatchObject({ status: 200, method: 'POST' });
  });

  it('marks error entries and HTTP >=400 as level=error', () => {
    expect(apiLogToLogEvent({ ...base, error: 'timeout', status: undefined }).level).toBe('error');
    expect(apiLogToLogEvent({ ...base, status: 500 }).level).toBe('error');
    expect(apiLogToLogEvent({ ...base, error: 'boom' }).message).toContain('ERROR boom');
  });

  it('defaults missing attribution to null (not undefined)', () => {
    const row = apiLogToLogEvent({ category: 'allmeta', label: 'Allmeta.PUT /instances' });
    expect(row.agent).toBeNull();
    expect(row.runId).toBeNull();
    expect(row.traceId).toBeNull();
    expect(row.durationMs).toBeNull();
    expect(row.message).toContain('→ -');
  });

  it('truncates oversized payloads to 4000 chars and keeps message ≤2000', () => {
    const row = apiLogToLogEvent({
      ...base,
      url: 'x'.repeat(3000),
      response: { blob: 'y'.repeat(10_000) },
    });
    expect(row.payloadJson!.length).toBeLessThanOrEqual(4000);
    expect(row.message.length).toBeLessThanOrEqual(2000);
  });

  it('survives unserializable payloads (circular refs)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const row = apiLogToLogEvent({ ...base, request: circular });
    expect(row.payloadJson).toBeNull();
    expect(row.level).toBe('info');
  });
});
