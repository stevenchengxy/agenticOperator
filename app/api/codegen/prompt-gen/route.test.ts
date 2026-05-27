// route.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/agent-codegen/prompt-gen/prompt-gen', () => ({
  generateAgentPrompt: vi.fn().mockResolvedValue({
    prompt: { intent: 'x', role: 'r', trigger: { event: 'E', payloadExpectations: '', confirmed: false }, inputs: [], steps: [{ id: 's', description: 'd' }], tools: [], emits: [], errorHandling: 'retry', constraints: [], acceptance: [], fieldOrigin: {} },
    modelUsed: 'm', missingTools: [], durationMs: 1,
  }),
}));

import { POST } from './route';

function req(body: unknown) { return new Request('http://t/api/codegen/prompt-gen', { method: 'POST', body: JSON.stringify(body) }); }

describe('POST /api/codegen/prompt-gen', () => {
  it('400 on invalid body (missing intent)', async () => {
    const res = await POST(req({ domain: 'raas' }));
    expect(res.status).toBe(400);
  });
  it('200 + prompt on valid body', async () => {
    const res = await POST(req({ intent: 'screen resumes', domain: 'raas', locked: { triggerEvent: 'RESUME_PROCESSED' } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.prompt.intent).toBe('x');
    expect(json.modelUsed).toBe('m');
  });
  it('200 response includes missingTools field', async () => {
    const res = await POST(req({ intent: 'screen resumes', domain: 'raas' }));
    const json = await res.json();
    expect(Array.isArray(json.missingTools)).toBe(true);
  });
});
