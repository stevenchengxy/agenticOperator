// Inngest client + event schemas for the merged AO monorepo.
//
// 历史:这个 client.ts 之前只在 AO main(端口 3002),resume-parser-agent
// (RPA,端口 3020)有自己的一份带完整 event 类型的 client.ts。p4 合并后,
// 两份 client 收敛成这一份 —— event 类型搬过来,但 inngest 实例的 id 仍然
// 保持 "agentic-operator-main"(不是 RPA 原来用的 "agentic-operator"),
// 避免破坏 Inngest dev server 上已注册的 app 槽位。
//
// Two modes via env:
//   - Shared gateway (RAAS联调): set INNGEST_BASE_URL + INNGEST_DEV to the
//     team-shared Inngest dev URL, e.g. http://10.100.0.70:8288. AO will
//     send events there AND must be registered as a serve endpoint there
//     (see scripts/register-with-inngest.ts).
//   - Local: INNGEST_DEV=1 (or unset and inngest-cli running on localhost)
//     for offline AO-only testing.
//
// No agent imports here — registry lives in server/inngest/functions.ts
// to avoid circular import (agents → client → agents).

import { Inngest } from "inngest";

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
   * 本地测试发布时若缺失，可以用 etag 兜底（见 scripts/publish-test-event.ts）。
   */
  upload_id?: string;
};

// ─── §3.2 RAAS 期望的解析结果（4 对象嵌套）────────────────
export type CandidateNested = {
  name: string | null;
  mobile: string | null;
  email: string | null;
  gender: string | null;
  birth_date: string | null;
  current_location: string | null;
  highest_acquired_degree: string | null;
  work_years: number | null;
  current_company: string | null;
  current_title: string | null;
  skills: string[];
};

export type CandidateExpectationNested = {
  expected_salary_monthly_min: number | null;
  expected_salary_monthly_max: number | null;
  expected_cities: string[];
  expected_industries: string[];
  expected_roles: string[];
  expected_work_mode: string | null;
};

export type ResumeNested = {
  summary: string | null;
  skills_extracted: string[];
  work_history: Array<{
    title?: string;
    company?: string;
    startDate?: string;
    endDate?: string;
    description?: string;
  }> | null;
  education_history: Array<{
    degree?: string;
    field?: string;
    institution?: string;
    graduationYear?: string;
  }> | null;
  project_history: unknown[] | null;
};

export type RuntimeNested = {
  current_title: string | null;
  current_company: string | null;
};

export type ResumeProcessedData = {
  bucket: string;
  objectKey: string;
  filename: string;
  hrFolder: string | null;
  employeeId: string | null;
  etag: string | null;
  size: number | null;
  sourceEventName: string | null;
  receivedAt: string;
  candidate: CandidateNested | Record<string, never>;
  candidate_expectation: CandidateExpectationNested | Record<string, never>;
  resume: ResumeNested | Record<string, never>;
  runtime: RuntimeNested | Record<string, never>;
  parsedAt: string;
  parserVersion: string;
  // ── matchResume agent 用到的字段 ──
  upload_id?: string;
  employee_id?: string;
  parsed?: { data?: Record<string, unknown> };
  // ── Workflow A: 持久化产物 ──
  candidate_id?: string;
  resume_id?: string;
  // 上传时关联的岗位（raas 前端"上传简历"弹框里的"关联岗位"下拉）
  job_requisition_id?: string | null;
};

// ─── §3.3 匹配输出事件 ─────────────────────────────────────
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

// ─── §3.5 Rule check 事件(matchResumeAgent 在调 RAAS /match-resume 之前
// 跑一次 LLM 预筛,决定是否推进。PASS/FAIL/REVIEW,见 lib/rule-check/) ───
export type RuleCheckAuditMeta = {
  rules_evaluated: number;
  graph_calls: number;
  client_id: string;
  business_group: string | null;
  studio: string | null;
  llm_model: string;
  llm_duration_ms: number;
  llm_round_trips: number;
  llm_prompt_tokens?: number;
  llm_completion_tokens?: number;
  rule_source: 'ontology-api' | 'json-fallback';
  fail_reason?: string;
};

export type RuleCheckPassedData = {
  upload_id: string;
  candidate_id?: string;
  resume_id?: string;
  job_requisition_id: string;
  client_id: string;
  audit: RuleCheckAuditMeta;
};

export type RuleCheckFailedData = {
  upload_id: string;
  candidate_id?: string;
  resume_id?: string;
  job_requisition_id: string;
  client_id: string;
  decision: 'FAIL' | 'REVIEW';
  failed_rules: Array<{
    rule_id: string;
    rule_name: string;
    step_id: string;
    status: 'fail' | 'pending' | 'insufficient_info' | 'not_executed';
    reason: string;
  }>;
  audit: RuleCheckAuditMeta;
};

// ─── §3.4 JD 生成相关事件 ─────────────────────────────────
export type RequirementLoggedData = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload?: Record<string, unknown>;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

export type JdGeneratedPayload = {
  job_requisition_id: string;
  client_id: string | null;

  title?: string;
  description?: string;
  qualifications?: string;
  hardRequirements?: string;
  niceToHave?: string;
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

  responsibility: string;
  requirement: string;

  jd_id: string;
  claimer_employee_id: string | null;
  hsm_employee_id: string | null;
  client_job_id: string | null;

  search_keywords: string[];
  quality_score: number;
  quality_suggestions: string[];
  market_competitiveness: "高" | "中" | "低";
  generator_version: string;
  generator_model: string;
  generated_at: string;

  [key: string]: unknown;
};

export type JdGeneratedEnvelope = {
  entity_type: "JobDescription";
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

// 事件 schema 在 inngest@4 已经不再走 EventSchemas/fromRecord(那是 v3 的
// 写法)。这里只导出 TypeScript 类型给 agent 文件 import,运行时不做强校验
// 由 agent 端做 unwrap+narrow(见 match-resume-agent.ts 里的 unwrap*Event)。

export const inngest = new Inngest({
  id: "agentic-operator-main",
  eventKey: process.env.INNGEST_EVENT_KEY,
});

// 字段映射版本号 (RoboHire output → RAAS schema)
export const MAPPING_VERSION = "2026-04-28";
export const PARSER_VERSION = `robohire@v1+map@${MAPPING_VERSION}`;
