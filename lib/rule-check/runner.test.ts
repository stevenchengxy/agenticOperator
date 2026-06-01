import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 2026-06-01: harness repaired. The runner now fetches rules via
// api-rule-fetcher and pre-fetches graph context via graph-context (it no
// longer calls the old ontology-source / instance-client directly). Mock those
// two so the runner reaches the LLM eval path instead of failing early with
// ontology-graph-unavailable.
vi.mock('./api-rule-fetcher', () => ({
  fetchRulesViaOntologyApi: vi.fn(),
  RuleFetchApiError: class RuleFetchApiError extends Error {},
}));
vi.mock('./graph-context', () => ({
  buildGraphContext: vi.fn(),
  createDispatcher: vi.fn(() => async () => null),
}));
vi.mock('@/server/llm/gateway', () => ({
  chatComplete: vi.fn(),
}));

import { fetchRulesViaOntologyApi } from './api-rule-fetcher';
import { buildGraphContext } from './graph-context';
import { chatComplete } from '@/server/llm/gateway';
import { buildRuleCheckInput, runRuleCheck } from './runner';
import type { RuleCheckInput } from './types';

const mFetchRules = vi.mocked(fetchRulesViaOntologyApi);
const mChat = vi.mocked(chatComplete);
const mBuildGraph = vi.mocked(buildGraphContext);

beforeEach(() => {
  mFetchRules.mockReset();
  mChat.mockReset();
  mBuildGraph.mockReset();
  process.env.ALLMETA_BASE_URL = 'http://localhost:3500';
  process.env.ALLMETA_API_KEY = 'tok';
});
afterEach(() => {
  delete process.env.ALLMETA_BASE_URL;
  delete process.env.ALLMETA_API_KEY;
});

function fakeInput(): RuleCheckInput {
  return {
    runtime_context: {
      upload_id: 'u',
      candidate_id: 'C-1',
      resume_id: 'r',
      employee_id: 'E',
    },
    resume: { name: '张三' },
    job_requisition: { job_requisition_id: 'JR-1', client_id: 'CLI_TENCENT_PCG' },
    job_requisition_specification: null,
    hsm_feedback: null,
  };
}

function mockGraphEmpty(): void {
  mBuildGraph.mockResolvedValue({
    candidate: null,
    resume: null,
    job_requisition: null,
    applications: [],
    blacklist_hits: [],
    employment_links: [],
    fetch_count: 0,
  });
}

function mockRulesFourRules(): void {
  const ruleShape = (id: string) => ({
    id,
    specificScenarioStage: '',
    businessLogicRuleName: `name-${id}`,
    applicableClient: '通用',
    applicableDepartment: 'N/A',
    submissionCriteria: 'sc',
    standardizedLogicRule: 'logic',
    relatedEntities: [],
    businessBackgroundReason: '',
    ruleSource: '',
    executor: 'Agent' as const,
    enforcementLevel: 'optional' as const,
    failurePolicy: 'warn' as const,
    severity: 'terminal' as const,
  });
  const rules = ['10-1', '10-2', '10-3', '10-4'].map(ruleShape);
  mFetchRules.mockResolvedValue({
    rules,
    source: 'ontology-api',
    steps: [
      {
        step_id: '10::s1',
        order: 1,
        name: 'validateRedlineAndBlacklist',
        description: 'd',
        condition: 'c',
        rules,
      },
    ],
  });
}

function mockRulesFiveRules(): void {
  const ruleShape = (id: string) => ({
    id,
    specificScenarioStage: '',
    businessLogicRuleName: `name-${id}`,
    applicableClient: '通用',
    applicableDepartment: 'N/A',
    submissionCriteria: 'sc',
    standardizedLogicRule: 'logic',
    relatedEntities: [],
    businessBackgroundReason: '',
    ruleSource: '',
    executor: 'Agent' as const,
    enforcementLevel: 'optional' as const,
    failurePolicy: 'warn' as const,
    severity: 'terminal' as const,
  });
  const rules = ['10-1', '10-2', '10-3', '10-4', '10-5'].map(ruleShape);
  mFetchRules.mockResolvedValue({
    rules,
    source: 'ontology-api',
    steps: [
      {
        step_id: '10::s1',
        order: 1,
        name: 'validateRedlineAndBlacklist',
        description: 'd',
        condition: 'c',
        rules,
      },
    ],
  });
}

