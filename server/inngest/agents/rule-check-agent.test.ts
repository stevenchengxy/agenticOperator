// rule-check-agent.test.ts — unit tests for the post-consolidation ruleCheckAgent.
//
// 2026-05-19: trigger 改为 RESUME_PROCESSED;吸收原 matchResume 1st seg
// (F1 回拉 + JR 列表收敛 + per-JR rule-check + persist + emit
// MATCH_RULE_CHECK_PASSED / MATCH_RULE_CHECK_FAILED)。
//
// Pattern: import handler function directly, mock step.run/sendEvent + the
// rule-check lib + RAAS API client.

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
}));

vi.mock('@/lib/raas-api-client', () => ({
  isRaasApiConfigured: vi.fn(() => true),
  getParsedResume: vi.fn(),
  getRequirementDetail: vi.fn(),
  getRequirementsAgentView: vi.fn(),
  RaasApiError: class RaasApiError extends Error {
    constructor(public code: string, msg: string, public httpStatus: number = 500) {
      super(msg);
    }
    get isClientError() { return this.httpStatus >= 400 && this.httpStatus < 500 && this.httpStatus !== 429; }
  },
}));

import { ruleCheckAgentHandler } from './rule-check-agent';
import { runRuleCheck } from '@/lib/rule-check';
import { extractDims } from '@/lib/rule-check/ontology';
import {
  getParsedResume,
  getRequirementDetail,
  getRequirementsAgentView,
} from '@/lib/raas-api-client';

const mockRunRuleCheck = runRuleCheck as ReturnType<typeof vi.fn>;
const mockExtractDims = extractDims as ReturnType<typeof vi.fn>;
const mockGetParsedResume = getParsedResume as ReturnType<typeof vi.fn>;
const mockGetRequirementDetail = getRequirementDetail as ReturnType<typeof vi.fn>;
const mockGetRequirementsAgentView = getRequirementsAgentView as ReturnType<typeof vi.fn>;

// Helper: build a minimal RESUME_PROCESSED event payload (thin variant).
// Path A: job_requisition_id set → triggers getRequirementDetail.
// Path B: job_requisition_id null → triggers getRequirementsAgentView.
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

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractDims.mockReturnValue({ client_id: '腾讯', business_group: null, studio: null });
});

