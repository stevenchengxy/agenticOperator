import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// resolveDepartmentBg 的 partner-pg client_department.dept_name 兜底。
// 对照 instance-client-fallback.test.ts(client 名解析的 partner-pg 兜底)——
// 这是对称的那一半:Neo4j 图谱没投入 :Client_Department 节点时,partner-pg
// 的 client_department 表(dept_name = "CDG"/"IEG"/…)才是 department→事业群
// 的事实源。少了它,陈思颖 的 JR(client_department_id=UUID、sd_org_name=
// "Technology")bg 解析成 null,CDG 专属规则 10-42 被 fail-closed 丢弃。

vi.mock('@/lib/partner-pg/client', () => ({
  isPartnerPgConfigured: () => true,
  query: vi.fn(),
}));

import { fetchRulesViaOntologyApi } from './api-rule-fetcher';
import { query as pgQuery } from '@/lib/partner-pg/client';
import { createNullLogger } from '@/lib/agent-logger';

const mPg = vi.mocked(pgQuery);

const TENCENT_ID = 'a5f6029a-8af8-4f9a-81e8-7c594cc52aa8';
const CDG_DEPT_UUID = '44cd4ad4-35af-4abd-b418-209491d16789';

const ACTION_RULES = {
  rules: [
    {
      id: '10-42',
      executor: 'Agent',
      enforcementLevel: 'mandatory',
      failurePolicy: 'block',
      applicableClient: '腾讯',
      applicableDepartment: 'CDG',
      businessLogicRuleName: 'CDG事业群6个月回流冷冻期绝对拦截',
    },
    {
      id: '10-25',
      executor: 'Agent',
      enforcementLevel: 'mandatory',
      failurePolicy: 'block',
      applicableClient: '腾讯',
      applicableDepartment: 'N/A',
      businessLogicRuleName: '客户级通用',
    },
    {
      id: '10-O1',
      executor: 'Agent',
      enforcementLevel: 'optional',
      failurePolicy: 'warn',
      applicableClient: '腾讯',
      applicableDepartment: 'N/A',
      businessLogicRuleName: '可选弱信号参考',
    },
  ],
  action_steps: [
    {
      id: '10::reference',
      order: 99,
      name: 'optionalReferenceChecks',
      rules: [{ id: '10-O1' }],
    },
  ],
};

/** Neo4j 全部 404 / 空,逼解析走 partner-pg 兜底;只有 action-rules 返回真数据。 */
function makeFetch() {
  const res = (status: number, body?: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/instances/Client_Department/')) return res(404, { error: 'nf' });
    if (u.includes('/instances/Client/')) return res(404, { error: 'nf' });
    if (u.includes('/cypher/query')) return res(200, { records: [] });
    if (u.includes('/actions/ruleCheckForMatchResume/rules')) return res(200, ACTION_RULES);
    return res(500, { error: `unexpected url ${u}` });
  });
}

beforeEach(() => {
  mPg.mockReset();
  process.env.ALLMETA_BASE_URL = 'http://localhost:3500';
  process.env.ALLMETA_API_KEY = 'tok';
  vi.stubGlobal('fetch', makeFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveDepartmentBg — partner-pg client_department.dept_name 兜底', () => {
  it('THE BUG: Neo4j 404 时,靠 partner-pg client_department(dept_name=CDG)解析 bg → 摘取 10-42', async () => {
    mPg.mockImplementation(async (sql: string) => {
      if (sql.includes('client_department')) return { rows: [{ dept_name: 'CDG' }] } as never;
      if (sql.includes('client_name')) return { rows: [{ client_name: '腾讯' }] } as never;
      return { rows: [] } as never;
    });

    const result = await fetchRulesViaOntologyApi({
      clientId: TENCENT_ID,
      departmentId: CDG_DEPT_UUID,
      businessGroup: null,
      orgName: 'Technology', // 解析不出 bg 的英文 org 名
      logger: createNullLogger(),
    });

    expect(result.business_group_resolved).toBe('CDG');
    expect(result.rules.map((r) => r.id)).toContain('10-42');
  });

  it('fail-closed 保留:partner-pg 也没有 client_department 行时 bg=null,10-42 不摘', async () => {
    mPg.mockImplementation(async (sql: string) => {
      if (sql.includes('client_department')) return { rows: [] } as never;
      if (sql.includes('client_name')) return { rows: [{ client_name: '腾讯' }] } as never;
      return { rows: [] } as never;
    });

    const result = await fetchRulesViaOntologyApi({
      clientId: TENCENT_ID,
      departmentId: CDG_DEPT_UUID,
      businessGroup: null,
      orgName: 'Technology',
      logger: createNullLogger(),
    });

    expect(result.business_group_resolved).toBeNull();
    expect(result.rules.map((r) => r.id)).not.toContain('10-42');
  });

  it('dept_name 不是已知事业群 token(如 "S线")时不强行命中,bg 仍 null', async () => {
    mPg.mockImplementation(async (sql: string) => {
      if (sql.includes('client_department')) return { rows: [{ dept_name: 'S线 三大职能系统' }] } as never;
      if (sql.includes('client_name')) return { rows: [{ client_name: '腾讯' }] } as never;
      return { rows: [] } as never;
    });

    const result = await fetchRulesViaOntologyApi({
      clientId: TENCENT_ID,
      departmentId: CDG_DEPT_UUID,
      businessGroup: null,
      orgName: 'Technology',
      logger: createNullLogger(),
    });

    expect(result.business_group_resolved).toBeNull();
  });

  it('keeps a matching optional Agent rule in the evaluated rule set', async () => {
    mPg.mockImplementation(async (sql: string) => {
      if (sql.includes('client_department')) return { rows: [{ dept_name: 'CDG' }] } as never;
      if (sql.includes('client_name')) return { rows: [{ client_name: '腾讯' }] } as never;
      return { rows: [] } as never;
    });

    const result = await fetchRulesViaOntologyApi({
      clientId: TENCENT_ID,
      departmentId: CDG_DEPT_UUID,
      logger: createNullLogger(),
    });
    const optional = result.rules.find((rule) => rule.id === '10-O1');
    expect(optional).toMatchObject({ enforcementLevel: 'optional', failurePolicy: 'warn' });
    expect(result.steps.flatMap((step) => step.rules).map((rule) => rule.id)).toContain('10-O1');
    expect(result.provenance.find((item) => item.rule_id === '10-O1')).toMatchObject({
      included: true,
      reference_only: true,
    });
  });
});
