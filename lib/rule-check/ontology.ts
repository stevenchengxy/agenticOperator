// Ontology loader + classifier + severity inferer for rule-check.
//
// Production:JSON 文件 only(rules.json 与 ontology-lab/data/rules_20260330.json 1:1)。
// Neo4j 直读模式留给 POC,生产里若要切回 Neo4j,通过 Ontology API HTTP 拉
// (见 docs/neo4j-instance-storage-plan.md)— 那是另一个 PR。

import rulesData from './rules.json';
import type {
  ClassifiedRules,
  OntologyDims,
  Rule,
  Severity,
} from './types';

interface RawRule {
  id: string;
  specificScenarioStage?: string;
  businessLogicRuleName?: string;
  applicableClient?: string;
  applicableDepartment?: string;
  submissionCriteria?: string;
  standardizedLogicRule?: string;
  relatedEntities?: string[];
  businessBackgroundReason?: string;
  ruleSource?: string;
  executor: 'Agent' | 'Human';
}

let CACHED_ALL_RULES: Rule[] | null = null;

// 跟 ontology-source.ts:inferSeverityFallback 保持同款正则(逻辑统一)。
// 调用方在 normalizeRaw 里会拼接 name + criteria + logic 三字段一起扫。
function inferSeverity(text: string): Severity {
  if (
    /(?:立即|直接)?(?:终止|拦截|阻断|拒绝)(?:后续)?(?:匹配|推荐|流程)?|一票否决|不予录用|不予推荐|禁止(?:推荐|跨室)|视为不匹配|标记.{0,8}不匹配/.test(
      text,
    )
  ) {
    return 'terminal';
  }
  if (
    /立即挂起|暂停|挂起|锁定推荐|待\s?HSM|需\s?HSM|由\s?HSM|发送系统通知|审核提醒|待办任务|人工核查|待确认|招聘专员复核/.test(
      text,
    )
  ) {
    return 'needs_human';
  }
  return 'flag_only';
}

function normalizeRaw(r: RawRule): Rule {
  const standardizedLogicRule = r.standardizedLogicRule ?? '';
  return {
    id: r.id,
    specificScenarioStage: r.specificScenarioStage ?? '',
    businessLogicRuleName: r.businessLogicRuleName ?? '',
    applicableClient: r.applicableClient ?? '通用',
    applicableDepartment: r.applicableDepartment ?? 'N/A',
    submissionCriteria: r.submissionCriteria ?? '',
    standardizedLogicRule,
    relatedEntities: r.relatedEntities ?? [],
    businessBackgroundReason: r.businessBackgroundReason ?? '',
    ruleSource: r.ruleSource ?? '',
    executor: r.executor,
    // 扫 name + criteria + logic 三字段(避免漏掉规则名里的"一票否决"等)
    severity: inferSeverity(
      `${r.businessLogicRuleName ?? ''}\n${r.submissionCriteria ?? ''}\n${standardizedLogicRule}`,
    ),
  };
}

/** Load all matchResume rules (id starts with "10-") from bundled JSON. */
export function loadAllRules(): Rule[] {
  if (CACHED_ALL_RULES) return CACHED_ALL_RULES;
  const data = rulesData as { rules: RawRule[] };
  const matchResumeRaw = data.rules.filter((r) => r.id.startsWith('10-'));
  CACHED_ALL_RULES = matchResumeRaw.map(normalizeRaw);
  return CACHED_ALL_RULES;
}

