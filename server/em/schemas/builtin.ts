// Hardcoded fallback schemas for the 8 core events.
//
// Source-of-truth contract: when EventDefinition table has a row from Neo4j,
// the registry uses that row. When it doesn't (cold start / off-VPN / event
// not in Neo4j), we fall through to these. They're intentionally permissive
// (most fields optional) — RAAS payloads vary; tightening happens later
// once we have real fixtures.

import { z } from "zod";
import type { EventSchemaRegistration } from "./types";

// ── Common envelope sub-schemas ───────────────────────────────────────────

const TraceSchema = z
  .object({
    trace_id: z.string().nullable().optional(),
    request_id: z.string().nullable().optional(),
    workflow_id: z.string().nullable().optional(),
    parent_trace_id: z.string().nullable().optional(),
  })
  .partial()
  .optional();

// Most RAAS events are wrapped in an envelope:
//   { entity_type, entity_id?, event_id, payload: {...}, trace? }
// Permissive base — individual events tighten the payload.
function envelope(payload: z.ZodType) {
  return z.object({
    entity_type: z.string().optional(),
    entity_id: z.union([z.string(), z.null()]).optional(),
    event_id: z.string().optional(),
    payload,
    trace: TraceSchema,
  });
}

// ── Event schemas ─────────────────────────────────────────────────────────

const REQUIREMENT_LOGGED_v1 = envelope(
  z.object({
    requirement_id: z.string(),
    client_id: z.string().optional(),
    job_requisition_id: z.string().optional(),
    title: z.string().optional(),
  }).passthrough(),
);

const RESUME_DOWNLOADED_v1 = envelope(
  z.object({
    upload_id: z.string().min(1),
    bucket: z.string().min(1),
    object_key: z.string().min(1),
    filename: z.string().nullable().optional(),
    etag: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
    employee_id: z.string().nullable().optional(),
    job_requisition_id: z.string().optional(),
    received_at: z.string().optional(),
  }).passthrough(),
);

const RESUME_PROCESSED_v1 = envelope(
  z.object({
    upload_id: z.string().min(1),
    parsed: z
      .object({
        data: z.record(z.string(), z.unknown()),
      })
      .optional(),
    job_requisition_id: z.string().optional(),
  }).passthrough(),
);

const JD_GENERATED_v1 = envelope(
  z.object({
    requirement_id: z.string().optional(),
    job_requisition_id: z.string().optional(),
    jd_id: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
  }).passthrough(),
);

// MATCH_PASSED_NEED_INTERVIEW / MATCH_PASSED_NO_INTERVIEW / MATCH_FAILED
// share the same shape — F3 (2026-05-19): top-level candidate_id / matching_score /
// upload_id with explicit nulls. Partner auto-invitation dispatcher reads these
// from top level.
const MATCH_PAYLOAD_v1 = z
  .object({
    job_requisition_id: z.string(),
    candidate_id: z.string().nullable(),
    matching_score: z.number().nullable(),
    upload_id: z.string().nullable(),
    job_posting_id: z.string().nullable().optional(),
    jd_id: z.string().optional(),
  })
  .passthrough();

const MATCH_PASSED_NEED_INTERVIEW_v1 = envelope(MATCH_PAYLOAD_v1);
const MATCH_PASSED_NO_INTERVIEW_v1 = envelope(MATCH_PAYLOAD_v1);
const MATCH_FAILED_v1 = envelope(MATCH_PAYLOAD_v1);

// MATCH_RULE_CHECK_PASSED — ruleCheckAgent → matchResumeAgent 过桥事件。
// 沿用 MATCH_PAYLOAD_v1 平铺契约;另带 job_requisition + parsed_resume 透传。
const MATCH_RULE_CHECK_PASSED_v1 = envelope(
  MATCH_PAYLOAD_v1.extend({
    employee_id: z.string().optional(),
    audit: z.record(z.string(), z.unknown()).optional(),
    job_requisition: z.record(z.string(), z.unknown()).optional(),
    parsed_resume: z.record(z.string(), z.unknown()).nullable().optional(),
    runtime_context: z.record(z.string(), z.unknown()).optional(),
  }),
);

// MATCH_RULE_CHECK_FAILED — ruleCheckAgent rule-check 失败时 emit;
// matching_score 在 rule-check 阶段固定为 null;data 里塞 failed_rules / decision。
const MATCH_RULE_CHECK_FAILED_v1 = envelope(MATCH_PAYLOAD_v1);

