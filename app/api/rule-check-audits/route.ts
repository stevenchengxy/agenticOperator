// GET /api/rule-check-audits — Q架构纠偏后:从 Prisma 读 audit
//
// 旧实现:从 Neo4j MATCH (a:RuleCheckAudit) 查 → 节点重、不支持 SQL 索引
// 新实现:从 Prisma SQLite ruleCheckAudit 表查 → 走索引、有事务、轻量

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { isRuleCheckDomain } from '@/lib/rule-check/domain-scope';
import {
  hasOntologyRuleChecks,
  ontologyAuditList,
  ontologyAuditFacets,
} from '@/lib/rule-check/ontology-audit-source';
import { foldVerdict, applyAuditFacets, type Verdict } from '@/lib/rule-check/audit-facets';
import { agentsForDomain, JR_COMPLIANCE_AGENT_ID, lookupAgent } from '@/lib/rule-check/agent-registry';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';

export const dynamic = 'force-dynamic';

/** A selectable value for one of the audit-list facets (execution agent / stage). */
export type AuditFacetOption = { id: string; label: string };
/** Facet option sets the /rule-check page renders its filter dropdowns from. */
export type AuditFacets = { agents: AuditFacetOption[]; stages: AuditFacetOption[] };

export type RuleCheckAuditRow = {
  audit_id: string;
  created_at: string;
  decision: 'PASS' | 'FAIL';
  /** Non-null = this FAIL is an infra park (没钱/故障), candidate NOT rejected.
   *  Lets the list badge it distinctly and counts exclude it. Optional so the
   *  generic-ontology audit source (no infra parking) stays compatible. */
  fail_reason?: string | null;
  /** Which rule-check agent produced this run (facet id, e.g. 'jr-compliance'). */
  agent_id: string;
  /** Server best-effort display label for the agent (UI may re-localize by id). */
  agent_label: string;
  /** Workflow position the run executed at (e.g. 简历筛查). Display + facet. */
  stage: string | null;
  /** Folded display verdict: pass | fail | parked(infra, candidate NOT rejected). */
  verdict: Verdict;
  llm_decision: string;
  candidate_id: string;
  resume_id: string;
  job_requisition_id: string;
  client_name: string;
  business_group: string | null;
  studio: string | null;
  /** 候选人姓名(从 parsed_resume_json 取);列表展示用,缺则 fallback 到 candidate_id。 */
  candidate_name: string | null;
  /** 岗位名称(job_requisition_json.client_job_title);列表展示用。 */
  jr_title: string | null;
  /** 部门标签(business_group 或 sd_org_name);"哪个部门的"。 */
  dept_label: string | null;
  llm_model: string;
  llm_duration_ms: number;
  llm_prompt_tokens: number | null;
  llm_completion_tokens: number | null;
  rules_evaluated: number;
  rule_source: string;
  n_flags: number;
  trace_id: string | null;
  failure_reasons: string[];
};

export type RuleCheckAuditListResponse = {
  rows: RuleCheckAuditRow[];
  total: number;
  meta: {
    empty: boolean;
    not_configured?: boolean;
    error?: string;
    generatedAt: string;
    /** Facet option sets for the filter dropdowns (execution agent / stage). */
    facets?: AuditFacets;
  };
};

/** Recruitment facet options, sourced from the agent registry (zh labels; the
 *  UI re-localizes by id). Stage options mirror each agent's workflow position. */
