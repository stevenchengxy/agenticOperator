# AO ↔ RAAS 出入参对照(v0_1_010 终稿)

> **目的**:RAAS 团队对接参考。AO 端基于 [docs/data/objects_v0_1_010.json](data/objects_v0_1_010.json) 完成 DataObject 对齐后,所有出参 / 入参的字段名 / 类型 / shape 在本文锁定。
>
> **效力**:本文是 AO 与 RAAS 之间的接口契约。AO 端字段已落库,RAAS 端**仅需调整 6 处字段命名**(见 §6 RAAS 端 action list)。其余字段保持不变。
>
> **关联文档**:
> - [docs/ao-allmeta-alignment-action-plan.md](ao-allmeta-alignment-action-plan.md) §0 → §3 — Allmeta DataObject 终稿
> - [docs/raas-internal-api-spec.md](raas-internal-api-spec.md) — 既有 RAAS API 契约(本文是其 v0_1_010 增量补丁)
> - [docs/data/objects_v0_1_010.json](data/objects_v0_1_010.json) — DataObject SSoT
>
> **更新时间**:2026-05-15

---

## 1. 改动概要(给 RAAS PM 看 30s)

| 维度 | v0_1_010 改动 | 谁要改 |
|---|---|---|
| ★ Candidate 字段命名 | `mobile → phone` · `current_location → address` | 双方 mapper 都改名 |
| ★ Candidate_Expectation | `expected_position/location/industry` → 复数 `expected_positions/_locations/_industries`(类型仍 String,不拆 List) | 双方 |
| ★ Resume 字段命名 | 跟 RoboHire vendor 一致(`work_experience → experience` 等 6 处) | 双方 |
| Resume 新增字段 | `summary` / `portfolio` / `publications` / `patents` / `awards` | RAAS 接住即可(可选填) |
| Candidate_Expectation 新增 | `expected_work_mode`(remote/hybrid/onsite) | RAAS 接住即可 |
| Job_Requisition | **完全不动** | 不用改 |
| Candidate_Match_Result | RAAS 端 schema 不变(RAAS 内部 legacy DB),Allmeta 端只存 4 个核心结论字段(score/verdict/summary/grade) | 不用改 |

**RAAS 端实际要改的核心**:5 处字段名 + 6 个新增可选字段。详见 §6。

---

## 2. 链路总图

```
              ┌─────────────────────┐
              │  RAAS partner side  │
              │  (Inngest + API)    │
              └─────────────────────┘
                  │           ▲
        events↓   │           │ AO emits events
                  │           │   (RESUME_PROCESSED / MATCH_* / JD_GENERATED)
                  ▼           │
        ╔═════════════════════╧═════════════╗
        ║  AO (Agentic Operator)            ║
        ║  3 deployed Inngest agents:       ║
        ║   - resume-parser-agent           ║
        ║   - create-jd-agent               ║
        ║   - match-resume-agent            ║
        ╚═════════╤═════════════════════════╝
                  │ AO calls RAAS HTTP API
                  ▼
        ┌──────────────────────────┐
        │ RAAS API Server :3001    │
        │ POST /candidates         │ ← saveCandidate
        │ POST /match-results      │ ← saveMatchResults
        │ POST /jd/sync-generated  │ ← syncJdGenerated
        │ POST /parse-resume       │ proxy → RoboHire
        │ POST /match-resume       │ proxy → RoboHire
        │ POST /generate-jd        │ proxy → RoboHire
        │ GET /requirements/...    │ ← read JR
        │ GET /resumes/uploads/... │ ← read PDF
        └──────────────────────────┘
```

---

## 3. **入参** — RAAS → AO(RAAS 发的事件 AO 消费)

### 3.1 `RESUME_DOWNLOADED`(简历入境)

**触发场景**:RAAS dashboard / IDE 上传简历,文件落 MinIO 后 RAAS 在 Inngest 发此事件。

**AO 消费方**:`resume-parser-agent`(workflow node 9-1)

**Payload v0_1_010**:

```typescript
type ResumeDownloadedData = {
  // ─── 必填(transport)───
  bucket: string;            // MinIO bucket,例 "recruit-resume-raw"
  objectKey: string;         // MinIO object key
  filename: string;
  receivedAt: string;        // ISO 8601

  // ─── 强烈推荐(去重 + 关联)───
  upload_id?: string;        // RAAS 上传记录 PK · 缺失时 AO 用 etag 兜底
  etag?: string;             // MinIO etag · 用于幂等
  size?: number;
  hrFolder?: string | null;
  employeeId?: string | null;
  sourceEventName?: string | null;

  // ─── ★ 可选 fast-path: 事件已带解析结果 ───
  // 如果 RAAS 已经预解析了,把 RoboHire /parse-resume 的 data 直接塞这里,
  // AO 跳过 MinIO 拉取 + 重新调 /parse-resume(省 ~10s + 一次 LLM 配额)。
  parsed?: {
    data: {
      // 跟 RoboHire /parse-resume 返回的 data 完全一致(camelCase)
      name?: string;
      email?: string;
      phone?: string;
      location?: string;       // ← 注意:RoboHire 用 location(顶级)
                               //   AO mapper 会改名为 Allmeta address
      summary?: string;
      experience?: Array<{
        title?: string;
        company?: string;
        startDate?: string;
        endDate?: string;
        description?: string;
        [k: string]: unknown;
      }>;
      education?: Array<{
        degree?: string;
        field?: string;
        institution?: string;
        graduationYear?: string;
        [k: string]: unknown;
      }>;
      skills?: string[];
      certifications?: string[] | Array<Record<string, unknown>>;
      languages?: Array<{ language?: string; proficiency?: string }>;
      // RoboHire 新增字段(AO mapper 会接住)
      linkedin?: string;
      github?: string;
      portfolio?: string;
      publications?: unknown[];
      patents?: unknown[];
      awards?: unknown[];
      // 散装中文 key(AO mapper 会派生)
      otherSections?: {
        '个人信息补充'?: string;     // "民族:汉族;生日:2002-10-10;籍贯:..."
        '求职意向'?: string;
        '期望薪资'?: string;
        [k: string]: unknown;
      };
    };
  };
};
```

### 3.2 `REQUIREMENT_LOGGED`(新招聘需求)

**触发场景**:HSM 或 partner system 录入一条新的招聘需求。

**AO 消费方**:`create-jd-agent`(workflow node 4)— 自动生成 JD 草稿

**Payload v0_1_010**:

```typescript
type RequirementLoggedData = {
  entity_type: 'Job_Requisition';
  entity_id: string;                    // = job_requisition_id
  event_id?: string;

  payload: {
    job_requisition_id: string;         // PK
    client_id: string;

    raw_input_data: {
      prompt: string;                   // 用户手写的需求描述(给 LLM)
      language?: 'zh' | 'en' | 'zh-TW';
      company?: string;
      department?: string;
      // 可选预填字段,LLM 会优先用
      title?: string;
      location?: string;
      headcount?: number;
      // ...其他 RoboHire /generate-jd 支持的预填字段
    };
  };

  trace?: {
    trace_id?: string;
    request_id?: string;
    workflow_id?: string;
    parent_trace_id?: string;
  };
};
```

---

## 4. **出参** — AO → RAAS(AO 调 RAAS HTTP API)

AO 3 个 agent 跑完后会调 RAAS 的 3 个持久化 endpoint。**这部分 v0_1_010 没改 endpoint shape**,RAAS 端**不需要改 API handler**。仅 AO 端内部 mapper 升级。

### 4.1 `POST /api/v1/candidates`(saveCandidate)

**调用方**:`resume-parser-agent` 在 parse 完简历后

**Request Body**:

```typescript
type SaveCandidateInput = {
  upload_id: string;                    // ★ 必填,RAAS 用它做候选人锁
  bucket: string;
  object_key: string;
  etag?: string;
  mime_type?: string;
  file_size?: number;
  original_filename?: string;
  operator_employee_id?: string;
  client_id?: string;
  job_requisition_id?: string;

  /** RoboHire /parse-resume.data — AO 透传(不做字段重命名)*/
  parsed: {
    name?: string;
    email?: string;
    phone?: string;
    location?: string;
    summary?: string;
    experience?: unknown[];
    education?: unknown[];
    skills?: string[];
    certifications?: unknown[];
    languages?: unknown[];
    [k: string]: unknown;
  };

  robohire_request_id?: string;
};
```

**Response**:

```typescript
type SaveCandidateResponse = {
  candidate_id: string;
  candidate_name?: string;
  resume_id?: string;
  is_new_candidate?: boolean;
  is_new_resume?: boolean;
  requestId: string;
};
```

> ✅ **RAAS 端不用改**。AO 端字段全部透传 RoboHire 原始 shape。

### 4.2 `POST /api/v1/match-results`(saveMatchResults)

**调用方**:`match-resume-agent` 在 match 完后

**Request Body**:

```typescript
type SaveMatchResultsInput =
  // need_interview 单条
  | (MatchResultItem & { source: 'need_interview' })
  // no_interview 批量
  | { source: 'no_interview'; match_results: MatchResultItem[] };

type MatchResultItem = {
  // 必填二选一
  candidate_id?: string;
  upload_id?: string;
  // 必填二选一(job_id 是 alias)
  job_requisition_id?: string;
  job_id?: string;

  client_id?: string;
  job_posting_id?: string;
  candidate_match_result_id?: string;     // 显式 override,否则 RAAS 按 (cand×JR) 去重

  // RoboHire /match-resume.data 全部 spread(camelCase)
  matchScore?: number;
  recommendation?: string;
  summary?: string;
  matchAnalysis?: Record<string, unknown>;
  mustHaveAnalysis?: Record<string, unknown>;
  niceToHaveAnalysis?: Record<string, unknown>;
  resumeAnalysis?: Record<string, unknown>;
  jdAnalysis?: Record<string, unknown>;
  skillMatch?: Record<string, unknown>;
  skillMatchScore?: Record<string, unknown> | number;
  experienceMatch?: Record<string, unknown>;
  experienceValidation?: Record<string, unknown>;
  candidatePotential?: Record<string, unknown>;
  transferableSkills?: unknown[];
  experienceBreakdown?: Record<string, unknown>;
  hardRequirementGaps?: string[];
  workHistoryStability?: Record<string, unknown>;
  overallMatchScore?: Record<string, unknown>;    // ★ 真实评分在这里
  overallFit?: Record<string, unknown>;           // ★ 真实分级在这里
  recommendations?: Record<string, unknown>;
  suggestedInterviewQuestions?: Record<string, unknown>;
  areasToProbeDeeper?: unknown[];
  preferenceAlignment?: Record<string, unknown>;

  // AO trace
  robohire_request_id?: string;
  savedAs?: string;
};
```

**Response**:

```typescript
type SaveMatchResultsResponse =
  | { upserted: true; candidate_match_result_id: string; source: 'need_interview' }
  | { count: number; results: Array<{...}>; source: 'no_interview' };
```

> ⚠ **重要提醒(2026-05-14 直连 RoboHire 实测)**:
> - `data.matchScore` / `data.recommendation` / `data.summary` 这 3 个顶级字段在真实响应里**永远是 null**。
> - 真实评分 = `data.overallMatchScore.score`(0-100 整数)
> - 真实分级 = `data.overallFit.verdict`("Strong Match" / "Good Match" 自然语言)
> - 真实摘要 = `data.overallFit.summary`
>
> **AO 端 mapper 已 pluck 这些嵌套路径**(see [docs/ao-allmeta-alignment-action-plan.md §3.5 C.5](ao-allmeta-alignment-action-plan.md)),写 Allmeta 时归一化。RAAS 端如果做 candidate_match_result 列表展示需要分数,**请用 `data.overallMatchScore.score` 而非 `data.matchScore`**。

### 4.3 `POST /api/v1/jd/sync-generated`(syncJdGenerated)

**调用方**:`create-jd-agent` 生成 JD 后

**Request Body**:

```typescript
type SyncJdInput = {
  // ─── 必填 ───
  job_requisition_id: string;
  client_id: string;

  // ─── RoboHire generate-jd.data camelCase(AO spread)───
  title?: string;
  description?: string;
  qualifications?: string;
  hardRequirements?: string;
  niceToHave?: string;
  interviewRequirements?: string;
  evaluationRules?: string;
  benefits?: string;
  salaryMin?: number | string;
  salaryMax?: number | string;
  salaryCurrency?: string;
  salaryPeriod?: string;
  salaryText?: string;
  headcount?: number | string;
  experienceLevel?: string;
  education?: string;
  employmentType?: string;
  location?: string;
  workType?: string;
  companyName?: string;
  department?: string;

  // ─── RAAS 内部 snake_case(增强)───
  posting_title?: string;
  posting_description?: string;
  city?: string[];
  salary_range?: string;
  interview_mode?: string;
  degree_requirement?: string;
  education_requirement?: string;
  must_have_skills?: string[];
  nice_to_have_skills?: string[];
  expected_level?: string;
  language_requirements?: string;
  negative_requirement?: string;
};
```

