import { describe, it, expect } from 'vitest';
import { renderHttpClient } from './render-http-client';
import type { LibraryFormFields, LibraryGenerationOutput } from '../lib-spec-types';

const FORM: LibraryFormFields = {
  name: 'demo-client',
  description: 'demo',
  baseUrl: 'https://example.com',
  authStyle: 'bearer',
  envVarsRequired: ['DEMO_BASE_URL', 'DEMO_API_KEY'],
};

function makeOutput(returnType: string): LibraryGenerationOutput {
  return {
    methods: [
      {
        name: 'invite',
        description: 'send invite',
        httpVerb: 'POST',
        httpPath: '/api/v1/invite',
        body: `const url = requestUrl('/api/v1/invite');
const res = await fetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(params) });
if (!res.ok) throw new ClientApiError(res.status, await res.text());
return (await res.json()) as InviteResponse;`,
        paramsType: '{ candidate_email: string }',
        returnType,
      },
    ],
    sharedTypes: [
      { name: 'InviteResponse', tsDefinition: 'export type InviteResponse = { success: boolean };' },
    ],
  };
}

describe('renderHttpClient — TS1064 guard (regression for 2026-05-25 issue)', () => {
  it('wraps a bare type returnType in Promise<>', () => {
    const r = renderHttpClient({ form: FORM, output: makeOutput('InviteResponse') });
    expect(r.content).toContain(
      'export async function invite(params: { candidate_email: string }): Promise<InviteResponse>',
    );
    // And the bare form must NOT appear (would be a TS1064 in tsc).
    expect(r.content).not.toMatch(/: InviteResponse \{/);
  });

  it('leaves an already-wrapped Promise<T> alone (no double-wrap)', () => {
    const r = renderHttpClient({ form: FORM, output: makeOutput('Promise<InviteResponse>') });
    expect(r.content).toContain('Promise<InviteResponse>');
    expect(r.content).not.toContain('Promise<Promise<');
  });

  it('handles complex generic returnType', () => {
    const r = renderHttpClient({
      form: FORM,
      output: makeOutput('{ data: InviteResponse; requestId: string }'),
    });
    expect(r.content).toContain(
      'Promise<{ data: InviteResponse; requestId: string }>',
    );
  });

  it('trims whitespace before wrapping', () => {
    const r = renderHttpClient({ form: FORM, output: makeOutput('  InviteResponse  ') });
    expect(r.content).toContain('Promise<InviteResponse>');
  });
});
