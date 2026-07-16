import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiTimeoutError, fetchJson } from './client';

describe('fetchJson', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

  it('returns parsed JSON on 200', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ a: 1 }),
    });
    const out = await fetchJson<{ a: number }>('/api/runs');
    expect(out.a).toBe(1);
  });

  it('throws structured ApiError on 4xx with JSON body', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'BAD_REQUEST', message: 'x', field: 'y' }),
    });
    await expect(fetchJson('/api/runs')).rejects.toMatchObject({
      error: 'BAD_REQUEST',
      field: 'y',
    });
  });

  it('throws fallback ApiError on 4xx without JSON body', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal',
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(fetchJson('/api/runs')).rejects.toMatchObject({
      error: 'INTERNAL',
      message: 'Internal',
    });
  });

  it('uses custom timeoutMs for AbortSignal without forwarding it to fetch', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ a: 1 }),
    });
    await fetchJson<{ a: number }>('/api/runs', { timeoutMs: 12_000 });
    expect(timeoutSpy).toHaveBeenCalledWith(12_000);
    const init = (fetch as any).mock.calls[0][1];
    expect(init.timeoutMs).toBeUndefined();
    expect(init.signal).toBeDefined();
  });

  it('throws ApiTimeoutError when fetch is aborted by the timeout signal', async () => {
    (fetch as any).mockRejectedValueOnce({ name: 'TimeoutError' });
    await expect(fetchJson('/api/runs')).rejects.toBeInstanceOf(ApiTimeoutError);
  });
});
