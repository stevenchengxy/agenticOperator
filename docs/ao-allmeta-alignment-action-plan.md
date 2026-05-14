# AO ↔ Allmeta DataObject 对齐操作手册

> **目的**:把 Agentic Operator(AO)实例数据写入 Allmeta Ontology(再落 Neo4j)这条链路打通。当前由于 AO 端字段名 / 类型 / 位置和 Allmeta DataObject 声明不一致,**Allmeta 默认开启的 property-name validation 会用 `400 validation-failed` 把整个 POST 拒掉**,链路完全跑不通。本文给出每个字段的对齐方案、双向选项、推荐改动方,并给 Allmeta 端(陈洋)和 AO 端(Steven)各一份操作清单。
>
> **依赖文档**:
> - 流程对照:[docs/ao-runtime-vs-allmeta-alignment-v2.md](ao-runtime-vs-allmeta-alignment-v2.md)
> - 字段速查表:[docs/ao-allmeta-field-alignment-table.md](ao-allmeta-field-alignment-table.md)
> - Allmeta API 契约:`/Users/yuhancheng/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md`

---

## 1. 链路全景与失败现场

### 1.1 数据流

```
┌────────┐  HR 上传简历      ┌────────────────────┐  RESUME_DOWNLOADED
│  RAAS  │  ────────────►   │  RAAS Event Bus     │  ───────────────────┐
└────────┘                  └────────────────────┘                      │
                                                                        ▼
                            ┌──────────────────────────────────────────────────┐
                            │  AO resume-parser-agent (Inngest)                │
                            │  ─ downloadResumeRaw → parseResume (RoboHire)    │
                            │  ─ mapRobohireToRaas (L1 → L2 mapper)            │
                            │  ─ emit RESUME_PROCESSED { CandidateNested,      │
                            │       CandidateExpectationNested, ResumeNested } │
                            └────────┬─────────────────────────────────────────┘
                                     │
                  ┌──────────────────┼──────────────────┐
                  ▼                  ▼                  ▼
            ┌─────────┐        ┌─────────┐        ┌──────────────────────┐
            │  RAAS   │        │  AO     │        │ ★ Allmeta Ontology   │
            │ DB写入  │        │ Match   │        │ POST /api/v1/        │
            │ (现状)  │        │ Agent   │        │ ontology/instances/  │
            └─────────┘        └────┬────┘        │  {label}?domain=     │
                                    │             │  RAAS-v1             │
                       MATCH_PASSED_*├───────────►│ ★ ←── 400 validation │
                                    │             │  failed (现状失败点) │
                                    │             └──────────┬───────────┘
                                    │                        │
                                    ▼                        ▼
                              ┌─────────┐               ┌─────────┐
                              │  RAAS   │               │ Neo4j   │
                              │ DB 写入 │               │ :Cand   │
                              └─────────┘               │ :Resume │
                                                        │ :MatchR │
                                                        └─────────┘
```

### 1.2 当前阻塞点 — Allmeta validation 默认行为

**[Allmeta API guide §5 Validation](file:///Users/yuhancheng/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md):**

> Property-name validation runs on every write — **default mode included**.
> A POST/PUT/PATCH body containing a key that isn't in `properties[]` (or
> the PK or `domainId`) is rejected with `400 validation-failed` and
> `details.unknown: [<field-names>]`. This is true whether or not
> `?validate=strict` is set.

**翻译成大白话**:不需要 `?validate=strict`,默认就会拒绝任何 `properties[]` 里没声明的字段。AO 当前如果直接拿 `CandidateNested` 整段 POST,会被 4xx 拒绝 — 链路上线前必须先对齐字段名。

### 1.3 各 DataObject 写入会失败的字段(预测的 400 错)

如果今天 AO 直接 `POST /api/v1/ontology/instances/Candidate?domain=RAAS-v1` 把 `CandidateNested` 整段发过去,Allmeta 会返回:

```json
{
  "error": "validation-failed",
  "details": {
    "unknown": ["work_years", "current_company", "current_title", "skills"]
  }
}
```

5 个 DataObject 的"必死字段"清单:

| DataObject | AO 会发的字段 | Allmeta `properties[]` 没有 | 预测 400 拒绝 |
|---|---|---|---|
| Candidate | `work_years` `current_company` `current_title` `skills` | 全部缺 | 4 字段 |
| Candidate_Expectation | `expected_salary_monthly_min/max` `expected_cities` `expected_industries` `expected_roles` `expected_work_mode` | 全部命名不一致 | 6 字段 |
| Resume | `skills_extracted` `work_history` `education_history` `project_history` `summary` `upload_id` | 改名 + 缺字段 | 6 字段 |
| Job_Requisition | (基本对齐,但若用 RAAS 64 字段直发,会被拒 ~30 字段)| | 30 字段 |
| Candidate_Match_Result | 全部 23+ RoboHire camelCase 字段 + 8 rule-check 字段 | 几乎全缺(L3 只有 6 字段)| 31 字段 |

**总计 ~77 字段**会触发拒绝。

---

## 2. 对齐决策原则(读下面的表前先读这个)

### 2.1 五条铁律

