// Production Neo4j instance writer — Q架构纠偏 (2026-05-12)
//
// 新角色(职责单一):
//   - 只写**实体节点 + 关系**:Candidate / Resume / Job_Requisition + EVALUATED_FOR / HAS_RESUME
//   - **不再写 :RuleCheckAudit / :RuleCheckFlag**(那是审计日志,该走 Prisma)
//
// 旧角色(已 deprecated):
//   - 同时写 audit + flag + entity → 节点过重 + 不符合图 DB 哲学
//   - 见 docs/ao-architecture-and-neo4j-integration-audit.md §4.1
//
// matchResumeAgent 调用顺序变成:
//   1. await writeRuleCheckAuditPrisma(verdict, ctx)   ← 关系 DB,写审计
//   2. await writeInstanceAnchorsOnly(ctx)             ← 图 DB,写实体
//
// 旧 writeRuleCheckAudit 保留为 deprecated wrapper(向后兼容,内部会调 2 个新函数)
//
// 关键约束:
//   - **不阻断主流程**:Neo4j 写失败只 log warning,不抛错,matchResume 继续
//   - **lazy init driver**:第一次调用时建连,之后复用;函数级 try/catch 保护
//   - **env-driven**:NEO4J_INSTANCE_* 优先,fallback 到 RAAS_LINKS_NEO4J_*
//   - **idempotent**:audit_id 是 (run / scenario / candidate / jr) hash,
//     MERGE 写入保证重复 emit 不会重复写
//
// 这条 module 跟 docs/neo4j-instance-storage-plan.md 的长期路径(走 Ontology
// API)等价 — 写的 label / property 一致,只是 transport 是 driver 直连。
// Phase 3 切到 Ontology API 时,本 module 内部实现替换即可,接口不变。

import neo4j, { type Driver, type Session } from 'neo4j-driver';

import type { RuleCheckVerdict, RuleFlag } from './types';

// ─── Env 读取(per-call,跟 Inngest cloud toggle 友好) ───

function readNeo4jConfig(): { uri: string; user: string; password: string; database: string } | null {
  const uri = process.env.NEO4J_INSTANCE_URI ?? process.env.RAAS_LINKS_NEO4J_URI;
  const user = process.env.NEO4J_INSTANCE_USER ?? process.env.RAAS_LINKS_NEO4J_USER;
  const password = process.env.NEO4J_INSTANCE_PASSWORD ?? process.env.RAAS_LINKS_NEO4J_PASSWORD;
  const database =
    process.env.NEO4J_INSTANCE_DATABASE ?? process.env.RAAS_LINKS_NEO4J_DATABASE ?? 'neo4j';
  if (!uri || !user || !password) return null;
  return { uri, user, password, database };
}

/**
 * Module-level driver cache。Inngest worker 长期跑,driver 复用避免每次建连。
 * 进程退出时 GC 关。
 */
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
    console.warn(`[neo4j-writer] driver init failed: ${(e as Error).message.slice(0, 200)}`);
    return null;
  }
}

// ─── Public API ───

export interface WriteVerdictContext {
  run_id: string;
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  job_requisition_id: string;
  /** 上游 RESUME_PROCESSED 的 trace_id(可选,审计串联用) */
  trace_id?: string | null;
  /** test scenario id(production 不传)— 让 e2e test 直接在 Neo4j 里按场景查 */
  scenario_id?: string | null;
  /**
   * 候选人 parsed resume(决策时 snapshot)。
   * 用于在 Neo4j 写一个 :Candidate / :Resume 锚节点,partner 可以在图里看到
   * "这个 candidate_id 是谁、简历有啥关键字段"。
   * 不传则不写锚节点,只保留 ID 引用。
   */
  parsed_resume?: Record<string, unknown> | null;
  /**
   * 客户原始招聘需求(决策时 snapshot)。
   * 用于在 Neo4j 写 :JobRequisition 锚节点。
   */
  job_requisition?: Record<string, unknown> | null;
}

/**
 * ★ Q架构纠偏新函数 — 只写实体节点 + 关系,不写 audit/flag。
 *
 * 调用方式:
 *   const r = await writeInstanceAnchorsOnly({
 *     candidate_id, resume_id, job_requisition_id, parsed_resume, job_requisition,
 *   });
 *
 * 行为契约:
 *   - 配置缺 → { wrote: false, reason: 'not_configured' }
 *   - 单个 anchor 写失败 → log warn,**其他 anchor 继续写**(retry 1 次)
 *   - 永远不抛
 *
 * 写入的图节点 + 关系:
 *   (Candidate {candidate_id, name, gender, ...})
 *   (Resume {resume_id, companies, skills, ...})
 *   (Job_Requisition {jr_id, client_name, ...})
 *
 *   (Candidate)-[:HAS_RESUME]->(Resume)
 *   (Candidate)-[:EVALUATED_FOR]->(Job_Requisition)
 *
 * audit/flag 节点不再写,改由 Prisma RuleCheckAudit / RuleCheckFlag 表存。
 */
