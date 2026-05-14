// Shared fixture definitions for the rule-check test suite.
//
// Both seed-rule-check-fixtures.ts (writes data into neo4j via Ontology API)
// and run-rule-check-test-suite.ts (runs runRuleCheck + checks expectations)
// read this file. Single source of truth so the seeded data and the
// expected outcomes can't drift.
//
// Today's date baseline: 2026-05-13 (affects whether "冷冻期" thresholds
// are crossed in S2/S3/S4).

export const DOMAIN = "RAAS-v1";

// Two shared JDs that all 14 scenarios run against. Property names match the
// Job_Requisition schema (per /api/v1/ontology/objects/Job_Requisition).
// Note: `client_id` is NOT on Job_Requisition (it's on Job_Requisition_Specification);
// kept here because the runtime extractDims reads it. filterToSchema will
// silently drop it at write time, which is fine.
export const SHARED_JDS = [
  {
    job_requisition_id: "JR-TENCENT-001",
    client_id: "CLI_TENCENT_PCG", // dropped at seed-time; used by runtime extractDims
    client_department_id: "CLI_TENCENT_IEG_TIANMEI",
    client_job_title: "高级后端工程师",
    job_responsibility:
      "负责广告投放系统服务端开发，主导亿级 QPS 接口的性能优化。",
    must_have_skills: ["Java", "Spring Boot", "MySQL"],
    nice_to_have_skills: ["Kafka", "Redis"],
    work_years: 5,
    degree_requirement: "本科",
    education_requirement: "全日制",
    age_range: "20-40岁",
    hc_status: "open",
  },
  {
    job_requisition_id: "JR-GENERIC-001",
    client_id: "CLI_BYTEDANCE",
    client_department_id: "CLI_BYTEDANCE_TIKTOK",
    client_job_title: "高级后端工程师",
    job_responsibility: "负责服务端开发。",
    must_have_skills: ["Java", "Spring Boot", "MySQL"],
    nice_to_have_skills: ["Kafka"],
    work_years: 5,
    degree_requirement: "本科",
    education_requirement: "全日制",
    age_range: "20-40岁",
    hc_status: "open",
  },
] as const;

// Note: this schema doesn't have a separate `Employer` label — candidate
// work history lives inside Resume.work_experience as structured JSON.
// The LLM reads competitor / red-line / 回流 employment context directly
// from that field; there are no EMPLOYED_BY links to create.

// ────────────────────────────────────────────────────────────────────────────
// LINK_SPECS — single source of truth for link types and directions.
//
// Every entry MUST be verified against the live link schema (via the Step 2
// probe in seed-rule-check-fixtures.ts). DO NOT add entries unless the type
// and (fromEntity, toEntity) direction are confirmed; the seed script will
// silently skip any pair without a matching entry, which is the safe default.
//
// `fromEntity` / `toEntity` refer to the scenario's entity roles (which
// resolve to concrete IDs at write time). They are NOT label strings.
// ────────────────────────────────────────────────────────────────────────────

export type LinkEntityRole =
  | "candidate"
  | "resume"
  | "blacklist"
  | "application"
  | "job_requisition";

export interface LinkSpec {
  /** Neo4j relationship type name (must be in server allowlist). */
  type: string;
  /** Source role — its ID is used as the link's fromId. */
  fromEntity: LinkEntityRole;
  /** Target role — its ID is used as the link's toId. */
  toEntity: LinkEntityRole;
}

export const LINK_SPECS: LinkSpec[] = [
  // All 4 confirmed from the Step 2 dry-run probe (schema-level edges in
  // RAAS-v1). Source: each row below was observed verbatim in the
  // (fromSchema, type, toSchema) listing.

  // (:Candidate)-[:CANDIDATE_HAS_RESUME]->(:Resume)
  { type: "CANDIDATE_HAS_RESUME", fromEntity: "candidate", toEntity: "resume" },

  // (:Blacklist)-[:BLOCKS_CANDIDATE]->(:Candidate)
  { type: "BLOCKS_CANDIDATE", fromEntity: "blacklist", toEntity: "candidate" },

  // (:Candidate)-[:CANDIDATE_HAS_APPLICATIONS]->(:Application)
  { type: "CANDIDATE_HAS_APPLICATIONS", fromEntity: "candidate", toEntity: "application" },

  // (:Application)-[:TARGETS_REQUISITION]->(:Job_Requisition)
  { type: "TARGETS_REQUISITION", fromEntity: "application", toEntity: "job_requisition" },
];