> ✅ **RAAS 端不用改**(原有 handler 已同时接受 camelCase + snake_case)。

---

## 5. **出参** — AO → RAAS(AO 发的事件 RAAS 消费)

### 5.1 `RESUME_PROCESSED`(简历处理完成)

**发出方**:`resume-parser-agent`

**消费方**:RAAS / `match-resume-agent`(AO 内部级联)

**Payload v0_1_010(★ 重要改动)**:

```typescript
type ResumeProcessedData = {
  // ─── transport 透传(从 RESUME_DOWNLOADED 带过来)───
  bucket: string;
  objectKey: string;
  filename: string;
  hrFolder: string | null;
  employeeId: string | null;
  etag: string | null;
  size: number | null;
  sourceEventName: string | null;
  receivedAt: string;

  // ─── anchor(matcher / RAAS 必读)───
  upload_id?: string;
  candidate_id?: string;                  // ← saveCandidate 返回的 PK
  resume_id?: string;                     // ← saveCandidate 返回的 PK
  employee_id?: string;
  job_requisition_id?: string | null;     // 上传时关联岗位(单匹配)

  // ─── parsed.data(透传 RoboHire 原文,RAAS 可以读)───
  parsed?: { data?: Record<string, unknown> };

  // ─── ★ v0_1_010 终稿:3 个 Nested(对齐 Allmeta DataObject)───
  // RAAS 如果要直接消费这些 Nested 而不是从 parsed.data 再解,
  // 字段名按本节,跟 Allmeta DataObject 一致(见 §7 字段映射表)。
  candidate: CandidateNested | {};
  candidate_expectation: CandidateExpectationNested | {};
  resume: ResumeNested | {};

  // 元数据
  parsedAt: string;
  parserVersion: string;                  // 例 "v7-pull-model@2026-05-08"
};
```

**关键改动 vs 之前**:
- ❌ 删除 `runtime` Nested(原 `{ current_title, current_company }`,跟 candidate 重复)
- ★ `CandidateNested.mobile → phone`
- ★ `CandidateNested.current_location → address`
- ★ `ResumeNested.skills_extracted → skills`(类型仍 string[])
- ★ `ResumeNested.work_history → experience`(类型 Object[] → String,JSON.stringify)
- ★ `ResumeNested.education_history → education`(同上)
- ★ `ResumeNested.project_history → projects`(同上)
- ✅ 新增 `ResumeNested.{summary, certifications, languages, portfolio, publications, patents, awards}`

详细 Nested 类型定义见 §7。

### 5.2 `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED`

**发出方**:`match-resume-agent`

**消费方**:RAAS interview-invitation / hitl-task-creator / notification-dispatcher 等

**Payload v0_1_010**:

```typescript
type MatchEventData = {
  upload_id: string;                      // RAAS 反查 candidate_id 用
  job_requisition_id: string;

  // RoboHire /match-resume 完整响应(平铺,不归一化)
  success?: boolean;
  data?: Record<string, unknown>;         // 19 个 RoboHire 顶级 key,见下
  requestId?: string;
  savedAs?: string;
  error?: string;
};
```

**`data` 的 19 个顶级 key**(基于 2026-05-14 实测,2 份样本完全一致):

