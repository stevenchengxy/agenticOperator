import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/rule-check/runner', () => ({
  runRuleCheck: vi.fn(),
  buildRuleCheckInput: vi.fn((args) => ({
    runtime_context: args.runtime_context,
    job_requisition: args.job_requisition,
    job_requisition_specification: null,
    hsm_feedback: null,
  })),
}));

vi.mock('@/lib/rule-check/ontology-source', () => ({
  fetchRulesForMatchResume: vi.fn(),
}));

vi.mock('@/server/db', () => ({
  prisma: {
    ruleCheckRun: {
      create: vi.fn(),
      update: vi.fn(),
    },
    ruleCheckScenarioResult: {
      upsert: vi.fn(),
    },
  },
}));

import { runRuleCheck } from '@/lib/rule-check/runner';
import { fetchRulesForMatchResume } from '@/lib/rule-check/ontology-source';
import { prisma } from '@/server/db';
import { streamRuleCheckRun } from './runs-service';

const mRun = vi.mocked(runRuleCheck);
const mFetchRules = vi.mocked(fetchRulesForMatchResume);
const mPrismaCreate = vi.mocked(prisma.ruleCheckRun.create);
const mPrismaUpdate = vi.mocked(prisma.ruleCheckRun.update);
const mUpsert = vi.mocked(prisma.ruleCheckScenarioResult.upsert);

const passingResult = {
  decision: 'PASS' as const,
  stats: { total: 0, pass: 0, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
  rule_results: [],
  explanations: [],
  graph_context: {
    candidate: null, resume: null, job_requisition: null,
    applications: [], blacklist_hits: [], employment_links: [],
    fetch_count: 0, _cache: new Map(),
  },
  audit: {
    rules_evaluated: 0, graph_calls: 0, llm_model: 'm', llm_duration_ms: 1000,
    llm_round_trips: 0, rule_source: 'ontology-api' as const,
  },
};

beforeEach(() => {
  mRun.mockReset(); mFetchRules.mockReset();
  mPrismaCreate.mockReset(); mPrismaUpdate.mockReset(); mUpsert.mockReset();
  mPrismaCreate.mockResolvedValue({ id: 'run-1' } as never);
  mPrismaUpdate.mockResolvedValue({ id: 'run-1' } as never);
  mUpsert.mockResolvedValue({ id: 'res-1' } as never);
  mFetchRules.mockResolvedValue({ rules: [], steps: [], source: 'ontology-api' });
});

afterEach(() => { vi.clearAllMocks(); });

describe('streamRuleCheckRun', () => {
  it('emits started, one result per scenario, and done', async () => {
    mRun.mockResolvedValue(passingResult);
    const events: unknown[] = [];
    for await (const e of streamRuleCheckRun({ scenario_ids: ['S01', 'S02'] })) {
      events.push(e);
    }
    expect((events[0] as { type: string }).type).toBe('started');
    expect((events[1] as { type: string }).type).toBe('result');
    expect((events[2] as { type: string }).type).toBe('result');
    expect((events[3] as { type: string }).type).toBe('done');
    expect(mUpsert).toHaveBeenCalledTimes(2);
  });

  it('emits error event when scenario runner throws', async () => {
    mRun.mockRejectedValueOnce(new Error('gateway-fire'));
    const events: unknown[] = [];
    for await (const e of streamRuleCheckRun({ scenario_ids: ['S01'] })) {
      events.push(e);
    }
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain('error');
    expect(mPrismaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'error' }) }),
    );
  });

  it('respects abort signal mid-stream', async () => {
    mRun.mockResolvedValue(passingResult);
    const ac = new AbortController();
    const events: unknown[] = [];
    let count = 0;
    for await (const e of streamRuleCheckRun({ scenario_ids: ['S01', 'S02', 'S03'], signal: ac.signal })) {
      events.push(e);
      count++;
      if (count === 2) ac.abort();  // abort after 'started' + first 'result'
    }
    expect(events[events.length - 1]).toMatchObject({ type: 'error' });
  });
});
