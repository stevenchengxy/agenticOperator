import { describe, it, expect } from 'vitest';
import { FEW_SHOT_INDEX, pickFewShots } from './few-shot-index';

describe('FEW_SHOT_INDEX', () => {
  it('contains entries from all 5 production agents', () => {
    const sources = new Set(FEW_SHOT_INDEX.map((e) => e.source));
    expect(sources.has('server/inngest/agents/create-jd-agent.ts')).toBe(true);
    expect(sources.has('server/inngest/agents/resume-parser-agent.ts')).toBe(true);
    expect(sources.has('server/inngest/agents/match-resume-agent.ts')).toBe(true);
    expect(sources.has('server/inngest/agents/rule-check-agent.ts')).toBe(true);
    expect(sources.has('server/inngest/agents/interview-inviter-agent.ts')).toBe(true);
  });

  it('every entry carries non-empty body + at least one toolId', () => {
    for (const e of FEW_SHOT_INDEX) {
      expect(e.body.length).toBeGreaterThan(20);
      expect(e.toolIds.length).toBeGreaterThan(0);
    }
  });
});

describe('pickFewShots', () => {
  it('prefers same-stage entries', () => {
    const shots = pickFewShots({ stage: 'interview', topN: 3 });
    expect(shots[0].stage).toBe('interview');
  });

  it('bumps entries whose toolIds overlap the target', () => {
    const shots = pickFewShots({
      stage: 'resume',
      toolIds: ['minio.getResumeBuffer'],
      topN: 1,
    });
    expect(shots[0].toolIds).toContain('minio.getResumeBuffer');
  });

  it('returns at most topN entries', () => {
    expect(pickFewShots({ topN: 2 }).length).toBe(2);
  });
});
