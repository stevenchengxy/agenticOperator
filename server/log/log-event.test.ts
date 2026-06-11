import { describe, it, expect } from 'vitest';
import { levelCategoryFor, typeForFileKind, canonicalShortForFileAgent } from './log-event';

// LogEvent is the unified, queryable audit log: every AgentActivity write is
// mirrored here with a normalized (level, category) so /api/logs can filter by
// severity and kind across all agents. levelCategoryFor maps the agent's
// activity `type` string to that normalized pair.

describe('levelCategoryFor', () => {
  it('maps unrecoverable errors to error level', () => {
    expect(levelCategoryFor('agent_error')).toEqual({ level: 'error', category: 'error' });
    expect(levelCategoryFor('step.failed')).toEqual({ level: 'error', category: 'step' });
  });
  it('maps anomalies to warn', () => {
    expect(levelCategoryFor('anomaly')).toEqual({ level: 'warn', category: 'anomaly' });
  });
  it('maps tool/decision/events/lifecycle to info', () => {
    expect(levelCategoryFor('tool')).toEqual({ level: 'info', category: 'tool' });
    expect(levelCategoryFor('decision')).toEqual({ level: 'info', category: 'decision' });
    expect(levelCategoryFor('event_received')).toEqual({ level: 'info', category: 'event' });
    expect(levelCategoryFor('event_emitted')).toEqual({ level: 'info', category: 'event' });
    expect(levelCategoryFor('agent_start')).toEqual({ level: 'info', category: 'lifecycle' });
    expect(levelCategoryFor('agent_complete')).toEqual({ level: 'info', category: 'lifecycle' });
  });
  it('maps hitl to notice', () => {
    expect(levelCategoryFor('hitl')).toEqual({ level: 'notice', category: 'hitl' });
  });
  it('maps dependency_degraded to its own warn/dependency lane', () => {
    expect(levelCategoryFor('dependency_degraded')).toEqual({ level: 'warn', category: 'dependency' });
  });
  it('maps dependency_reset to its own info/dependency_reset lane', () => {
    expect(levelCategoryFor('dependency_reset')).toEqual({ level: 'info', category: 'dependency_reset' });
  });
  it('maps domain_drift to warn on the dependency lane', () => {
    expect(levelCategoryFor('domain_drift')).toEqual({ level: 'warn', category: 'dependency' });
  });
  it('defaults unknown types to info/info', () => {
    expect(levelCategoryFor('something_new')).toEqual({ level: 'info', category: 'info' });
  });
});

// The real agents write to the JSONL file logger (lib/agent-logger) with kind
// strings like 'handler.start' / 'emit.jd-generated' / 'api.RAAS' / 'handler.error'.
// typeForFileKind maps those to the canonical AgentActivity type so the bridge
// can run them through levelCategoryFor and into the unified audit log.
describe('typeForFileKind', () => {
  it('maps handler lifecycle', () => {
    expect(typeForFileKind('handler.start')).toBe('agent_start');
    expect(typeForFileKind('handler.done')).toBe('agent_complete');
    expect(typeForFileKind('handler.error')).toBe('agent_error');
    expect(typeForFileKind('handler.raw_input')).toBe('event_received');
  });
  it('maps emits to event_emitted and api.* to tool', () => {
    expect(typeForFileKind('emit.jd-generated')).toBe('event_emitted');
    expect(typeForFileKind('emit.resume-processed')).toBe('event_emitted');
    expect(typeForFileKind('api.RAAS POST /candidates')).toBe('tool');
  });
  it('maps step phases', () => {
    expect(typeForFileKind('step.start')).toBe('step.started');
    expect(typeForFileKind('step.end')).toBe('step.completed');
    expect(typeForFileKind('step.error')).toBe('step.failed');
  });
  it('maps business *.failed to anomaly, other *.error to agent_error', () => {
    expect(typeForFileKind('save-candidate.failed')).toBe('anomaly');
    expect(typeForFileKind('some.error')).toBe('agent_error');
  });
  it('defaults to info', () => {
    expect(typeForFileKind('save-candidate.ok')).toBe('info');
    expect(typeForFileKind('match.input')).toBe('info');
  });
});

describe('canonicalShortForFileAgent', () => {
  it('maps file-local AGENT_NAMEs to AGENT_MAP shorts (so /monitor groups them)', () => {
    expect(canonicalShortForFileAgent('ruleCheck')).toBe('RuleCheck');
    expect(canonicalShortForFileAgent('createJD')).toBe('JDGenerator');
    expect(canonicalShortForFileAgent('matchResume')).toBe('Matcher');
    expect(canonicalShortForFileAgent('resumeParser')).toBe('ResumeParser');
    expect(canonicalShortForFileAgent('interviewInviter')).toBe('InterviewInviter');
  });
  it('passes through unknown names unchanged', () => {
    expect(canonicalShortForFileAgent('SomethingElse')).toBe('SomethingElse');
  });
});