// Per-rule expected status (what runRuleCheck should emit for that rule).
export type ExpectedRuleStatus =
  | "pass"
  | "fail"
  | "pending"
  | "insufficient_info"
  | "not_triggered"
  | "not_executed";

export interface WorkExperience {
  company: string;
  title: string;
  start_date: string; // "YYYY-MM"
  end_date: string; // "YYYY-MM" or "present"
}

export interface ScenarioFixture {
  id: string; // "S01" .. "S14"
  name: string;

  // Candidate — property names match /api/v1/ontology/objects/Candidate schema.
  candidate_id: string;
  candidate: {
    name: string;
    gender: "男" | "女" | "未知";
    birth_date: string | null; // YYYY-MM-DD; null for S13 (信息不全 case)
    highest_acquired_degree: string; // "大专" | "本科" | "硕士" | "博士"
    unified_enrollment: boolean; // 是否统招全日制
    /** 利益冲突声明 — on Candidate, not Resume. */
    conflict_interest_declaration: string;
    is_locked: boolean;
    blacklist_status: boolean;
  };

  // Resume — property names match /api/v1/ontology/objects/Resume schema.
  resume_id: string;
  resume: {
    /** List<String> of JR ids this resume targets. */
    job_requisition_id: string[];
    /** List<String> of extracted skill keywords. */
    skill_tags: string[];
    /** String (the schema declares it as String); seed script JSON.stringifies
     *  the WorkExperience[] structure for transmission. */
    work_experience: WorkExperience[];
    /** String (schema). Seed script stringifies as needed. */
    education_experience: string;
    /** Free-form string per schema. */
    language_skills: string;
    /** Chinese or English. */
    language: "中文" | "英文";
    is_original: boolean;
  };

  // Optional supporting nodes
  blacklist?: {
    blacklist_id: string;
    /** Single string per schema. Combine reason code + text here. */
    lock_reason: string;
    lock_duration: number; // months
  };

  applications?: Array<{
    application_id: string;
    job_requisition_id: string;
    /** "筛选淘汰" | "面试淘汰" | "筛选通过未到面" | ... */
    status: string;
    /** ISO 8601 timestamp — "简历推送给客户的时间". Used by rule 10-32 for
     *  the 3-month cooldown calculation. */
    push_timestamp: string;
  }>;

  // Which JD this scenario runs against
  job_requisition_id: string;

  // Expected outcomes
  expected: {
    decision: "PASS" | "FAIL" | "REVIEW";
    /** Specific rules whose status we want to pin. Empty = no rule-level
     *  assertion, only decision is checked. */
    rule_status: Partial<Record<string, ExpectedRuleStatus>>;
    /** If set, every rule after this rule_id (in evaluation order) must be
     *  status='not_executed' — i.e. the short-circuit was triggered HERE. */
    short_circuit_after_rule?: string;
  };
}

// ============================================================================
// 14 scenarios
// ============================================================================

// Contiguous work history from毕业(2012-06) to most-recent — no gaps > 3 months,
// so rules 10-9 / 10-10 (空窗期) don't fire insufficient_info on control cases.
const CLEAN_WORK_EXP: WorkExperience[] = [
  {
    company: "字节跳动",
    title: "后端工程师",
    start_date: "2022-01",
    end_date: "2025-12",
  },
  {
    company: "某通用公司",
    title: "软件工程师",
    start_date: "2012-07",
    end_date: "2021-12",
  },
];

const QUALIFIED_SKILLS = ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"];

function baseCandidate(_scenarioId: string, name: string) {
  return {
    name,
    gender: "男" as const,
    birth_date: "1990-01-01",
    highest_acquired_degree: "本科",
    unified_enrollment: true,
    conflict_interest_declaration: "无",
    is_locked: false,
    blacklist_status: false,
  };
}

function baseResume(targetJrId: string) {
  return {
    job_requisition_id: [targetJrId],
    skill_tags: [...QUALIFIED_SKILLS],
    work_experience: CLEAN_WORK_EXP,
    education_experience:
      "复旦大学 / 计算机科学与技术 / 本科 / 全日制 / 2008-09 ~ 2012-06",
    language_skills: "英语 CET-6",
    language: "中文" as const,
    is_original: true,
  };
}