export async function writeInstanceAnchorsOnly(ctx: {
  candidate_id: string;
  resume_id: string;
  job_requisition_id: string;
  parsed_resume?: Record<string, unknown> | null;
  job_requisition?: Record<string, unknown> | null;
}): Promise<{
  wrote: boolean;
  reason?: string;
  via: 'allmeta' | 'bolt';
  details?: { candidate?: string; resume?: string; jr?: string; dropped?: Record<string, string[]> };
}> {
  // Phase 3 改造:首选 Allmeta Ontology API,Bolt 直连只在 Allmeta 不可用时 fallback。
  // 用 env switch `ALLMETA_WRITER_ENABLED=false` 可关掉(灰度回退)。
  const allmetaEnabled = process.env.ALLMETA_WRITER_ENABLED !== 'false';
  if (allmetaEnabled) {
    const r = await writeInstanceAnchorsViaAllmeta(ctx);
    if (r.wrote) return { ...r, via: 'allmeta' };
    // Allmeta 路径失败 → fallback 到 Bolt 直连(灰度期保护)
    // eslint-disable-next-line no-console
    console.warn(`[neo4j-instance-writer] Allmeta failed (${r.reason}), fallback to Bolt`);
  }
  const boltResult = await writeInstanceAnchorsViaBolt(ctx);
  return { ...boltResult, via: 'bolt' };
}

/** Path A:经 Allmeta Ontology API 写实例 + 关系。 */
async function writeInstanceAnchorsViaAllmeta(ctx: {
  candidate_id: string;
  resume_id: string;
  job_requisition_id: string;
  parsed_resume?: Record<string, unknown> | null;
  job_requisition?: Record<string, unknown> | null;
}): Promise<{ wrote: boolean; reason?: string; details?: { candidate?: string; resume?: string; jr?: string; dropped?: Record<string, string[]> } }> {
  const { writeInstance, writeLink } = await import('@/lib/allmeta-client');
  const now = new Date().toISOString();
  const dropped: Record<string, string[]> = {};
  const status: { candidate?: string; resume?: string; jr?: string } = {};

  // 把 parsed_resume / job_requisition raw 数据转成 ontology 字段名
  const candidateProps = parsedResumeToCandidateFields(ctx.parsed_resume, ctx.candidate_id);
  const resumeProps = parsedResumeToResumeFields(ctx.parsed_resume, ctx.resume_id, ctx.candidate_id);
  const jrProps = jobReqRawToOntologyFields(ctx.job_requisition, ctx.job_requisition_id);

  let anyFailed = false;

  // 1. 写 Candidate
  if (ctx.candidate_id && candidateProps) {
    const r = await writeInstance('Candidate', { ...candidateProps, last_seen_at: now });
    if (r.ok) {
      status.candidate = 'ok';
      if (r.data.dropped.length > 0) dropped.Candidate = r.data.dropped;
    } else {
      status.candidate = `fail:${r.reason}`;
      anyFailed = true;
    }
  }

  // 2. 写 Resume
  if (ctx.resume_id && resumeProps) {
    const r = await writeInstance('Resume', { ...resumeProps, last_seen_at: now });
    if (r.ok) {
      status.resume = 'ok';
      if (r.data.dropped.length > 0) dropped.Resume = r.data.dropped;
    } else {
      status.resume = `fail:${r.reason}`;
      anyFailed = true;
    }
  }

  // 3. 写 Job_Requisition
  if (ctx.job_requisition_id && jrProps) {
    const r = await writeInstance('Job_Requisition', { ...jrProps, last_seen_at: now });
    if (r.ok) {
      status.jr = 'ok';
      if (r.data.dropped.length > 0) dropped.Job_Requisition = r.data.dropped;
    } else {
      status.jr = `fail:${r.reason}`;
      anyFailed = true;
    }
  }

  // 4. 建关系(Candidate -[:HAS_RESUME]-> Resume, Candidate -[:EVALUATED_FOR]-> JR)
  // Allmeta links endpoint 要求两端节点都存在,所以放最后建。失败不影响整体结果。
  if (status.candidate === 'ok' && status.resume === 'ok' && ctx.candidate_id && ctx.resume_id) {
    await writeLink('HAS_RESUME', ctx.candidate_id, ctx.resume_id).catch(() => {});
  }
  if (status.candidate === 'ok' && status.jr === 'ok' && ctx.candidate_id && ctx.job_requisition_id) {
    await writeLink('EVALUATED_FOR', ctx.candidate_id, ctx.job_requisition_id).catch(() => {});
  }

  if (anyFailed) {
    const summary = Object.entries(status).map(([k, v]) => `${k}=${v}`).join(' ');
    return { wrote: false, reason: `allmeta_partial:${summary}`, details: { ...status, dropped } };
  }
  return { wrote: true, details: { ...status, dropped } };
}

