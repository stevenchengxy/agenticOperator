import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./instance-client', () => ({
  getInstance: vi.fn(),
  listInstances: vi.fn(),
  listLinks: vi.fn(),
}));

import { getInstance, listInstances, listLinks } from './instance-client';
import { buildGraphContext, createDispatcher } from './graph-context';

const mGet = vi.mocked(getInstance);
const mListInst = vi.mocked(listInstances);
const mListLinks = vi.mocked(listLinks);

beforeEach(() => {
  mGet.mockReset();
  mListInst.mockReset();
  mListLinks.mockReset();
});

describe('buildGraphContext', () => {
  it('fetches all five slots in parallel', async () => {
    mGet.mockImplementation(async (label, _value) => {
      if (label === 'Candidate') return { candidate_id: 'C-1', name: '张三' };
      if (label === 'Job_Requisition') return { job_requisition_id: 'JR-1', title: 'BE' };
      return null;
    });
    mListInst.mockImplementation(async (label) => {
      if (label === 'Application') return [{ id: 'A-1' }];
      if (label === 'Blacklist') return [];
      return [];
    });
    mListLinks.mockResolvedValueOnce([{ linkId: 'L-1', type: 'EMPLOYED_BY', toId: 'E-1' }]);

    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });

    expect(ctx.candidate).toEqual({ candidate_id: 'C-1', name: '张三' });
    expect(ctx.job_requisition).toEqual({ job_requisition_id: 'JR-1', title: 'BE' });
    expect(ctx.applications).toEqual([{ id: 'A-1' }]);
    expect(ctx.blacklist_hits).toEqual([]);
    expect(ctx.employment_links).toHaveLength(1);
    expect(ctx.fetch_count).toBe(5);
  });

  it('records null slot when candidate is 404', async () => {
    mGet.mockImplementation(async (label) =>
      label === 'Candidate' ? null : { job_requisition_id: 'JR-1' },
    );
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    const ctx = await buildGraphContext({
      candidate_id: 'missing',
      job_requisition_id: 'JR-1',
    });
    expect(ctx.candidate).toBeNull();
    expect(ctx.job_requisition).not.toBeNull();
  });

  it('propagates 401 from getInstance (caller decides fail-safe)', async () => {
    mGet.mockImplementation(async () => {
      throw new Error('Ontology API getInstance(...) -> 401. Body: unauthorized');
    });
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    await expect(
      buildGraphContext({ candidate_id: 'C-1', job_requisition_id: 'JR-1' }),
    ).rejects.toThrow(/401/);
  });
});

describe('createDispatcher (tool-use loop dispatcher)', () => {
  it('returns pre-fetched candidate without re-calling fetch', async () => {
    mGet.mockResolvedValue({ candidate_id: 'C-1', name: '张三' });
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });
    const callCountBefore = mGet.mock.calls.length;

    const dispatch = createDispatcher(ctx);
    const out = await dispatch('get_instance', { label: 'Candidate', value: 'C-1' });
    expect(out).toEqual({ candidate_id: 'C-1', name: '张三' });
    expect(mGet.mock.calls.length).toBe(callCountBefore); // no extra fetch
  });

  it('calls instance-client on a cache miss', async () => {
    mGet.mockResolvedValueOnce({ candidate_id: 'C-1' }); // for buildGraphContext
    mGet.mockResolvedValueOnce({ job_requisition_id: 'JR-1' });
    mGet.mockResolvedValueOnce({ blacklist_id: 'B-99', candidate_id: 'C-1' }); // tool call
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });

    const dispatch = createDispatcher(ctx);
    const out = await dispatch('get_instance', { label: 'Blacklist', value: 'B-99' });
    expect(out).toEqual({ blacklist_id: 'B-99', candidate_id: 'C-1' });
  });

  it('dispatches list_instances + list_links and counts calls', async () => {
    mGet.mockResolvedValue(null);
    mListInst.mockResolvedValueOnce([]); // applications during build
    mListInst.mockResolvedValueOnce([]); // blacklist during build
    mListLinks.mockResolvedValueOnce([]); // employment during build
    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });

    mListInst.mockResolvedValueOnce([{ id: 'X' }]); // tool call
    mListLinks.mockResolvedValueOnce([{ linkId: 'L-1' }]); // tool call

    const dispatch = createDispatcher(ctx);
    expect(
      await dispatch('list_instances', { label: 'Foo', filters: { candidate_id: 'C-1' } }),
    ).toEqual([{ id: 'X' }]);
    expect(
      await dispatch('list_links', { from: 'C-1', type: 'RELATIVE_OF' }),
    ).toEqual([{ linkId: 'L-1' }]);
  });

  it('returns { error } when dispatched tool throws', async () => {
    mGet.mockResolvedValue(null);
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });

    mGet.mockRejectedValueOnce(new Error('Ontology API getInstance(Foo, x) -> 500. Body: boom'));
    const dispatch = createDispatcher(ctx);
    const out = await dispatch('get_instance', { label: 'Foo', value: 'x' });
    expect(out).toMatchObject({ error: expect.stringContaining('500') });
  });

  it('throws on unknown tool name', async () => {
    mGet.mockResolvedValue(null);
    mListInst.mockResolvedValue([]);
    mListLinks.mockResolvedValue([]);
    const ctx = await buildGraphContext({
      candidate_id: 'C-1',
      job_requisition_id: 'JR-1',
    });
    const dispatch = createDispatcher(ctx);
    await expect(dispatch('not_a_real_tool', {})).rejects.toThrow(/unknown tool/);
  });
});
