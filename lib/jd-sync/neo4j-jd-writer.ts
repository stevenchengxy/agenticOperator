// JD → Neo4j writer · createJdAgent 在 sync-generated 之后调一次,
// 把刚拿到的 RAAS requirement 详情 + 刚生成的 JD 内容映射成
//   (:Job_Requisition)-[:HAS_POSTING]->(:Job_Posting)
// 写进 partner 共享 Neo4j(10.100.0.70:7687)。
//
// 行为契约 — 跟 rule-check writer 对齐:
//   - 配置缺 → 静默 skip(返回 { wrote: false, reason: 'not_configured' })
//   - Neo4j 不可达 / 写失败 → log warning,返回 { wrote: false, reason }
//   - **永远不抛**(Inngest step 不会因 Neo4j 失败重试 → 不污染主流程)
//   - MERGE on primary id → idempotent,重试不会重复创建
//
// Label 命名:沿用 partner 已经在用的 `:Job_Requisition` / `:Job_Posting`
// 下划线命名(查过 Neo4j 现网就有这俩 label,6 条 JR + 3 条 Posting)。
// rule-check writer 写的 `:JobRequisition` 是另一个 snapshot label,独立。

import neo4j, { type Driver, type Session } from 'neo4j-driver';

import type {
  RaasGenerateJdData,
  RaasRequirement,
  RaasRequirementSpecification,
} from '@/lib/raas-api-client';

// ─── Driver cache(env-driven,跟 rule-check 一致) ───

function readNeo4jConfig(): { uri: string; user: string; password: string; database: string } | null {
  const uri = process.env.NEO4J_INSTANCE_URI ?? process.env.RAAS_LINKS_NEO4J_URI;
  const user = process.env.NEO4J_INSTANCE_USER ?? process.env.RAAS_LINKS_NEO4J_USER;
  const password =
    process.env.NEO4J_INSTANCE_PASSWORD ?? process.env.RAAS_LINKS_NEO4J_PASSWORD;
  const database =
    process.env.NEO4J_INSTANCE_DATABASE ?? process.env.RAAS_LINKS_NEO4J_DATABASE ?? 'neo4j';
  if (!uri || !user || !password) return null;
  return { uri, user, password, database };
}

let __cachedDriver: { driver: Driver; database: string } | null = null;

