// Ontology loader + classifier + severity inferer for rule-check.
//
// Production:JSON 文件 only(rules.json 与 ontology-lab/data/rules_20260330.json 1:1)。
// Neo4j 直读模式留给 POC,生产里若要切回 Neo4j,通过 Ontology API HTTP 拉
// (见 docs/ontology/neo4j-instance-storage-plan.md)— 那是另一个 PR。

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
  enforcementLevel?: 'mandatory' | 'optional';
  failurePolicy?: 'block' | 'warn';
}

let CACHED_ALL_RULES: Rule[] | null = null;

function deriveLegacySeverity(
  enforcementLevel: 'mandatory' | 'optional' | undefined,
  failurePolicy: 'block' | 'warn' | undefined,
): Severity {
  if (enforcementLevel === 'optional') return 'flag_only';
  if (enforcementLevel === 'mandatory' && failurePolicy === 'block') return 'terminal';
  if (enforcementLevel === undefined || failurePolicy === undefined) return 'flag_only';
  return 'needs_human';
}

export function normalizeRawRule(r: RawRule): Rule {
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
    enforcementLevel: r.enforcementLevel,
    failurePolicy: r.failurePolicy,
    severity: deriveLegacySeverity(r.enforcementLevel, r.failurePolicy),
  };
}

/** Load all matchResume rules (id starts with "10-") from bundled JSON. */
export function loadAllRules(): Rule[] {
  if (CACHED_ALL_RULES) return CACHED_ALL_RULES;
  const data = rulesData as { rules: RawRule[] };
  const matchResumeRaw = data.rules.filter((r) => r.id.startsWith('10-'));
  CACHED_ALL_RULES = matchResumeRaw.map(normalizeRawRule);
  return CACHED_ALL_RULES;
}

/**
 * 查 rule catalog 的真实 severity(terminal / flag_only / needs_human)。
 * audit detail API 从 llm_raw 回填 flag 时,LLM 输出不带 severity,之前一律
 * 硬编码 'flag_only',把 terminal 阻断规则误显成"提示规则不影响推进"。
 * 用 rule_id 查 catalog 拿真值;查不到才退回 flag_only。
 */
export function severityForRuleId(ruleId: string): Severity {
  const rule = loadAllRules().find((r) => r.id === ruleId);
  return rule?.severity ?? 'flag_only';
}

export function matchesDepartment(applicableDept: string, queryBg: string | null): boolean {
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

/** "CLI_TENCENT" → "腾讯", "CLI_BYTEDANCE" → "字节",其余原样。 */
export function normalizeClientId(id: string): string {
  if (!id) return '';
  const upper = id.toUpperCase();
  if (upper.includes('TENCENT')) return '腾讯';
  if (upper.includes('BYTEDANCE') || upper.includes('BYTE')) return '字节';
  return id;
}

/** "CLI_TENCENT_PCG" / "CLI_TENCENT_IEG_TIANMEI" → "PCG" / "IEG"。 */
export function deriveBgFromDepartmentId(deptId?: string | null): string | null {
  if (!deptId) return null;
  const upper = deptId.toUpperCase();
  for (const bg of ['IEG', 'PCG', 'WXG', 'CDG', 'CSIG', 'TEG', 'TIKTOK']) {
    if (upper.includes(`_${bg}_`) || upper.endsWith(`_${bg}`)) {
      return bg === 'TIKTOK' ? 'TikTok' : bg;
    }
  }
  return null;
}

// sd_org_name 中文(简称/全称都可能)→ BG token 的子串映射。
// 真实 partner-pg JR 的 sd_org_name 是"腾讯互娱事业部"这种简称,跟
// yeyang-runner 里 BG_DISPLAY 的 canonical 全称("互动娱乐事业群")对不上,
// 所以这里用"任一别名子串命中即可"的策略,而不是精确等值。
const ORG_NAME_BG_ALIASES: Array<{ bg: string; aliases: string[] }> = [
  { bg: 'IEG', aliases: ['互娱', '互动娱乐'] },
  { bg: 'PCG', aliases: ['平台与内容', '平台内容'] },
  { bg: 'WXG', aliases: ['微信'] },
  { bg: 'CDG', aliases: ['企业发展'] },
  { bg: 'CSIG', aliases: ['云与智慧产业', '云智', '云与智慧'] },
  { bg: 'TEG', aliases: ['技术工程'] },
];

/** "腾讯互娱事业部" → "IEG";无法识别返回 null。 */
export function deriveBgFromOrgName(orgName?: string | null): string | null {
  if (!orgName || !orgName.trim()) return null;
  const name = orgName.trim();
  for (const { bg, aliases } of ORG_NAME_BG_ALIASES) {
    if (aliases.some((a) => name.includes(a))) return bg;
  }
  return null;
}

/** Extract (client × business_group × studio) dims from a RaasRequirement-shaped object. */
export function extractDims(jr: Record<string, unknown>): OntologyDims {
  const clientId = typeof jr.client_id === 'string' ? jr.client_id : '';
  const explicitBg =
    typeof jr.client_business_group === 'string' && jr.client_business_group.trim()
      ? (jr.client_business_group as string)
      : null;
  const deptId = typeof jr.client_department_id === 'string' ? jr.client_department_id : null;
  const orgName = typeof jr.sd_org_name === 'string' ? jr.sd_org_name : null;
  const studio =
    typeof jr.client_studio === 'string' && jr.client_studio.trim() ? (jr.client_studio as string) : null;

  // 解析顺序:显式 client_business_group → department_id 编码(CLI_*_IEG_*)→
  // sd_org_name 中文兜底。真实 JR 的 department_id 是 UUID,只有 sd_org_name 这条能命中。
  return {
    client_id: normalizeClientId(clientId),
    business_group:
      explicitBg ?? deriveBgFromDepartmentId(deptId) ?? deriveBgFromOrgName(orgName),
    studio,
  };
}
