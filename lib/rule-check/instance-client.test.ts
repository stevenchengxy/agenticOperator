import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInstance, listInstances, listLinks } from './instance-client';

describe('instance-client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.ALLMETA_BASE_URL = 'http://localhost:3500';
    process.env.ALLMETA_API_KEY = 'test-token';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getInstance', () => {
    it('GETs /instances/{label}/{value}?domain=招聘-v1 with Bearer auth', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ candidate_id: 'C-100023', name: '张三' }),
      });
      const out = await getInstance('Candidate', 'C-100023');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3500/api/v1/ontology/instances/Candidate/C-100023?domain=招聘-v1',
        { headers: { Authorization: 'Bearer test-token' } },
      );
      expect(out).toEqual({ candidate_id: 'C-100023', name: '张三' });
    });

    it('returns null on 404', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not-found' });
      expect(await getInstance('Candidate', 'missing')).toBeNull();
    });

    it('throws on 401', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' });
      await expect(getInstance('Candidate', 'x')).rejects.toThrow(/401/);
    });

    it('throws on 502', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'neo4j-unavailable' });
      await expect(getInstance('Candidate', 'x')).rejects.toThrow(/502/);
    });
  });

  describe('listInstances', () => {
    it('GETs /instances/{label}?domain=招聘-v1&<filters> and returns items array', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 'A-1' }, { id: 'A-2' }],
          nextCursor: null,
        }),
      });
      const out = await listInstances('Application', { candidate_id: 'C-100023' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3500/api/v1/ontology/instances/Application?domain=招聘-v1&candidate_id=C-100023',
        { headers: { Authorization: 'Bearer test-token' } },
      );
      expect(out).toEqual([{ id: 'A-1' }, { id: 'A-2' }]);
    });

    it('URL-encodes filter values', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      });
      await listInstances('Application', { client: '腾讯' });
      const calledWith = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledWith).toContain('client=' + encodeURIComponent('腾讯'));
    });

    it('returns [] on 404', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not-found' });
      expect(await listInstances('Application', { candidate_id: 'x' })).toEqual([]);
    });
  });

  describe('listLinks', () => {
    it('GETs /links?domain=招聘-v1&<filters> and returns items array', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { linkId: 'l1', type: 'EMPLOYED_BY', fromId: 'C-1', toId: 'E-1' },
          ],
        }),
      });
      const out = await listLinks({ from: 'C-1', type: 'EMPLOYED_BY' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3500/api/v1/ontology/links?domain=招聘-v1&from=C-1&type=EMPLOYED_BY',
        { headers: { Authorization: 'Bearer test-token' } },
      );
      expect(out).toHaveLength(1);
    });

    it('returns [] on 404', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not-found' });
      expect(await listLinks({ from: 'C-1' })).toEqual([]);
    });

    it('throws on 401', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized' });
      await expect(listLinks({ from: 'C-1' })).rejects.toThrow(/401/);
    });
  });

  describe('config errors', () => {
    it('throws if ALLMETA_BASE_URL is missing', async () => {
      delete process.env.ALLMETA_BASE_URL;
      await expect(getInstance('Candidate', 'x')).rejects.toThrow(/ALLMETA_BASE_URL/);
    });

    it('throws if ALLMETA_API_KEY is missing', async () => {
      delete process.env.ALLMETA_API_KEY;
      await expect(getInstance('Candidate', 'x')).rejects.toThrow(/ALLMETA_API_KEY/);
    });
  });
});