| # | 原则 | 应用 |
|---|---|---|
| 1 | **Vendor 源头字段名 → Allmeta 跟齐** | RoboHire / RAAS 返回的字段名是 vendor 决定的,AO 改不了源头。如果 vendor 命名行业通用、Allmeta 命名是自造,优先 ★ Allmeta 改 |
| 2 | **AO 自创字段名 → Ontology 主导** | AO 业务自定义的字段名(如 rule-check 审计)如果 ontology 想要别的,★ AO 改 mapper |
| 3 | **类型分歧 → 用更结构化的那个** | String 装 List 一律 ★ Allmeta 改 List;String 装数值一律 ★ Allmeta 拆 min/max Float — 数值/列表才能筛选排序 |
| 4 | **位置分歧 → 跟 ontology 设计** | 同一份数据 AO 放 Candidate / Allmeta 放 Resume,以 ontology 设计为准(因为 ontology 是经过实体建模的)→ ★ AO 改 mapper 写到对的位置 |
| 5 | **缺字段 → 评估去留再决定** | Allmeta 没字段:看是不是核心业务数据,核心 ★ Allmeta 加字段;低用率/vendor 内部 ★ AO 丢弃 |

### 2.2 谁该改的判断流程图

```
┌──────────────────────────────────┐
│  AO 端这个字段从哪来?            │
└────────┬─────────────────────────┘
         │
    ┌────┴────────────────────────┐
    │                             │
    ▼                             ▼
[Vendor 源头]                [AO 自创业务字段]
(RoboHire / RAAS)            (rule-check audit / final_decision)
    │                             │
    ▼                             ▼
比 Allmeta 命名好?           Allmeta 有同语义字段?
    │                             │
   ┌┴┐                           ┌┴┐
   是 否                         是 否
   │  │                          │  │
   ▼  ▼                          ▼  ▼
★ All ★ AO mapping            ★ AO ★ Allmeta 加字段
metaOK 接受 vendor 命名       改名  (评估业务必要性)
改名
```

### 2.3 不该做的事

- ❌ 不要为了"AO 改最少"就把所有事推 Allmeta — ontology 是经过设计的,有些选择(skills 放 Resume 而不是 Candidate)是对的,AO 应该跟。
- ❌ 不要为了"Allmeta 不动"就让 AO 把 8 个数据序列化成 1 个大 JSON — 失去结构化检索能力,partner 仪表盘做不出筛选。
- ❌ 不要在 AO 端做"双写"(同时按 vendor 名和 ontology 名各写一份)— 维护成本高,而且 Allmeta strict 会拒绝多余字段。
- ❌ 不要把 vendor 的内部 metadata 字段(RoboHire `documentId / cached / savedAs`)当 ontology 字段加 — 这是 vendor 实现细节,不属于业务实体。

---

## 3. 逐 DataObject 详细对齐方案

### 3.1 Candidate

#### A. 当前 AO 写入 payload(假设直接 spread `CandidateNested`)

```http
POST /api/v1/ontology/instances/Candidate?domain=RAAS-v1
Content-Type: application/json
Authorization: Bearer ${AO_API_KEY}

{
  "domainId": "RAAS-v1",
  "candidate_id": "C-100023",       // AO 自己生成或 RAAS 回填
  "name": "张三",
  "mobile": "13800138000",
  "email": "zhangsan@example.com",
  "gender": null,
  "birth_date": null,
  "current_location": "深圳",
  "highest_acquired_degree": "本科",
  "work_years": 5.2,                // ❌ 拒
  "current_company": "字节跳动",     // ❌ 拒
  "current_title": "高级研发工程师",  // ❌ 拒
  "skills": ["Java", "MySQL"]        // ❌ 拒
}
```

**预测 Allmeta 响应**:
```json
{
  "error": "validation-failed",
  "details": { "unknown": ["work_years", "current_company", "current_title", "skills"] }
}
```

#### B. 逐字段对齐决策表

| AO 字段 | Allmeta 字段 | 字段来源 | 选项 A:AO 改 | 选项 B:Allmeta 改 | ★ 推荐 | 原则依据 |
|---|---|---|---|---|---|---|
| `work_years: number` | `experience_years: Float` | 都是自创(RoboHire 不返,AO 算)| AO mapper 改名 | Allmeta 改名 | **★ B (Allmeta 改 `experience_years → work_years`)** | 原则 ②:JR 已经叫 work_years,行业通用;Allmeta 内部都不一致,自己跟齐 |
| `current_company: string` | (无) | RoboHire 派生(currentExp.company)| AO 不写 | Allmeta 加字段 | **★ B (Allmeta 加 `current_company: String`)** | 原则 ⑤:候选人卡片必显示,核心高频字段,埋 Resume 字符串里查询不到 |
| `current_title: string` | (无) | RoboHire 派生 | 同上 | Allmeta 加 | **★ B (Allmeta 加 `current_title: String`)** | 同上 |
| `skills: string[]` | (无,Allmeta 在 `Resume.skill_tags`)| RoboHire 直接给 | AO 不写 Candidate.skills,只写 Resume.skill_tags | Allmeta 加 Candidate.skill_tags 冗余字段 | **★ A (AO 改:Candidate 不写 skills)** | 原则 ④:ontology 设计正确(简历多版,技能跟简历走);AO 当前 mapper 重复挂 Candidate + Resume 是 bug |
| `gender: null` | `gender: String` | RoboHire 不返 | (维持 null,Allmeta 接受 null)| — | ⚪ 维持 — RoboHire 加性别识别后再填 | (无操作) |
| `birth_date: null` | `birth_date: Date` | 同上 | 同上 | — | ⚪ 维持 | (无操作) |

#### C. 配套改动:删除 RuntimeNested 空壳