```
overallMatchScore   { score, grade, confidence, breakdown }   ★ 真实评分
overallFit          { verdict, summary, hiringRecommendation, topReasons, ... }   ★ 真实分级
mustHaveAnalysis    { mustHaveScore, disqualified, disqualificationReasons, ... }
niceToHaveAnalysis  { niceToHaveScore, competitiveAdvantage, ... }
skillMatchScore     { score, credibilityFlags { hasRedFlags, concerns, ... } }
skillMatch          { matchedMustHave, missingMustHave, matchedNiceToHave, ... }
experienceMatch     { required, candidate, yearsGap, assessment }
experienceValidation { score, relevanceToRole, gaps, strengths, careerProgression }
candidatePotential  { riskFactors, growthTrajectory, leadershipIndicators, ... }
transferableSkills  [{ required, candidateHas, relevance, valueFactor }]
experienceBreakdown { fullTime, internship, contract, totalRelevant, note }
hardRequirementGaps [string]
workHistoryStability { score, pattern, shortStintCount, currentlyEmployed, ... }
recommendations     { forRecruiter, forCandidate, interviewQuestions }
suggestedInterviewQuestions { technical, behavioral, redFlagProbing }
areasToProbeDeeper  [{ area, priority, reason, subAreas, suggestedApproach }]
preferenceAlignment { overallScore, locationFit, salaryFit, ... }
resumeAnalysis      (RoboHire 对简历的二次解读)
jdAnalysis          (RoboHire 对 JD 的二次解读)

⚠ 顶级 matchScore / recommendation / summary 这 3 个字段实测永远 = null,
   勿用,真实评分在 overallMatchScore.score + overallFit.verdict。
```

### 5.3 `JD_GENERATED`(JD 生成完成)

**发出方**:`create-jd-agent`

**消费方**:RAAS jd-distribution / hitl-task-creator(JD review)

**Payload v0_1_010**:

```typescript
type JdGeneratedPayload = {
  // 关联(必填)
  job_requisition_id: string;
  client_id: string | null;

  // RoboHire generate-jd.data camelCase(spread)
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

  // partner-canonical snake_case(增强,跟 sync-generated body 一致)
  posting_title: string;          // 必填(AO 派生)
  posting_description: string;    // 必填(AO 派生)
  city: string[];
  salary_range: string;
  interview_mode: string;
  degree_requirement: string;
  education_requirement: string;
  must_have_skills: string[];
  nice_to_have_skills: string[];
  expected_level: string;
  language_requirements: string;
  negative_requirement: string;

  // AO bookkeeping
  jd_id?: string;                 // sync-generated 返回的 PK
  claimer_employee_id?: string | null;
  generator_version?: string;     // 例 "robohire-v1@2026-05-08"

  // catch-all 容忍 vendor 新字段
  [k: string]: unknown;
};
```

---

## 6. ★ RAAS 端 v0_1_010 action items(实操清单)

### Phase A — 字段命名修正(5 处,P0)

| # | 位置 | 旧 | 新 |
|---|---|---|---|
| 1 | RESUME_PROCESSED.candidate(consume side)| `mobile` | `phone` |
| 2 | RESUME_PROCESSED.candidate | `current_location` | `address` |
| 3 | RESUME_PROCESSED.candidate_expectation | `expected_position` | `expected_positions`(类型仍 String)|
| 4 | RESUME_PROCESSED.candidate_expectation | `expected_location` | `expected_locations`(类型仍 String)|
| 5 | RESUME_PROCESSED.candidate_expectation | `expected_industry` | `expected_industries`(类型仍 String)|

### Phase B — Resume Nested 字段重命名(6 处,P0)

如果 RAAS 端有消费 `RESUME_PROCESSED.resume` 嵌套对象,字段名按以下更新:

| # | 旧 | 新 | 类型 |
|---|---|---|---|
| 1 | `skills_extracted` | `skills` | `string[]`(不变)|
| 2 | `work_history`(Object[]) | `experience` | **String** ★(JSON.stringify 序列化)|
| 3 | `education_history`(Object[]) | `education` | **String** |
| 4 | `project_history`(Object[]) | `projects` | **String** |
| 5 | `language_skills` | `languages` | String |
| 6 | `certificate` | `certifications` | String |

> 关键:Object 数组类型的字段(experience / projects / education)统一改成 **JSON.stringify 后的 String**。Neo4j 不擅长嵌套对象,这是 Allmeta 端的硬约束。RAAS 端需要时反序列化(`JSON.parse(payload.resume.experience)`)。

### Phase C — 新增字段(7 处,P1 可选填)

如果 RAAS 端要展示这些字段,本地 schema 加列即可;不需要立刻强制非空。