function matchesDepartment(applicableDept: string, queryBg: string | null): boolean {
  if (!applicableDept) return true;
  const normalized = applicableDept.trim();
  if (normalized === 'N/A' || normalized === '通用' || normalized === '') return true;
  const allowed = normalized
    .split(/[、,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  if (!queryBg) return false;
  return allowed.includes(queryBg);
}

function matches(r: Rule, q: OntologyDims): boolean {
  if (r.executor !== 'Agent') return false;
  if (r.applicableClient !== '通用' && r.applicableClient !== q.client_id) return false;
  if (!matchesDepartment(r.applicableDepartment, q.business_group)) return false;
  return true;
}

/** Filter rules applicable to the given (client × business_group × studio) dimensions. */
export function filterRules(dims: OntologyDims): { rules: Rule[]; total: number } {
  const all = loadAllRules();
  const filtered = all.filter((r) => matches(r, dims));
  return { rules: filtered, total: all.length };
}

/**
 * Same filter logic as `filterRules`, but takes an externally-loaded rule set
 * (例如从 Ontology API 拿到的 rule_id whitelist + JSON metadata 拼合后的结果)。
 * Phase 2 引入 — `runner.ts` 调 `ontology-source.fetchRulesForMatchResume()`
 * 拿到 rules 后用这个做 dim 过滤。
 */
export function applyClientFilter(rules: Rule[], dims: OntologyDims): Rule[] {
  return rules.filter((r) => matches(r, dims));
}

/**
 * 同 applyClientFilter,但额外返回被过滤掉的规则 + 每条的过滤原因。
 * 前端 drawer 用这个证明 "ontology N 条全审视过,M 条因 X 跳过"。
 */
export function applyClientFilterWithReasons(
  rules: Rule[],
  dims: OntologyDims,
): {
  kept: Rule[];
  filtered_out: Array<{
    rule_id: string;
    rule_name: string;
    applicable_client: string;
    applicable_department: string;
    executor: string;
    reason: string;
  }>;
} {
  const kept: Rule[] = [];
  const filtered_out: Array<{
    rule_id: string;
    rule_name: string;
    applicable_client: string;
    applicable_department: string;
    executor: string;
    reason: string;
  }> = [];

  for (const r of rules) {
    if (r.executor !== 'Agent') {
      filtered_out.push({
        rule_id: r.id,
        rule_name: r.businessLogicRuleName,
        applicable_client: r.applicableClient,
        applicable_department: r.applicableDepartment,
        executor: r.executor,
        reason: `executor="${r.executor}" — 这条规则由人工(${r.executor === 'Human' ? 'HSM/recruiter' : r.executor})执行,不属于 rule-check LLM 范围,跳过`,
      });
      continue;
    }
    if (r.applicableClient !== '通用' && r.applicableClient !== dims.client_id) {
      filtered_out.push({
        rule_id: r.id,
        rule_name: r.businessLogicRuleName,
        applicable_client: r.applicableClient,
        applicable_department: r.applicableDepartment,
        executor: r.executor,
        reason: `applicableClient="${r.applicableClient}",本 audit 的 client_id="${dims.client_id ?? '(未知)'}" 不在列,跳过`,
      });
      continue;
    }
    if (!matchesDepartment(r.applicableDepartment, dims.business_group)) {
      filtered_out.push({
        rule_id: r.id,
        rule_name: r.businessLogicRuleName,
        applicable_client: r.applicableClient,
        applicable_department: r.applicableDepartment,
        executor: r.executor,
        reason: `applicableDepartment="${r.applicableDepartment}",本 audit 的 business_group="${dims.business_group ?? '(未知)'}" 不在列,跳过`,
      });
      continue;
    }
    kept.push(r);
  }
  return { kept, filtered_out };
}

function hasDepartmentCondition(r: Rule): boolean {
  const d = r.applicableDepartment.trim();
  return d !== '' && d !== 'N/A' && d !== '通用';
}

/** Classify into general / client / department buckets + severity index. */
export function classifyRules(rules: Rule[]): ClassifiedRules {
  const general = rules.filter((r) => r.applicableClient === '通用');
  const client_level = rules.filter(
    (r) => r.applicableClient !== '通用' && !hasDepartmentCondition(r),
  );
  const department_level = rules.filter(
    (r) => r.applicableClient !== '通用' && hasDepartmentCondition(r),
  );
  return {
    general,
    client_level,
    department_level,
    by_severity: {
      terminal: rules.filter((r) => r.severity === 'terminal'),
      needs_human: rules.filter((r) => r.severity === 'needs_human'),
      flag_only: rules.filter((r) => r.severity === 'flag_only'),
    },
  };
}

// ─── client_id / business_group 归一化(来自 RaasRequirement 的扩展字段) ───
//
// RAAS getRequirementsAgentView 实际返回的字段(2026-05-12 实测):
//   client_id: "f592f8ce-..."           ← UUID,推不出客户名
//   client_name: "腾讯"                  ← 客户中文名,直接用
//   client_department_id: "654aa45b-..." ← UUID,推不出 BG
//   first_level_department: "WXG 微信事业群" ← BG 在这里(文本前几个字符)
//   second_level_department: null        ← studio / 子部门
//
// 老 e2e fixtures 用的是 ID 字符串("CLI_TENCENT" / "CLI_TENCENT_IEG_TIANMEI"),
// 下面的实现保留向后兼容:优先读真实 RAAS 字段,fallback 到老的 ID 字符串解析。

/**
 * 客户标识归一化。优先返回中文客户名:
 *   - "腾讯" / "字节" / "字节跳动" → 原样
 *   - "CLI_TENCENT" / "TENCENT_xxx" → "腾讯"(老 fixture 兼容)
 *   - "CLI_BYTEDANCE" / "BYTE_xxx" → "字节"
 *   - UUID 或未知格式 → 原样返回(rule 过滤会跳客户级规则)
 */
export function normalizeClientId(id: string): string {
  if (!id) return '';
  const trimmed = id.trim();
  // 中文客户名直接放行
  if (trimmed === '腾讯' || trimmed === '字节' || trimmed === '字节跳动') {
    return trimmed === '字节跳动' ? '字节' : trimmed;
  }
  const upper = trimmed.toUpperCase();
  if (upper.includes('TENCENT')) return '腾讯';
  if (upper.includes('BYTEDANCE') || upper.includes('BYTE')) return '字节';
  return trimmed;
}

const BG_CODES = ['IEG', 'PCG', 'WXG', 'CDG', 'CSIG', 'TEG', 'TIKTOK'] as const;

function bgDisplayName(code: string): string {
  return code === 'TIKTOK' ? 'TikTok' : code;
}

/**
 * 在任意字符串里抠 BG 关键字(对应实际 RAAS 字段 `first_level_department`):
 *   "WXG 微信事业群"  → "WXG"
 *   "IEG 互娱事业群"  → "IEG"
 *   "CLI_TENCENT_IEG_TIANMEI" → "IEG"(老 fixture 兼容)
 *
 * 匹配优先级:
 *   1) 以 BG 码开头(允许后跟空格 / 中文)         ← 命中真实 RAAS first_level_department
 *   2) `_BG_` / `_BG` 包裹(老 fixture ID 形式)
 *   3) 全字符串 toUpperCase 后包含 BG token       ← 兜底
 */
export function deriveBg(text?: string | null): string | null {
  if (!text) return null;
  const upper = text.toUpperCase().trim();
  if (!upper) return null;
  // ① BG 码开头 — RAAS 风格 "WXG 微信事业群"
  for (const bg of BG_CODES) {
    if (upper === bg || upper.startsWith(`${bg} `) || upper.startsWith(`${bg}-`)) {
      return bgDisplayName(bg);
    }
  }
  // ② `_BG_` / `_BG` 形式 — 老 fixture ID "CLI_TENCENT_IEG_TIANMEI"
  for (const bg of BG_CODES) {
    if (upper.includes(`_${bg}_`) || upper.endsWith(`_${bg}`)) {
      return bgDisplayName(bg);
    }
  }
  // ③ 兜底:文本里出现 BG 码作为词边界
  for (const bg of BG_CODES) {
    const re = new RegExp(`\\b${bg}\\b`);
    if (re.test(upper)) return bgDisplayName(bg);
  }
  return null;
}

/** @deprecated 老接口名,仅 client_department_id 风格 ID 字符串使用。新代码用 `deriveBg`。 */
export function deriveBgFromDepartmentId(deptId?: string | null): string | null {
  return deriveBg(deptId);
}

/** Extract (client × business_group × studio) dims from a RaasRequirement-shaped object. */
export function extractDims(jr: Record<string, unknown>): OntologyDims {
  const pickStr = (k: string): string => (typeof jr[k] === 'string' ? (jr[k] as string).trim() : '');

  // ── client_id ─────────────────────────────────────────────────
  // 优先级: client_name(RAAS 实际字段) > client_id(UUID 或老 fixture ID)
  const clientName = pickStr('client_name');
  const clientId = pickStr('client_id');
  const rawClient = clientName || clientId;

  // ── business_group ────────────────────────────────────────────
  // 优先级:
  //   1) client_business_group / business_group(显式字段,partner 后期可能加)
  //   2) first_level_department(RAAS 实际字段,如 "WXG 微信事业群")
  //   3) client_department_id 字符串解析(老 fixture 兼容)
  const explicitBg = pickStr('client_business_group') || pickStr('business_group');
  const firstLevelDept = pickStr('first_level_department');
  const deptId = pickStr('client_department_id');

  // ── studio ────────────────────────────────────────────────────
  // 优先级: client_studio > second_level_department
  const studio = pickStr('client_studio') || pickStr('second_level_department') || null;

  return {
    client_id: normalizeClientId(rawClient),
    business_group:
      (explicitBg ? deriveBg(explicitBg) ?? explicitBg : null) ??
      deriveBg(firstLevelDept) ??
      deriveBg(deptId),
    studio: studio || null,
  };
}
