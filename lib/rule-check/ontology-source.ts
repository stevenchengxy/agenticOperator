// Ontology rule source — 3 路径,按优先级 fallback:
//   1. neo4j-direct  — 直连本地 Neo4j (Cypher MATCH (:Rule)) — 最优,跟用户灌入的
//                       schema 同步。需要 NEO4J_INSTANCE_* env。
//   2. ontology-api  — 调叶洋 fetchAction (主仓 Ontology API :3500) — partner 远程。
//                       需要 ONTOLOGY_API_{BASE,TOKEN} env。
//   3. json-fallback — 读 lib/rule-check/rules.json 静态副本 — 兜底,永远可用。
//
// 当前实现:1 → 2 → 3 按 env 配置链式尝试,第一个成功的赢。
// 配置缺失或失败 → 静默降级,audit.rule_source 记下实际用了哪条。

import neo4j, { type Driver, type Session } from 'neo4j-driver';

import { fetchAction, OntologyGenError } from '@/lib/ontology-gen';
import { getJson } from '@/lib/ontology-gen/client';
import { OntologyNotFoundError } from '@/lib/ontology-gen/errors';

import { loadAllRules } from './ontology';
import type { Rule, Severity } from './types';

const ONTOLOGY_DOMAIN = 'RAAS-v1';

export interface FetchRulesResult {
  /** matchResume rules,已经做完 severity 推断(从 JSON metadata 来),
   * 但**未做** (client × business_group) 过滤(那是 filterRules 的事)。 */
  rules: Rule[];
  /** 哪条路径产出了 rules。 */
  source: 'neo4j-direct' | 'ontology-api' | 'json-fallback';
  /** 如果 API 和 JSON 的 rule_id 集合不一致,记录差异。两边都为空就是 undefined。 */
  drift?: {
    only_in_api: string[];
    only_in_json: string[];
  };
  /** 如果 API/Neo4j 出错,记录错误简述(类型 + message)。 */
  api_error?: string;
}

// ─── Path 1:Neo4j direct ───

let __neo4jDriver: Driver | null = null;

function getNeo4jDriver(): Driver | null {
  if (__neo4jDriver) return __neo4jDriver;
  const uri = process.env.NEO4J_INSTANCE_URI ?? process.env.RAAS_LINKS_NEO4J_URI;
  const user = process.env.NEO4J_INSTANCE_USER ?? process.env.RAAS_LINKS_NEO4J_USER;
  const password =
    process.env.NEO4J_INSTANCE_PASSWORD ?? process.env.RAAS_LINKS_NEO4J_PASSWORD;
  if (!uri || !user || !password) return null;
  try {
    __neo4jDriver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      connectionTimeout: 5_000,
      disableLosslessIntegers: true,
    });
    return __neo4jDriver;
  } catch {
    return null;
  }
}

/**
 * 直接从 Neo4j 查 matchResume 的全部 rules。
 * 我们的 schema loader (scripts/e2e-mock-test/load-ontology-schema.ts) 灌入
 * (:Action)-[:HAS_RULE]->(:Rule),所以从 Action {name:'matchResume'} 出发拉
 * 所有挂载的 Rule 节点最稳。
 *
 * 字段对齐:Neo4j Rule 节点属性是 schema loader 拷贝的 JSON 字段名,直接 cast
 * 成我们的 Rule type 即可。
 */
