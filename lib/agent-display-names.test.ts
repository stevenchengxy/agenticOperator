import { describe, it, expect } from 'vitest';
import { displayNameFor } from './agent-display-names';

// The run-summary bug: per-agent breakdown used byShort(nodeId) where nodeId is
// the app-prefixed Inngest slug → always missed → the raw slug
// "agentic-operator-main-rule-check-agent" leaked into the summary. displayNameFor
// must resolve every identifier shape to the business name so no slug ever reaches
// the user.

describe('displayNameFor', () => {
  it('resolves an app-prefixed Inngest slug to the zh business name', () => {
    expect(displayNameFor('agentic-operator-main-rule-check-agent', 'zh')).toBe('规则校验');
  });
  it('resolves a bare Inngest fn id', () => {
    expect(displayNameFor('rule-check-agent', 'zh')).toBe('规则校验');
    expect(displayNameFor('match-resume-agent', 'zh')).toBe('简历匹配');
  });
  it('resolves a canonical short in both languages', () => {
    expect(displayNameFor('Matcher', 'zh')).toBe('简历匹配');
    expect(displayNameFor('Matcher', 'en')).toBe('Resume Matcher');
    expect(displayNameFor('RuleCheck', 'zh')).toBe('规则校验');
  });
  it('passes through genuinely unknown ids unchanged', () => {
    expect(displayNameFor('totally-unknown-thing', 'zh')).toBe('totally-unknown-thing');
  });
});