function recruitmentFacets(domain: string | null | undefined): AuditFacets {
  const agents = agentsForDomain(domain);
  return {
    agents: agents.map((a) => ({ id: a.id, label: a.label.zh })),
    stages: agents.map((a) => ({ id: a.stage.zh, label: a.stage.zh })),
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const decision = searchParams.get('decision');
  const client = searchParams.get('client') ?? '';
  const jrId = searchParams.get('jrId') ?? '';
  const ruleId = searchParams.get('ruleId') ?? '';
  // Unified-surface facets (Option B): which agent ran, at which stage, and the
  // folded verdict (pass | fail | parked). `verdict` supersedes the legacy
  // `decision` filter when present; `decision` stays for old deep-links.
  const agent = searchParams.get('agent') ?? '';
  const stage = searchParams.get('stage') ?? '';
  const verdictParam = searchParams.get('verdict');
  const verdict: Verdict | '' =
    verdictParam === 'pass' || verdictParam === 'fail' || verdictParam === 'parked'
      ? verdictParam
      : '';
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 200);

  // Non-recruitment domains: serve from the generic ontology rule-check store.
  const domain = searchParams.get('domain');
  if (!isRuleCheckDomain(domain)) {
    if (await hasOntologyRuleChecks(domain)) {
      const d = domain!.trim();
      let rows = await ontologyAuditList(d, limit);
      if (decision === 'PASS' || decision === 'FAIL') rows = rows.filter((r) => r.decision === decision);
      if (client) rows = rows.filter((r) => r.client_name === client);
      rows = applyAuditFacets(rows, { agent, stage, verdict });
      const facets = await ontologyAuditFacets(d);
      return NextResponse.json<RuleCheckAuditListResponse>({
        rows,
        total: rows.length,
        meta: { empty: rows.length === 0, generatedAt: new Date().toISOString(), facets },
      });
    }
    return NextResponse.json<RuleCheckAuditListResponse>({
      rows: [],
      total: 0,
      meta: { empty: true, generatedAt: new Date().toISOString(), facets: { agents: [], stages: [] } },
    });
  }

  try {
    const facets = recruitmentFacets(domain);
    // The recruitment RuleCheckAudit store has no agent column — every row is the
    // compliance agent @ 简历筛查. Identity (it has its own slug) comes from the
    // registry so the stamped facet matches the dropdown.
    const compliance = lookupAgent(domain, JR_COMPLIANCE_AGENT_ID);
    const complianceStage = compliance?.stage.zh ?? null;
    const complianceLabel = compliance?.label.zh ?? JR_COMPLIANCE_AGENT_ID;
    // Skip this store when the agent/stage facet selects a *different* recruitment
    // agent (the planned identity / ownership ones write to the generic store).
    const wantsCompliance =
      (!agent || agent === JR_COMPLIANCE_AGENT_ID) && (!stage || stage === complianceStage);

    const where: Record<string, unknown> = {};
    if (client) where.client_name = client;
    if (jrId) where.job_requisition_id = jrId;
    // Rule drill-down from the 总览 rule table: audits where this rule was
    // assessed (persisted flag) OR was a blocking reason (failure_reasons text,
    // e.g. "[10-45] …"). The trailing `]` in the contains pattern prevents
    // prefix collisions (10-4 vs 10-45).
    if (ruleId) {
      where.OR = [
        { flags: { some: { rule_id: ruleId } } },
        { failure_reasons: { contains: `[${ruleId}]` } },
      ];
    }
    // verdict → DB constraint (richer than the legacy decision filter):
    //   pass = PASS;  fail = FAIL & 真违规(fail_reason null);  parked = FAIL & 基础设施挂起.
    if (verdict === 'pass') where.decision = 'PASS';
    else if (verdict === 'fail') { where.decision = 'FAIL'; where.fail_reason = null; }
    else if (verdict === 'parked') { where.decision = 'FAIL'; where.fail_reason = { not: null }; }
    else if (decision === 'PASS' || decision === 'FAIL') where.decision = decision;

    const audits = wantsCompliance
      ? await prisma.ruleCheckAudit.findMany({
          where,
          orderBy: { created_at: 'desc' },
          take: limit,
          include: { _count: { select: { flags: true } } },
        })
      : [];
    const prismaTotal = wantsCompliance ? await prisma.ruleCheckAudit.count({ where }) : 0;

    const prismaRows: RuleCheckAuditRow[] = audits.map((a) => {
      const resume = parseJsonObj(a.parsed_resume_json);
      const jr = parseJsonObj(a.job_requisition_json);
      const candidate_name = pluckStr(resume, 'name');
      const jr_title = pluckStr(jr, 'client_job_title');
      const sdOrg = pluckStr(jr, 'sd_org_name');
      const dept_label = a.business_group || sdOrg || null;
      return {
      audit_id: a.audit_id,
      created_at: a.created_at.toISOString(),
      decision: a.decision as 'PASS' | 'FAIL',
      fail_reason: a.fail_reason,
      agent_id: JR_COMPLIANCE_AGENT_ID,
      agent_label: complianceLabel,
      stage: complianceStage,
      verdict: foldVerdict(a.decision, a.fail_reason),
      llm_decision: a.llm_decision,
      candidate_id: a.candidate_id,
      resume_id: a.resume_id,
      job_requisition_id: a.job_requisition_id,
      client_name: a.client_name ?? '',
      business_group: a.business_group,
      studio: a.studio,
      candidate_name,
      jr_title,
      dept_label,
      llm_model: a.llm_model,
      llm_duration_ms: a.llm_duration_ms,
      llm_prompt_tokens: a.llm_prompt_tokens,
      llm_completion_tokens: a.llm_completion_tokens,
      rules_evaluated: a.rules_evaluated,
      rule_source: a.rule_source,
      n_flags: a._count.flags,
      trace_id: a.trace_id,
      failure_reasons: safeJsonArray(a.failure_reasons),
      };
    });

    // Merge generic-store rule-checks recorded under the recruitment domain —
    // the planned 候选人身份去重 / 归属 agents write there (one row per run).
    // Empty today; the page is forward-compatible, so those agents light up the
    // agent facet the moment they start emitting.
    let ontoRows = await ontologyAuditList(RECRUITMENT_DOMAIN_ID, limit).catch(() => []);
    ontoRows = applyAuditFacets(ontoRows, { agent, stage, verdict });
    if (decision === 'PASS' || decision === 'FAIL') ontoRows = ontoRows.filter((r) => r.decision === decision);
    if (client) ontoRows = ontoRows.filter((r) => r.client_name === client);

    const rows = [...prismaRows, ...ontoRows]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);

    return NextResponse.json<RuleCheckAuditListResponse>({
      rows,
      total: prismaTotal + ontoRows.length,
      meta: { empty: rows.length === 0, generatedAt: new Date().toISOString(), facets },
    });
  } catch (e) {
    return NextResponse.json<RuleCheckAuditListResponse>({
      rows: [],
      total: 0,
      meta: {
        empty: true,
        error: (e as Error).message.slice(0, 200),
        generatedAt: new Date().toISOString(),
      },
    });
  }
}

function safeJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Parse a stored JSON-text column into an object (null on any failure). */
function parseJsonObj(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pluck a non-empty string field from a parsed object (null otherwise). */
function pluckStr(obj: Record<string, unknown> | null, key: string): string | null {
  const v = obj?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