/** 把 parsed_resume 抠出 Candidate ontology 字段。 */
function parsedResumeToCandidateFields(
  parsed: Record<string, unknown> | null | undefined,
  candidate_id: string,
): Record<string, unknown> | null {
  if (!candidate_id) return null;
  const p = parsed ?? {};
  const out: Record<string, unknown> = { candidate_id };
  if (typeof p.name === 'string') out.name = p.name;
  if (typeof p.gender === 'string') out.gender = p.gender;
  if (typeof p.nationality === 'string') out.nationality = p.nationality;
  if (typeof p.birth_date === 'string') out.birth_date = p.birth_date;
  // ontology 字段名是 marital_fertility_status,不是 marital_status
  if (typeof p.marital_status === 'string') out.marital_fertility_status = p.marital_status;
  if (typeof p.email === 'string') out.email = p.email;
  if (typeof p.phone === 'string') out.mobile = p.phone;
  if (typeof p.location === 'string') out.current_location = p.location;
  // conflict_interest_declaration 是 String,不是 object,序列化
  if (p.conflict_of_interest != null) {
    out.conflict_interest_declaration = typeof p.conflict_of_interest === 'string'
      ? p.conflict_of_interest
      : JSON.stringify(p.conflict_of_interest).slice(0, 1_000);
  }
  return out;
}

/** 把 parsed_resume 抠出 Resume ontology 字段。 */
function parsedResumeToResumeFields(
  parsed: Record<string, unknown> | null | undefined,
  resume_id: string,
  candidate_id: string,
): Record<string, unknown> | null {
  if (!resume_id) return null;
  const p = parsed ?? {};
  const out: Record<string, unknown> = { resume_id };
  if (candidate_id) out.candidate_id = candidate_id;

  // experience / education / skills 序列化成 ontology 声明的字段
  const exp = Array.isArray(p.experience) ? (p.experience as Array<Record<string, unknown>>) : [];
  const edu = Array.isArray(p.education) ? (p.education as Array<Record<string, unknown>>) : [];

  if (exp.length > 0) {
    out.work_experience = exp.slice(0, 10).map((e) =>
      `${e.company ?? ''}·${e.title ?? ''} (${e.startDate ?? ''}-${e.endDate ?? ''})`,
    ).join('\n').slice(0, 4_000);
  }
  if (edu.length > 0) {
    out.education_experience = edu.slice(0, 5).map((e) =>
      `${e.institution ?? ''}·${e.degree ?? ''}·${e.field ?? ''} (${e.startDate ?? ''}-${e.endDate ?? ''})`,
    ).join('\n').slice(0, 2_000);
  }
  if (Array.isArray(p.skills)) {
    out.skill_tags = (p.skills as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 50);
  } else if (p.skills && typeof p.skills === 'object') {
    const flat: string[] = [];
    for (const v of Object.values(p.skills as Record<string, unknown>)) {
      if (Array.isArray(v)) for (const i of v) if (typeof i === 'string') flat.push(i);
    }
    out.skill_tags = flat.slice(0, 50);
  }
  if (Array.isArray(p.languages)) {
    out.language_skills = (p.languages as unknown[]).filter((x): x is string => typeof x === 'string').join(', ').slice(0, 500);
  }
  // is_original — 是否候选人原始件
  out.is_original = true;
  return out;
}

