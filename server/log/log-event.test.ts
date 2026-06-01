import { describe, it, expect } from 'vitest';
import { levelCategoryFor } from './log-event';

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
  it('defaults unknown types to info/info', () => {
    expect(levelCategoryFor('something_new')).toEqual({ level: 'info', category: 'info' });
  });
});
