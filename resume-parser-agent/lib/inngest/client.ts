import { Inngest } from 'inngest';

// ─── §3.1 输入事件（来自 RAAS）──────────────────────────────
export type ResumeDownloadedData = {
  bucket: string;
  objectKey: string;
  filename: string;
  hrFolder: string | null;
  employeeId: string | null;
  etag: string | null;
  size: number | null;
  sourceEventName: string | null;
  receivedAt: string;
  /**
   * 上游 RAAS 在 RESUME_DOWNLOADED 上挂的 candidate-resume 上传 ID。
   * matchResume 需要把它原样回写到 MATCH_* 事件里供 RAAS 反查 candidate。
   * 本地测试发布时若缺失，可以用 etag 兜底（见 publish-test-event.ts）。
   */
  upload_id?: string;
};

// ─── §3.2 解析结果(v0_1_010 终稿,对齐 docs/data/objects_v0_1_010.json)────────
// 字段命名 / 类型跟 RoboHire vendor + Allmeta DataObject 一致。
// mapper 会把这些 Nested 转成 Allmeta `POST /api/v1/ontology/instances/{label}` payload。

export type CandidateNested = {
  name: string | null;
  phone: string | null;              // v0_1_010: was `mobile`, renamed to vendor name
  email: string | null;
  gender: string | null;
  birth_date: string | null;
  address: string | null;            // v0_1_010: was `current_location`, renamed to vendor name
  highest_acquired_degree: string | null;
  work_years: number | null;
  github: string | null;             // v0_1_010 new — RoboHire 顶级直返
  ethnicity: string | null;          // v0_1_010 new — 派生 otherSections.个人信息补充"民族"
  native_place: string | null;       // v0_1_010 new — 派生 otherSections.个人信息补充"籍贯"
  // ❌ Removed v0_1_010: current_company / current_title / skills(技能跟简历走,在 ResumeNested.skills)
};

export type CandidateExpectationNested = {
  expected_positions: string | null;       // v0_1_010: renamed + type changed string[] → string
                                            //   (mapper 多值用 "/" 或 "、" join)
  expected_locations: string | null;       // v0_1_010: renamed + type changed
  expected_industries: string | null;      // v0_1_010: renamed + type changed
  expected_salary_range: string | null;    // v0_1_010 new — String,例 "6k-8k",不拆 min/max
  expected_work_mode: string | null;       // remote/hybrid/onsite
  // ❌ Removed v0_1_010: expected_salary_monthly_min / _max(改回单 String)
};

export type ResumeNested = {
  summary: string | null;                  // RoboHire summary
  skills: string[];                        // v0_1_010: renamed from `skills_extracted`(仅此字段保持 List)
  experience: string | null;               // v0_1_010: renamed work_history → experience;类型 Object[] → String(JSON.stringify)
  education: string | null;                // v0_1_010: renamed education_history → education;同上
  projects: string | null;                 // v0_1_010: renamed project_history → projects;同上
  certifications: string | null;           // v0_1_010 new — RoboHire certifications 序列化
  languages: string | null;                // v0_1_010 new — RoboHire languages 序列化
  portfolio: string | null;                // v0_1_010 new — RoboHire 顶级
  publications: string | null;             // v0_1_010 new — RoboHire 顶级
  patents: string | null;                  // v0_1_010 new — RoboHire 顶级
  awards: string | null;                   // v0_1_010 new — RoboHire 顶级
};

// ❌ Removed v0_1_010: RuntimeNested(historical duplicate of current_company/current_title)

export type ResumeProcessedData = {
  // 透传
  bucket: string;
  objectKey: string;
  filename: string;
  hrFolder: string | null;
  employeeId: string | null;
  etag: string | null;
  size: number | null;
  sourceEventName: string | null;
  receivedAt: string;
  // 解析结果（v0_1_010 — 3 个 Nested 对应 Allmeta 3 个 DataObject;runtime 已删）
  candidate: CandidateNested | Record<string, never>;
  candidate_expectation: CandidateExpectationNested | Record<string, never>;
  resume: ResumeNested | Record<string, never>;
  // 元数据
  parsedAt: string;
  parserVersion: string;
  // ── matchResume agent 用到的字段 ──
  upload_id?: string;
  employee_id?: string;
  parsed?: { data?: Record<string, unknown> };
  // ── Workflow A: 持久化产物 ──
  // resume-parser-agent 调 saveCandidate 后拿到的 RAAS DB id，下游
  // matcher 不必再反查就能用 candidate_id 调 saveMatchResults。
  candidate_id?: string;
  resume_id?: string;
  // 上传时关联的岗位（来自 RESUME_DOWNLOADED.payload.job_requisition_id）。
  // 有值 → matchResumeAgent 只匹配该一个岗位；为空 → fallback 到 agent-view
  // 拉取上传者名下所有 recruiting 需求做匹配。raas 前端"上传简历"弹框里
  // 的"关联岗位（可选）"下拉决定了这个字段是否有值。
  job_requisition_id?: string | null;
};

// ─── §3.3 匹配输出事件 ─────────────────────────────────────
//
// 新 shape — 只放 matcher 需要的两个 anchor + RoboHire /match-resume 的
// 完整响应。RoboHire 响应的全部字段（success / data / requestId / savedAs /
// error）都被原样平铺在 payload 顶层。
//
// 旧的 candidate_ref / jd_text / jd_source / 自己重打分的 outcome 等字段
// 已删除：MATCH_* 的事件名本身就承载 outcome；candidate 信息让消费方按
// upload_id 回查；JD 文本不再写出（消费方按 job_requisition_id 查 RAAS）。
export type MatchPassedNeedInterviewData = {
  /** 来自 RESUME_PROCESSED 的 upload_id —— RAAS 用它反查 candidate_id。 */
  upload_id: string;
  /** 当前轮匹配的需求 ID —— RAAS 用它定位是哪条需求的得分。 */
  job_requisition_id: string;

  // ── 以下字段由 RoboHire /match-resume 响应直接平铺 ──
  success?: boolean;
  data?: Record<string, unknown>;
  requestId?: string;
  savedAs?: string;
  error?: string;
};