export const SCENARIOS: ScenarioFixture[] = [
  // S01 — 控制组 PASS
  {
    id: "S01",
    name: "控制组 PASS",
    candidate_id: "C-S01-100023",
    candidate: baseCandidate("S01", "S01 — 控制组"),
    resume_id: "R-S01-100023",
    resume: baseResume("JR-TENCENT-001"),
    job_requisition_id: "JR-TENCENT-001",
    expected: { decision: "PASS", rule_status: {} },
  },

  // S02 — 华为冷冻期 REVIEW (距 2026-05-13 < 3 月 → 规则 10-25 "立即挂起")
  {
    id: "S02",
    name: "华为冷冻期 REVIEW",
    candidate_id: "C-S02-100024",
    candidate: baseCandidate("S02", "S02 — 华为近期离职"),
    resume_id: "R-S02-100024",
    resume: {
      ...baseResume("JR-TENCENT-001"),
      work_experience: [
        {
          company: "华为",
          title: "软件工程师",
          start_date: "2024-01",
          end_date: "2026-04",
        },
        ...CLEAN_WORK_EXP,
      ],
    },
    job_requisition_id: "JR-TENCENT-001",
    expected: {
      decision: "REVIEW",
      rule_status: { "10-25": "pending" },
    },
  },

  // S03 — OPPO 已过 6 月冷冻 PASS
  {
    id: "S03",
    name: "OPPO 已过冷冻 PASS",
    candidate_id: "C-S03-100025",
    candidate: baseCandidate("S03", "S03 — OPPO 久离职"),
    resume_id: "R-S03-100025",
    resume: {
      ...baseResume("JR-TENCENT-001"),
      work_experience: [
        {
          company: "OPPO",
          title: "软件工程师",
          start_date: "2024-01",
          end_date: "2025-09",
        },
        ...CLEAN_WORK_EXP,
      ],
    },
    job_requisition_id: "JR-TENCENT-001",
    expected: { decision: "PASS", rule_status: { "10-26": "pass" } },
  },

  // S04 — 小米未过 6 月冷冻 REVIEW
  {
    id: "S04",
    name: "小米未过冷冻 REVIEW",
    candidate_id: "C-S04-100026",
    candidate: baseCandidate("S04", "S04 — 小米近期离职"),
    resume_id: "R-S04-100026",
    resume: {
      ...baseResume("JR-TENCENT-001"),
      work_experience: [
        {
          company: "小米",
          title: "软件工程师",
          start_date: "2024-01",
          end_date: "2026-01",
        },
        ...CLEAN_WORK_EXP,
      ],
    },
    job_requisition_id: "JR-TENCENT-001",
    expected: { decision: "REVIEW", rule_status: { "10-26": "pending" } },
  },

  // S05 — 腾讯历史 REVIEW
  {
    id: "S05",
    name: "腾讯历史 REVIEW",
    candidate_id: "C-S05-100027",
    candidate: baseCandidate("S05", "S05 — 腾讯老员工"),
    resume_id: "R-S05-100027",
    resume: {
      ...baseResume("JR-TENCENT-001"),
      work_experience: [
        {
          company: "腾讯",
          title: "高级工程师",
          start_date: "2018-07",
          end_date: "2022-12",
        },
        ...CLEAN_WORK_EXP,
      ],
    },
    job_requisition_id: "JR-TENCENT-001",
    expected: { decision: "REVIEW", rule_status: { "10-38": "pending" } },
  },

  // S06 — 黑名单高风险 FAIL
  {
    id: "S06",
    name: "黑名单高风险 FAIL",
    candidate_id: "C-S06-100028",
    candidate: baseCandidate("S06", "S06 — 高风险回流"),
    resume_id: "R-S06-100028",
    resume: {
      ...baseResume("JR-TENCENT-001"),
      work_experience: [
        {
          company: "华腾",
          title: "工程师",
          start_date: "2016-01",
          end_date: "2019-06",
        },
        ...CLEAN_WORK_EXP,
      ],
    },
    blacklist: {
      blacklist_id: "BL-S06-100028",
      lock_reason: "A15 — 劳动纠纷诉讼（YCH）",
      lock_duration: 12,
    },
    job_requisition_id: "JR-TENCENT-001",
    expected: { decision: "FAIL", rule_status: { "10-17": "fail" } },
  },

  // S07 — EHS 挂起 REVIEW
  {
    id: "S07",
    name: "EHS 挂起 REVIEW",
    candidate_id: "C-S07-100029",
    candidate: baseCandidate("S07", "S07 — EHS 风险"),
    resume_id: "R-S07-100029",
    resume: {
      ...baseResume("JR-TENCENT-001"),
      work_experience: [
        {
          company: "华腾",
          title: "工程师",
          start_date: "2016-01",
          end_date: "2019-06",
        },
        ...CLEAN_WORK_EXP,
      ],
    },
    blacklist: {
      blacklist_id: "BL-S07-100029",
      lock_reason: "A13(1) — EHS 类",
      lock_duration: 12,
    },
    job_requisition_id: "JR-TENCENT-001",
    expected: { decision: "REVIEW", rule_status: { "10-18": "pending" } },
  },

  // S08 — 学历不符 FAIL
  {
    id: "S08",
    name: "学历不符 FAIL",
    candidate_id: "C-S08-100030",
    candidate: {
      ...baseCandidate("S08", "S08 — 大专学历"),
      highest_acquired_degree: "大专",
      unified_enrollment: false,
    },
    resume_id: "R-S08-100030",
    resume: baseResume("JR-TENCENT-001"),
    job_requisition_id: "JR-TENCENT-001",
    expected: { decision: "FAIL", rule_status: { "10-5": "fail" } },
  },

  // S09 — 年龄超限 FAIL
  {
    id: "S09",
    name: "年龄超限 FAIL",
    candidate_id: "C-S09-100031",
    candidate: {
      ...baseCandidate("S09", "S09 — 年龄 46"),
      birth_date: "1980-01-01",
    },
    resume_id: "R-S09-100031",
    resume: baseResume("JR-TENCENT-001"),
    job_requisition_id: "JR-TENCENT-001",
    expected: { decision: "FAIL", rule_status: { "10-21": "fail" } },
  },

  // S10 — 必备技能缺失 FAIL
  {
    id: "S10",
    name: "必备技能缺失 FAIL",
    candidate_id: "C-S10-100032",
    candidate: baseCandidate("S10", "S10 — 技能不符"),
    resume_id: "R-S10-100032",
    resume: {
      ...baseResume("JR-TENCENT-001"),
      skill_tags: ["Python", "Go", "Rust"], // missing Java/Spring Boot/MySQL
    },
    job_requisition_id: "JR-TENCENT-001",
    expected: { decision: "FAIL", rule_status: { "10-5": "fail" } },
  },

  // S11 — 亲属回避 REVIEW
  {
    id: "S11",
    name: "亲属回避 REVIEW",
    candidate_id: "C-S11-100033",
    candidate: {
      ...baseCandidate("S11", "S11 — 配偶在腾讯"),
      conflict_interest_declaration:
        "配偶王某某在腾讯 IEG 任正式员工（产品经理）。",
    },
    resume_id: "R-S11-100033",
    resume: baseResume("JR-TENCENT-001"),
    job_requisition_id: "JR-TENCENT-001",
    expected: { decision: "REVIEW", rule_status: { "10-27": "pending" } },
  },

  // S12 — 岗位冷冻期 REVIEW
  {
    id: "S12",
    name: "岗位冷冻期 REVIEW",
    candidate_id: "C-S12-100034",
    candidate: baseCandidate("S12", "S12 — 近期淘汰"),
    resume_id: "R-S12-100034",
    resume: baseResume("JR-TENCENT-001"),
    applications: [
      {
        application_id: "A-S12-100034",
        job_requisition_id: "JR-TENCENT-001",
        status: "筛选淘汰",
        push_timestamp: "2026-03-15T00:00:00+08:00",
      },
    ],
    job_requisition_id: "JR-TENCENT-001",
    expected: { decision: "REVIEW", rule_status: { "10-32": "pending" } },
  },

  // S13 — 年龄信息不全
  {
    id: "S13",
    name: "年龄信息不全",
    candidate_id: "C-S13-100035",
    candidate: {
      ...baseCandidate("S13", "S13 — 缺出生日期"),
      birth_date: null,
    },
    resume_id: "R-S13-100035",
    resume: baseResume("JR-TENCENT-001"),
    job_requisition_id: "JR-TENCENT-001",
    expected: {
      decision: "REVIEW",
      rule_status: { "10-21": "insufficient_info" },
    },
  },

  // S14 — 短路验证
  {
    id: "S14",
    name: "短路验证（华为冷冻期 + 学历不符）",
    candidate_id: "C-S14-100036",
    candidate: {
      ...baseCandidate("S14", "S14 — 多问题"),
      highest_acquired_degree: "大专",
      unified_enrollment: false,
    },
    resume_id: "R-S14-100036",
    resume: {
      ...baseResume("JR-TENCENT-001"),
      work_experience: [
        {
          company: "华为",
          title: "软件工程师",
          start_date: "2024-01",
          end_date: "2026-04",
        },
        ...CLEAN_WORK_EXP,
      ],
    },
    job_requisition_id: "JR-TENCENT-001",
    expected: {
      decision: "FAIL",
      rule_status: {
        "10-25": "fail",
        "10-5": "not_executed", // short-circuited by 10-25 in Step 1
      },
      short_circuit_after_rule: "10-25",
    },
  },
];