/** 把 RAAS requirement raw 数据抠成 Job_Requisition ontology 字段。 */
function jobReqRawToOntologyFields(
  jr: Record<string, unknown> | null | undefined,
  job_requisition_id: string,
): Record<string, unknown> | null {
  if (!job_requisition_id) return null;
  const out: Record<string, unknown> = { job_requisition_id };
  if (!jr) return out;
  const passthrough = [
    'csi_department_id', 'client_department_id', 'standard_job_role_id', 'evaluation_model_id',
    'client_job_id', 'client_job_title', 'client_job_type', 'job_responsibility', 'job_requirement',
    'job_type', 'recruitment_type', 'work_years', 'gender', 'age_range', 'degree_requirement',
    'education_requirement', 'city',
  ];
  for (const k of passthrough) {
    const v = jr[k];
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

/** Path B:Bolt 直连(老路径,Allmeta 失败时 fallback)。 */
async function writeInstanceAnchorsViaBolt(ctx: {
  candidate_id: string;
  resume_id: string;
  job_requisition_id: string;
  parsed_resume?: Record<string, unknown> | null;
  job_requisition?: Record<string, unknown> | null;
}): Promise<{ wrote: boolean; reason?: string }> {
  const cfg = getDriver();
  if (!cfg) return { wrote: false, reason: 'not_configured' };
  const now = new Date().toISOString();
  let session: Session | null = null;
  try {
    session = cfg.driver.session({ database: cfg.database });
    const candidateProps = buildCandidateSnapshot(ctx.parsed_resume, now);
    const resumeProps = buildResumeStandaloneSnapshot(ctx, now);
    const jrProps = buildJobRequisitionSnapshot(ctx.job_requisition, now);

    if (ctx.candidate_id) {
      await tryAnchor('Candidate', () =>
        session!.run(
          `MERGE (c:Candidate {candidate_id: $cid})
           SET c += $props, c.last_seen_at = datetime($now)`,
          { cid: ctx.candidate_id, props: candidateProps, now },
        ),
      );
    }
    if (ctx.resume_id) {
      await tryAnchor('Resume', () =>
        session!.run(
          `MERGE (r:Resume {resume_id: $rid})
           SET r += $props, r.last_seen_at = datetime($now)
           WITH r
           OPTIONAL MATCH (c:Candidate {candidate_id: $cid})
           FOREACH (cc IN CASE WHEN c IS NULL THEN [] ELSE [c] END |
             MERGE (cc)-[:HAS_RESUME]->(r)
           )`,
          { rid: ctx.resume_id, cid: ctx.candidate_id, props: resumeProps, now },
        ),
      );
    }
    if (ctx.job_requisition_id) {
      await tryAnchor('Job_Requisition', () =>
        session!.run(
          `MERGE (j:Job_Requisition {job_requisition_id: $jrid})
           SET j += $props, j.last_seen_at = datetime($now)
           WITH j
           OPTIONAL MATCH (c:Candidate {candidate_id: $cid})
           FOREACH (cc IN CASE WHEN c IS NULL THEN [] ELSE [c] END |
             MERGE (cc)-[:EVALUATED_FOR]->(j)
           )`,
          { jrid: ctx.job_requisition_id, cid: ctx.candidate_id, props: jrProps, now },
        ),
      );
    }
    return { wrote: true };
  } catch (e) {
    return { wrote: false, reason: `error:${(e as Error).message.slice(0, 100)}` };
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

async function tryAnchor(label: string, fn: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 80));
        continue;
      }
      // eslint-disable-next-line no-console
      console.warn(`[neo4j-writer] anchor ${label} fail (2 tries): ${(e as Error).message.slice(0, 200)}`);
      return;
    }
  }
}

/** Resume snapshot — 不依赖 audit context 的版本 */
function buildResumeStandaloneSnapshot(
  ctx: { candidate_id: string; resume_id: string; parsed_resume?: Record<string, unknown> | null },
  now: string,
): Record<string, unknown> {
  const parsed = ctx.parsed_resume as Record<string, unknown> | null | undefined;
  if (!parsed) {
    return { snapshot_at: now, candidate_id: ctx.candidate_id ?? null };
  }
  const exp = (parsed.experience as Array<Record<string, unknown>> | undefined) ?? [];
  const edu = (parsed.education as Array<Record<string, unknown>> | undefined) ?? [];
  const skills = flattenSkills(parsed.skills);
  return {
    snapshot_at: now,
    candidate_id: ctx.candidate_id ?? null,
    experience_count: exp.length,
    education_count: edu.length,
    skills,
    companies: exp.map((e) => (typeof e.company === 'string' ? e.company : '')).filter(Boolean),
    highest_degree:
      typeof edu[0]?.degree === 'string'
        ? (edu[0].degree as string)
        : null,
  };
}

/**
 * @deprecated Q架构纠偏 (2026-05-12) — audit/flag 应该走 Prisma,不该写 Neo4j。
 * 本函数保留为向后兼容 wrapper:内部仍写 :RuleCheckAudit / :RuleCheckFlag(legacy),
 * 但 caller 应该改用 `writeRuleCheckAuditPrisma()` + `writeInstanceAnchorsOnly()`。
 *
 * 写一次 rule check 的完整审计数据:1 个 RuleCheckAudit + N 个 RuleCheckFlag。
 *
 * 行为契约:
 *   - 配置缺 → 静默 skip(返回 { wrote: false, reason: 'not_configured' })
 *   - Neo4j 不可达 / 写失败 → log warning,返回 { wrote: false, reason: ... }
 *   - **永远不抛**(Inngest step 不会因 Neo4j 失败重试)
 */