| # | 位置 | 字段 | 类型 | 来源 |
|---|---|---|---|---|
| 1 | candidate | `github` | String | RoboHire 顶级 |
| 2 | candidate | `ethnicity` | String | 派生 otherSections."个人信息补充" |
| 3 | candidate | `native_place` | String | 派生 otherSections."个人信息补充" |
| 4 | candidate_expectation | `expected_work_mode` | String | remote/hybrid/onsite |
| 5 | candidate_expectation | `expected_salary_range` | String | "6k-8k" 等,**不拆 min/max** |
| 6 | resume | `summary` | String | RoboHire 顶级 |
| 7 | resume | `portfolio / publications / patents / awards` | String | RoboHire 顶级 |

### Phase D — 删除字段(1 处,P1)

| # | 位置 | 字段 | 备注 |
|---|---|---|---|
| 1 | RESUME_PROCESSED.runtime | **整个 Nested 删除** | 字段重复(`current_title / current_company`),AO 端已停发 |

### Phase E — 注意事项(不需要改 schema,但需要改读取逻辑)

| # | 提醒 | 影响 |
|---|---|---|
| 1 | 候选人匹配分数请读 `match_results.data.overallMatchScore.score`,**不要读 `data.matchScore`**(实测永远 null)| RAAS dashboard / partner UI |
| 2 | 候选人匹配分级请读 `match_results.data.overallFit.verdict`(自然语言 "Strong Match" 等),不是 `data.recommendation` | 同上 |
| 3 | 候选人摘要读 `match_results.data.overallFit.summary`,不是 `data.summary` | 同上 |
| 4 | `RESUME_PROCESSED.parsed.data.location`(RoboHire 顶级 location)→ Allmeta 端会映射成 `candidate.address` | 名词对齐 |
| 5 | Job_Requisition DataObject **完全不动** — `csi_department_id` / `hc_status` / `open_date` 等都保留原命名 | 不用改 mapper |

---

## 7. Nested 类型完整定义(给 RAAS 工程师 copy 用)

### 7.1 `CandidateNested`(v0_1_010 终稿)

```typescript
type CandidateNested = {
  name: string | null;
  phone: string | null;                  // ★ 改 mobile → phone
  email: string | null;
  gender: string | null;
  birth_date: string | null;
  address: string | null;                // ★ 改 current_location → address
  highest_acquired_degree: string | null;
  work_years: number | null;
  github: string | null;                 // ★ 新
  ethnicity: string | null;              // ★ 新
  native_place: string | null;           // ★ 新
};
```

### 7.2 `CandidateExpectationNested`

```typescript
type CandidateExpectationNested = {
  expected_positions: string | null;     // ★ 改名(复数);类型仍 string,多值用 "/" 或 "、" join
  expected_locations: string | null;     // ★ 改名;类型 string
  expected_industries: string | null;    // ★ 改名;类型 string
  expected_salary_range: string | null;  // ★ 新;直接存 "6k-8k",不拆 min/max
  expected_work_mode: string | null;     // ★ 新;remote/hybrid/onsite
};
```

### 7.3 `ResumeNested`

```typescript
type ResumeNested = {
  summary: string | null;                // RoboHire 顶级 summary
  skills: string[];                      // ★ 改名 skills_extracted → skills
  experience: string | null;             // ★ 改名 + 改类型 Object[] → String(JSON.stringify)
  education: string | null;              // ★ 同上
  projects: string | null;               // ★ 同上(原 project_history)
  certifications: string | null;         // ★ 改名 certificate → certifications
  languages: string | null;              // ★ 改名 language_skills → languages
  portfolio: string | null;              // ★ 新
  publications: string | null;           // ★ 新
  patents: string | null;                // ★ 新
  awards: string | null;                 // ★ 新
};
```

---

## 8. 字段映射速查(三层对照)

