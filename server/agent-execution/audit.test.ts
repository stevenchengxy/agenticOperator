import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture what auditExecution forwards to recordLogEvent, to lock in the
// isolation contract (distinct source/agent, executionId as runId).
const calls: Array<Record<string, unknown>> = [];
const recordLogEvent = vi.fn((arg: Record<string, unknown>): Promise<void> => {
  calls.push(arg);
  return Promise.resolve();
});
vi.mock('@/server/log/log-event', () => ({
  recordLogEvent: (arg: Record<string, unknown>) => recordLogEvent(arg),
}));

import { auditExecution, AGENT_EXECUTION_LOG_SOURCE, AGENT_EXECUTION_LOG_AGENT } from './audit';

function lastCall(): Record<string, unknown> {
  const c = calls.at(-1);
  if (!c) throw new Error('recordLogEvent was not called');
  return c;
}

describe('auditExecution — isolation contract', () => {
  beforeEach(() => {
    calls.length = 0;
    recordLogEvent.mockClear();
  });

  it('tags rows with the distinct source + agent (never a recruitment agent)', () => {
    auditExecution({ type: 'agent_start', executionId: 'exec_1', message: 'start' });
    expect(recordLogEvent).toHaveBeenCalledTimes(1);
    expect(lastCall().source).toBe(AGENT_EXECUTION_LOG_SOURCE);
    expect(lastCall().source).toBe('agent-execution');
    expect(lastCall().agent).toBe(AGENT_EXECUTION_LOG_AGENT);
    expect(lastCall().agent).toBe('agent-execution-api');
  });

  it('uses executionId as runId so the audit trail is queryable per execution', () => {
    auditExecution({ type: 'agent_complete', executionId: 'exec_42', traceId: 'tr-1', message: 'done' });
    expect(lastCall().runId).toBe('exec_42');
    expect(lastCall().traceId).toBe('tr-1');
  });

  it('serializes payload defensively (never throws on cyclic input)', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => auditExecution({ type: 'agent_error', executionId: 'exec_x', message: 'boom', payload: cyclic })).not.toThrow();
    expect(lastCall().payloadJson).toBeNull();
  });

  it('truncates long payloads to keep audit rows bounded', () => {
    const big = { blob: 'x'.repeat(10000) };
    auditExecution({ type: 'agent_complete', executionId: 'exec_b', message: 'm', payload: big });
    expect(String(lastCall().payloadJson).length).toBeLessThanOrEqual(4000);
  });
});