function mockRulesOneStepOneRule(): void {
  mFetchRules.mockResolvedValue({
    rules: [
      {
        id: '10-25',
        specificScenarioStage: '',
        businessLogicRuleName: '华为荣耀',
        applicableClient: '通用',
        applicableDepartment: 'N/A',
        submissionCriteria: 'sc',
        standardizedLogicRule: 'logic',
        relatedEntities: [],
        businessBackgroundReason: '',
        ruleSource: '',
        executor: 'Agent',
        enforcementLevel: 'optional',
        failurePolicy: 'warn',
        severity: 'terminal',
      },
    ],
    source: 'ontology-api',
    steps: [
      {
        step_id: '10::s1',
        order: 1,
        name: 'validateRedlineAndBlacklist',
        description: 'd',
        condition: 'c',
        rules: [
          {
            id: '10-25',
            specificScenarioStage: '',
            businessLogicRuleName: '华为荣耀',
            applicableClient: '通用',
            applicableDepartment: 'N/A',
            submissionCriteria: 'sc',
            standardizedLogicRule: 'logic',
            relatedEntities: [],
            businessBackgroundReason: '',
            ruleSource: '',
            executor: 'Agent',
            severity: 'terminal',
          },
        ],
      },
    ],
  });
}

describe('runRuleCheck — new MatchResumeCheckResult shape', () => {
  it('FAIL: folds to FAIL when stats.fail > 0', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        decision: 'FAIL',
        rule_results: [
          { rule_id: '10-25', rule_name: '华为荣耀', step_id: '10::s1', status: 'fail', reason: 'hit' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 50,
      toolUseIterations: 0,
    });

    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.stats.fail).toBe(1);
    expect(out.stats.total).toBe(1);
    expect(out.rule_results).toHaveLength(1);
    expect(out.explanations).toHaveLength(1);
    expect(out.audit.rule_source).toBe('ontology-api');
    expect(out.audit.fail_reason).toBeUndefined();
  });

  it('PASS: folds to PASS when no fail/pending/insufficient_info', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        rule_results: [
          { rule_id: '10-25', rule_name: '华为荣耀', step_id: '10::s1', status: 'pass' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 50,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('PASS');
    expect(out.stats.pass).toBe(1);
    expect(out.rule_results).toHaveLength(1);
    expect(out.explanations).toHaveLength(0);
  });

  it('PASS: pending no longer folds to REVIEW (policy 2026-05-26 — only真违反阻断)', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        rule_results: [
          { rule_id: '10-25', rule_name: '华为荣耀', step_id: '10::s1', status: 'pending', reason: 'needs HSM' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 30,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    // foldDecision folds pending → PASS (no longer blocks); the pending rule is
    // still recorded in stats/explanations for the HSM review surface.
    expect(out.decision).toBe('PASS');
    expect(out.stats.pending).toBe(1);
  });

  it('PASS: insufficient_info does NOT block match (folds to PASS, not REVIEW)', async () => {
    // Per partner contract: missing data shouldn't penalize the candidate.
    // Only REAL rule violations (status='fail') block.
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        rule_results: [
          { rule_id: '10-25', rule_name: '华为荣耀', step_id: '10::s1', status: 'insufficient_info', reason: '缺出生日期,无法验证年龄' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 30,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('PASS');
    expect(out.stats.insufficient_info).toBe(1);
    expect(out.stats.fail).toBe(0);
    // explanations still surface the insufficient_info entry for audit visibility
    expect(out.explanations).toHaveLength(1);
    expect(out.explanations[0].status).toBe('insufficient_info');
  });

  it('fail-safe FAIL when LLM returns invalid JSON', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: 'not json',
      modelUsed: 'm',
      durationMs: 5,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.audit.fail_reason).toBe('parse-error');
    expect(out.rule_results).toEqual([]);
    expect(out.explanations).toEqual([]);
  });

  it('fail-safe FAIL when chatComplete rejects (gateway/network)', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockRejectedValueOnce(new Error('LLM gateway not configured'));
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.audit.fail_reason).toBe('llm-call-error');
    expect(out.rule_results).toEqual([]);
  });

  it('fail-safe FAIL with ontology-graph-unavailable when getInstance throws 401', async () => {
    mockRulesOneStepOneRule();
    mBuildGraph.mockRejectedValueOnce(
      new Error('Ontology API getInstance(Candidate, C-1) -> 401. Body: unauthorized'),
    );
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.audit.fail_reason).toBe('ontology-graph-unavailable');
    expect(out.rule_results).toEqual([]);
  });

  it('threads tools to chatComplete', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        rule_results: [
          { rule_id: '10-25', rule_name: '华为荣耀', step_id: '10::s1', status: 'pass' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 1,
      toolUseIterations: 1,
    });
    await runRuleCheck(fakeInput());
    const opts = mChat.mock.calls[0]?.[0] as {
      tools?: { schema: Array<{ function: { name: string } }> };
    };
    expect(opts.tools?.schema.map((t) => t.function.name).sort()).toEqual(
      ['get_instance', 'list_instances', 'list_links'].sort(),
    );
  });
  it('derives explanations from rule_results — filters out pass + not_triggered', async () => {
    mockRulesFourRules();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        rule_results: [
          { rule_id: '10-1', rule_name: 'name-10-1', step_id: '10::s1', status: 'pass' },
          { rule_id: '10-2', rule_name: 'name-10-2', step_id: '10::s1', status: 'fail', reason: 'hit' },
          { rule_id: '10-3', rule_name: 'name-10-3', step_id: '10::s1', status: 'not_triggered' },
          { rule_id: '10-4', rule_name: 'name-10-4', step_id: '10::s1', status: 'pending', reason: 'review' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 1,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.rule_results).toHaveLength(4);
    expect(out.explanations).toHaveLength(2);
    expect(out.explanations.map((e) => e.status).sort()).toEqual(['fail', 'pending']);
    expect(out.decision).toBe('FAIL');
  });

  it('recomputes stats from rule_results; ignores LLM-emitted stats', async () => {
    mockRulesFourRules();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        decision: 'PASS',
        stats: { total: 999, pass: 999, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 0, not_executed: 0 },
        rule_results: [
          { rule_id: '10-1', rule_name: 'name-10-1', step_id: '10::s1', status: 'pass' },
          { rule_id: '10-2', rule_name: 'name-10-2', step_id: '10::s1', status: 'fail', reason: 'hit' },
          { rule_id: '10-3', rule_name: 'name-10-3', step_id: '10::s1', status: 'pass' },
          { rule_id: '10-4', rule_name: 'name-10-4', step_id: '10::s1', status: 'pass' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 1,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.stats.total).toBe(4);
    expect(out.stats.pass).toBe(3);
    expect(out.stats.fail).toBe(1);
    expect(out.decision).toBe('FAIL');
  });

  it('parse-error fail-safe when rule_results count != filtered rule count', async () => {
    mockRulesOneStepOneRule();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({ rule_results: [] }),
      modelUsed: 'm',
      durationMs: 1,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.audit.fail_reason).toBe('parse-error');
  });

  it('treats not_executed as requiring a reason; includes it in explanations', async () => {
    mockRulesFiveRules();
    mockGraphEmpty();
    mChat.mockResolvedValueOnce({
      text: JSON.stringify({
        rule_results: [
          { rule_id: '10-1', rule_name: 'name-10-1', step_id: '10::s1', status: 'fail', reason: 'hit' },
          { rule_id: '10-2', rule_name: 'name-10-2', step_id: '10::s1', status: 'not_executed', reason: '前序规则 10-1 已 FAIL' },
          { rule_id: '10-3', rule_name: 'name-10-3', step_id: '10::s1', status: 'not_executed', reason: '前序规则 10-1 已 FAIL' },
          { rule_id: '10-4', rule_name: 'name-10-4', step_id: '10::s1', status: 'not_executed', reason: '前序规则 10-1 已 FAIL' },
          { rule_id: '10-5', rule_name: 'name-10-5', step_id: '10::s1', status: 'not_executed', reason: '前序规则 10-1 已 FAIL' },
        ],
      }),
      modelUsed: 'm',
      durationMs: 1,
      toolUseIterations: 0,
    });
    const out = await runRuleCheck(fakeInput());
    expect(out.decision).toBe('FAIL');
    expect(out.rule_results).toHaveLength(5);
    expect(out.explanations).toHaveLength(5); // fail + 4 not_executed all appear in explanations
    expect(out.stats.fail).toBe(1);
    expect(out.stats.not_executed).toBe(4);
  });
});

describe('buildRuleCheckInput', () => {
  it('preserves the existing build helper', () => {
    const input = buildRuleCheckInput({
      runtime_context: {
        upload_id: 'u',
        candidate_id: 'c',
        resume_id: 'r',
        employee_id: 'e',
      },
      parsed_resume: { name: 'x' },
      job_requisition: { job_requisition_id: 'JR-x' },
    });
    expect(input.job_requisition.job_requisition_id).toBe('JR-x');
  });
});
