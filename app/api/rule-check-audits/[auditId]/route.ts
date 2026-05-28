// GET /api/rule-check-audits/[auditId] — Q架构纠偏后:Prisma 读 audit/flag,Neo4j 读实体图
//
// 数据合并:
//   - Prisma: audit + flags + parsed_resume_json + user_prompt + llm_raw_text + lineage
//   - Neo4j: 通过 candidate_id / resume_id / jr_id soft link 拉关联实体节点的精简版

import { NextResponse } from 'next/server';
import neo4j, { type Driver } from 'neo4j-driver';
import { prisma } from '@/server/db';
import { severityForRuleId } from '@/lib/rule-check/ontology';

export const dynamic = 'force-dynamic';

export type RuleCheckFlagRow = {
  flag_id: string;
  rule_id: string;
  rule_name_snapshot: string;
  severity: string;
  applicable: boolean;
  result: string;
  evidence: string;
  next_action: string;
  /**
   * true = 这条 flag 在 RuleCheckFlag 表里没找到,是从 llm_raw_text 的
   * rule_flags[] 里抠出来回填的。早期 writer 过滤掉 applicable=false 的 flag,
   * 导致 DB 只有 16 条但 LLM 实际输出 27 条 — 用 raw fallback 让前端能完整渲染。
   */
  from_raw_fallback?: boolean;
};

export type RuleCheckAuditDetail = {
  audit_id: string;
  decision: 'PASS' | 'FAIL';
  llm_decision: string;
  created_at: string;
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  job_requisition_id: string;
  trace_id: string | null;
  client_name: string;
  /** Readable client name resolved at read-time from partner-pg `client`
   *  (the audit only persists the raw client_id). null when unresolved. */
  client_display_name: string | null;
  business_group: string | null;
  studio: string | null;
  llm_model: string;
  llm_duration_ms: number;
  llm_prompt_tokens: number | null;
  llm_completion_tokens: number | null;
  parse_error: string | null;
  rules_evaluated: number;
  rules_total_in_ontology: number;
  rule_source: string;
  partial_resume_fields: string[];
  failure_reasons: string[];
  filtered_out_rules: Array<{
    rule_id: string;
    rule_name: string;
    applicable_client: string;
    applicable_department: string;
    executor: string;
    reason: string;
  }>;
  /** 三层抓取证据:为何纳入/排除每条规则。 */
  rule_provenance: Array<{
    rule_id: string;
    tier: 'general' | 'client' | 'department';
    included: boolean;
    reason: string;
  }>;
  user_prompt: string | null;
  system_prompt: string | null;
  llm_raw_text: string | null;
  resume_augmentation: string | null;
  parsed_resume_full: Record<string, unknown> | null;
  job_requisition_full: Record<string, unknown> | null;
  flags: RuleCheckFlagRow[];
  // Neo4j 实体 anchor 精简版(图查询友好)
  candidate_snapshot: Record<string, unknown> | null;
  resume_snapshot: Record<string, unknown> | null;
  jr_snapshot: Record<string, unknown> | null;
  // Lineage
  parent_audit_id: string | null;
  child_audit_ids: string[];
};

export type RuleCheckAuditDetailResponse =
  | { ok: true; detail: RuleCheckAuditDetail }
  | { ok: false; reason: 'not_found' | 'error'; error?: string };

let __driver: Driver | null = null;
function getNeo4jDriver(): Driver | null {
  if (__driver) return __driver;
  const uri = process.env.NEO4J_INSTANCE_URI ?? process.env.RAAS_LINKS_NEO4J_URI;
  const user = process.env.NEO4J_INSTANCE_USER ?? process.env.RAAS_LINKS_NEO4J_USER;
  const password =
    process.env.NEO4J_INSTANCE_PASSWORD ?? process.env.RAAS_LINKS_NEO4J_PASSWORD;
  if (!uri || !user || !password) return null;
  __driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    connectionTimeout: 5_000,
    disableLosslessIntegers: true,
  });
  return __driver;
}

async function fetchEntitySnapshots(
  candidate_id: string,
  resume_id: string,
  job_requisition_id: string,
): Promise<{
  candidate: Record<string, unknown> | null;
  resume: Record<string, unknown> | null;
  jr: Record<string, unknown> | null;
}> {
  const driver = getNeo4jDriver();
  if (!driver) return { candidate: null, resume: null, jr: null };
  const database = process.env.NEO4J_INSTANCE_DATABASE ?? process.env.RAAS_LINKS_NEO4J_DATABASE ?? 'neo4j';
  const session = driver.session({ database });
  try {
    const r = await session.run(
      `OPTIONAL MATCH (c:Candidate {candidate_id: $cid})
       OPTIONAL MATCH (re:Resume {resume_id: $rid})
       OPTIONAL MATCH (j:Job_Requisition {job_requisition_id: $jrid})
       RETURN c, re, j`,
      { cid: candidate_id, rid: resume_id, jrid: job_requisition_id },
    );
    if (r.records.length === 0) return { candidate: null, resume: null, jr: null };
    const rec = r.records[0];
    return {
      candidate: (rec.get('c') as { properties?: Record<string, unknown> } | null)?.properties ?? null,
      resume: (rec.get('re') as { properties?: Record<string, unknown> } | null)?.properties ?? null,
      jr: (rec.get('j') as { properties?: Record<string, unknown> } | null)?.properties ?? null,
    };
  } catch {
    return { candidate: null, resume: null, jr: null };
  } finally {
    await session.close().catch(() => {});
  }
}

