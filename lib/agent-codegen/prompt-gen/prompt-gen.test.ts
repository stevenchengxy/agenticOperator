// prompt-gen.test.ts
import { describe, it, expect, vi } from 'vitest';

const valid = {
  intent: 'screen resumes', role: 'Screens resumes.',
  trigger: { event: 'RESUME_PROCESSED', payloadExpectations: 'candidate_id' },
  inputs: ['parsed_resume'], steps: [{ id: 'fetch', description: 'load resume' }],
  tools: ['bogus-tool-not-in-registry'], emits: ['MATCH_RULE_CHECK_PASSED'], errorHandling: 'retry',
  constraints: ['dual-write'], acceptance: ['emits one event'],
};

vi.mock('../llm/gateway', () => ({
  pickPromptGenGateway: () => ({ baseURL: 'x', apiKey: 'x', model: 'test-model' }),
  makeClient: () => ({
    chat: { completions: { create: vi.fn().mockResolvedValue({
      choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'submit_agent_prompt', arguments: JSON.stringify(valid) } }] } }],
    }) } },
  }),
}));

import { generateAgentPrompt } from './prompt-gen';

describe('generateAgentPrompt', () => {
  it('parses the tool call, validates it, and attaches provenance', async () => {
    const res = await generateAgentPrompt({
      intent: 'screen resumes', locked: { triggerEvent: 'RESUME_PROCESSED' }, domain: 'raas',
    });
    expect(res.prompt.intent).toBe('screen resumes');
    expect(res.prompt.trigger.confirmed).toBe(false);
    expect(res.prompt.fieldOrigin.triggerEvent).toBe('locked');
    expect(res.modelUsed).toBe('test-model');
  });
  it('reports missingTools for tool ids not in the registry', async () => {
    const res = await generateAgentPrompt({
      intent: 'screen resumes', locked: { triggerEvent: 'RESUME_PROCESSED' }, domain: 'raas',
    });
    // 'bogus-tool-not-in-registry' is in the LLM draft tools[] but not in the RAAS tool registry
    expect(res.missingTools).toContain('bogus-tool-not-in-registry');
  });
});