export async function writeRuleCheckAudit(args: {
  verdict: RuleCheckVerdict;
  context: WriteVerdictContext;
}): Promise<{ wrote: boolean; audit_id?: string; n_flags?: number; reason?: string }> {
  const cfg = getDriver();
  if (!cfg) {
    return { wrote: false, reason: 'not_configured' };
  }

  const audit_id = makeAuditId(args.context);
  const now = new Date().toISOString();

  let session: Session | null = null;
  try {
    session = cfg.driver.session({ database: cfg.database });

    // MERGE audit node(idempotent)
    await session.run(
      `MERGE (a:RuleCheckAudit {audit_id: $audit_id})
       SET a += $props,
           a.created_at = coalesce(a.created_at, datetime($created_at))`,
      {
        audit_id,
        created_at: now,
        props: buildAuditProps(args.verdict, args.context, now),
      },
    );

    // 写 applicable=true 的 flag(每条 MERGE,链关系)
    const flags = (args.verdict.llm_output?.rule_flags ?? []).filter(
      (f) => f.applicable === true,
    );
    if (flags.length > 0) {
      await session.run(
        `MATCH (a:RuleCheckAudit {audit_id: $audit_id})
         UNWIND $flags AS f
         MERGE (rcf:RuleCheckFlag {flag_id: f.flag_id})
         SET rcf += f.props,
             rcf.created_at = coalesce(rcf.created_at, datetime(f.props.created_at))
         MERGE (a)-[:HAS_FLAG]->(rcf)`,
        {
          audit_id,
          flags: flags.map((f) => ({
            flag_id: `${audit_id}::${f.rule_id}`,
            props: serializeFlag(f, audit_id, now),
          })),
        },
      );
    }

    // 如果 ontology Action / Rule 节点存在,链一下(可选关系,不存在不抛)
    await session.run(
      `MATCH (a:RuleCheckAudit {audit_id: $audit_id})
       OPTIONAL MATCH (ax:Action) WHERE ax.id = '10' OR ax.name = 'matchResume'
       FOREACH (x IN CASE WHEN ax IS NULL THEN [] ELSE [ax] END |
         MERGE (a)-[:FOR_ACTION]->(x)
       )`,
      { audit_id },
    );

    // 写实例锚节点 :Candidate / :Resume / :JobRequisition + 关系
    // MERGE 保证 idempotent;同 candidate 多次跑只更新最新 snapshot 字段
    await writeInstanceAnchors(session, audit_id, args.context, now);

    return { wrote: true, audit_id, n_flags: flags.length };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    // eslint-disable-next-line no-console
    console.warn(
      `[neo4j-writer] write failed for audit_id=${audit_id}: ${msg.slice(0, 200)}`,
    );
    return { wrote: false, reason: `error:${msg.slice(0, 80)}` };
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

// ─── Instance anchor nodes(:Candidate / :Resume / :JobRequisition) ───
//
// Partner / 我们调试时,经常想在 Neo4j 图里看"这个 candidate_id 究竟是谁"。
// 把 decision-time snapshot 写成独立 label 节点(MERGE — 同 ID 多次跑只更新
// snapshot 字段),通过关系链回 RuleCheckAudit。
//
// **不存 PII 重灾区**(email / phone / raw_text)— 那些 raas Postgres 有,
// 这里存的是"用来理解 audit 上下文"的最小有用集合。

/**
 * 三个 anchor 各自独立 try/catch + 1 次 retry,**互不阻断**。
 *
 * 之前的行为:第 2/3 步任一抛错 → 外层 try/catch 接住 → 整个 writeInstanceAnchors
 * 抛回 writeRuleCheckAudit 的 catch → 返回 wrote:false。但第 1 步已经独立 commit,
 * 结果是"Candidate 写了,Resume / JR 缺位",观测面残缺。
 *
 * 现在的行为:每个 anchor 各自 try / retry-once / log-warn-on-final-fail,**不抛**。
 * 这样 Resume 失败不影响 JR 写;每次失败都打日志(包含 audit_id 和阶段名),便于定位。
 */
async function writeInstanceAnchors(
  session: Session,
  audit_id: string,
  ctx: WriteVerdictContext,
  now: string,
): Promise<void> {
  const candidateProps = buildCandidateSnapshot(ctx.parsed_resume, now);
  const resumeProps = buildResumeSnapshot(ctx, now);
  const jrProps = buildJobRequisitionSnapshot(ctx.job_requisition, now);

  // 1. :Candidate 节点 + 关系
  if (ctx.candidate_id) {
    await tryWithRetry('Candidate', audit_id, () =>
      session.run(
        `MATCH (a:RuleCheckAudit {audit_id: $audit_id})
         MERGE (c:Candidate {candidate_id: $candidate_id})
         SET c += $props,
             c.last_seen_at = coalesce($props.snapshot_at_dt, c.last_seen_at)
         MERGE (a)-[:FOR_CANDIDATE]->(c)`,
        {
          audit_id,
          candidate_id: ctx.candidate_id,
          props: { ...candidateProps, snapshot_at_dt: now },
        },
      ),
    );
  }

  // 2. :Resume 节点 + 关系(:Candidate)-[:HAS_RESUME]->(:Resume) + (:Audit)-[:USED_RESUME]->(:Resume)
  if (ctx.resume_id) {
    await tryWithRetry('Resume', audit_id, () =>
      session.run(
        `MATCH (a:RuleCheckAudit {audit_id: $audit_id})
         MERGE (r:Resume {resume_id: $resume_id})
         SET r += $props
         MERGE (a)-[:USED_RESUME]->(r)
         WITH a, r
         OPTIONAL MATCH (c:Candidate {candidate_id: $candidate_id})
         FOREACH (cc IN CASE WHEN c IS NULL THEN [] ELSE [c] END |
           MERGE (cc)-[:HAS_RESUME]->(r)
         )`,
        {
          audit_id,
          resume_id: ctx.resume_id,
          candidate_id: ctx.candidate_id,
          props: resumeProps,
        },
      ),
    );
  }

  // 3. :Job_Requisition 节点 + 关系(:Audit)-[:AGAINST_JOB]->(:JR) +
  //                               (:Candidate)-[:EVALUATED_FOR]->(:JR)
  //
  // ⚠️ Label 用下划线版 `:Job_Requisition` —— 对齐 partner ontology
  // (raas_v4/ontology/dataobjects_*.json + jd-sync/neo4j-jd-writer.ts)。
  // 之前写的是 `:JobRequisition`(无下划线),跟 createJD 写的 `:Job_Requisition`
  // 分裂成两个孤岛节点。本次修复(2026-05-12)统一到下划线版,做到 candidate
  // → JR → Posting 全图打通。详见 docs/ao-architecture-and-neo4j-integration-audit.md §4.1
  if (ctx.job_requisition_id) {
    await tryWithRetry('Job_Requisition', audit_id, () =>
      session.run(
        `MATCH (a:RuleCheckAudit {audit_id: $audit_id})
         MERGE (j:Job_Requisition {job_requisition_id: $jr_id})
         SET j += $props
         MERGE (a)-[:AGAINST_JOB]->(j)
         WITH a, j
         OPTIONAL MATCH (c:Candidate {candidate_id: $candidate_id})
         FOREACH (cc IN CASE WHEN c IS NULL THEN [] ELSE [c] END |
           MERGE (cc)-[:EVALUATED_FOR]->(j)
         )`,
        {
          audit_id,
          jr_id: ctx.job_requisition_id,
          candidate_id: ctx.candidate_id,
          props: jrProps,
        },
      ),
    );
  }
}

async function tryWithRetry(
  label: string,
  audit_id: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (attempt === 1) {
        // 第 1 次失败:可能是 transient(connection cold / lock 抢占),静默 retry
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      // 第 2 次仍失败:吃下异常 + 显式 log,**不抛**(否则后续 anchor 链断)
      // eslint-disable-next-line no-console
      console.warn(
        `[neo4j-writer] anchor ${label} write failed (2 attempts) for audit_id=${audit_id}: ${msg.slice(0, 240)}`,
      );
      return;
    }
  }
}

/**
 * 从 parsed_resume snapshot 选出能在 Neo4j 上做 query 的字段。
 * 不存:email / phone / raw_text / summary(PII 或体积大,raas Postgres 有)
 */
function buildCandidateSnapshot(
  parsed: Record<string, unknown> | null | undefined,
  now: string,
): Record<string, unknown> {
  if (!parsed) return { snapshot_at: now };
  const p = parsed as Record<string, unknown>;
  return {
    snapshot_at: now,
    name: typeof p.name === 'string' ? p.name : null,
    gender: typeof p.gender === 'string' ? p.gender : null,
    birth_date: typeof p.birth_date === 'string' ? p.birth_date : null,
    nationality: typeof p.nationality === 'string' ? p.nationality : null,
    marital_status: typeof p.marital_status === 'string' ? p.marital_status : null,
    location: typeof p.location === 'string' ? p.location : null,
    // 派生 boolean flags — 给"按某类历史筛 audit"用
    has_former_csi: Boolean(p.former_csi_employment),
    has_former_tencent: Boolean(p.former_tencent_employment),
    has_gap_periods: Array.isArray(p.gap_periods) && (p.gap_periods as unknown[]).length > 0,
    has_conflict_of_interest:
      Array.isArray(p.conflict_of_interest) && (p.conflict_of_interest as unknown[]).length > 0,
  };
}

function buildResumeSnapshot(
  ctx: WriteVerdictContext,
  now: string,
): Record<string, unknown> {
  const parsed = ctx.parsed_resume as Record<string, unknown> | null | undefined;
  if (!parsed) {
    return {
      snapshot_at: now,
      candidate_id: ctx.candidate_id ?? null,
      upload_id: ctx.upload_id ?? null,
    };
  }
  const exp = (parsed.experience as Array<Record<string, unknown>> | undefined) ?? [];
  const edu = (parsed.education as Array<Record<string, unknown>> | undefined) ?? [];

  // skills 兼容两种 shape:
  //   - string[]  (老 fixture / 简单解析)
  //   - { technical: string[], soft: string[], other: string[], ... }(Robohire 实际)
  // Neo4j 属性不接 nested map,所以拍平成一个 string[]。
  const skills = flattenSkills(parsed.skills);

  // experience snapshot:取前 5 段 + 关键字段(给 Cypher 查"曾在 X 公司")
  const expSnapshot = exp.slice(0, 5).map((e) => ({
    company: e.company ?? null,
    title: e.title ?? null,
    startDate: e.startDate ?? null,
    endDate: e.endDate ?? null,
  }));

  // highest_degree 防御性:Robohire 可能给 string(如"大专")或 object,强制 string
  const rawDegree = edu[0]?.degree;
  const highest_degree =
    typeof rawDegree === 'string'
      ? rawDegree
      : rawDegree && typeof rawDegree === 'object'
        ? String((rawDegree as Record<string, unknown>).name ?? '')
        : null;

  return {
    snapshot_at: now,
    candidate_id: ctx.candidate_id ?? null,
    upload_id: ctx.upload_id ?? null,
    experience_count: exp.length,
    education_count: edu.length,
    skills,
    // 关键公司名(便于按"曾在华为"快速查)
    companies: exp.map((e) => (typeof e.company === 'string' ? e.company : '')).filter(Boolean),
    highest_degree,
    experience_snapshot_json: JSON.stringify(expSnapshot),
  };
}

/**
 * 把 Robohire 的 skills 字段拍成 string[]。
 * 输入可能是:
 *   - string[]                    → 直接返回
 *   - { technical:[], soft:[]... } → 把所有子数组拼起来去重
 *   - undefined / null / 其他      → []
 */
function flattenSkills(s: unknown): string[] {
  if (Array.isArray(s)) {
    return s.filter((x): x is string => typeof x === 'string');
  }
  if (s && typeof s === 'object') {
    const all: string[] = [];
    for (const v of Object.values(s as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === 'string' && item.trim()) all.push(item.trim());
        }
      }
    }
    // 去重保序
    return Array.from(new Set(all));
  }
  return [];
}

