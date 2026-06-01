// rule-check-agent.test.ts — unit tests for the post-consolidation ruleCheckAgent.
//
// 2026-05-19: trigger 改为 RESUME_PROCESSED;吸收原 matchResume 1st seg
// (F1 回拉 + JR 列表收敛 + per-JR rule-check + persist + emit
// MATCH_RULE_CHECK_PASSED / MATCH_RULE_CHECK_FAILED)。
//
// 2026-06-01: harness repaired — agent reads from partner-pg (not raas-api-client)
// and mirrors to Neo4j via allmeta. Added infra-failure coverage: an
// infrastructure failSafe FAIL (LLM gateway/parse/graph) must NOT reject the
// candidate — it throws to retry, never writes 未通过 to partner / Neo4j and
// never emits MATCH_RULE_CHECK_FAILED.
//
// Pattern: import handler function directly, mock step.run/sendEvent + the
// rule-check lib + partner-pg + allmeta writers.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the inngest client so importing the agent module doesn't try to
// register a real function.
vi.mock('@/server/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })),
  },
}));

vi.mock('@/lib/rule-check', () => ({
  buildRuleCheckInput: vi.fn((x: unknown) => x),
  runRuleCheck: vi.fn(),
}));

vi.mock('@/lib/rule-check/ontology', () => ({
  extractDims: vi.fn(),
  severityForRuleId: vi.fn(() => 'flag_only'),
}));

// Allmeta (Neo4j) writers — HTTP side-effects; stub to no-op success.
vi.mock('@/lib/allmeta-writers', () => ({
  writeJobRequisitionInstance: vi.fn(async () => ({ ok: true })),
  writeCandidateMatchResultInstance: vi.fn(async () => ({ ok: true })),
}));