[`RuntimeNested`](../resume-parser-agent/lib/inngest/client.ts#L65) 只装 `current_title / current_company` 两字段,和 `CandidateNested` 重复。当前 mapper 的 [robohire-to-raas.ts:152](../resume-parser-agent/lib/mappers/robohire-to-raas.ts#L152) 也是直接复制 candidate 的两个字段过去 — 这是历史 bug。

→ 删除 `RuntimeNested`,事件 payload 也删 `runtime` 字段。

---

### 3.2 Candidate_Expectation

#### A. 当前 AO 写入 payload(全部 null/[],因为 RoboHire 不解析期望)

```json
{
  "domainId": "RAAS-v1",
  "candidate_expectation_id": "ce_C-100023",
  "candidate_id": "C-100023",
  "expected_salary_monthly_min": null,    // ❌ 拒(Allmeta 字段叫 expected_salary_range)
  "expected_salary_monthly_max": null,    // ❌ 拒
  "expected_cities": [],                  // ❌ 拒(Allmeta 叫 expected_location 单数 String)
  "expected_industries": [],              // ❌ 拒
  "expected_roles": [],                   // ❌ 拒
  "expected_work_mode": null              // ❌ 拒
}
```

**这个对象问题最大** — 6 个 AO 字段,**0 个能通过 validation**。

#### B. 逐字段对齐决策表

| AO 字段 | Allmeta 字段 | 字段来源 | 选项 A:AO 改 | 选项 B:Allmeta 改 | ★ 推荐 | 原则依据 |
|---|---|---|---|---|---|---|
| `expected_salary_monthly_min: number` + `..._max: number` | `expected_salary_range: String`("15K-25K/月") | 都是自创 | AO mapper 拼字符串 | Allmeta 拆字段 | **★ B (Allmeta 拆 `expected_salary_monthly_min / max: Float` + `salary_currency: String`)** | 原则 ③:数值才能筛选排序("我要 15K 以上"用 String 实现不了) |
| `expected_cities: string[]` | `expected_location: String` | 自创 | AO `.join(',')` | Allmeta 改 List + 复数 | **★ B (Allmeta 改 `expected_locations: List<String>`)** | 原则 ③:候选人多选地点是常态,String 单值是错误设计 |
| `expected_industries: string[]` | `expected_industry: String` | 自创 | 同上 | 同上 | **★ B (Allmeta 改 `expected_industries: List<String>`)** | 同上 |
| `expected_roles: string[]` | `expected_position: String` | 自创 | AO 改名 + join | Allmeta 改 List + 复数 | **★ 双改:AO `expected_roles → expected_positions` + Allmeta `expected_position → expected_positions: List<String>`** | 原则 ②:`position` 比 `role` 准(role 容易和 Standard_Job_Role 混) |
| `expected_work_mode: string` (remote/hybrid/onsite) | `outsourcing_acceptance_level: String` | **完全不同语义**(AO 指办公模式,Allmeta 指外包接受度) | AO 不发 outsourcing | Allmeta 加 `expected_work_mode` | **★ B (Allmeta 加 `expected_work_mode: String`)** | 原则 ⑤:`outsourcing_acceptance_level` 是中软外包业务字段,留给 hsm 填,AO 别动 |

#### C. AO mapper 当前问题

[robohire-to-raas.ts:128](../resume-parser-agent/lib/mappers/robohire-to-raas.ts#L128) 6 个字段全写死 null/[] — RoboHire prompt 里压根没要候选人期望。这一节短期内 AO 都是发空值,**对齐工作主要是把字段名/类型先对上**,等 RoboHire 加期望解析能力后这些字段才有真值。

---

### 3.3 Resume

#### A. 当前 AO 写入 payload

```json
{
  "domainId": "RAAS-v1",
  "resume_id": "R-100023",
  "candidate_id": "C-100023",
  "summary": "5 年研发经验 ...",         // ❌ 拒(Allmeta 没 summary)
  "skills_extracted": ["Java", "MySQL"], // ❌ 拒(Allmeta 叫 skill_tags)
  "work_history": [                      // ❌ 拒(Allmeta 叫 work_experience 而且类型是 String)
    { "title": "工程师", "company": "字节", "startDate": "2021-03", ... }
  ],
  "education_history": [...],            // ❌ 拒
  "project_history": [],                 // ❌ 拒
  "upload_id": "upload_xxx",             // ❌ 拒(Allmeta 没 upload_id)
  "file_path": "s3://bucket/key.pdf",
  "is_original": true
}
```

#### B. 逐字段对齐决策表

| AO 字段 | Allmeta 字段 | 字段来源 | 选项 A | 选项 B | ★ 推荐 | 原则依据 |
|---|---|---|---|---|---|---|
| `summary: string` | (无) | RoboHire 直接给 | AO 不发 | Allmeta 加 | **★ B (Allmeta 加 `summary: String`)** | 原则 ①:简历摘要是基本字段,RoboHire / 行业 / Greenhouse 都有 |
| `skills_extracted: string[]` | `skill_tags: List<String>` | 自创 | AO 改名 | Allmeta 改名 | **★ A (AO 改 `skills_extracted → skill_tags`)** | 原则 ②:`skill_tags` 短而准,Allmeta 命名好 |
| `work_history: Array<Object>` | `work_experience: String` | RoboHire 给 Object 数组 | AO 序列化为 JSON String | Allmeta 改 List<Object> | **★ 双改(类型保留 String,但 Allmeta 改名)**:Allmeta `work_experience → work_history` + AO 序列化 Object→String 写入 | 原则 ②:`history` 比 `experience` 达意(experience 让人误以为是年数);Neo4j 不擅长嵌套 Object,String 是合理妥协 |
| `education_history: Array<Object>` | `education_experience: String` | 同上 | 同上 | 同上 | **★ 双改(同上)**:Allmeta `education_experience → education_history` | 同上 |
| `project_history: unknown[]` | `project_experience: String` | 同上 | 同上 | 同上 | **★ 双改(同上)**:Allmeta `project_experience → project_history` | 同上 |
| `upload_id: string` | (无,L3 只有 file_path 装 URI)| RAAS 上传层主键 | AO 不发 | Allmeta 加 | **★ B (Allmeta 加 `upload_id: String`)** | 原则 ⑤:upload_id 是 MinIO 上传记录的稳定 ID,跟 file_path(URI,可能多版本)语义不同;链 RAAS 上传日志要用 |

#### C. 关于 `language_skills` / `certificate`

L3 有这俩字段、RoboHire 也返(`languages[]` / `certifications[]`),但当前 [`ResumeNested`](../resume-parser-agent/lib/inngest/client.ts#L46) 没把它们加进去。

→ 这是 **AO mapper 该补的字段**(原则 ① — vendor 给了的字段就该接住):
```typescript
// 在 ResumeNested 加:
certificate: string | null;       // RoboHire certifications 序列化
language_skills: string | null;   // RoboHire languages 序列化
```

---

### 3.4 Job_Requisition

#### A. 流向特殊

JR 是 AO **从 RAAS 读**(`GET /api/v1/requirements/:id` 返回 64 字段)然后**投影写 Allmeta**。AO 不是 source of truth,投影规则就是对齐规则。

#### B. 三类字段处理策略

| 类别 | 字段数 | 处理 |
|---|---|---|
| **直接对得上的核心字段**(name/type 一致) | 19 | AO mapper 直接写,无改动 |
| **vendor 命名 vs ontology 命名分歧** | 5 | 见下表逐条 |
| **RAAS 流程态字段**(status/hc_status/priority/created_at 等) | ~30 | AO **丢弃** — DataObject 存"事实",状态走 Event 流追,不进 ontology |

#### C. 命名/类型分歧逐字段决策

| AO/RAAS 字段 | Allmeta 字段 | 字段来源 | 选项 A | 选项 B | ★ 推荐 | 原则依据 |
|---|---|---|---|---|---|---|
| `publish_date` | `open_date: Date` | RAAS vendor 命名 | AO 改名 | Allmeta 改名 | **★ B (Allmeta 改 `open_date → publish_date`)** | 原则 ①:RAAS 行业用法是 publish |
| `expected_arrival_date` | `required_arrival_date: Date` | RAAS vendor | AO 改名 | Allmeta 改名 | **★ B (Allmeta 改 `required_arrival_date → expected_arrival_date`)** | 原则 ①:RAAS 用 expected,语气也对(候选人到岗是预期不是强制)|
| `city: string` (单值) | `city: String` (单值) | 都自创 | AO 改 List | Allmeta 改 List | **★ B (Allmeta 改 `city: List<String>`)** | 原则 ③:多地点办公是常态 |
| `salary_range: string` ("1-1.5万/月") | `salary_range: String` | RAAS vendor | AO 拆数值 | Allmeta 拆 | **★ B (Allmeta 拆 `salary_range_monthly_min/max: Float` + `salary_currency: String` + 保留 `salary_range: String` 兼容)** | 原则 ③ |
| `expected_level` | `expected_level: String` | 自创 | — | Allmeta 改名 | **★ B (Allmeta 改 `expected_level → target_job_level`)** | 原则 ②:`expected_level` 模糊(指岗位想招的级别)|
| (Allmeta `csi_department_id`)| `csi_department_id: String (FK)` | Allmeta 自创 | — | Allmeta 改名 | **★ B (Allmeta 改 `csi_department_id → recruiting_department_id`)** | 原则 ②:ontology 不该带租户名(csi = 中软国际)|
| (Allmeta `hc_status`)| `hc_status: String` | Allmeta 自创 | — | Allmeta 改名 | **★ B (Allmeta 改 `hc_status → headcount_status`)** | 原则 ②:缩写应展开 |

---

### 3.5 Candidate_Match_Result(问题最严重)

#### A. 现状对比

| | AO 写出字段数 | Allmeta `properties[]` |
|---|---|---|
| MR 节点 | 23+(RoboHire 透传)+ 8(rule-check)= **31** | **6**(`candidate_match_result_id / client_id / candidate_id / job_position_id / result / reason`)|

如果 AO 直接发 31 字段给 Allmeta,**25 个会被拒** + 1 个 `job_position_id` 字段名孤儿。

#### B. AO 当前 emit 的 payload 形态(看 [`MatchPassedNeedInterviewData`](../resume-parser-agent/lib/inngest/client.ts#L114))

```json
{
  "upload_id": "upload_xxx",
  "job_requisition_id": "JR-001",
  "success": true,
  "data": {
    "matchScore": 0.82,
    "recommendation": "GOOD_MATCH",
    "summary": "技术栈基本匹配 ...",
    "matchAnalysis": {...},
    "mustHaveAnalysis": {...},
    "niceToHaveAnalysis": {...},
    "resumeAnalysis": {...},
    "jdAnalysis": {...},
    "skillMatch": {...},
    "skillMatchScore": 0.85,
    "experienceMatch": {...},
    "experienceValidation": {...},
    "candidatePotential": {...},
    "transferableSkills": ["Spring → SpringBoot"],
    "experienceBreakdown": {...},
    "hardRequirementGaps": ["3年Java经验未达5年要求"],
    "overallMatchScore": 0.82,
    "overallFit": {...},
    "recommendations": {...},
    "suggestedInterviewQuestions": [...],
    "areasToProbeDeeper": [...],
    "preferenceAlignment": {...},
    "candidateSummary": {...}
  },
  "requestId": "rh_req_xxx",
  "savedAs": "match_2026-05-14.json"
}
```

#### C. 对齐方案 — 4 类字段分别处理

##### C.1 命名分歧(必须改)

| AO 字段 | Allmeta 字段 | 字段来源 | ★ 推荐 | 理由 |
|---|---|---|---|---|
| `job_requisition_id` | `job_position_id` | 都自创 | **★ Allmeta 改 `job_position_id → job_requisition_id`** | 原则 ②:`job_position_id` 是孤儿命名(ontology 没 Job_Position 对象);其他所有 DataObject (Job_Offer/Resume/Job_Posting/Application) 都用 `job_requisition_id` |
| `data.summary` | `reason` | RoboHire 给 summary | **★ AO 改:把 data.summary 当 reason 写** | 原则 ②:`reason` 在 MR 上下文里更准(为什么得出这个结论)|

##### C.2 高价值字段(Allmeta 加单独字段,做查询用)

| AO 字段 | Allmeta 加什么 | 理由 |
|---|---|---|
| `data.matchScore: number` | `match_score: Float` | 评分是核心 metric,做"Top 10 候选人"必用 |
| `data.recommendation: 'STRONG_MATCH'\|...\|'WEAK_MATCH'` | `recommendation: String` | 算法 4 档分级,跟现有 `result`(中文 3 档"匹配/不匹配/待定")并存 |
| `data.hardRequirementGaps: string[]` | `must_have_gaps: List<String>` | 做"硬性条件不达标"筛选 |
| `data.transferableSkills: string[]` | `transferable_skills: List<String>` | 猎头看候选人潜力 |
| `requestId` | `raas_match_request_id: String` | 关联 RoboHire / RAAS 日志做 audit |
| (mapper 加 timestamp) | `decided_at: Timestamp` | 决策时间 |

##### C.3 大 JSON 块(Allmeta 加单一 String 字段装下)

剩余 ~17 个 RoboHire 字段(`matchAnalysis / niceToHaveAnalysis / resumeAnalysis / jdAnalysis / skillMatch / experienceMatch / experienceValidation / candidatePotential / experienceBreakdown / overallFit / recommendations / suggestedInterviewQuestions / areasToProbeDeeper / preferenceAlignment / candidateSummary`)— 都是大 Object 块,partner 仪表盘需要展示原文,但**不需要做结构化筛选**。

→ **★ Allmeta 加 `match_breakdown_json: String`**,AO mapper 把 `data` 整段 `JSON.stringify` 写进去。

##### C.4 Rule-check 审计字段(AO 自创,L3 完全没)

| AO 字段 | 处理 | 理由 |
|---|---|---|
| `rule_check_audit_id` | **★ Allmeta 加 `rule_check_audit_id: String`** | partner UI "为什么不通过" 必备入口 |
| `rule_check_decision: 'PASS'\|'FAIL'` | **★ Allmeta 加 `rule_check_decision: String`** | rule-check 阶段独立结论(跟 final_decision 分离)|
| `failure_reason_codes: string[]` | **★ Allmeta 加 `failure_reason_codes: List<String>`** | 结构化筛选(`MATCH WHERE "10-5" IN failure_reason_codes`)|
| `rules_evaluated_count: number` | ⚪ AO 内部 metric,留 Inngest event metadata,不进 ontology | 原则 ⑤:debug 用,低价值 |
| `terminal_rule_hits: string[]` | ⚪ 同上 | 同上 |
| `final_decision: 'PASS'\|'FAIL'` | ⚪ AO 内部,`result` 字段已表达 | 同上 |
| `final_decision_reason: string` | 🟡 AO 写到 `reason` 字段 | 跟 §C.1 #2 合并 |
| `parent_match_result_id: string` | ⚪ AO 内部 audit 链,留 Inngest | 原则 ⑤ |

---

## 4. 总改动清单 — 给两边的 diff

### 4.1 Allmeta 端(陈洋)— `properties_json` 改动

#### 改名(15 项)

| DataObject | 现在 | 改成 | 优先级 |
|---|---|---|---|
| Candidate | `experience_years` | `work_years` | P1 |
| Candidate | `marital_fertility_status` | `family_status` | P3 |
| Candidate | `conflict_interest_declaration` | `conflict_of_interest_declaration` | P3 |
| Candidate_Expectation | `expected_position` | `expected_positions`(配套类型 String → List<String>) | P2 |
| Candidate_Expectation | `expected_location` | `expected_locations`(配套 String → List<String>) | P2 |
| Candidate_Expectation | `expected_industry` | `expected_industries`(配套 String → List<String>) | P2 |
| Resume | `work_experience` | `work_history` | P2 |
| Resume | `education_experience` | `education_history` | P2 |
| Resume | `project_experience` | `project_history` | P2 |
| Job_Requisition | `open_date` | `publish_date` | P3 |
| Job_Requisition | `required_arrival_date` | `expected_arrival_date` | P3 |
| Job_Requisition | `csi_department_id` | `recruiting_department_id` | P3 |
| Job_Requisition | `hc_status` | `headcount_status` | P3 |
| Job_Requisition | `expected_level` | `target_job_level` | P3 |
| Candidate_Match_Result | `job_position_id` | `job_requisition_id` | **P0(MR 链路必经)** |

#### 改类型(2 项)

| DataObject | 字段 | 现在 | 改成 |
|---|---|---|---|
| Candidate_Expectation | `expected_position/location/industry` | `String` | `List<String>`(配合上面改名)|
| Job_Requisition | `city` | `String` | `List<String>` |

#### 拆字段(2 处)

| DataObject | 现字段 | 拆成 |
|---|---|---|
| Candidate_Expectation | `expected_salary_range: String` | `expected_salary_monthly_min: Float` + `expected_salary_monthly_max: Float` + `salary_currency: String`(保留原 `expected_salary_range: String` 兼容)|
| Job_Requisition | `salary_range: String` | `salary_range_monthly_min: Float` + `salary_range_monthly_max: Float` + `salary_currency: String`(保留 `salary_range`)|

#### 加字段(17 项)

| DataObject | 新字段 | 类型 | 优先级 | 用途 |
|---|---|---|---|---|
| Candidate | `current_company` | String | P1 | 候选人卡片必显示 |
| Candidate | `current_title` | String | P1 | 同上 |
| Candidate_Expectation | `expected_work_mode` | String | P2 | 远程/混合/onsite |
| Resume | `summary` | String | P2 | 简历摘要 |
| Resume | `upload_id` | String | P2 | MinIO 上传主键 |
| Candidate_Match_Result | `match_score` | Float | **P0** | 评分核心 metric |
| Candidate_Match_Result | `recommendation` | String | **P0** | RoboHire 4 档算法分级 |
| Candidate_Match_Result | `match_breakdown_json` | String | **P0** | RoboHire data 整段透传 |
| Candidate_Match_Result | `must_have_gaps` | List<String> | P1 | 硬性条件不达标筛选 |
| Candidate_Match_Result | `transferable_skills` | List<String> | P1 | 可迁移技能 |
| Candidate_Match_Result | `raas_match_request_id` | String | P1 | RoboHire 跨服务 trace |
| Candidate_Match_Result | `decided_at` | Timestamp | P1 | 决策时间 |
| Candidate_Match_Result | `rule_check_audit_id` | String | **P0** | partner UI 入口 |
| Candidate_Match_Result | `rule_check_decision` | String | P1 | rule-check 阶段独立结论 |
| Candidate_Match_Result | `failure_reason_codes` | List<String> | P1 | 失败原因代码 |

#### Allmeta 端总改动:**15 改名 + 2 改类型 + 2 拆字段 + 15 加字段 = 34 处**

---

### 4.2 AO 端(Steven)— mapper 改动

新建 [`resume-parser-agent/lib/mappers/ao-to-allmeta.ts`](../resume-parser-agent/lib/mappers/ao-to-allmeta.ts) 集中 L2 → L3 翻译。

#### Candidate 写入 mapper

```typescript
// 输入:CandidateNested (L2)
// 输出:Allmeta Candidate properties_json 合规的 payload
export function toAllmetaCandidate(
  c: CandidateNested,
  candidate_id: string,
): Record<string, unknown> {
  return {
    candidate_id,
    name: c.name,
    mobile: c.mobile,
    email: c.email,
    gender: c.gender,                  // null OK,Allmeta 接受 null
    birth_date: c.birth_date,
    current_location: c.current_location,
    highest_acquired_degree: c.highest_acquired_degree,
    work_years: c.work_years,          // ★ Allmeta 改名后对齐
    current_company: c.current_company, // ★ Allmeta 加字段后对齐
    current_title: c.current_title,
    // ★ skills 不写 Candidate,只写 Resume.skill_tags(见 toAllmetaResume)
  };
}
```

#### Candidate_Expectation 写入 mapper

```typescript
export function toAllmetaCandidateExpectation(
  e: CandidateExpectationNested,
  candidate_id: string,
): Record<string, unknown> {
  return {
    candidate_expectation_id: `ce_${candidate_id}`,
    candidate_id,
    expected_salary_monthly_min: e.expected_salary_monthly_min, // ★ Allmeta 拆字段后对齐
    expected_salary_monthly_max: e.expected_salary_monthly_max,
    salary_currency: 'CNY',  // 默认人民币
    expected_locations: e.expected_cities,    // ★ 改字段名 + 类型对齐
    expected_industries: e.expected_industries,
    expected_positions: e.expected_roles,     // ★ AO 改名 expected_roles → expected_positions
    expected_work_mode: e.expected_work_mode, // ★ Allmeta 加字段后对齐
    // outsourcing_acceptance_level 不写,留给 hsm 填
  };
}
```

#### Resume 写入 mapper

```typescript
export function toAllmetaResume(
  r: ResumeNested,
  candidate_id: string,
  upload_id: string,
  file_path: string,
): Record<string, unknown> {
  return {
    resume_id: `R_${upload_id}`,
    candidate_id,
    upload_id,                                          // ★ Allmeta 加字段后对齐
    file_path,
    is_original: true,
    summary: r.summary,                                 // ★ Allmeta 加字段后对齐
    skill_tags: r.skills_extracted,                     // ★ AO 改名 skills_extracted → skill_tags
    work_history: JSON.stringify(r.work_history),       // ★ Object[] → String,Allmeta 改名后对齐
    education_history: JSON.stringify(r.education_history),
    project_history: JSON.stringify(r.project_history),
    // certificate / language_skills 等 RoboHire 给但当前 ResumeNested 没装的字段,后续 mapper 补
  };
}
```

#### Job_Requisition 写入 mapper(从 RAAS 64 字段投影)

```typescript
export function toAllmetaJobRequisition(
  raas: RaasRequirement,            // 来自 getRequirementDetail
  spec: RaasRequirementSpecification,
): Record<string, unknown> {
  // 解析 salary_range "1-1.5万/月" → min/max
  const { min, max, currency } = parseSalaryRange(raas.salary_range);

  return {
    job_requisition_id: raas.job_requisition_id,
    job_requisition_specification_id: raas.job_requisition_specification_id,
    client_department_id: raas.client_department_id,
    client_job_id: raas.client_job_id,
    client_job_title: raas.client_job_title,
    client_job_type: raas.client_job_type,
    job_responsibility: raas.job_responsibility,
    job_requirement: raas.job_requirement,
    must_have_skills: raas.must_have_skills,
    nice_to_have_skills: raas.nice_to_have_skills,
    negative_requirement: raas.negative_requirement,
    language_requirements: raas.language_requirements,
    city: Array.isArray(raas.city) ? raas.city : [raas.city], // ★ Allmeta 改类型后对齐
    salary_range: raas.salary_range,            // 保留兼容
    salary_range_monthly_min: min,              // ★ 拆数值
    salary_range_monthly_max: max,
    salary_currency: currency,
    headcount: raas.headcount,
    work_years: raas.work_years,
    degree_requirement: raas.degree_requirement,
    education_requirement: raas.education_requirement,
    interview_mode: raas.interview_mode,
    target_job_level: raas.expected_level,      // ★ AO 改字段名(如果 Allmeta 改名)
    recruitment_type: raas.recruitment_type,
    publish_date: raas.publish_date,            // ★ Allmeta 改名后对齐
    expected_arrival_date: raas.expected_arrival_date,
    // ★ 丢弃:status / hc_status / priority / created_at 等流程态字段
    // ★ 不写:client_id / client_name / hsm_employee_id 等冗余,走 FK 链
  };
}
```

#### Candidate_Match_Result 写入 mapper

```typescript
export function toAllmetaMatchResult(
  matchData: Record<string, unknown>,  // RoboHire /match-resume 整段 data
  ruleCheckAudit: RuleCheckAuditResult, // AO rule-check 产物
  context: { candidate_id: string; client_id: string; job_requisition_id: string; raas_match_request_id: string },
): Record<string, unknown> {
  return {
    candidate_match_result_id: `cmr_${ruleCheckAudit.audit_id}`,
    client_id: context.client_id,
    candidate_id: context.candidate_id,
    job_requisition_id: context.job_requisition_id,  // ★ Allmeta 改名后对齐(原 job_position_id)

    // 高价值字段平铺
    match_score: matchData.matchScore,
    recommendation: matchData.recommendation,        // STRONG_MATCH / GOOD_MATCH / ...
    must_have_gaps: matchData.hardRequirementGaps,   // ★ AO 改名 + pluck
    transferable_skills: matchData.transferableSkills,
    raas_match_request_id: context.raas_match_request_id,
    decided_at: new Date().toISOString(),

    // 中文人类可读结论(根据 recommendation 映射)
    result: mapRecommendationToResult(matchData.recommendation),  // STRONG/GOOD → "匹配", PARTIAL → "待定", WEAK → "不匹配"

    // summary → reason
    reason: matchData.summary,   // ★ AO 改名

    // 大块原始数据
    match_breakdown_json: JSON.stringify(matchData),

    // rule-check 审计
    rule_check_audit_id: ruleCheckAudit.audit_id,
    rule_check_decision: ruleCheckAudit.decision,    // PASS / FAIL
    failure_reason_codes: ruleCheckAudit.failure_reason_codes,
  };
}
```

#### AO 端总改动:**1 个新文件 `lib/mappers/ao-to-allmeta.ts`(5 个 mapper)+ 1 个新 client `lib/allmeta-client.ts`(POST API 调用) ≈ 6-8 小时**

---

## 5. 实施顺序与上线检查清单

### 5.1 Phase 0 — 阻塞修复(必须先做)

| 任务 | 谁 | 估时 | 阻塞理由 |
|---|---|---|---|
| Allmeta 修 strict validation 还是 default mode 的 bug(若 properties_json 字段也被拒)| 陈洋 | 1-2h | 不修连 P0 改字段都不能验证 |

### 5.2 Phase 1 — MR 链路必经(P0)

让"江银行链路"能跑通的最小改动集:

| # | 任务 | 谁 | 估时 |
|---|---|---|---|
| 1 | Allmeta `Candidate_Match_Result`:改名 `job_position_id → job_requisition_id` + 加 4 字段(`match_score / recommendation / match_breakdown_json / rule_check_audit_id`)| 陈洋 | 30 min |
| 2 | Allmeta `Candidate`:改名 `experience_years → work_years` + 加 2 字段(`current_company / current_title`)| 陈洋 | 20 min |
| 3 | AO 写新 `lib/allmeta-client.ts`(POST 调用 + 错误处理)| Steven | 2h |
| 4 | AO 写新 `lib/mappers/ao-to-allmeta.ts` 的 `toAllmetaCandidate / toAllmetaMatchResult` | Steven | 2h |
| 5 | E2E 联调:江银行简历 → AO POST Candidate + MR → Allmeta validation 通过 → Neo4j 落地 | 双方 | 1h |

**Phase 1 done = 链路打通,可以跑 demo**。

### 5.3 Phase 2 — 数据质量(P1)

| # | 任务 | 谁 | 估时 |
|---|---|---|---|
| 6 | Allmeta `Candidate_Expectation`:改名 3 字段 + 改类型 + 拆 salary_range(配合 properties_json 改 + Allmeta strict validation 类型测试)| 陈洋 | 1h |
| 7 | Allmeta `Resume`:改名 3 字段 + 加 2 字段(`summary / upload_id`)| 陈洋 | 30 min |
| 8 | Allmeta `Job_Requisition`:改 city 类型 + 拆 salary_range | 陈洋 | 30 min |
| 9 | AO 补 `toAllmetaResume / toAllmetaCandidateExpectation / toAllmetaJobRequisition` mapper | Steven | 2h |
| 10 | AO mapper 删 `RuntimeNested` + 删 `Candidate.skills` 重复 | Steven | 30 min |
| 11 | AO 在 `ResumeNested` 加 `certificate / language_skills` 字段(对 RoboHire `certifications[] / languages[]`)| Steven | 1h |

### 5.4 Phase 3 — 命名清理(P2-P3,可后续 sprint)

| # | 任务 | 谁 | 估时 |
|---|---|---|---|
| 12 | Allmeta JR 改名 4 个(`open_date / required_arrival_date / csi_department_id / hc_status / expected_level`)| 陈洋 | 30 min |
| 13 | Allmeta Candidate 改名 2 个(`marital_fertility_status / conflict_interest_declaration`)| 陈洋 | 20 min |
| 14 | AO mapper 跟齐 Phase 3 改名 | Steven | 30 min |

### 5.5 上线 Checklist(联调时逐条验证)

每个 DataObject 都要跑一次端到端验证:

```bash
# 用 curl 模拟 AO 行为,看 Allmeta 是否接受
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @candidate-payload.json \
  "https://allmeta.example.com/api/v1/ontology/instances/Candidate?domain=RAAS-v1&validate=strict"

# 期望:200 OK { upserted: ["C-100023"], count: 1 }
# 失败:400 validation-failed { details: { unknown: [...] } } → 看 unknown 字段名,补 mapper
```

| # | 验证项 | 通过标准 |
|---|---|---|
| 1 | Candidate POST 响应 200 | `details.unknown` 为空 |
| 2 | Candidate_Expectation POST 响应 200 | 同上 |
| 3 | Resume POST 响应 200 + file_path/upload_id 落库 | 同上 |
| 4 | Job_Requisition POST 响应 200 + city 是 List 类型 | 同上 |
| 5 | Candidate_Match_Result POST 响应 200 + match_score 可查询 | 同上 |
| 6 | `?validate=strict` 模式也通过(类型 / required 检查)| 不报 type_errors |
| 7 | Neo4j Browser 能 `MATCH (c:Candidate {candidate_id: "..."})` 查到节点 | 节点 + 关系都在 |
| 8 | `MATCH (mr:Candidate_Match_Result) WHERE "10-5" IN mr.failure_reason_codes RETURN mr` 能返回 | List 字段查询正常 |

---

## 6. 风险与备选方案

### 6.1 主要风险

| 风险 | 缓解 |
|---|---|
| Allmeta 改名影响 partner 仪表盘 / hsm UI 的现有 query | 改名前陈洋扫一遍 partner 端查询代码;过渡期可加 alias view(`MATCH (n) RETURN n.work_years AS experience_years`)|
| AO mapper 改完 RoboHire 升级 vendor 字段名 | mapper 集中在一个文件,vendor 字段变化只改一处;同时 mapper 加 `[k: string]: unknown` catch-all 容忍未来字段 |
| Allmeta 拆 salary_range 后老 String 字段还有数据 | 保留 `salary_range: String` 兼容,逐步把 partner 写入也改成填 min/max,过渡期双写 |
| `match_breakdown_json` 字符串太大(RoboHire 一次响应可能 30KB)| Neo4j 单 String 属性上限是 100KB,够用;但如果超 50KB 应该考虑改 TEXT 节点 + 关系 |

### 6.2 备选:如果 Allmeta 不愿改名(陈洋拒绝)

只 AO 端 mapper 双向翻译 — 可行但有代价:

```typescript
const CANDIDATE_FIELD_RENAME: Record<string, string> = {
  work_years: 'experience_years',  // AO 名 → Allmeta 名
  // ... 其他 14 项
};

function applyFieldRename(payload: Record<string, unknown>, map: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [map[k] ?? k, v])
  );
}
```

**代价**:
- partner 端拿到的 Neo4j 数据还是 `experience_years / job_position_id` 这些坏命名 — 治标不治本。
- 每次 RoboHire 改字段 AO 跟着改 mapper(没解决根因)。
- AO 内部代码 / TypeScript 类型 / Allmeta DataObject 三套命名,新人看代码两眼一黑。

→ **强烈不推荐这条路**。命名问题该在 ontology 一次性修干净。

---

## 7. 文档关系

| 文档 | 范围 | 受众 |
|---|---|---|
| **本文** [docs/ao-allmeta-alignment-action-plan.md](ao-allmeta-alignment-action-plan.md) | ★ 操作手册:流程 + 决策原则 + 改动清单 + 上线步骤 | Steven + 陈洋 + Leader |
| [docs/ao-allmeta-field-alignment-table.md](ao-allmeta-field-alignment-table.md) | 字段速查表(单表式) | 联调时查 |
| [docs/ao-runtime-vs-allmeta-alignment-v2.md](ao-runtime-vs-allmeta-alignment-v2.md) | 三层模型 + 双向选项详解 | 设计讨论 |
| [docs/ao-runtime-vs-allmeta-dataobject-gap.md](ao-runtime-vs-allmeta-dataobject-gap.md) | 旧版(L1 vs L3,有偏差)| 已被取代 |
| Allmeta API 契约 | 写入 endpoint / validation 行为 | 必读 |