| RoboHire response | AO Nested(事件 payload) | Allmeta DataObject 字段 |
|---|---|---|
| `phone` | `candidate.phone` | `Candidate.phone` |
| `address` | `candidate.address` | `Candidate.address` |
| `location`(顶级,简历提取出的地址)| `candidate.address` | `Candidate.address` |
| (计算)`experience[].duration sum` | `candidate.work_years` | `Candidate.work_years` |
| `github` | `candidate.github` | `Candidate.github` |
| `otherSections["个人信息补充"]` 派生民族 | `candidate.ethnicity` | `Candidate.ethnicity` |
| `otherSections["个人信息补充"]` 派生籍贯 | `candidate.native_place` | `Candidate.native_place` |
| `otherSections["求职意向"]` | `candidate_expectation.expected_positions` | `Candidate_Expectation.expected_positions` |
| `otherSections["期望薪资"]` | `candidate_expectation.expected_salary_range` | `Candidate_Expectation.expected_salary_range` |
| `summary` | `resume.summary` | `Resume.summary` |
| `skills` 嵌套对象 → flatten | `resume.skills` | `Resume.skills` |
| `experience[]` JSON.stringify | `resume.experience` | `Resume.experience` |
| `education[]` JSON.stringify | `resume.education` | `Resume.education` |
| `projects[]` JSON.stringify | `resume.projects` | `Resume.projects` |
| `certifications[]` JSON.stringify | `resume.certifications` | `Resume.certifications` |
| `languages[]` JSON.stringify | `resume.languages` | `Resume.languages` |
| `portfolio` | `resume.portfolio` | `Resume.portfolio` |
| `publications[]` | `resume.publications` | `Resume.publications` |
| `patents[]` | `resume.patents` | `Resume.patents` |
| `awards[]` | `resume.awards` | `Resume.awards` |
| `overallMatchScore.score`(0-100) | MatchEventData.data.overallMatchScore.score | `Candidate_Match_Result.overall_match_score`(Float, 0-1 或 0-100 由 AO 端归一化)|
| `overallMatchScore.grade` | (同上).grade | `Candidate_Match_Result.overall_match_grade` |
| `overallFit.verdict`("Strong Match" 等)| .data.overallFit.verdict | `Candidate_Match_Result.overall_fit_verdict` |
| `overallFit.summary` | .data.overallFit.summary | `Candidate_Match_Result.overall_fit_summary` |

---

## 9. AO 端实施状态(给 RAAS 参考)

| 模块 | 状态 |
|---|---|
| Allmeta DataObject schema 已 sync 到 v0_1_010 | ✅ Done(2026-05-14) |
| `resume-parser-agent/lib/inngest/client.ts` 3 个 Nested types | ✅ Done |
| `resume-parser-agent/lib/mappers/ao-to-allmeta.ts` 5 个 mapper | ✅ Done |
| `lib/allmeta-client.ts` Allmeta API HTTP client | ✅ Done |
| E2E mock test(秦嘉阔样本 → Allmeta → Neo4j)| ✅ Done · [scripts/e2e-mock-test/v0_1_010-mock-e2e.ts](../scripts/e2e-mock-test/v0_1_010-mock-e2e.ts) |
| 3 Inngest agents 生产部署 + 监控 | ✅ Done |
| AO ↔ RAAS 联调(本文 §6 改动)| ⏳ 等 RAAS 端确认本文后开工 |

---

## 10. 联调时序建议

**Phase 1**(RAAS 端开工,约 1-2 天):
1. RAAS 接 §6 Phase A 5 处字段改名(改 consumer mapper)
2. RAAS 接 §6 Phase B 6 处 Resume 字段改名 + JSON.stringify 反序列化
3. RAAS 接 §6 Phase C 7 个新字段加列(可选,可放后续)

**Phase 2**(双方联调,1 小时):
- AO 端发一个真实 RESUME_DOWNLOADED 事件(可走 mock RAAS 或真 RoboHire)
- RAAS 端验证 RESUME_PROCESSED 收到的 `candidate.phone` / `resume.experience` 等字段读得到
- AO 端调 RAAS `POST /candidates` 看 200 + 拿到 candidate_id
- 跨服务 trace_id 串通

**Phase 3**(MR 链路验证):
- 触发 match-resume-agent
- AO → RAAS `POST /match-results` 200
- RAAS dashboard 显示分数走 `data.overallMatchScore.score` 而非 `data.matchScore`

---

## 11. 联系方式 / 备注

- AO 端字段如有疑问 → 看 [docs/ao-allmeta-alignment-action-plan.md](ao-allmeta-alignment-action-plan.md) §3 / §4
- RAAS 端 internal API 契约 → [docs/raas-internal-api-spec.md](raas-internal-api-spec.md)
- 跨服务 trace 关联机制 → [docs/raas-event-flow-upload-id-correlation.md](raas-event-flow-upload-id-correlation.md)

**本文有效期**:v0_1_010 schema 锁定期间(2026-05-14 起)。如 RoboHire vendor 升级 + 字段变化 → 双方再走一次对齐流程。
