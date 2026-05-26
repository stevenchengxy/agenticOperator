import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every SQL the writer runs inside withTx.
const queries: Array<{ text: string; params: unknown[] }> = [];
let existingRow: Record<string, unknown> | undefined;
let postingRow: Record<string, unknown> | undefined;

vi.mock('./client', () => ({
  withTx: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => {
    const client = {
      query: vi.fn(async (text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM job_posting/i.test(text)) {
          return { rows: postingRow ? [postingRow] : [] };
        }
        if (/SELECT[\s\S]*FROM candidate_match_result\b/i.test(text)) {
          return { rows: existingRow ? [existingRow] : [] };
        }
        return { rows: [] };
      }),
    };
    return fn(client);
  }),
}));

import { saveRuleCheckFailToPartnerPg } from './rule-check-result';

beforeEach(() => {
  queries.length = 0;
  existingRow = undefined;
  postingRow = undefined;
});

const baseItem = {
  candidate_match_result_id: 'cmr_cand1_JR1',
  candidate_id: 'cand1',
  job_requisition_id: 'JR1',
  client_id: 'CLI',
  match_reason: '[10-42] CDG冷冻期: 命中',
};

describe('saveRuleCheckFailToPartnerPg', () => {
  it('INSERTs a 未通过 row when none exists, regardless of job_posting', async () => {
    existingRow = undefined; // no existing CMR
    postingRow = undefined; // no job_posting either
    const r = await saveRuleCheckFailToPartnerPg(baseItem);

    expect(r.created).toBe(true);
    const insert = queries.find((q) => /INSERT INTO candidate_match_result\b/i.test(q.text));
    expect(insert, 'should INSERT the main candidate_match_result row even with no posting').toBeTruthy();
    // match_status='未通过', match_reason carried, match_score null
    expect(insert!.params).toContain('未通过');
    expect(insert!.params).toContain(baseItem.match_reason);
  });

  it('UPDATEs the existing row to 未通过 instead of inserting', async () => {
    existingRow = { candidate_match_result_id: 'cmr_cand1_JR1' };
    const r = await saveRuleCheckFailToPartnerPg(baseItem);

    expect(r.created).toBe(false);
    const update = queries.find((q) => /UPDATE candidate_match_result\b/i.test(q.text));
    expect(update).toBeTruthy();
    expect(update!.params).toContain('未通过');
    expect(queries.find((q) => /INSERT INTO candidate_match_result\b/i.test(q.text))).toBeFalsy();
  });

  it('does NOT touch runtime_state (lean writer, no score machinery)', async () => {
    await saveRuleCheckFailToPartnerPg(baseItem);
    expect(
      queries.find((q) => /candidate_match_result_runtime_state/i.test(q.text)),
    ).toBeFalsy();
  });
});