function buildJobRequisitionSnapshot(
  jr: Record<string, unknown> | null | undefined,
  now: string,
): Record<string, unknown> {
  if (!jr) return { snapshot_at: now };
  return {
    snapshot_at: now,
    client_id: typeof jr.client_id === 'string' ? jr.client_id : null,
    client_department_id:
      typeof jr.client_department_id === 'string' ? jr.client_department_id : null,
    client_business_group:
      typeof jr.client_business_group === 'string' ? jr.client_business_group : null,
    client_studio: typeof jr.client_studio === 'string' ? jr.client_studio : null,
    client_job_title: typeof jr.client_job_title === 'string' ? jr.client_job_title : null,
    must_have_skills: Array.isArray(jr.must_have_skills) ? (jr.must_have_skills as string[]) : [],
    nice_to_have_skills: Array.isArray(jr.nice_to_have_skills)
      ? (jr.nice_to_have_skills as string[])
      : [],
    work_years: typeof jr.work_years === 'number' ? jr.work_years : null,
    degree_requirement:
      typeof jr.degree_requirement === 'string' ? jr.degree_requirement : null,
    salary_range: typeof jr.salary_range === 'string' ? jr.salary_range : null,
    city: typeof jr.city === 'string' ? jr.city : null,
    expected_level: typeof jr.expected_level === 'string' ? jr.expected_level : null,
    recruitment_type:
      typeof jr.recruitment_type === 'string' ? jr.recruitment_type : null,
    age_min: extractAge(jr, 'min'),
    age_max: extractAge(jr, 'max'),
  };
}

