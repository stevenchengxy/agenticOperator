// context-sources.test.ts
import { describe, it, expect } from 'vitest';
import { eventContexts, type EventContext } from './context-sources';

describe('eventContexts', () => {
  it('builds EventContext[] from the static codegen event registry', () => {
    const ecs = eventContexts('raas');
    expect(ecs.length).toBeGreaterThan(10);
    const r = ecs.find((e: EventContext) => e.name === 'RESUME_PROCESSED');
    expect(r?.stage).toBe('resume');
    expect(typeof r?.summary).toBe('string');
  });
  it('returns [] for a domain with no registered events (r7)', () => {
    expect(eventContexts('r7')).toEqual([]);
  });
});
