import { describe, it, expect, beforeEach, vi } from 'vitest';

// 真实 run 模拟测试 —— PART B:事件流(替代 RAAS 接收 + 发送 events)。
//
// 用 run 01KTKGJ0QC8PQCTHZ6FVDVKFY4 的**真实 RESUME_PROCESSED 事件**喂进真实的
// ruleCheckAgentHandler,捕获它 step.sendEvent 出去的事件(本应发回 RAAS 的),
// 不碰任何生产配置 / 网络(全部边界 mock)。runRuleCheck 这里 mock 成 PASS(规则
// 抓取的真实性由 PART A: rule-fetch-real-run.test.ts 验证)。
//
// 验证:① 入站真实事件被正确消费;② rule-check 拿到的是「合适的简历」(陈思 ·
// 字节跳动行政文秘)+ 真实岗位;③ 出站事件 = MATCH_RULE_CHECK_PASSED,带真实
// candidate/JR 锚点。

vi.mock('@/server/inngest/client', () => ({
  inngest: { createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })) },
}));

const mockRunRuleCheck = vi.fn<(...a: any[]) => any>();
vi.mock('@/lib/rule-check', () => ({
  buildRuleCheckInput: (x: unknown) => x, // 透传,便于断言 runRuleCheck 收到的入参
  runRuleCheck: (...a: unknown[]) => mockRunRuleCheck(...a),
  formatExplanation: (e: { rule_id: string; rule_name: string; reason?: string }) =>
    `[${e.rule_id}] ${e.rule_name}: ${e.reason ?? ''}`,
}));

vi.mock('@/lib/rule-check/ontology', () => ({
  extractDims: vi.fn(() => ({ client_id: '腾讯', business_group: null, studio: null })),
  severityForRuleId: vi.fn(() => 'flag_only'),
}));

vi.mock('@/lib/rule-check/live-rule-catalog', () => ({
  getLiveRuleCatalog: vi.fn(async () => new Map()),
  severityForRuleIdLive: vi.fn(async () => 'flag_only'),
}));

vi.mock('@/lib/allmeta-writers', () => ({
  writeJobRequisitionInstance: vi.fn(async () => ({ ok: true })),
  writeCandidateMatchResultInstance: vi.fn(async () => ({ ok: true })),
}));

const auditCreate = vi.fn<(...a: any[]) => Promise<unknown>>(async () => ({}));
vi.mock('@/server/db', () => ({
  prisma: {
    ruleCheckAudit: { create: (...a: unknown[]) => auditCreate(...a), upsert: vi.fn(async () => ({})) },
    ruleCheckFlag: { createMany: vi.fn(async () => ({ count: 0 })) },
    notification: { upsert: vi.fn(async () => ({ id: 'n1' })), create: vi.fn(async () => ({ id: 'n1' })) },
  },
}));

vi.mock('@/lib/partner-pg/client', () => ({ isPartnerPgConfigured: vi.fn(() => true) }));
vi.mock('@/lib/partner-pg/requirements', () => ({ getRequirementDetail: vi.fn() }));
vi.mock('@/lib/partner-pg/agent-view', () => ({ getRequirementsAgentView: vi.fn() }));
vi.mock('@/lib/partner-pg/recruiting-jobs', () => ({
  getRecruitingJobsAsRequirements: vi.fn(async () => ({ items: [] })),
}));
vi.mock('@/lib/partner-pg/parsed-resume', () => ({ getParsedResume: vi.fn() }));
vi.mock('@/lib/partner-pg/rule-check-result', () => ({
  saveRuleCheckFailToPartnerPg: vi.fn(async () => ({ candidate_match_result_id: 'cmr', created: true, job_posting_id: null })),
}));

const notifyRecruitmentLifecycle = vi.fn<(...a: any[]) => Promise<void>>(async () => {});
vi.mock('@/server/notifications/recruitment-lifecycle', () => ({
  notifyRecruitmentLifecycle: (...a: unknown[]) => notifyRecruitmentLifecycle(...a),
}));

import { ruleCheckAgentHandler } from './rule-check-agent';
import { getRequirementDetail } from '@/lib/partner-pg/requirements';
import {
  realResumeProcessedEvent,
  realJobRequisitionDetail,
  REAL_ANCHORS,
} from './__fixtures__/real-run-chensiying';

const mockGetRequirementDetail = vi.mocked(getRequirementDetail);