// ─── §3.4 JD 生成相关事件 ─────────────────────────────────
//
// REQUIREMENT_LOGGED (RAAS → AO)：raw_input_data 28 字段平铺在 payload 里。
// 这里只声明顶层壳；具体 28 字段类型在 createJdAgent 内部定义。
export type RequirementLoggedData = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload?: Record<string, unknown>;   // 含 raw_input_data 等
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

// JD_GENERATED (AO → RAAS)：
//
// doc v5 §4.6 写法是直接 spread RoboHire generate-jd 的 data —— 我们的
// JD_GENERATED.payload 也跟 sync-generated 的 body 形态保持一致：
//   1. 整段 spread RoboHire camelCase data (title/description/qualifications/
//      hardRequirements/niceToHave/interviewRequirements/evaluationRules/benefits/
//      salaryMin/Max/Currency/Period/Text/headcount/experienceLevel/education/
//      employmentType/location 等 21 字段)
//   2. 叠加 raas snake_case 增强字段（must_have_skills / work_years / city array /
//      negative_requirement / language_requirements 等 —— 来自 RAAS requirement 详情）
//   3. partner-canonical normalized 字段（posting_title / posting_description /
//      salary_range / city array 兜底）
//   4. AO bookkeeping (jd_id / claimer_employee_id / generator_version / ...)
//
// `[key: string]: unknown` 兜底允许 RoboHire 未来加新 camelCase 字段时不破类型。
export type JdGeneratedPayload = {
  // ── raas 关联（partner 必读）──
  job_requisition_id: string;
  client_id: string | null;

  // ── RoboHire generate-jd 原始 camelCase 字段（spread 自 jdData，全部可选）──
  title?: string;
  description?: string;          // ★ JD 正文 markdown，§4.6 必填语义
  qualifications?: string;       // 任职要求 markdown
  hardRequirements?: string;     // 硬性要求 markdown
  niceToHave?: string;           // 加分项 markdown
  interviewRequirements?: string;
  evaluationRules?: string;
  benefits?: string;
  salaryMin?: string | number;
  salaryMax?: string | number;
  salaryCurrency?: string;
  salaryPeriod?: string;
  salaryText?: string;
  headcount?: string | number;
  experienceLevel?: string;
  education?: string;
  employmentType?: string;
  location?: string;
  workType?: string;
  companyName?: string;
  department?: string;

  // ── partner-canonical normalized snake_case (与 sync-generated body 对齐) ──
  posting_title: string;
  posting_description: string;
  city: string[];
  salary_range: string;
  interview_mode: string;
  degree_requirement: string;
  education_requirement: string;
  work_years: number;
  recruitment_type: string;
  must_have_skills: string[];
  nice_to_have_skills: string[];
  negative_requirement: string;
  language_requirements: string;
  expected_level: string;

  // ── 发布渠道用的 2 段独立字段 ──
  responsibility: string;
  requirement: string;

  // ── bookkeeping ──
  jd_id: string;
  claimer_employee_id: string | null;
  hsm_employee_id: string | null;
  client_job_id: string | null;

  // ── 诊断字段（RAAS 可忽略）──
  search_keywords: string[];
  quality_score: number;
  quality_suggestions: string[];
  market_competitiveness: '高' | '中' | '低';
  generator_version: string;
  generator_model: string;
  generated_at: string;

  // RoboHire 未来加的 camelCase 字段从这里兜底，不破类型
  [key: string]: unknown;
};

export type JdGeneratedEnvelope = {
  entity_type: 'JobDescription';
  entity_id: string | null;
  event_id: string;
  payload: JdGeneratedPayload;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

// Inngest v4 dropped EventSchemas / fromRecord — typed events are now
// declared by passing a generic on Inngest. We list the event-type union
// as documentation (consumed by event types exported from this module),
// but the inngest client construction is now schemas-free.
//
// Event type map (retained for type exports + future v4 generic uplift):
//   RESUME_DOWNLOADED, RESUME_PROCESSED, MATCH_*, REQUIREMENT_LOGGED,
//   CLARIFICATION_READY, JD_REJECTED, JD_GENERATED.
export type RpaEvents = {
  RESUME_DOWNLOADED: { data: ResumeDownloadedData };
  RESUME_PROCESSED: { data: ResumeProcessedData };
  MATCH_PASSED_NEED_INTERVIEW: { data: MatchPassedNeedInterviewData };
  MATCH_PASSED_NO_INTERVIEW: { data: MatchPassedNeedInterviewData };
  MATCH_FAILED: { data: MatchPassedNeedInterviewData };
  REQUIREMENT_LOGGED: { data: RequirementLoggedData };
  CLARIFICATION_READY: { data: RequirementLoggedData };
  JD_REJECTED: { data: RequirementLoggedData };
  JD_GENERATED: { data: JdGeneratedEnvelope };
};

export const inngest = new Inngest({
  id: 'agentic-operator',
});

// 字段映射版本号 (RoboHire output → RAAS schema)
export const MAPPING_VERSION = '2026-04-28';
export const PARSER_VERSION = `robohire@v1+map@${MAPPING_VERSION}`;
