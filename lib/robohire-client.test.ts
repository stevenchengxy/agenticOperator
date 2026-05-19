import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseResumeDirect,
  matchResumeDirect,
  RobohireApiError,
} from './robohire-client';

const env = {
  ROBOHIRE_API_BASE_URL: 'https://api.robohire.io',
  ROBOHIRE_API_KEY: 'rh_test_key',
  ROBOHIRE_TIMEOUT_MS: '120000',
};

beforeEach(() => {
  Object.assign(process.env, env);
  vi.restoreAllMocks();
});

describe('parseResumeDirect', () => {
  it('returns parsed data on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { name: 'John', skills: ['React'] },
          cached: false,
          requestId: 'req_abc',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await parseResumeDirect(Buffer.from('%PDF-1.4'), 'r.pdf');
    expect(r.data.name).toBe('John');
    expect(r.requestId).toBe('req_abc');
    expect(r.cached).toBe(false);
  });

  it('throws RobohireApiError with CLIENT code on 400', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: 'PDF required', requestId: 'req_xyz' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(parseResumeDirect(Buffer.from(''), 'r.pdf')).rejects.toMatchObject({
      httpStatus: 400,
      code: 'CLIENT',
      requestId: 'req_xyz',
    });
  });

  it('throws RobohireApiError with RATE_LIMITED on 429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429 }),
    );
    await expect(parseResumeDirect(Buffer.from('%PDF'), 'r.pdf')).rejects.toMatchObject({
      httpStatus: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('throws QUOTA_EXHAUSTED on 402', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'quota exhausted' }), { status: 402 }),
    );
    await expect(parseResumeDirect(Buffer.from('%PDF'), 'r.pdf')).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
    });
  });

  it('passes X-Trace-Id header when opts.traceId set', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: {}, cached: true, requestId: 'r' })));
    await parseResumeDirect(Buffer.from('%PDF'), 'r.pdf', { traceId: 'trace-123' });
    const init = (fetchSpy.mock.calls[0][1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>)['X-Trace-Id']).toBe('trace-123');
  });
});

describe('matchResumeDirect', () => {
  it('returns match data on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { matchScore: 87, recommendation: 'STRONG_MATCH', summary: 'good' },
          requestId: 'req_match_123',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await matchResumeDirect({ resume: 'resume text', jd: 'jd text' });
    expect(r.data.matchScore).toBe(87);
    expect(r.data.recommendation).toBe('STRONG_MATCH');
  });

  it('serializes resume + jd as JSON body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: { matchScore: 50, recommendation: 'PARTIAL_MATCH' }, requestId: 'r' })));
    await matchResumeDirect({ resume: 'R', jd: 'J' });
    const body = JSON.parse(((fetchSpy.mock.calls[0][1]?.body as string) ?? '{}'));
    expect(body).toEqual({ resume: 'R', jd: 'J' });
  });
});

describe('RobohireApiError', () => {
  it('isClientError true for 4xx (excluding 429)', () => {
    expect(new RobohireApiError(400, 'CLIENT', 'x').isClientError).toBe(true);
    expect(new RobohireApiError(429, 'RATE_LIMITED', 'x').isClientError).toBe(false);
    expect(new RobohireApiError(500, 'SERVER', 'x').isClientError).toBe(false);
  });
});