// runRuleCheck 的真实返回形状(PASS):候选人陈思无腾讯经历 → CDG 冷冻规则抓取但
// 不触发,整体 PASS。审计带真实解析的 client/bg + provenance(5 选中 / 6 排除)。
function passResultForRealRun() {
  const prov = [
    { rule_id: '10-25', tier: 'general', included: true, reason: '通用规则(CSI),无条件纳入' },
    { rule_id: '10-26', tier: 'general', included: true, reason: '通用规则(CSI),无条件纳入' },
    { rule_id: '10-45', tier: 'client', included: true, reason: '客户=腾讯 命中,部门无限定,纳入' },
    { rule_id: '10-46', tier: 'client', included: true, reason: '客户=腾讯 命中,部门无限定,纳入' },
    { rule_id: '10-42', tier: 'department', included: true, reason: '部门=CDG 命中岗位 bg=CDG,纳入' },
    { rule_id: '10-43', tier: 'department', included: false, reason: '排除：规则部门=IEG ≠ 岗位 bg=CDG' },
    { rule_id: '10-56', tier: 'department', included: false, reason: '排除：规则部门=IEG ≠ 岗位 bg=CDG' },
    { rule_id: '10-49', tier: 'client', included: false, reason: '排除：规则客户=字节 ≠ 岗位客户=腾讯' },
    { rule_id: '10-32', tier: 'client', included: false, reason: '排除：规则客户=字节 ≠ 岗位客户=腾讯' },
    { rule_id: '10-34', tier: 'client', included: false, reason: '排除：规则客户=字节 ≠ 岗位客户=腾讯' },
    { rule_id: '10-51', tier: 'client', included: false, reason: '排除：规则客户=字节 ≠ 岗位客户=腾讯' },
  ];
  return {
    decision: 'PASS',
    stats: { total: 5, pass: 3, fail: 0, pending: 0, insufficient_info: 0, not_triggered: 2, not_executed: 0 },
    rule_results: [
      { rule_id: '10-25', status: 'not_triggered', reason: '非华为/荣耀竞对' },
      { rule_id: '10-26', status: 'not_triggered', reason: '非 OPPO/小米竞对' },
      { rule_id: '10-45', status: 'pass', reason: '无腾讯正编经历' },
      { rule_id: '10-46', status: 'pass', reason: '无需凭证' },
      { rule_id: '10-42', status: 'pass', reason: '候选人无腾讯经历,CDG 回流冷冻不触发' },
    ],
    explanations: [],
    audit: {
      rules_evaluated: 5,
      graph_calls: 0,
      llm_model: 'google/gemini-3-flash-preview',
      llm_duration_ms: 3255,
      llm_round_trips: 0,
      rule_source: 'ontology-api',
      client_name_resolved: '腾讯',
      business_group_resolved: 'CDG',
      rule_provenance: prov,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RULE_CHECK_BYPASS;
  mockGetRequirementDetail.mockResolvedValue(realJobRequisitionDetail() as never);
  mockRunRuleCheck.mockResolvedValue(passResultForRealRun() as never);
});

function mockStep() {
  const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
  return {
    sent,
    run: async (_id: string, fn: () => Promise<unknown>) => fn(),
    sendEvent: async (_id: string, e: { name: string; data: Record<string, unknown> }) => {
      sent.push(e);
    },
  };
}
const mockLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe('真实 run · 事件流模拟(替代 RAAS 收发 events)', () => {
  it('消费真实 RESUME_PROCESSED → 走 path A 拉真实 JR(腾讯 CDG 岗位)', async () => {
    const step = mockStep();
    await ruleCheckAgentHandler({
      event: realResumeProcessedEvent() as never,
      step: step as never,
      logger: mockLogger as never,
    });
    expect(mockGetRequirementDetail).toHaveBeenCalledWith(REAL_ANCHORS.job_requisition_id);
  });

  it('rule-check 拿到的是「合适的简历」:陈思 · 字节跳动行政文秘 + 真实岗位', async () => {
    const step = mockStep();
    await ruleCheckAgentHandler({
      event: realResumeProcessedEvent() as never,
      step: step as never,
      logger: mockLogger as never,
    });
    expect(mockRunRuleCheck).toHaveBeenCalledTimes(1);
    const input = mockRunRuleCheck.mock.calls[0][0] as {
      parsed_resume: { name: string; experience: Array<{ company: string }> };
      job_requisition: { job_requisition_id: string; client_id: string };
      runtime_context: { candidate_id: string; resume_id: string };
    };
    // 抓到的简历是这位真实候选人本人
    expect(input.parsed_resume.name).toBe('陈思');
    expect(input.parsed_resume.experience[0].company).toContain('字节跳动');
    // 关联的是真实岗位 + 真实候选人锚点
    expect(input.job_requisition.job_requisition_id).toBe(REAL_ANCHORS.job_requisition_id);
    expect(input.job_requisition.client_id).toBe(REAL_ANCHORS.client_id);
    expect(input.runtime_context.candidate_id).toBe(REAL_ANCHORS.candidate_id);
    expect(input.runtime_context.resume_id).toBe(REAL_ANCHORS.resume_id);
  });

  it('发回 RAAS 的出站事件 = MATCH_RULE_CHECK_PASSED,带真实锚点 + 简历', async () => {
    const step = mockStep();
    await ruleCheckAgentHandler({
      event: realResumeProcessedEvent() as never,
      step: step as never,
      logger: mockLogger as never,
    });
    expect(step.sent).toHaveLength(1);
    const ev = step.sent[0];
    expect(ev.name).toBe('MATCH_RULE_CHECK_PASSED');
    expect(ev.data.candidate_id).toBe(REAL_ANCHORS.candidate_id);
    expect(ev.data.job_requisition_id).toBe(REAL_ANCHORS.job_requisition_id);
    expect((ev.data.parsed_resume as { name: string }).name).toBe('陈思');
  });

  it('审计落库带真实解析的 client=腾讯 / bg=CDG + 含 10-42 的 provenance', async () => {
    const step = mockStep();
    await ruleCheckAgentHandler({
      event: realResumeProcessedEvent() as never,
      step: step as never,
      logger: mockLogger as never,
    });
    expect(auditCreate).toHaveBeenCalled();
    const data = (auditCreate.mock.calls[0]?.[0] as unknown as { data: Record<string, unknown> }).data;
    expect(data.client_display_name).toBe('腾讯');
    expect(data.business_group).toBe('CDG');
    const prov = JSON.parse(data.rule_provenance as string) as Array<{ rule_id: string; included: boolean }>;
    expect(prov.find((p) => p.rule_id === '10-42')?.included).toBe(true);
  });
});
