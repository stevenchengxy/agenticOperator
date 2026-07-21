import { afterEach, describe, expect, it, vi } from 'vitest';

const originalFetch = global.fetch;

describe('inngest-admin-client URL resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('resolves INNGEST_BASE_URL at call time instead of caching import-time env', async () => {
    vi.resetModules();
    vi.stubEnv('INNGEST_BASE_URL', 'http://first-inngest:8288/');

    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              apps: [
                {
                  name: 'agentic-operator-main',
                  connected: true,
                  functionCount: 6,
                  sdkVersion: 'test',
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      ),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { listApps } = await import('./inngest-admin-client');

    await listApps();
    vi.stubEnv('INNGEST_BASE_URL', 'http://second-inngest:9292');
    await listApps();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      'http://first-inngest:8288/v0/gql',
      'http://second-inngest:9292/v0/gql',
    ]);
  });
});