function extractAge(jr: Record<string, unknown>, kind: 'min' | 'max'): number | null {
  const range = jr.age_range as { min?: number; max?: number } | undefined;
  if (range && typeof range[kind] === 'number') return range[kind]!;
  return null;
}

// ─── Helpers ───

function makeAuditId(ctx: WriteVerdictContext): string {
  // run_id + scenario_id(test 时)/ upload_id + jr_id(prod 时)保证 idempotent
  if (ctx.scenario_id) {
    return `rca_${ctx.run_id}_${ctx.scenario_id}`;
  }
  return `rca_${ctx.run_id}_${shortHash(ctx.upload_id)}_${shortHash(ctx.job_requisition_id)}`;
}

function shortHash(s: string): string {
  // 简单不可碰撞 hash(djb2 取 base36 前 8 位)
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 8);
}

function buildAuditProps(
  v: RuleCheckVerdict,
  ctx: WriteVerdictContext,
  now: string,
): Record<string, unknown> {
  return {
    run_id: ctx.run_id,
    scenario_id: ctx.scenario_id ?? null,
    upload_id: ctx.upload_id,
    candidate_id: ctx.candidate_id,
    resume_id: ctx.resume_id,
    job_requisition_id: ctx.job_requisition_id,
    trace_id: ctx.trace_id ?? null,
    // 决策快照
    decision: v.decision,
    llm_decision: v.llm_decision,
    failure_reasons: v.failure_reasons,
    // 维度上下文 snapshot(point-in-time)
    client_name: v.audit.dims.client_id,
    business_group: v.audit.dims.business_group,
    studio: v.audit.dims.studio,
    // LLM 观测
    llm_model: v.audit.llm_model,
    llm_duration_ms: v.audit.llm_duration_ms,
    llm_prompt_tokens: v.audit.llm_prompt_tokens ?? null,
    llm_completion_tokens: v.audit.llm_completion_tokens ?? null,
    parse_error: v.audit.parse_error ?? null,
    // 规则集 + projection
    rules_evaluated: v.audit.rules_evaluated,
    rules_total_in_ontology: v.audit.rules_total_in_ontology,
    rule_source: v.audit.rule_source ?? 'unknown',
    partial_resume_fields: v.audit.partial_resume_fields ?? [],
    // Augmentation 快照(给 Robohire 看的 markdown)
    resume_augmentation: v.resume_augmentation ?? null,
    // 完整 LLM I/O — 给审计 UI 复现"LLM 看到了什么 / 回答了什么"
    user_prompt: v.audit.user_prompt ?? null,
    system_prompt: v.audit.system_prompt ?? null,
    llm_raw_text: v.audit.llm_raw_text ?? null,
    // 决策时完整 input snapshot(给 UI 实例数据 tab 显示完整 JSON)。
    // anchor 节点(:Resume / :JobRequisition / :Candidate)仍只存 query-friendly
    // 字段;完整 JSON 跟着 audit 走,审计追溯一找一个准。
    parsed_resume_json: ctx.parsed_resume ? safeJsonStringify(ctx.parsed_resume) : null,
    job_requisition_json: ctx.job_requisition ? safeJsonStringify(ctx.job_requisition) : null,
    // 创建时间
    created_at: now,
  };
}

function safeJsonStringify(v: unknown, maxBytes = 200_000): string | null {
  try {
    const s = JSON.stringify(v);
    if (!s) return null;
    // Neo4j 字符串属性理论上没硬限制,但避免单个 audit 节点过胖,clip 到 200KB
    if (s.length > maxBytes) {
      return s.slice(0, maxBytes) + `...[truncated ${s.length - maxBytes} chars]`;
    }
    return s;
  } catch {
    return null;
  }
}

function serializeFlag(
  f: RuleFlag,
  audit_id: string,
  now: string,
): Record<string, unknown> {
  return {
    audit_id,
    rule_id: f.rule_id,
    rule_name_snapshot: f.rule_name ?? '',
    severity: f.severity,
    applicable: f.applicable,
    result: f.result,
    evidence: f.evidence ?? '',
    next_action: f.next_action ?? '',
    created_at: now,
  };
}

// ─── 生命周期(给 Inngest function shutdown 用,可选) ───

export async function closeNeo4jWriter(): Promise<void> {
  if (__cachedDriver) {
    await __cachedDriver.driver.close();
    __cachedDriver = null;
  }
}
