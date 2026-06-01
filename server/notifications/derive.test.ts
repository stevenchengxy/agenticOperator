import { describe, it, expect } from 'vitest';
import {
  deriveNotification,
  severityOf,
  categoryOf,
  resolveLink,
  isMessageWorthy,
  type CaptureInput,
} from './derive';

// The deterministic backbone of the notification center. Everything captured
// (errors, infra failures, business lifecycle events) flows through here to be
// classified WITHOUT any LLM — so the alert pipeline keeps working when the LLM
// gateway (a top alert source) is down. The AI layer only enriches afterward.

function base(over: Partial<CaptureInput> = {}): CaptureInput {
  return {
    level: 'info',
    category: 'agent_lifecycle',
    source: 'ruleCheck',
    message: 'something happened',
    runId: 'run-1',
    ...over,
  };
}

describe('severityOf', () => {
  it('maps critical level to critical', () => {
    expect(severityOf(base({ level: 'critical' }))).toBe('critical');
  });
  it('maps error level to warning by default, critical when a broad-impact dedupeHint is present', () => {
    expect(severityOf(base({ level: 'error' }))).toBe('warning');
    expect(severityOf(base({ level: 'error', dedupeHint: 'llm_gateway_401' }))).toBe('critical');
    expect(severityOf(base({ level: 'error', dedupeHint: 'em_degraded' }))).toBe('critical');
  });
  it('maps info/notice to info', () => {
    expect(severityOf(base({ level: 'info' }))).toBe('info');
    expect(severityOf(base({ level: 'notice' }))).toBe('info');
  });
});

describe('categoryOf', () => {
  it('routes infra/system signals to system', () => {
    expect(categoryOf(base({ source: 'LLM 网关', category: 'llm_call', level: 'error' }))).toBe('system');
    expect(categoryOf(base({ category: 'system', source: 'EM' }))).toBe('system');
  });
  it('routes candidate/job anchors to their category', () => {
    expect(categoryOf(base({ anchors: { candidate_id: 'C1' } }))).toBe('candidate');
    expect(categoryOf(base({ anchors: { job_requisition_id: 'JR1' } }))).toBe('job');
  });
  it('routes event publishes to event and agent lifecycle to agent', () => {
    expect(categoryOf(base({ category: 'event_publish', eventName: 'REQUIREMENT_SYNCED' }))).toBe('event');
    expect(categoryOf(base({ category: 'agent_lifecycle', anchors: {} }))).toBe('agent');
  });
});

describe('resolveLink', () => {
  it('prefers rule-check audit, then run, then trace, then event', () => {
    expect(resolveLink(base({ auditId: 'rca_1', runId: 'r', traceId: 't' }))).toEqual({ linkKind: 'rule_check', linkId: 'rca_1' });
    expect(resolveLink(base({ runId: 'r1', traceId: 't1' }))).toEqual({ linkKind: 'run', linkId: 'r1' });
    expect(resolveLink(base({ runId: null, traceId: 't1' }))).toEqual({ linkKind: 'trace', linkId: 't1' });
    expect(resolveLink(base({ runId: null, traceId: null, eventInstanceId: 'ei1' }))).toEqual({ linkKind: 'event', linkId: 'ei1' });
  });
  it('returns none when no correlation key present', () => {
    expect(resolveLink(base({ runId: null, traceId: null, eventInstanceId: null }))).toEqual({ linkKind: 'none', linkId: null });
  });
});

describe('isMessageWorthy', () => {
  it('surfaces business lifecycle + domain event publishes', () => {
    expect(isMessageWorthy(base({ category: 'agent_lifecycle', message: 'handler.end' }))).toBe(true);
    expect(isMessageWorthy(base({ category: 'event_publish', eventName: 'REQUIREMENT_SYNCED' }))).toBe(true);
    expect(isMessageWorthy(base({ category: 'manage_action' }))).toBe(true);
  });
  it('drops low-value plumbing (tool/db/api/debug)', () => {
    expect(isMessageWorthy(base({ category: 'tool_call' }))).toBe(false);
    expect(isMessageWorthy(base({ category: 'db_call' }))).toBe(false);
    expect(isMessageWorthy(base({ category: 'api_call' }))).toBe(false);
    expect(isMessageWorthy(base({ level: 'debug' }))).toBe(false);
  });
});

describe('deriveNotification', () => {
  it('error/critical → alert with dedupeKey + notify decision', () => {
    const n = deriveNotification(base({ level: 'critical', source: 'LLM 网关', category: 'llm_call', message: '401 无效的令牌', dedupeHint: 'llm_gateway_401' }));
    expect(n).not.toBeNull();
    expect(n!.kind).toBe('alert');
    expect(n!.severity).toBe('critical');
    expect(n!.category).toBe('system');
    expect(n!.dedupeKey).toBe('llm_gateway_401');
    expect(n!.disposition).toBe('needs_human');
    expect(n!.shouldNotify).toBe(true);
  });

  it('message-worthy info → message, no dedupe, info_only, not notified', () => {
    const n = deriveNotification(base({ level: 'info', category: 'event_publish', eventName: 'REQUIREMENT_SYNCED', message: '需求已同步', anchors: { job_requisition_id: 'JR1' } }));
    expect(n).not.toBeNull();
    expect(n!.kind).toBe('message');
    expect(n!.severity).toBe('info');
    expect(n!.category).toBe('event');
    expect(n!.dedupeKey).toBeNull();
    expect(n!.disposition).toBe('info_only');
    expect(n!.shouldNotify).toBe(false);
  });

  it('low-value plumbing → null (stays in the audit log, not surfaced)', () => {
    expect(deriveNotification(base({ category: 'tool_call', level: 'info' }))).toBeNull();
    expect(deriveNotification(base({ category: 'db_call', level: 'debug' }))).toBeNull();
  });

  it('warning alert: notified in AI/normal mode, NOT notified in fallback mode', () => {
    const warn = base({ level: 'error', source: 'ruleCheck', message: 'low confidence', dedupeHint: 'agent_warn.ruleCheck' });
    expect(deriveNotification(warn).shouldNotify).toBe(true); // normal
    expect(deriveNotification(warn, { mode: 'fallback' }).shouldNotify).toBe(false); // fallback → only critical
  });

  it('critical alert is notified even in fallback mode', () => {
    const crit = base({ level: 'error', dedupeHint: 'em_degraded', source: 'EM', category: 'system', message: 'EM down' });
    expect(deriveNotification(crit, { mode: 'fallback' }).shouldNotify).toBe(true);
  });
});
