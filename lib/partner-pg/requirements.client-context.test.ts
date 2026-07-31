import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('./client', () => ({ query: queryMock }));

import { getClientContext } from './requirements';

beforeEach(() => queryMock.mockReset());

describe('getClientContext — best-effort client enrichment for createJD (defensive)', () => {
  it('builds full context (anonymized descriptor + tech/welfare) when the rich columns exist', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          client_name: '字节跳动',
          industry_category: '金融科技',
          technical_stack_preference: 'Java/Spring Cloud/K8s',
          welfare_policy: '五险一金、年度体检',
        },
      ],
    });
    const ctx = await getClientContext('client-1');
    expect(ctx).not.toBeNull();
    expect(ctx!.client_name).toBe('字节跳动'); // real name kept for compliance scrub only
    expect(ctx!.company_descriptor).toBe('某金融科技行业知名企业'); // anonymized — safe to send
    expect(ctx!.technical_stack_preference).toBe('Java/Spring Cloud/K8s');
    expect(ctx!.welfare_policy).toBe('五险一金、年度体检');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to name-only when the rich query throws (columns not in this partner DB)', async () => {
    queryMock
      .mockRejectedValueOnce(new Error('column "industry_category" does not exist'))
      .mockResolvedValueOnce({ rows: [{ client_name: '字节跳动' }] });
    const ctx = await getClientContext('client-1');
    expect(ctx).not.toBeNull();
    expect(ctx!.client_name).toBe('字节跳动');
    expect(ctx!.company_descriptor).toBe('某知名企业'); // no industry → generic
    expect(ctx!.technical_stack_preference).toBeNull();
    expect(ctx!.welfare_policy).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('returns null (degrade to today) when even the name query fails', async () => {
    queryMock
      .mockRejectedValueOnce(new Error('no rich columns'))
      .mockRejectedValueOnce(new Error('client table unreachable'));
    expect(await getClientContext('client-1')).toBeNull();
  });

  it('does not query for a missing client id', async () => {
    expect(await getClientContext(null)).toBeNull();
    expect(await getClientContext('')).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
