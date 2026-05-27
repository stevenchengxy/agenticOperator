import { describe, it, expect } from 'vitest';
import { serializePromptText, deserializePromptText } from './prompt-version';
import type { AgentPrompt } from './prompt-types';

const prompt: AgentPrompt = {
  intent: 'screen resumes', role: 'r', trigger: { event: 'E', payloadExpectations: '', confirmed: true },
  inputs: [], steps: [{ id: 's', description: 'd' }], tools: [], emits: [], errorHandling: 'retry',
  constraints: [], acceptance: [], fieldOrigin: {},
};

describe('prompt-version', () => {
  it('round-trips an AgentPrompt through promptText', () => {
    expect(deserializePromptText(serializePromptText(prompt))).toEqual(prompt);
  });
  it('reads a legacy plain-string promptText as { intent }', () => {
    const legacy = deserializePromptText('just some old business logic prose');
    expect(legacy?.intent).toBe('just some old business logic prose');
    expect(legacy?.steps).toEqual([]);
  });
  it('returns null for empty/garbage', () => {
    expect(deserializePromptText('')).toBeNull();
  });
});