describe('ruleCheckAgent — path A (linked job_requisition_id)', () => {
  it('fetches single JR via getRequirementDetail, emits MATCH_RULE_CHECK_PASSED on PASS', async () => {
    mockGetRequirementDetail.mockResolvedValue({
      requirement: sampleReq,
      specification: {},
    });
    mockGetParsedResume.mockResolvedValue({ data: { name: 'John' } });
    mockRunRuleCheck.mockResolvedValue({
      decision: 'PASS',
      stats: { total: 5, pass: 5, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [],
      explanations: [],
      audit: {
        rules_evaluated: 5,
        graph_calls: 6,
        llm_model: 'gemini',
        llm_duration_ms: 1234,
        llm_round_trips: 0,
        rule_source: 'json-fallback',
      },
    } as any);

    const step = mockStep();
    await ruleCheckAgentHandler({
      event: thinEvt({ job_requisition_id: 'JR1' }) as any,
      step: step as any,
      logger: mockLogger as any,
    });

    // path A → 调 getRequirementDetail,不调 agent-view
    expect(mockGetRequirementDetail).toHaveBeenCalledWith('JR1', expect.any(Object));
    expect(mockGetRequirementsAgentView).not.toHaveBeenCalled();

    // F1 thin 回拉
    expect(mockGetParsedResume).toHaveBeenCalledWith('C1', 'R1', expect.any(Object));

    // emit 唯一 PASS 事件
    expect(step.sent).toHaveLength(1);
    expect(step.sent[0].name).toBe('MATCH_RULE_CHECK_PASSED');
    expect(step.sent[0].data.job_requisition_id).toBe('JR1');
    expect(step.sent[0].data.parsed_resume).toEqual({ name: 'John' });
    expect(step.sent[0].data.job_requisition).toMatchObject({ job_requisition_id: 'JR1' });
  });
});

describe('ruleCheckAgent — path B (no linked JR)', () => {
  it('fetches JR list via agent-view + filename, fans out per JR', async () => {
    const jr1 = { ...sampleReq, job_requisition_id: 'JR1' };
    const jr2 = { ...sampleReq, job_requisition_id: 'JR2', client_id: 'CLI_BYTEDANCE' };
    mockGetRequirementsAgentView.mockResolvedValue({ items: [jr1, jr2] });
    mockGetParsedResume.mockResolvedValue({ data: { name: 'John' } });
    mockRunRuleCheck.mockResolvedValue({
      decision: 'PASS',
      stats: { total: 5, pass: 5, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [],
      explanations: [],
      audit: { rules_evaluated: 5, graph_calls: 6, llm_model: 'gemini', llm_duration_ms: 1, llm_round_trips: 0, rule_source: 'json-fallback' },
    } as any);

    const step = mockStep();
    await ruleCheckAgentHandler({ event: thinEvt() as any, step: step as any, logger: mockLogger as any });

    // path B → agent-view 调用,带 resume_filename
    expect(mockGetRequirementsAgentView).toHaveBeenCalledWith(
      { claimer_employee_id: 'EMP_TEST', resume_filename: '【后端工程师】张三.pdf' },
      expect.any(Object),
    );
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
    mockGetRequirementDetail.mockResolvedValue({ requirement: sampleReq, specification: {} });
    mockRunRuleCheck.mockResolvedValue({
      decision: 'PASS',
      stats: { total: 1, pass: 1, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [],
      explanations: [],
      audit: { rules_evaluated: 1, graph_calls: 0, llm_model: 'gemini', llm_duration_ms: 1, llm_round_trips: 0, rule_source: 'json-fallback' },
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
  it('emits MATCH_RULE_CHECK_FAILED on FAIL', async () => {
    mockGetRequirementDetail.mockResolvedValue({ requirement: sampleReq, specification: {} });
    mockGetParsedResume.mockResolvedValue({ data: { name: 'John' } });
    mockRunRuleCheck.mockResolvedValue({
      decision: 'FAIL',
      stats: { total: 5, pass: 4, fail: 1, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [],
      explanations: [
        { rule_id: '10-5', rule_name: 'degree', step_id: 'STEP1', status: 'fail', reason: 'no degree' },
      ],
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
    expect(step.sent[0].data.data.rule_check_decision).toBe('FAIL');
    expect(step.sent[0].data.data.failed_rules).toHaveLength(1);
  });

  it('emits MATCH_RULE_CHECK_PASSED on REVIEW (放行 policy 2026-05-20)', async () => {
    // Policy: REVIEW (rules need HSM review but no actual violation) folds
    // to PASS event so workflow continues; HSM reviews via /rule-check UI.
    mockGetRequirementDetail.mockResolvedValue({ requirement: sampleReq, specification: {} });
    mockGetParsedResume.mockResolvedValue({ data: { name: 'John' } });
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

describe('ruleCheckAgent — bypass', () => {
  it('skips runRuleCheck and emits MATCH_RULE_CHECK_PASSED directly when RULE_CHECK_BYPASS=true', async () => {
    process.env.RULE_CHECK_BYPASS = 'true';
    try {
      mockGetRequirementDetail.mockResolvedValue({ requirement: sampleReq, specification: {} });
      mockGetParsedResume.mockResolvedValue({ data: { name: 'John' } });

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
  it('returns early with reason=no-matchable-requirements when agent-view returns empty', async () => {
    mockGetRequirementsAgentView.mockResolvedValue({ items: [] });

    const step = mockStep();
    const r = await ruleCheckAgentHandler({
      event: thinEvt() as any,
      step: step as any,
      logger: mockLogger as any,
    });

    expect(r).toMatchObject({ ok: true, requested_count: 0, reason: 'no-matchable-requirements' });
    expect(mockGetParsedResume).not.toHaveBeenCalled();
    expect(mockRunRuleCheck).not.toHaveBeenCalled();
    expect(step.sent).toHaveLength(0);
  });
});