// JD_REJECTED — when JD generation hits a business reject (unclear req etc.)
const JD_REJECTED_v1 = envelope(
  z.object({
    requirement_id: z.string().optional(),
    reason: z.string(),
  }).passthrough(),
);

// ── Registrations ─────────────────────────────────────────────────────────

export const BUILTIN_SCHEMAS: EventSchemaRegistration[] = [
  {
    name: "REQUIREMENT_LOGGED",
    description: "客户提交了一条招聘需求；触发 JD 生成",
    versions: [{ version: "1.0", schema: REQUIREMENT_LOGGED_v1 }],
    publishers: ["raas-dashboard", "raas-bridge"],
    subscribers: ["createJdAgent"],
  },
  {
    name: "RESUME_DOWNLOADED",
    description: "MinIO 收到一份新简历；触发解析",
    versions: [{ version: "1.0", schema: RESUME_DOWNLOADED_v1 }],
    publishers: ["raas-bridge"],
    subscribers: ["resumeParserAgent"],
  },
  {
    name: "RESUME_PROCESSED",
    description: "简历解析完成（RoboHire / LLM）;2026-05-19 后 ruleCheckAgent 直订",
    versions: [{ version: "1.0", schema: RESUME_PROCESSED_v1 }],
    publishers: ["rpa.resumeParserAgent", "raas.reassign-republisher"],
    subscribers: [
      "ao.ruleCheckAgent",
      "raas-backend.resume-processed-ingest",
    ],
  },
  {
    name: "MATCH_RULE_CHECK_PASSED",
    description: "ruleCheckAgent 通过规则检查;matchResumeAgent 据此调 RoboHire match",
    versions: [{ version: "1.0", schema: MATCH_RULE_CHECK_PASSED_v1 }],
    publishers: ["ao.ruleCheckAgent"],
    subscribers: ["ao.matchResumeAgent"],
  },
  {
    // ruleCheckAgent rule-check 失败时发(区别于 matchResumeAgent 自身的
    // 低分 MATCH_FAILED).  Team review 2026-05-20: revert Plan B 统一 — 保留独立事件,
    // 让审计 / partner dispatcher 能 route 不同的失败语义。
    name: "MATCH_RULE_CHECK_FAILED",
    description: "rule-check FAIL/REVIEW;matching_score 固定 null,data 含 failed_rules + decision",
    versions: [{ version: "1.0", schema: MATCH_RULE_CHECK_FAILED_v1 }],
    publishers: ["ao.ruleCheckAgent"],
    subscribers: [],
  },
  {
    name: "JD_GENERATED",
    description: "createJdAgent 输出的 JD",
    versions: [{ version: "1.0", schema: JD_GENERATED_v1 }],
    publishers: ["createJdAgent"],
    subscribers: ["raas-backend.jd-generated-sync"],
  },
  {
    name: "JD_REJECTED",
    description: "JD 生成被业务拒绝（需澄清等）",
    versions: [{ version: "1.0", schema: JD_REJECTED_v1 }],
    publishers: ["createJdAgent"],
    subscribers: ["raas-backend"],
  },
  {
    name: "MATCH_PASSED_NEED_INTERVIEW",
    description: "候选人 × JD 匹配通过，需面试",
    versions: [{ version: "1.0", schema: MATCH_PASSED_NEED_INTERVIEW_v1 }],
    publishers: ["rpa.matchResumeAgent"],
    subscribers: ["raas-backend.match-result-ingest-need-interview"],
  },
  {
    name: "MATCH_PASSED_NO_INTERVIEW",
    description: "候选人 × JD 匹配通过，免面试",
    versions: [{ version: "1.0", schema: MATCH_PASSED_NO_INTERVIEW_v1 }],
    publishers: ["rpa.matchResumeAgent"],
    subscribers: ["raas-backend.match-result-ingest-no-interview"],
  },
  {
    name: "MATCH_FAILED",
    description: "matchResumeAgent 低分淘汰(score < 50 / null);rule-check 失败请订阅 MATCH_RULE_CHECK_FAILED",
    versions: [{ version: "1.0", schema: MATCH_FAILED_v1 }],
    publishers: ["rpa.matchResumeAgent"],
    subscribers: ["raas-backend.match-result-ingest-failed"],
  },
];

export const BUILTIN_SCHEMAS_BY_NAME = new Map(
  BUILTIN_SCHEMAS.map((r) => [r.name, r] as const),
);
