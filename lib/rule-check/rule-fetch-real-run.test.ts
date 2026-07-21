import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 真实 run 模拟测试 —— PART A:规则抓取(替代 RAAS 的 ontology API + partner-pg)。
//
// 用 run 01KTKGJ0QC8PQCTHZ6FVDVKFY4(候选人陈思 · 腾讯 CDG 岗位 TEST334)的真实
// JR 字段,跑**真实的** fetchRulesViaOntologyApi,只把网络/DB 边界用真实值 mock:
//   - ontology API(global.fetch):返回该 run 真实的 11 条候选规则;Neo4j 实例查 404
//   - partner-pg(query):client_name=腾讯,client_department.dept_name=CDG
// 验证:rule-check 是否为这份简历/岗位抓取了「合适的规则」—— 尤其修复后 bg 应解析
// 成 CDG,把 CDG 专属规则 10-42 纳入(修复前 bg=null 会 fail-closed 漏掉它)。

vi.mock('@/lib/partner-pg/client', () => ({
  isPartnerPgConfigured: () => true,
  query: vi.fn(),
}));

import { fetchRulesViaOntologyApi } from './api-rule-fetcher';
import { query as pgQuery } from '@/lib/partner-pg/client';
import { createNullLogger } from '@/lib/agent-logger';
import { REAL_ANCHORS, REAL_ACTION_RULES } from '@/server/inngest/agents/__fixtures__/real-run-chensiying';

const mPg = vi.mocked(pgQuery);

/** ontology API:Neo4j 实例查全 404(真实如此)、cypher 空、action-rules 返回真实 11 条。 */
function makeOntologyFetch() {
  const res = (status: number, body?: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/instances/Client_Department/')) return res(404, { error: 'instance-not-found' });
    if (u.includes('/instances/Client/')) return res(404, { error: 'instance-not-found' });
    if (u.includes('/cypher/query')) return res(200, { records: [] });
    if (u.includes('/actions/ruleCheckForMatchResume/rules'))
      return res(200, { rules: REAL_ACTION_RULES, action_steps: [] });
    return res(500, { error: `unexpected url ${u}` });
  });
}

/** partner-pg:client 名 + 部门名都解析得到(client_department 兜底命中 CDG)。 */
function withResolvedClientAndDept() {
  mPg.mockImplementation(async (sql: string) => {
    if (sql.includes('client_department')) return { rows: [{ dept_name: 'CDG' }] } as never;
    if (sql.includes('client_name')) return { rows: [{ client_name: '腾讯' }] } as never;
    return { rows: [] } as never;
  });
}

beforeEach(() => {
  mPg.mockReset();
  process.env.ALLMETA_BASE_URL = 'http://localhost:3500';
  process.env.ALLMETA_API_KEY = 'test-token';
  vi.stubGlobal('fetch', makeOntologyFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const fetchForRealRun = () =>
  fetchRulesViaOntologyApi({
    clientId: REAL_ANCHORS.client_id, // a5f6029a… → 腾讯
    departmentId: REAL_ANCHORS.client_department_id, // 44cd4ad4…(UUID,Neo4j 404)
    businessGroup: null, // JR 未带显式 bg
    orgName: 'Technology', // 英文 org 名,deriveBgFromOrgName 解析不出
    logger: createNullLogger(),
  });

describe('真实 run · 规则抓取(fetchRulesViaOntologyApi)', () => {
  it('解析出 client=腾讯 + bg=CDG(靠 client_department 兜底)', async () => {
    withResolvedClientAndDept();
    const r = await fetchForRealRun();
    expect(r.client_name_resolved).toBe('腾讯');
    expect(r.business_group_resolved).toBe('CDG');
  });

  it('抓取「合适的规则」:选中通用 + 腾讯客户级 + 腾讯/CDG 部门级(共 5 条),含 10-42', async () => {
    withResolvedClientAndDept();
    const r = await fetchForRealRun();
    const included = r.rules.map((x) => x.id).sort();
    expect(included).toEqual(['10-25', '10-26', '10-42', '10-45', '10-46']);
    // 关键:CDG 专属规则 10-42 被正确纳入(这正是 client_department 兜底修复的效果)
    expect(included).toContain('10-42');
  });

  it('正确排除不适用规则:字节客户规则 + 腾讯/IEG 部门规则(共 6 条)', async () => {
    withResolvedClientAndDept();
    const r = await fetchForRealRun();
    const prov = new Map(r.provenance.map((p) => [p.rule_id, p]));
    // 字节规则:客户不匹配
    for (const id of ['10-49', '10-32', '10-34', '10-51']) {
      expect(prov.get(id)?.included).toBe(false);
      expect(prov.get(id)?.reason).toContain('客户');
    }
    // 腾讯/IEG 规则:客户对、部门(IEG)≠ 岗位 bg(CDG)
    for (const id of ['10-43', '10-56']) {
      expect(prov.get(id)?.included).toBe(false);
      expect(prov.get(id)?.reason).toContain('IEG');
    }
  });

  it('回归护栏:partner-pg 没有 client_department 行时 bg=null,10-42 被 fail-closed 漏掉', async () => {
    // 模拟「修复前」/「兜底数据缺失」:client 名能解析,部门解析不到
    mPg.mockImplementation(async (sql: string) => {
      if (sql.includes('client_department')) return { rows: [] } as never;
      if (sql.includes('client_name')) return { rows: [{ client_name: '腾讯' }] } as never;
      return { rows: [] } as never;
    });
    const r = await fetchForRealRun();
    expect(r.business_group_resolved).toBeNull();
    const prov = new Map(r.provenance.map((p) => [p.rule_id, p]));
    expect(prov.get('10-42')?.included).toBe(false);
    expect(prov.get('10-42')?.reason).toContain('fail-closed');
    expect(r.rules.map((x) => x.id)).not.toContain('10-42');
  });
});
