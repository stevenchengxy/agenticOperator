// 「规则中身」的统一 live 来源 —— 优先 live ontology(Neo4j 经 Allmeta API),
// API 宕/空时回退打包 rules.json(降级但可用)。带短 TTL 缓存,避免每次读都打网络。
//
// 所有展示/校验面(provenance 规则名、被排除规则定义、severity、dashboard grid)
// 都改用这里,不再各自硬编码读打包文件 → 改 Neo4j 立即对齐(下个 TTL 窗口生效)。
import { fetchActionRulesLive } from './api-rule-fetcher';
import { loadAllRules } from './ontology';
import type { Rule, Severity } from './types';

const TTL_MS = 30_000;

let cache: { at: number; byId: Map<string, Rule>; degraded: boolean } | null = null;

/** 测试用:清缓存。 */
export function __resetLiveRuleCatalogCache(): void {
  cache = null;
}

function bundledCatalog(): Map<string, Rule> {
  return new Map(loadAllRules().map((r) => [r.id, r]));
}

/**
 * 取规则目录(按 id),live 优先 + 打包兜底,带 30s 缓存。
 * - live 成功且非空 → 缓存 30s。
 * - live 失败/空 → 用打包兜底,只缓存 5s(尽快重试 live)。
 */
export async function getLiveRuleCatalog(): Promise<Map<string, Rule>> {
  const now = Date.now();
  if (cache && now - cache.at < (cache.degraded ? 5_000 : TTL_MS)) return cache.byId;
  try {
    const live = await fetchActionRulesLive();
    if (live.size > 0) {
      cache = { at: now, byId: live, degraded: false };
      return live;
    }
  } catch {
    // fall through to bundled
  }
  const bundled = bundledCatalog();
  cache = { at: now, byId: bundled, degraded: true };
  return bundled;
}

/** live severity(terminal/flag_only/needs_human);查不到回退 flag_only。 */
export async function severityForRuleIdLive(ruleId: string): Promise<Severity> {
  const cat = await getLiveRuleCatalog();
  return cat.get(ruleId)?.severity ?? 'flag_only';
}