// Prisma — audit + flag persistence is soft-fail; stub the methods used.
vi.mock('@/server/db', () => ({
  prisma: {
    ruleCheckAudit: { create: vi.fn(async () => ({})) },
    ruleCheckFlag: { createMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

// The agent reads candidate/JR/resume data from partner Postgres modules and
// persists rule-check FAILs there. Mock each so no real DB is touched and we
// can assert on the partner-write call.
vi.mock('@/lib/partner-pg/client', () => ({
  isPartnerPgConfigured: vi.fn(() => true),
}));
vi.mock('@/lib/partner-pg/requirements', () => ({
  getRequirementDetail: vi.fn(),
}));
vi.mock('@/lib/partner-pg/agent-view', () => ({
  getRequirementsAgentView: vi.fn(),
}));
vi.mock('@/lib/partner-pg/recruiting-jobs', () => ({
  getRecruitingJobsAsRequirements: vi.fn(async () => ({ items: [] })),
}));
vi.mock('@/lib/partner-pg/parsed-resume', () => ({
  getParsedResume: vi.fn(),
}));
vi.mock('@/lib/partner-pg/rule-check-result', () => ({
  saveRuleCheckFailToPartnerPg: vi.fn(async () => ({
    candidate_match_result_id: 'cmr_test',
    created: true,
    job_posting_id: null,
  })),
}));

import { ruleCheckAgentHandler } from './rule-check-agent';
import { runRuleCheck } from '@/lib/rule-check';
import { extractDims } from '@/lib/rule-check/ontology';
import { getParsedResume } from '@/lib/partner-pg/parsed-resume';
import { getRequirementDetail } from '@/lib/partner-pg/requirements';
import { getRecruitingJobsAsRequirements } from '@/lib/partner-pg/recruiting-jobs';
import { saveRuleCheckFailToPartnerPg } from '@/lib/partner-pg/rule-check-result';
import { writeCandidateMatchResultInstance } from '@/lib/allmeta-writers';

const mockRunRuleCheck = runRuleCheck as ReturnType<typeof vi.fn>;
const mockExtractDims = extractDims as ReturnType<typeof vi.fn>;
const mockGetParsedResume = getParsedResume as ReturnType<typeof vi.fn>;
const mockGetRequirementDetail = getRequirementDetail as ReturnType<typeof vi.fn>;
const mockGetRecruitingJobs = getRecruitingJobsAsRequirements as ReturnType<typeof vi.fn>;
const mockSavePartnerFail = saveRuleCheckFailToPartnerPg as ReturnType<typeof vi.fn>;
const mockWriteCmr = writeCandidateMatchResultInstance as ReturnType<typeof vi.fn>;

// Helper: build a minimal RESUME_PROCESSED event payload (thin variant).
// Path A: job_requisition_id set → getRequirementDetail.
// Path B: job_requisition_id null → getRecruitingJobsAsRequirements.
function thinEvt(over: Record<string, unknown> = {}) {
  return {
    name: 'RESUME_PROCESSED',
    data: {
      upload_id: 'U1',
      candidate_id: 'C1',
      resume_id: 'R1',
      employee_id: 'EMP_TEST',
      filename: '【后端工程师】张三.pdf',
      // parsed.data 故意缺失 → 触发 F1 回拉
      job_requisition_id: null, // path B
      ...over,
    },
  };
}

function thickEvt(over: Record<string, unknown> = {}) {
  return {
    name: 'RESUME_PROCESSED',
    data: {
      upload_id: 'U1',
      candidate_id: 'C1',
      resume_id: 'R1',
      employee_id: 'EMP_TEST',
      filename: 'resume.pdf',
      parsed: { data: { name: 'John', skills: ['typescript'] } },
      job_requisition_id: null,
      ...over,
    },
  };
}

function mockStep() {
  const sent: Array<{ name: string; data: any }> = [];
  const ranSteps: string[] = [];
  return {
    sent,
    ranSteps,
    run: async (id: string, fn: () => Promise<unknown>) => {
      ranSteps.push(id);
      return await fn();
    },
    sendEvent: async (_id: string, e: { name: string; data: any }) => {
      sent.push(e);
    },
  };
}

const mockLogger = { info: () => {}, warn: () => {}, error: () => {} };

const sampleReq = {
  job_requisition_id: 'JR1',
  client_id: 'CLI_TENCENT',
  client_job_title: '后端工程师',
  status: 'recruiting',
  must_have_skills: ['typescript', 'go'],
  job_responsibility: '写后端',
};

// partner-pg getRequirementDetail returns the requirement row flattened with a
// nested `.specification`; the agent merges them. Build that shape from a req.
function detailOf(req: Record<string, unknown>) {
  return { ...req, specification: {} };
}

const passResult = {
  decision: 'PASS',
  stats: { total: 5, pass: 5, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
  rule_results: [],
  explanations: [],
  audit: { rules_evaluated: 5, graph_calls: 6, llm_model: 'gemini', llm_duration_ms: 1, llm_round_trips: 0, rule_source: 'json-fallback' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractDims.mockReturnValue({ client_id: '腾讯', business_group: null, studio: null });
});

describe('ruleCheckAgent — path A (linked job_requisition_id)', () => {
  it('fetches single JR via getRequirementDetail, emits MATCH_RULE_CHECK_PASSED on PASS', async () => {
    mockGetRequirementDetail.mockResolvedValue(detailOf(sampleReq));
    mockGetParsedResume.mockResolvedValue({ data: { name: 'John' }, parsed_content: null });
    mockRunRuleCheck.mockResolvedValue(passResult as any);

    const step = mockStep();
    await ruleCheckAgentHandler({
      event: thinEvt({ job_requisition_id: 'JR1' }) as any,
      step: step as any,
      logger: mockLogger as any,
    });

    // path A → getRequirementDetail(linkedJrId);不走 path-B recruiting lookup
    expect(mockGetRequirementDetail).toHaveBeenCalledWith('JR1');
    expect(mockGetRecruitingJobs).not.toHaveBeenCalled();

    // F1 thin 回拉
    expect(mockGetParsedResume).toHaveBeenCalledWith('C1', 'R1');

    // emit 唯一 PASS 事件
    expect(step.sent).toHaveLength(1);
    expect(step.sent[0].name).toBe('MATCH_RULE_CHECK_PASSED');
    expect(step.sent[0].data.job_requisition_id).toBe('JR1');
    expect(step.sent[0].data.parsed_resume).toEqual({ name: 'John' });
    expect(step.sent[0].data.job_requisition).toMatchObject({ job_requisition_id: 'JR1' });
  });
});

describe('ruleCheckAgent — path B (no linked JR)', () => {
  it('fetches recruiting JRs via getRecruitingJobsAsRequirements + filename, fans out per JR', async () => {
    const jr1 = { ...sampleReq, job_requisition_id: 'JR1' };
    const jr2 = { ...sampleReq, job_requisition_id: 'JR2', client_id: 'CLI_BYTEDANCE' };
    mockGetRecruitingJobs.mockResolvedValue({ items: [jr1, jr2] });
    mockGetParsedResume.mockResolvedValue({ data: { name: 'John' }, parsed_content: null });
    mockRunRuleCheck.mockResolvedValue(passResult as any);

    const step = mockStep();
    await ruleCheckAgentHandler({ event: thinEvt() as any, step: step as any, logger: mockLogger as any });

    // path B → recruiting-jobs lookup,带 resumeFilename
    expect(mockGetRecruitingJobs).toHaveBeenCalledWith({
      claimerEmployeeId: 'EMP_TEST',
      resumeFilename: '【后端工程师】张三.pdf',
    });
    expect(mockGetRequirementDetail).not.toHaveBeenCalled();

    // 两条 JR 各 emit 一次
    expect(step.sent).toHaveLength(2);
    expect(step.sent.map((e) => e.name)).toEqual([
      'MATCH_RULE_CHECK_PASSED',
      'MATCH_RULE_CHECK_PASSED',
    ]);
  });
});

describe('ruleCheckAgent — F1 thick event compat', () => {
  it('skips back-pull when event.data.parsed.data is present', async () => {
    mockGetRequirementDetail.mockResolvedValue(detailOf(sampleReq));
    mockRunRuleCheck.mockResolvedValue({
      ...passResult,
      stats: { total: 1, pass: 1, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      audit: { ...passResult.audit, rules_evaluated: 1, graph_calls: 0 },
    } as any);

    const step = mockStep();
    await ruleCheckAgentHandler({
      event: thickEvt({ job_requisition_id: 'JR1' }) as any,
      step: step as any,
      logger: mockLogger as any,
    });

    expect(mockGetParsedResume).not.toHaveBeenCalled();
    expect(step.sent[0].data.parsed_resume).toEqual({ name: 'John', skills: ['typescript'] });
  });
});

describe('ruleCheckAgent — decision branches', () => {
  it('emits MATCH_RULE_CHECK_FAILED + writes partner/Neo4j on a REAL rule violation (no fail_reason)', async () => {
    mockGetRequirementDetail.mockResolvedValue(detailOf(sampleReq));
    mockGetParsedResume.mockResolvedValue({ data: { name: 'John' }, parsed_content: null });
    mockRunRuleCheck.mockResolvedValue({
      decision: 'FAIL',
      stats: { total: 5, pass: 4, fail: 1, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [],
      explanations: [
        { rule_id: '10-5', rule_name: 'degree', step_id: 'STEP1', status: 'fail', reason: 'no degree' },
      ],
      // NOTE: no audit.fail_reason → genuine violation, not an infra failure
      audit: { rules_evaluated: 5, graph_calls: 6, llm_model: 'gemini', llm_duration_ms: 1, llm_round_trips: 0, rule_source: 'json-fallback' },
    } as any);

    const step = mockStep();
    await ruleCheckAgentHandler({
      event: thinEvt({ job_requisition_id: 'JR1' }) as any,
      step: step as any,
      logger: mockLogger as any,
    });

    expect(step.sent).toHaveLength(1);
    expect(step.sent[0].name).toBe('MATCH_RULE_CHECK_FAILED');
    expect(step.sent[0].data.success).toBe(false);
    expect(step.sent[0].data.matching_score).toBeNull();
    expect(step.sent[0].data.job_requisition_id).toBe('JR1');
    expect(step.sent[0].data.candidate_id).toBe('C1');
    expect(step.sent[0].data.upload_id).toBe('U1');

    // a real violation DOES persist 未通过 to partner + Neo4j
    expect(mockSavePartnerFail).toHaveBeenCalledTimes(1);
    expect(mockWriteCmr).toHaveBeenCalledWith(
      expect.objectContaining({ rule_check_result: '未通过', job_requisition_id: 'JR1' }),
    );
  });

  it('emits MATCH_RULE_CHECK_PASSED on REVIEW (放行 policy 2026-05-20)', async () => {
    // Policy: REVIEW (rules need HSM review but no actual violation) folds
    // to PASS event so workflow continues; HSM reviews via /rule-check UI.
    mockGetRequirementDetail.mockResolvedValue(detailOf(sampleReq));
    mockGetParsedResume.mockResolvedValue({ data: { name: 'John' }, parsed_content: null });
    mockRunRuleCheck.mockResolvedValue({
      decision: 'REVIEW',
      stats: { total: 5, pass: 4, fail: 0, pending: 1, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [],
      explanations: [
        { rule_id: '10-21', rule_name: 'age', step_id: 'S2', status: 'pending', reason: 'needs HSM review' },
      ],
      audit: { rules_evaluated: 5, graph_calls: 6, llm_model: 'gemini', llm_duration_ms: 1, llm_round_trips: 0, rule_source: 'json-fallback' },
    } as any);

    const step = mockStep();
    await ruleCheckAgentHandler({
      event: thinEvt({ job_requisition_id: 'JR1' }) as any,
      step: step as any,
      logger: mockLogger as any,
    });

    expect(step.sent[0].name).toBe('MATCH_RULE_CHECK_PASSED');
  });
});

describe('ruleCheckAgent — infra failure does NOT reject the candidate', () => {
  // The production incident (2026-06-01): LLM gateway 401 made failSafe return
  // decision='FAIL' with audit.fail_reason='llm-call-error', which used to write
  // 未通过 to the partner main table + emit MATCH_RULE_CHECK_FAILED — falsely
  // rejecting every candidate. Infra failures must instead throw (Inngest
  // retries; on exhaustion the run parks for replay), touching no downstream.
  for (const reason of [
    'llm-call-error',
    'gateway-unavailable',
    'ontology-graph-unavailable',
    'tool-use-loop-exceeded',
    'parse-error',
  ]) {
    it(`throws (retry/park) on infra failSafe FAIL (${reason}) — no partner write, no Neo4j write, no FAILED emit`, async () => {
      mockGetRequirementDetail.mockResolvedValue(detailOf(sampleReq));
      mockGetParsedResume.mockResolvedValue({ data: { name: 'John' }, parsed_content: null });
      mockRunRuleCheck.mockResolvedValue({
        decision: 'FAIL',
        stats: { total: 0, pass: 0, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
        rule_results: [],
        explanations: [], // failSafe → no per-rule violations
        audit: {
          rules_evaluated: 4,
          graph_calls: 0,
          llm_model: 'unknown',
          llm_duration_ms: 0,
          llm_round_trips: 0,
          rule_source: 'ontology-api',
          fail_reason: reason, // ← infrastructure failure
        },
      } as any);

      const step = mockStep();
      await expect(
        ruleCheckAgentHandler({
          event: thinEvt({ job_requisition_id: 'JR1' }) as any,
          step: step as any,
          logger: mockLogger as any,
        }),
      ).rejects.toThrow(/infra/i);

      // candidate must NOT be rejected anywhere downstream
      expect(mockSavePartnerFail).not.toHaveBeenCalled();
      expect(mockWriteCmr).not.toHaveBeenCalled();
      expect(step.sent.find((e) => e.name === 'MATCH_RULE_CHECK_FAILED')).toBeUndefined();
      expect(step.sent.find((e) => e.name === 'MATCH_RULE_CHECK_PASSED')).toBeUndefined();
    });
  }
});

describe('ruleCheckAgent — bypass', () => {
  it('skips runRuleCheck and emits MATCH_RULE_CHECK_PASSED directly when RULE_CHECK_BYPASS=true', async () => {
    process.env.RULE_CHECK_BYPASS = 'true';
    try {
      mockGetRequirementDetail.mockResolvedValue(detailOf(sampleReq));
      mockGetParsedResume.mockResolvedValue({ data: { name: 'John' }, parsed_content: null });

      const step = mockStep();
      await ruleCheckAgentHandler({
        event: thinEvt({ job_requisition_id: 'JR1' }) as any,
        step: step as any,
        logger: mockLogger as any,
      });

      expect(mockRunRuleCheck).not.toHaveBeenCalled();
      expect(step.sent).toHaveLength(1);
      expect(step.sent[0].name).toBe('MATCH_RULE_CHECK_PASSED');
      expect(step.sent[0].data.audit.llm_model).toBe('bypass');
    } finally {
      delete process.env.RULE_CHECK_BYPASS;
    }
  });
});

describe('ruleCheckAgent — empty JR list', () => {
  it('returns early when recruiter has no published claimed JR', async () => {
    mockGetRecruitingJobs.mockResolvedValue({ items: [] });

    const step = mockStep();
    const r = await ruleCheckAgentHandler({
      event: thinEvt() as any,
      step: step as any,
      logger: mockLogger as any,
    });

    expect(r).toMatchObject({ ok: true, requested_count: 0, reason: 'no-published-jr-claimed-by-recruiter' });
    expect(mockGetParsedResume).not.toHaveBeenCalled();
    expect(mockRunRuleCheck).not.toHaveBeenCalled();
    expect(step.sent).toHaveLength(0);
  });
});
