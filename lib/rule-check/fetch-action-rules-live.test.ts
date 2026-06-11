import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchActionRulesLive } from './api-rule-fetcher';

// fetchActionRulesLive 给「单条规则定义」展示用 —— 跟 agent 同一个 live endpoint
// (/actions/ruleCheckForMatchResume/rules),整条规则用 toRule 规范化(含 live 的
// standardizedLogicRule)。这样 UI「原规则定义」面板能显示 Neo4j 当前值,而不是打包旧值。

function makeFetch(rules: unknown[]) {
  const res = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  return vi.fn(async (url: string | URL) => {
    if (String(url).includes('/actions/ruleCheckForMatchResume/rules'))
      return res(200, { rules, action_steps: [] });
    return res(500, { error: 'unexpected' });
  });
}

beforeEach(() => {
  process.env.ALLMETA_BASE_URL = 'http://localhost:3500';
  process.env.ALLMETA_API_KEY = 'test-token';
});
afterEach(() => vi.unstubAllGlobals());

describe('fetchActionRulesLive — UI 单规则定义走 live ontology', () => {
  it('返回整条 live 规则,standardizedLogicRule 是 Neo4j 当前值(永不回流)', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        {
          id: '10-42',
          businessLogicRuleName: 'CDG事业群6个月回流冷冻期绝对拦截',
          standardizedLogicRule: 'CDG永不回流。', // ← live
          applicableClient: '腾讯',
          applicableDepartment: 'CDG',
          executor: 'Agent',
          enforcementLevel: 'mandatory',
          failurePolicy: 'block',
          specificScenarioStage: '简历匹配',
          submissionCriteria: '目标岗位归属腾讯CDG事业群…',
        },
      ]),
    );
    const m = await fetchActionRulesLive();
    const r = m.get('10-42');
    expect(r).toBeTruthy();
    expect(r!.standardizedLogicRule).toBe('CDG永不回流。');
    expect(r!.applicableDepartment).toBe('CDG');
    expect(r!.businessLogicRuleName).toContain('CDG');
  });

  it('ALLMETA 未配置 → 抛错(由调用方回退打包 JSON)', async () => {
    delete process.env.ALLMETA_BASE_URL;
    await expect(fetchActionRulesLive()).rejects.toThrow();
  });
});