function getDriver(): { driver: Driver; database: string } | null {
  if (__cachedDriver) return __cachedDriver;
  const cfg = readNeo4jConfig();
  if (!cfg) return null;
  try {
    const driver = neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password), {
      connectionTimeout: 5_000,
      disableLosslessIntegers: true,
    });
    __cachedDriver = { driver, database: cfg.database };
    return __cachedDriver;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[neo4j-jd-writer] driver init failed: ${(e as Error).message.slice(0, 200)}`);
    return null;
  }
}

// ─── Public API ───

export interface WriteJdContext {
  job_requisition_id: string;
  /** RAAS sync-generated 返回的 posting_id;为空时用 jd_id 兜底 */
  job_posting_id: string | null;
  /** AO 自己生成的 jd_xxx_xxx id(给 Neo4j 找回到 JD_GENERATED 事件) */
  jd_id: string;
  client_id: string;
  trace_id?: string | null;
  requirement: RaasRequirement;
  specification: RaasRequirementSpecification | null;
  generated: RaasGenerateJdData;
  generator_model: string;
  generator_version: string;
}

export async function writeJdToNeo4j(
  ctx: WriteJdContext,
): Promise<{
  wrote: boolean;
  reason?: string;
  jr_id?: string;
  posting_id?: string;
}> {
  const cfg = getDriver();
  if (!cfg) {
    return { wrote: false, reason: 'not_configured' };
  }
  const now = new Date().toISOString();
  let session: Session | null = null;
  try {
    session = cfg.driver.session({ database: cfg.database });

    const jrProps = buildJrProps(ctx, now);
    const postingId = ctx.job_posting_id || ctx.jd_id;
    const postingProps = buildPostingProps(ctx, postingId, now);

    // 写 :Job_Requisition + :Job_Posting + 关系(单事务,3 个 MERGE)
    await session.run(
      `
      MERGE (jr:Job_Requisition {job_requisition_id: $jrid})
      SET jr += $jrProps,
          jr.last_seen_at = datetime($now)

      MERGE (jp:Job_Posting {job_posting_id: $pid})
      SET jp += $postingProps,
          jp.last_seen_at = datetime($now)

      MERGE (jr)-[r:HAS_POSTING]->(jp)
      SET r.last_seen_at = datetime($now),
          r.jd_id = $jdId
      `,
      {
        jrid: ctx.job_requisition_id,
        pid: postingId,
        jdId: ctx.jd_id,
        now,
        jrProps,
        postingProps,
      },
    );

    return { wrote: true, jr_id: ctx.job_requisition_id, posting_id: postingId };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    // eslint-disable-next-line no-console
    console.warn(
      `[neo4j-jd-writer] write failed jrid=${ctx.job_requisition_id}: ${msg.slice(0, 240)}`,
    );
    return { wrote: false, reason: `error:${msg.slice(0, 80)}` };
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

// ─── Property builders ───

function buildJrProps(
  ctx: WriteJdContext,
  now: string,
): Record<string, unknown> {
  const r = ctx.requirement as Record<string, unknown>;
  const s = (ctx.specification ?? {}) as Record<string, unknown>;
  return {
    // ── 主键 + 关联 ──
    job_requisition_id: ctx.job_requisition_id,
    job_requisition_specification_id:
      pickStr(r.job_requisition_specification_id) ?? pickStr(s.job_requisition_specification_id),
    client_id: ctx.client_id,
    client_name: pickStr(r.client_name),
    client_department_id: pickStr(r.client_department_id),
    first_level_department: pickStr(r.first_level_department),
    second_level_department: pickStr(r.second_level_department),
    csi_department_id: pickStr(r.csi_department_id),
    csi_department_name: pickStr(r.csi_department_name),
    client_job_id: pickStr(r.client_job_id),
    client_job_title: pickStr(r.client_job_title),
    client_job_type: pickStr(r.client_job_type),
    job_type: pickStr(r.job_type),
    standard_job_role_id: pickStr(r.standard_job_role_id),
    // ── 业务属性 snapshot ──
    requirement_name: pickStr(r.requirement_name),
    work_city: pickStr(r.work_city) ?? pickStr(r.city),
    work_address: pickArr(r.work_address),
    salary_range: pickStr(r.salary_range),
    headcount: typeof r.headcount === 'number' ? r.headcount : null,
    headcount_filled: typeof r.headcount_filled === 'number' ? r.headcount_filled : null,
    work_years: typeof r.work_years === 'number' ? r.work_years : null,
    degree_requirement: pickStr(r.degree_requirement),
    education_requirement: pickStr(r.education_requirement),
    interview_mode: pickStr(r.interview_mode),
    expected_level: pickStr(r.expected_level),
    recruitment_type: pickStr(r.recruitment_type),
    must_have_skills: pickArr(r.must_have_skills),
    nice_to_have_skills: pickArr(r.nice_to_have_skills),
    negative_requirement: pickStr(r.negative_requirement),
    language_requirements: pickStr(r.language_requirements),
    // ── 面试配置 ──
    first_interview_format: pickStr(r.first_interview_format),
    first_interviewer_name: pickStr(r.first_interviewer_name),
    final_interview_format: pickStr(r.final_interview_format),
    final_interviewer_name: pickStr(r.final_interviewer_name),
    // ── 全文(decision-time snapshot,~ KB 级,Neo4j 支持) ──
    job_responsibility: clipStr(r.job_responsibility, 6000),
    job_requirement: clipStr(r.job_requirement, 6000),
    // ── 流程状态(partner Postgres 的 lifecycle 字段) ──
    status: pickStr(s.status),                            // spec.status 优先
    jd_status: pickStr(r.jd_status),
    hc_status: pickStr(r.hc_status),
    workflow_status: pickStr(r.workflow_status),
    analysis_status: pickStr(r.analysis_status),
    // ── 时间字段 ──
    publish_date: pickStr(r.publish_date),
    expected_arrival_date: pickStr(r.expected_arrival_date),
    raas_create_time: pickStr(r.create_time),
    raas_updated_at: pickStr(s.updated_at),
    // ── Specification 关键字段 ──
    priority: pickStr(s.priority),
    deadline: pickStr(s.deadline),
    start_date: pickStr(s.start_date),
    is_exclusive: typeof s.is_exclusive === 'boolean' ? s.is_exclusive : null,
    hsm_employee_id: pickStr(s.hsm_employee_id),
    recruiter_employee_id: pickStr(s.recruiter_employee_id),
    sd_org_name: pickStr(s.sd_org_name),
    hro_service_contract_id: pickStr(s.hro_service_contract_id),
    contract_full_name: pickStr(s.contract_full_name),
    create_by: pickStr(s.create_by),
    number_of_competitors:
      typeof s.number_of_competitors === 'number' ? s.number_of_competitors : null,
    competitor_application_count:
      typeof r.competitor_application_count === 'number' ? r.competitor_application_count : null,
    our_application_count:
      typeof r.our_application_count === 'number' ? r.our_application_count : null,
    require_foreigner: typeof r.require_foreigner === 'boolean' ? r.require_foreigner : null,
    // ── Trace ──
    trace_id: ctx.trace_id ?? null,
    first_seen_at: now,
  };
}

function buildPostingProps(
  ctx: WriteJdContext,
  postingId: string,
  now: string,
): Record<string, unknown> {
  const jd = ctx.generated as Record<string, unknown>;
  return {
    job_posting_id: postingId,
    jd_id: ctx.jd_id,
    job_requisition_id: ctx.job_requisition_id,
    // JD 内容(可能很长,Neo4j 支持长字符串)
    title: pickStr(jd.title),
    description: clipStr(jd.description, 8000),
    qualifications: clipStr(jd.qualifications, 8000),
    hard_requirements: clipStr(jd.hardRequirements, 6000),
    nice_to_have: clipStr(jd.niceToHave, 4000),
    benefits: clipStr(jd.benefits, 4000),
    evaluation_rules: clipStr(jd.evaluationRules, 6000),
    interview_requirements: clipStr(jd.interviewRequirements, 6000),
    // 薪资/属性
    salary_currency: pickStr(jd.salaryCurrency),
    salary_min: typeof jd.salaryMin === 'number' ? jd.salaryMin : pickStr(jd.salaryMin),
    salary_max: typeof jd.salaryMax === 'number' ? jd.salaryMax : pickStr(jd.salaryMax),
    salary_period: pickStr(jd.salaryPeriod),
    salary_text: pickStr(jd.salaryText),
    location: pickStr(jd.location),
    employment_type: pickStr(jd.employmentType),
    work_type: pickStr(jd.workType),
    experience_level: pickStr(jd.experienceLevel),
    education: pickStr(jd.education),
    // 生成元数据
    generator_model: ctx.generator_model,
    generator_version: ctx.generator_version,
    generated_at: now,
    trace_id: ctx.trace_id ?? null,
    first_seen_at: now,
  };
}

function pickStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function pickArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function clipStr(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…[truncated ${t.length - max} chars]` : t;
}

// ─── 生命周期 ───

export async function closeJdNeo4jWriter(): Promise<void> {
  if (__cachedDriver) {
    await __cachedDriver.driver.close();
    __cachedDriver = null;
  }
}
