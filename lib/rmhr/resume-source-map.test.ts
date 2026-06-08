import { describe, it, expect } from 'vitest';
import { resolveResumeSourceId, DEFAULT_RESUME_SOURCE_ID } from './resume-source-map';
describe('resolveResumeSourceId', () => {
  it('maps a known channel label to its company code', () => {
    expect(resolveResumeSourceId('BOSS直聘-AI')).toBe('02001034');
  });
  it('falls back to the default code for null/unknown', () => {
    expect(resolveResumeSourceId(null)).toBe(DEFAULT_RESUME_SOURCE_ID);
    expect(resolveResumeSourceId('某个绝不会命中的渠道')).toBe(DEFAULT_RESUME_SOURCE_ID);
  });
  it('trims/normalizes before lookup', () => {
    expect(resolveResumeSourceId('  BOSS直聘-AI ')).toBe('02001034');
  });
});
