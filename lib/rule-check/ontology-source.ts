// Ontology rule source — Phase 2 unified entry。
//
// 之前 ontology.ts 只读 rules.json 静态文件。Phase 2 加上"调主仓 Ontology API
// live 拿"作为 primary,JSON 作为 fallback。当 API 在但跟 JSON 数据不一致时,
// 用 API 的 rule_id 集合 + JSON 的 metadata(JSON 暂时是 applicableDepartment
// 等字段的 source-of-truth,因为叶洋当前 ActionRule type 还没 surface 这些字段
// — Phase 3 推他加 gating_severity 时一并解决)。
//
// 策略:
//   1. ONTOLOGY_API_{BASE,TOKEN} 任一缺失 → 直接 JSON fallback
//   2. 调叶洋的 fetchAction() → 成功:用 API 的 rule_id whitelist
//                                + JSON 的 metadata 拼出 Rule[]
//                              失败:log warning + JSON fallback
//   3. 上报 drift(API 有 JSON 没有 / JSON 有 API 没有)给 audit + console

import { fetchAction, OntologyGenError } from '@/lib/ontology-gen';

import { loadAllRules } from './ontology';
import type { Rule } from './types';

export interface FetchRulesResult {
  /** matchResume rules,已经做完 severity 推断(从 JSON metadata 来),
   * 但**未做** (client × business_group) 过滤(那是 filterRules 的事)。 */
  rules: Rule[];
  /** 哪条路径产出了 rules:用 API live 数据还是退到 JSON 静态。 */
  source: 'ontology-api' | 'json-fallback';
  /** 如果 API 和 JSON 的 rule_id 集合不一致,记录差异。两边都为空就是 undefined。 */
  drift?: {
    only_in_api: string[]; // API 返回了但 JSON 没有 → 我们 fallback metadata 缺失
    only_in_json: string[]; // JSON 里有但 API 没返回 → 规则可能在 Neo4j 已删除
  };
  /** 如果 API 出错,记录错误简述(类型 + message)。 */
  api_error?: string;
  /** Step-grouped view, only emitted on the ontology-api success path. */
  steps?: import('./types').MatchResumeStepGroup[];
}

export async function fetchRulesForMatchResume(): Promise<FetchRulesResult> {
  const jsonRules = loadAllRules();

  // 1. Env 检查 — 没配 API base / token 直接 fallback,不产生网络请求
  const apiBase = process.env.ONTOLOGY_API_BASE;
  const apiToken = process.env.ONTOLOGY_API_TOKEN;
  if (!apiBase || !apiToken) {
    return { rules: jsonRules, source: 'json-fallback' };
  }

  // 2. 调叶洋的 fetchAction(它在主仓 lib/ontology-gen/fetch.ts)
  try {
    const action = await fetchAction({
      actionRef: 'matchResume',
      domain: 'RAAS-v1',
      apiBase,
      apiToken,
      timeoutMs: 5000,
    });

    // 提取 API 返回的所有 rule_ids(来自 action.actionSteps[].rules[].id)
    const apiRuleIds = new Set<string>();
    for (const step of action.actionSteps ?? []) {
      for (const rule of step.rules ?? []) {
        if (typeof rule.id === 'string' && rule.id.trim()) {
          apiRuleIds.add(rule.id);
        }
      }
    }

    if (apiRuleIds.size === 0) {
      // API 在但没返回任何 rule_id — 视为契约错,fallback 而非用空规则集跑 LLM
      return {
        rules: jsonRules,
        source: 'json-fallback',
        api_error: 'API returned 0 rules',
      };
    }

    // 3. API rule_id whitelist + JSON metadata 拼合 — JSON 暂时是
    // applicableDepartment / standardizedLogicRule 等字段的 source-of-truth
    const jsonIndex = new Map(jsonRules.map((r) => [r.id, r]));
    const rules: Rule[] = [];
    const onlyInApi: string[] = [];
    for (const ruleId of apiRuleIds) {
      const meta = jsonIndex.get(ruleId);
      if (meta) {
        rules.push(meta);
      } else {
        onlyInApi.push(ruleId);
      }
    }
    const onlyInJson = jsonRules.map((r) => r.id).filter((id) => !apiRuleIds.has(id));

    const drift =
      onlyInApi.length > 0 || onlyInJson.length > 0
        ? { only_in_api: onlyInApi, only_in_json: onlyInJson }
        : undefined;

    if (drift) {
      console.warn(
        `[rule-check/ontology-source] DRIFT detected — ` +
          `only_in_api=${drift.only_in_api.length} ` +
          `only_in_json=${drift.only_in_json.length}. ` +
          `API IDs missing JSON metadata are excluded from this run; ` +
          `please regenerate rules.json from ontology to resolve.`,
      );
    }

    const stepsGrouped: import('./types').MatchResumeStepGroup[] = [];
    for (const step of action.actionSteps ?? []) {
      const stepRules: Rule[] = [];
      for (const r of step.rules ?? []) {
        const meta = typeof r.id === 'string' ? jsonIndex.get(r.id) : undefined;
        if (meta) stepRules.push(meta);
      }
      if (stepRules.length === 0) continue;
      stepsGrouped.push({
        step_id: typeof step.id === 'string' ? step.id : '',
        order: Number(step.order ?? '0'),
        name: typeof step.name === 'string' ? step.name : '',
        description: typeof step.description === 'string' ? step.description : '',
        condition: typeof step.condition === 'string' ? step.condition : '',
        rules: stepRules,
      });
    }
    stepsGrouped.sort((a, b) => a.order - b.order);

    return { rules, source: 'ontology-api', drift, steps: stepsGrouped };
  } catch (err) {
    // 4. 任意错误 → fallback。区分 OntologyGenError(契约/权限/服务侧)和其他
    const errType =
      err instanceof OntologyGenError ? err.name : err instanceof Error ? err.name : 'Unknown';
    const errMsg = err instanceof Error ? err.message : String(err);
    const summary = `${errType}: ${errMsg.slice(0, 200)}`;
    console.warn(
      `[rule-check/ontology-source] ontology API call failed, falling back to JSON: ${summary}`,
    );
    return {
      rules: jsonRules,
      source: 'json-fallback',
      api_error: summary,
    };
  }
}