async function fetchFromNeo4j(): Promise<FetchRulesResult | null> {
  const driver = getNeo4jDriver();
  if (!driver) return null;
  const database = process.env.NEO4J_INSTANCE_DATABASE ?? 'neo4j';
  let session: Session | null = null;
  try {
    session = driver.session({ database });
    const r = await session.run(
      `MATCH (act:Action)
       WHERE act.name = 'matchResume' OR act.id = '10'
       MATCH (act)-[:HAS_RULE]->(rule:Rule)
       RETURN rule {
         .id,
         .specificScenarioStage,
         .businessLogicRuleName,
         .applicableClient,
         .applicableDepartment,
         .submissionCriteria,
         .standardizedLogicRule,
         .relatedEntities,
         .businessBackgroundReason,
         .ruleSource,
         .executor
       } AS rule
       ORDER BY rule.id`,
    );
    if (r.records.length === 0) return null; // 没数据 → 走下一路径
    const rules: Rule[] = r.records.map((rec) => {
      const raw = rec.get('rule') as Record<string, unknown>;
      const stdLogic = (raw.standardizedLogicRule as string) ?? '';
      return {
        id: (raw.id as string) ?? '',
        specificScenarioStage: (raw.specificScenarioStage as string) ?? '',
        businessLogicRuleName: (raw.businessLogicRuleName as string) ?? '',
        applicableClient: (raw.applicableClient as string) ?? '通用',
        applicableDepartment: (raw.applicableDepartment as string) ?? 'N/A',
        submissionCriteria: (raw.submissionCriteria as string) ?? '',
        standardizedLogicRule: stdLogic,
        relatedEntities: (raw.relatedEntities as string[]) ?? [],
        businessBackgroundReason: (raw.businessBackgroundReason as string) ?? '',
        ruleSource: (raw.ruleSource as string) ?? '',
        executor: ((raw.executor as string) ?? 'Agent') as 'Agent' | 'Human',
        // severity 仍走文本推断(Phase 3 陈洋落地 gating_severity 字段后切掉)。
        // 扫规则名 + 触发条件 + 判定逻辑 3 字段拼起来,避免漏掉关键词(如规则 10-5
        // 名字带"一票否决"但 logic 文本没有 → 之前误判为 flag_only)。
        severity: inferSeverityFallback(
          `${(raw.businessLogicRuleName as string) ?? ''}\n${(raw.submissionCriteria as string) ?? ''}\n${stdLogic}`,
        ),
      };
    });
    return { rules, source: 'neo4j-direct' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[rule-check/ontology-source] Neo4j direct failed: ${msg.slice(0, 120)}`);
    return null;
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

// 文本推断 severity 的临时实现(等陈洋 ontology Rule.gating_severity 字段上线后退役)
// 关键词更宽松:覆盖"终止后续...流程"、"标记...为(不匹配/不予录用)"、规则名级别
// 的"一票否决"等(在 caller 拼接 name + criteria + logic 多字段后扫)
function inferSeverityFallback(text: string): Severity {
  // terminal 关键词(命中即整体 FAIL,无人工介入)
  if (
    /(?:立即|直接)?(?:终止|拦截|阻断|拒绝)(?:后续)?(?:匹配|推荐|流程)?|一票否决|不予录用|不予推荐|禁止(?:推荐|跨室)|视为不匹配|标记.{0,8}不匹配/.test(
      text,
    )
  ) {
    return 'terminal';
  }
  // needs_human(命中即整体 FAIL,但下游派人工)
  if (
    /立即挂起|暂停|挂起|锁定推荐|待\s?HSM|需\s?HSM|由\s?HSM|发送系统通知|审核提醒|待办任务|人工核查|待确认|招聘专员复核/.test(
      text,
    )
  ) {
    return 'needs_human';
  }
  return 'flag_only';
}

/**
 * 单条规则查询 — 给前端 audit drawer 点击 rule_flag 展开"完整规则定义"用。
 *
 * 数据源优先级:
 *   1. Allmeta Ontology HTTP API — GET /api/v1/ontology/rules/{ruleId}?domain=RAAS-v1
 *      文档:/Users/yuhancheng/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md §1
 *   2. lib/rule-check/rules.json — API 不可达 / 404 / 配置缺失时兜底,永远可用
 *
 * 不走 Neo4j 直查 — 用户要求"rules 抓取通过 allmetaOntology API"。
 * 找不到(API 404 + JSON 没这条)→ 返回 null,route 上层给 404。
 */
export interface FetchSingleRuleResult {
  rule: Rule;
  source: 'ontology-api' | 'json-fallback';
}

/**
 * Allmeta API 返回的 Rule 节点的"属性袋"形状(schema-agnostic;字段都是
 * server 存什么读什么)。我们只关心 Rule type 需要的几个,其他忽略。
 * relatedEntities 在 Allmeta 通常是 string[](原始数组),但 API 文档说嵌套
 * 对象/对象数组会被 JSON-stringify 存储 — 加 parse 兜底。
 */
interface AllmetaRuleNode {
  id?: string;
  domainId?: string;
  businessLogicRuleName?: string;
  applicableClient?: string;
  applicableDepartment?: string;
  submissionCriteria?: string;
  standardizedLogicRule?: string;
  relatedEntities?: string[] | string;
  businessBackgroundReason?: string;
  ruleSource?: string;
  executor?: string;
  specificScenarioStage?: string;
}

function ruleFromAllmetaNode(raw: AllmetaRuleNode): Rule {
  const stdLogic = raw.standardizedLogicRule ?? '';
  // relatedEntities 可能是 string[] 也可能是 JSON-stringified array(文档 §"flatten rule")
  let relatedEntities: string[] = [];
  if (Array.isArray(raw.relatedEntities)) {
    relatedEntities = raw.relatedEntities.filter(
      (v): v is string => typeof v === 'string',
    );
  } else if (typeof raw.relatedEntities === 'string' && raw.relatedEntities.trim()) {
    try {
      const parsed = JSON.parse(raw.relatedEntities);
      if (Array.isArray(parsed)) {
        relatedEntities = parsed.filter(
          (v): v is string => typeof v === 'string',
        );
      }
    } catch {
      // 不是 JSON,保持 []
    }
  }
  return {
    id: raw.id ?? '',
    specificScenarioStage: raw.specificScenarioStage ?? '',
    businessLogicRuleName: raw.businessLogicRuleName ?? '',
    applicableClient: raw.applicableClient ?? '通用',
    applicableDepartment: raw.applicableDepartment ?? 'N/A',
    submissionCriteria: raw.submissionCriteria ?? '',
    standardizedLogicRule: stdLogic,
    relatedEntities,
    businessBackgroundReason: raw.businessBackgroundReason ?? '',
    ruleSource: raw.ruleSource ?? '',
    executor: (raw.executor ?? 'Agent') as 'Agent' | 'Human',
    // severity 仍走文本推断(Phase 3 陈洋 ontology 落 gating_severity 后退役)
    severity: inferSeverityFallback(
      `${raw.businessLogicRuleName ?? ''}\n${raw.submissionCriteria ?? ''}\n${stdLogic}`,
    ),
  };
}

export async function fetchSingleRule(
  ruleId: string,
): Promise<FetchSingleRuleResult | null> {
  if (!ruleId || typeof ruleId !== 'string' || !ruleId.trim()) return null;

  // ─── Path 1:Allmeta Ontology API ───
  const apiBase = process.env.ONTOLOGY_API_BASE;
  const apiToken = process.env.ONTOLOGY_API_TOKEN;
  if (apiBase && apiToken) {
    try {
      const node = (await getJson({
        apiBase,
        apiToken,
        path: `/api/v1/ontology/rules/${encodeURIComponent(ruleId)}?domain=${encodeURIComponent(ONTOLOGY_DOMAIN)}`,
        timeoutMs: 5000,
      })) as AllmetaRuleNode | null;
      if (node && typeof node === 'object' && typeof node.id === 'string' && node.id.trim()) {
        return { rule: ruleFromAllmetaNode(node), source: 'ontology-api' };
      }
      // API 返回非预期结构 → 走 JSON fallback
    } catch (err) {
      // 404 → 走 JSON 兜底(JSON 可能也没,但起码给个机会)
      // 其他错(timeout / 502 / auth / 网络)→ 走 JSON,但记一行 warn
      if (!(err instanceof OntologyNotFoundError)) {
        const errType =
          err instanceof OntologyGenError ? err.name : err instanceof Error ? err.name : 'Unknown';
        const errMsg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[rule-check/ontology-source] Allmeta API rule lookup failed for ${ruleId}, falling back to JSON: ${errType}: ${errMsg.slice(0, 160)}`,
        );
      }
    }
  }

  // ─── Path 2:JSON fallback ───
  const found = loadAllRules().find((r) => r.id === ruleId);
  if (found) return { rule: found, source: 'json-fallback' };
  return null;
}

export async function fetchRulesForMatchResume(): Promise<FetchRulesResult> {
  const jsonRules = loadAllRules();

  // ─── Path 1:本地 Neo4j 直连(优先,跟用户灌入的 schema 一致) ───
  const neo4jResult = await fetchFromNeo4j();
  if (neo4jResult) {
    return neo4jResult;
  }

  // ─── Path 2:叶洋 Ontology API(partner 远程) ───
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

    return { rules, source: 'ontology-api', drift };
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