function parseJsonField(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseStringArray(v: string | null): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseFilteredOut(v: string | null): RuleCheckAuditDetail['filtered_out_rules'] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseProvenance(v: string | null): RuleCheckAuditDetail['rule_provenance'] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 从 llm_raw_text 抠 rule 结果 —— audit row 漏写时(早期 writer 过滤掉
 * applicable=false)用来还原完整规则评估。LLM raw 始终是全的,DB 才是被裁的。
 *
 * 兼容两种 LLM 输出形状:
 *   - 新版(rule-check runner.ts): `rule_results: [{rule_id, status, reason?}]`
 *     status: pass | fail | insufficient_info | not_triggered
 *   - 老版(早期 rule_flags shape): `rule_flags: [{rule_id, severity, applicable, result, evidence, next_action}]`
 */
type RawFlag = {
  rule_id: string;
  rule_name?: string;
  severity?: string;
  applicable?: boolean;
  result?: string;
  evidence?: string;
  next_action?: string;
};

/** Map LLM rule_results.status → RuleCheckFlag.result (legacy uppercase). */
function statusToResult(status: string): string {
  const s = status.toLowerCase();
  if (s === 'pass') return 'PASS';
  if (s === 'fail') return 'FAIL';
  if (s === 'insufficient_info') return 'INSUFFICIENT_INFO';
  if (s === 'not_triggered') return 'NOT_TRIGGERED';
  if (s === 'review' || s === 'pending') return 'REVIEW';
  return status.toUpperCase();
}

function statusToApplicable(status: string): boolean {
  const s = status.toLowerCase();
  // 只有 not_triggered 算"规则不适用此场景";其他(pass/fail/insufficient_info)都是 applicable
  return s !== 'not_triggered';
}

const VALID_NEXT_ACTIONS = new Set(['continue', 'block', 'supplement', 'review']);

/** status → 下一步动作默认映射(与 runner.defaultNextAction 对齐)。 */
function statusToNextAction(status: string): string {
  switch (status.toLowerCase()) {
    case 'fail':
      return 'block';
    case 'insufficient_info':
      return 'supplement';
    case 'pending':
      return 'review';
    default:
      return 'continue';
  }
}

export function extractRawFlagsByRuleId(llmRawText: string | null): Map<string, RawFlag> {
  const out = new Map<string, RawFlag>();
  if (!llmRawText || !llmRawText.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(llmRawText);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;

  // 新版: rule_results
  const ruleResults = (parsed as { rule_results?: unknown }).rule_results;
  if (Array.isArray(ruleResults)) {
    for (const r of ruleResults) {
      if (!r || typeof r !== 'object') continue;
      const o = r as {
        rule_id?: unknown;
        status?: unknown;
        reason?: unknown;
        rule_name?: unknown;
        next_action?: unknown;
      };
      if (typeof o.rule_id !== 'string' || !o.rule_id) continue;
      const status = typeof o.status === 'string' ? o.status : 'not_triggered';
      // next_action: 用 LLM 给的合法值,否则按 status 推导(不再硬编码空串 →
      // UI 因果链第②步不再显示"(未给)")。
      const nextAction =
        typeof o.next_action === 'string' && VALID_NEXT_ACTIONS.has(o.next_action)
          ? o.next_action
          : statusToNextAction(status);
      out.set(o.rule_id, {
        rule_id: o.rule_id,
        rule_name: typeof o.rule_name === 'string' ? o.rule_name : undefined,
        // LLM rule_results 不带 severity —— 查 rule catalog 拿真值,别再硬编码
        // flag_only(否则 terminal 阻断规则会被误显成"提示规则不影响推进")。
        severity: severityForRuleId(o.rule_id),
        applicable: statusToApplicable(status),
        result: statusToResult(status),
        evidence: typeof o.reason === 'string' ? o.reason : '',
        next_action: nextAction,
      });
    }
    if (out.size > 0) return out;
  }

  // 老版(legacy): rule_flags
  const flags = (parsed as { rule_flags?: unknown }).rule_flags;
  if (Array.isArray(flags)) {
    for (const f of flags) {
      if (!f || typeof f !== 'object') continue;
      const r = f as RawFlag;
      if (typeof r.rule_id !== 'string' || !r.rule_id) continue;
      out.set(r.rule_id, r);
    }
  }
  return out;
}

/**
 * 把 DB 拉的 flag rows + llm_raw_text 的全量 rule_flags 合并:
 *   - DB 里已有的 rule_id 优先(权威)
 *   - DB 里缺的(早期被过滤掉的 NOT_APPLICABLE)从 raw 抠出来补,标 from_raw_fallback=true
 */
export function mergeFlagsWithRawFallback(
  dbFlags: RuleCheckFlagRow[],
  rawFlagsByRuleId: Map<string, RawFlag>,
  auditId: string,
): RuleCheckFlagRow[] {
  if (rawFlagsByRuleId.size === 0) return dbFlags;
  const presentRuleIds = new Set(dbFlags.map((f) => f.rule_id));
  const recovered: RuleCheckFlagRow[] = [];
  for (const [ruleId, raw] of rawFlagsByRuleId) {
    if (presentRuleIds.has(ruleId)) continue;
    recovered.push({
      flag_id: `${auditId}::${ruleId}::raw`,
      rule_id: ruleId,
      rule_name_snapshot: raw.rule_name ?? '',
      severity: typeof raw.severity === 'string' ? raw.severity : 'flag_only',
      applicable: Boolean(raw.applicable),
      result: typeof raw.result === 'string' ? raw.result : 'NOT_APPLICABLE',
      evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
      next_action: typeof raw.next_action === 'string' ? raw.next_action : '',
      from_raw_fallback: true,
    });
  }
  if (recovered.length === 0) return dbFlags;
  return [...dbFlags, ...recovered].sort((a, b) =>
    a.rule_id.localeCompare(b.rule_id),
  );
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ auditId: string }> },
) {
  const { auditId } = await ctx.params;
  try {
    const audit = await prisma.ruleCheckAudit.findUnique({
      where: { audit_id: auditId },
      include: { flags: true },
    });
    if (!audit) {
      return NextResponse.json<RuleCheckAuditDetailResponse>({
        ok: false,
        reason: 'not_found',
      });
    }

    // 并行查 Neo4j 实体 + 子 audit + 客户可读名(partner-pg)
    const [entities, children] = await Promise.all([
      fetchEntitySnapshots(audit.candidate_id, audit.resume_id, audit.job_requisition_id),
      prisma.ruleCheckAudit.findMany({
        where: { parent_audit_id: auditId },
        select: { audit_id: true },
      }),
    ]);

    const dbFlags: RuleCheckFlagRow[] = audit.flags.map((f) => ({
      flag_id: f.flag_id,
      rule_id: f.rule_id,
      rule_name_snapshot: f.rule_name_snapshot,
      severity: f.severity,
      applicable: f.applicable,
      result: f.result,
      evidence: f.evidence ?? '',
      next_action: f.next_action ?? '',
    }));

    // 兜底:从 llm_raw_text 抠 LLM 全量输出,把 DB 漏写的 flag(早期 writer 过滤了
    // applicable=false 的 NOT_APPLICABLE)合进来,让前端能完整渲染 27 条评估结果。
    const rawFlagsByRuleId = extractRawFlagsByRuleId(audit.llm_raw_text);
    const flags = mergeFlagsWithRawFallback(dbFlags, rawFlagsByRuleId, audit.audit_id).sort(
      (a, b) => a.rule_id.localeCompare(b.rule_id),
    );

    const detail: RuleCheckAuditDetail = {
      audit_id: audit.audit_id,
      decision: audit.decision as 'PASS' | 'FAIL',
      llm_decision: audit.llm_decision,
      created_at: audit.created_at.toISOString(),
      upload_id: audit.upload_id,
      candidate_id: audit.candidate_id,
      resume_id: audit.resume_id,
      job_requisition_id: audit.job_requisition_id,
      trace_id: audit.trace_id,
      client_name: audit.client_name ?? '',
      // Persisted at write-time (no live partner-pg query → no ETIMEDOUT on read).
      client_display_name: audit.client_display_name ?? null,
      business_group: audit.business_group,
      studio: audit.studio,
      llm_model: audit.llm_model,
      llm_duration_ms: audit.llm_duration_ms,
      llm_prompt_tokens: audit.llm_prompt_tokens,
      llm_completion_tokens: audit.llm_completion_tokens,
      parse_error: audit.parse_error,
      rules_evaluated: audit.rules_evaluated,
      rules_total_in_ontology: audit.rules_total_in_ontology,
      rule_source: audit.rule_source,
      partial_resume_fields: parseStringArray(audit.partial_resume_fields),
      failure_reasons: parseStringArray(audit.failure_reasons),
      filtered_out_rules: parseFilteredOut(audit.filtered_out_rules),
      rule_provenance: parseProvenance(audit.rule_provenance),
      user_prompt: audit.user_prompt,
      system_prompt: audit.system_prompt,
      llm_raw_text: audit.llm_raw_text,
      resume_augmentation: audit.resume_augmentation,
      parsed_resume_full: parseJsonField(audit.parsed_resume_json),
      job_requisition_full: parseJsonField(audit.job_requisition_json),
      flags,
      candidate_snapshot: entities.candidate,
      resume_snapshot: entities.resume,
      jr_snapshot: entities.jr,
      parent_audit_id: audit.parent_audit_id,
      child_audit_ids: children.map((c) => c.audit_id),
    };
    return NextResponse.json<RuleCheckAuditDetailResponse>({ ok: true, detail });
  } catch (e) {
    return NextResponse.json<RuleCheckAuditDetailResponse>({
      ok: false,
      reason: 'error',
      error: (e as Error).message.slice(0, 300),
    });
  }
}
