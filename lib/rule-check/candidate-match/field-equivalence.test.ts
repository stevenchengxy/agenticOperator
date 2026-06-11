import { describe, it, expect, vi } from 'vitest';
import { fieldEquivalent, type AiFieldJudge } from './field-equivalence';

const judgeYes: AiFieldJudge = async () => ({ equivalent: true, confidence: 0.95, reason: '同义' });
const judgeLow: AiFieldJudge = async () => ({ equivalent: true, confidence: 0.5, reason: '不确定' });
const judgeNo: AiFieldJudge = async () => ({ equivalent: false, confidence: 0.9, reason: '不同' });

describe('fieldEquivalent — exact fast path', () => {
  it('equal after normalization → exact, no AI call', async () => {
    const judge = vi.fn(judgeYes);
    const r = await fieldEquivalent('phone', '+86 138 0013 8000', '13800138000', { fuzzy: true, judge });
    expect(r.equivalent).toBe(true);
    expect(r.method).toBe('exact');
    expect(r.confidence).toBe(1);
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('fieldEquivalent — missing data is never a match', () => {
  it('one side empty → not equivalent, method empty, AI not consulted', async () => {
    const judge = vi.fn(judgeYes);
    const r = await fieldEquivalent('email', '', 'a@b.com', { fuzzy: true, judge });
    expect(r.equivalent).toBe(false);
    expect(r.method).toBe('empty');
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('fieldEquivalent — exact mismatch without fuzzy', () => {
  it('different values, fuzzy off → mismatch, AI not consulted', async () => {
    const judge = vi.fn(judgeYes);
    const r = await fieldEquivalent('gender', 'male', 'female', { fuzzy: false, judge });
    expect(r.equivalent).toBe(false);
    expect(r.method).toBe('mismatch');
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('fieldEquivalent — AI fuzzy path', () => {
  it('exact fails but fuzzy judge agrees with high confidence → equivalent via ai', async () => {
    const r = await fieldEquivalent('school', '清华', '清华大学', { fuzzy: true, judge: judgeYes });
    expect(r.equivalent).toBe(true);
    expect(r.method).toBe('ai');
    expect(r.confidence).toBeCloseTo(0.95);
  });

  it('AI says equivalent but below threshold → not equivalent (conservative)', async () => {
    const r = await fieldEquivalent('school', '清华', '北大', { fuzzy: true, judge: judgeLow, aiThreshold: 0.8 });
    expect(r.equivalent).toBe(false);
    expect(r.method).toBe('ai');
  });

  it('AI says not equivalent → not equivalent', async () => {
    const r = await fieldEquivalent('degree', '本科', '博士', { fuzzy: true, judge: judgeNo });
    expect(r.equivalent).toBe(false);
    expect(r.method).toBe('ai');
  });

  it('fuzzy requested but no judge supplied → falls back to mismatch (no crash)', async () => {
    const r = await fieldEquivalent('major', '计算机', '软件工程', { fuzzy: true });
    expect(r.equivalent).toBe(false);
    expect(r.method).toBe('mismatch');
  });
});
