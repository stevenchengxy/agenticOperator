import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// getLiveRuleCatalog 是「规则中身」的统一 live 来源:优先 live ontology
// (fetchActionRulesLive),API 宕/空时回退打包 rules.json(降级但可用)。
// 所有展示/校验面(provenance 名、排除规则定义、severity、dashboard grid)都走它,
// 不再各自硬编码读打包文件 → 改 Neo4j 立即对齐。

vi.mock('./api-rule-fetcher', () => ({ fetchActionRulesLive: vi.fn() }));

import { getLiveRuleCatalog, __resetLiveRuleCatalogCache } from './live-rule-catalog';
import { fetchActionRulesLive } from './api-rule-fetcher';
import type { Rule } from './types';

const mLive = vi.mocked(fetchActionRulesLive);

function liveRule(id: string, logic: string): Rule {
  return {
    id,
    specificScenarioStage: '简历匹配',
    businessLogicRuleName: `${id}-name`,
    applicableClient: '腾讯',
    applicableDepartment: 'CDG',
    submissionCriteria: '',
    standardizedLogicRule: logic,
    relatedEntities: [],
    businessBackgroundReason: '',
    ruleSource: '客户SOP',
    executor: 'Agent',
    enforcementLevel: 'mandatory',
    failurePolicy: 'block',
    severity: 'terminal',
  };
}

beforeEach(() => {
  mLive.mockReset();
  __resetLiveRuleCatalogCache();
});
afterEach(() => __resetLiveRuleCatalogCache());

describe('getLiveRuleCatalog', () => {
  it('live API 成功 → 用 live 中身(永不回流)', async () => {
    mLive.mockResolvedValue(new Map([['10-42', liveRule('10-42', 'CDG永不回流。')]]));
    const cat = await getLiveRuleCatalog();
    expect(cat.get('10-42')?.standardizedLogicRule).toBe('CDG永不回流。');
  });

  it('live API 抛错 → 回退打包 rules.json(降级,仍可用)', async () => {
    mLive.mockRejectedValue(new Error('ECONNREFUSED'));
    const cat = await getLiveRuleCatalog();
    // 打包目录里 10-42 一定存在(其中身是旧的,但至少不空)
    expect(cat.has('10-42')).toBe(true);
  });

  it('live API 返回空 → 也回退打包(契约异常不该让目录空掉)', async () => {
    mLive.mockResolvedValue(new Map());
    const cat = await getLiveRuleCatalog();
    expect(cat.has('10-42')).toBe(true);
  });

  it('缓存:TTL 内多次调用只打一次 live API', async () => {
    mLive.mockResolvedValue(new Map([['10-42', liveRule('10-42', 'CDG永不回流。')]]));
    await getLiveRuleCatalog();
    await getLiveRuleCatalog();
    expect(mLive).toHaveBeenCalledTimes(1);
  });
});
