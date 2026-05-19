// rule-check-agent.test.ts — unit tests for ruleCheckAgent decision branches.
//
// Uses the manager-agent.test.ts pattern: import the separately-exported
// handler function directly, mock step.run/sendEvent + the rule-check lib.

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

import { ruleCheckAgentHandler } from './rule-check-agent';
import { runRuleCheck } from '@/lib/rule-check';
import { extractDims } from '@/lib/rule-check/ontology';

const mockRunRuleCheck = runRuleCheck as ReturnType<typeof vi.fn>;
const mockExtractDims = extractDims as ReturnType<typeof vi.fn>;

// Helper: build a minimal RULE_CHECK_REQUESTED event payload
function evt(over: Record<string, unknown> = {}) {
  return {
    name: 'RULE_CHECK_REQUESTED',
    data: {
      upload_id: 'U1',
      candidate_id: 'C1',
      resume_id: 'R1',
      employee_id: 'EMP_TEST',
      job_requisition_id: 'JR1',
      client_id: 'CLI_TENCENT',
      job_requisition: { job_requisition_id: 'JR1', client_id: 'CLI_TENCENT' },
      parsed_resume: { name: 'John' },
      runtime_context: {
        upload_id: 'U1',
        candidate_id: 'C1',
        resume_id: 'R1',
        employee_id: 'EMP_TEST',
        trace_id: null,
      },
      ...over,
    },
  };
}

// Helper: mock step.run / step.sendEvent
function mockStep() {
  const sent: Array<{ name: string; data: any }> = [];
  return {
    sent,
    run: async (_id: string, fn: () => Promise<unknown>) => await fn(),
    sendEvent: async (_id: string, e: { name: string; data: any }) => {
      sent.push(e);
    },
  };
}

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractDims.mockReturnValue({ client_id: '腾讯', business_group: null, studio: null });
});

describe('ruleCheckAgent', () => {
  it('emits RULE_CHECK_PASSED when runRuleCheck returns PASS', async () => {
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
    await ruleCheckAgentHandler({ event: evt() as any, step: step as any, logger: mockLogger as any });

    expect(step.sent).toHaveLength(1);
    expect(step.sent[0].name).toBe('RULE_CHECK_PASSED');
    expect(step.sent[0].data.job_requisition_id).toBe('JR1');
    expect(step.sent[0].data.job_requisition).toEqual({ job_requisition_id: 'JR1', client_id: 'CLI_TENCENT' });
    expect(step.sent[0].data.parsed_resume).toEqual({ name: 'John' });
  });

  it('emits MATCH_FAILED when runRuleCheck returns FAIL', async () => {
    mockRunRuleCheck.mockResolvedValue({
      decision: 'FAIL',
      stats: { total: 5, pass: 4, fail: 1, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [],
      explanations: [
        { rule_id: '10-5', rule_name: 'degree', step_id: 'STEP1', status: 'fail', reason: 'no degree' },
      ],
      audit: {
        rules_evaluated: 5,
        graph_calls: 6,
        llm_model: 'gemini',
        llm_duration_ms: 1,
        llm_round_trips: 0,
        rule_source: 'json-fallback',
      },
    } as any);

    const step = mockStep();
    await ruleCheckAgentHandler({ event: evt() as any, step: step as any, logger: mockLogger as any });

    expect(step.sent).toHaveLength(1);
    expect(step.sent[0].name).toBe('MATCH_FAILED');
    expect(step.sent[0].data.success).toBe(false);
    expect(step.sent[0].data.matching_score).toBeNull();
    expect(step.sent[0].data.job_requisition_id).toBe('JR1');
    expect(step.sent[0].data.candidate_id).toBe('C1');
    expect(step.sent[0].data.upload_id).toBe('U1');
    expect(step.sent[0].data.data.rule_check_decision).toBe('FAIL');
    expect(step.sent[0].data.data.failed_rules).toHaveLength(1);
  });

  it('emits MATCH_FAILED with rule_check_decision=REVIEW when REVIEW returned', async () => {
    mockRunRuleCheck.mockResolvedValue({
      decision: 'REVIEW',
      stats: { total: 5, pass: 4, fail: 0, pending: 1, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
      rule_results: [],
      explanations: [
        { rule_id: '10-21', rule_name: 'age', step_id: 'S2', status: 'pending', reason: 'needs HSM review' },
      ],
      audit: {
        rules_evaluated: 5,
        graph_calls: 6,
        llm_model: 'gemini',
        llm_duration_ms: 1,
        llm_round_trips: 0,
        rule_source: 'json-fallback',
      },
    } as any);

    const step = mockStep();
    await ruleCheckAgentHandler({ event: evt() as any, step: step as any, logger: mockLogger as any });

    expect(step.sent[0].name).toBe('MATCH_FAILED');
    expect(step.sent[0].data.data.rule_check_decision).toBe('REVIEW');
  });
});
