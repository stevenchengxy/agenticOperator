# AO Runtime ↔ Allmeta DataObject — 完整对齐方案 (v2)

> **修订背景**:Leader 提出 "DataObject 数据里命名不好"。本文据此重做对齐分析。
>
> **关键修正**:旧版 [docs/ao-runtime-vs-allmeta-dataobject-gap.md](ao-runtime-vs-allmeta-dataobject-gap.md) 直接拿 **RoboHire vendor 字段**(L1)对照 **Allmeta DataObject**(L3),但 AO 实际并不发 L1 — 在 [resume-parser-agent/lib/mappers/robohire-to-raas.ts](../resume-parser-agent/lib/mappers/robohire-to-raas.ts) 里已经把 29 个 vendor camelCase 字段映射成 11 个 snake_case 的 `CandidateNested` 等结构(L2)再写出。所以真正要对齐的是 **L2 ↔ L3**,而不是 L1 ↔ L3,差异种类、改动量都和旧版不一样。
>
> **数据源**:
> - L1 vendor:[resume-parser-agent/lib/raas-api-client.ts](../resume-parser-agent/lib/raas-api-client.ts) (`RaasParseResumeData` / `RaasMatchResumeData` / `RaasRequirement` / `MatchResultItem`)
> - L2 AO emit:[resume-parser-agent/lib/inngest/client.ts](../resume-parser-agent/lib/inngest/client.ts) (`CandidateNested` / `CandidateExpectationNested` / `ResumeNested` / `JdGeneratedPayload` / `MatchPassedNeedInterviewData`)
> - L2 mapper:[resume-parser-agent/lib/mappers/robohire-to-raas.ts](../resume-parser-agent/lib/mappers/robohire-to-raas.ts)
> - L3 ontology:`/Users/yuhancheng/allmetaOntology/apps/events-builder/data copy/dataobjects_20260408 (1).json`(陈洋的 ontology 设计)

---

## 0. 三层 schema 模型(必须先读)

```
┌──────────────────┐  RoboHire camelCase, 29+ 字段, vendor 决定
│  L1: vendor      │  RaasParseResumeData, RaasMatchResumeData, RaasRequirement
│   (我们改不了)   │  MatchResultItem (RoboHire /match-resume 23+ 字段平铺)
└────────┬─────────┘
         │  mapper (lib/mappers/robohire-to-raas.ts)
         │  + AO 业务字段拼装
         ▼
┌──────────────────┐  AO snake_case, 已经做过一轮映射/裁剪
│  L2: AO emit     │  CandidateNested(11字段) / CandidateExpectationNested(6字段)
│  (Inngest事件)   │  ResumeNested(5字段) / JdGeneratedPayload(40+字段)
└────────┬─────────┘  MatchPassedNeedInterviewData (透传 RoboHire data)
         │
         │  RAAS DB / Allmeta DataObject 写入
         ▼
┌──────────────────┐  陈洋 ontology, snake_case
│  L3: ontology    │  Candidate(28) / Candidate_Expectation(9) / Resume(21)
│  (我们说了算)    │  Job_Requisition(39) / Candidate_Match_Result(6)
└──────────────────┘
```

**对齐目标**:让 L2(AO emit)的字段名/类型/位置 1:1 对得上 L3(ontology),mapper 一遍写完不用再翻译。**Leader 关注的"命名问题"集中在 L3** — ontology 命名要么含义太窄(`expected_position` 单数但实际是多个)、要么含义不准(`outsourcing_acceptance_level` 把"可远程办公"塞到"外包接受度")、要么和 L2/L1 的行业通用命名不一致。

---

## 1. Candidate

### 1.1 三层字段并列

| L1 RoboHire (vendor) | L2 `CandidateNested` (AO emit) | L3 Allmeta `Candidate` | 对齐状态 |
|---|---|---|---|
| `name: string\|null` | `name: string\|null` | `name: String` | ✅ 三层一致 |
| `phone: string\|null` | `mobile: string\|null` (mapper 改名 + cleanMobile) | `mobile: String` | ✅ L2/L3 一致,L1 已改 |
| `email: string\|null` | `email: string\|null` | `email: String` | ✅ 三层一致 |
| (无,RoboHire 不返) | `gender: null` (永远 null) | `gender: String` | ⚠️ AO 不解析 — RoboHire prompt 里没要,要么补,要么 ontology 不强求 |
| (无) | `birth_date: null` (永远 null) | `birth_date: Date` | ⚠️ 同上 |
| `location: string` | `current_location: string\|null` | `current_location: String` | ✅ L2/L3 一致 |
| `education[].degree` (取 highest) | `highest_acquired_degree: string\|null` | `highest_acquired_degree: String` | ✅ L2/L3 一致 |
| `experience[]` (汇总) | `work_years: number\|null` (calculateWorkYears 算出来) | **`experience_years: Float`** | ❌ **命名分歧** |
| (无) | `current_company: string\|null` | (无字段) | ❌ **L2 有 L3 没** |
| (无) | `current_title: string\|null` | (无字段) | ❌ **L2 有 L3 没** |
| `skills: string[]` | `skills: string[]` | (无,Allmeta 在 Resume.skill_tags) | ⚠️ **位置分歧** |
| — | — | `candidate_id: String` (PK) | L3 only — DB 生成 |
| — | — | `id_number / employee_id / referrer_employee_id / is_locked / lock_start_time / nationality / unified_enrollment / flight_risk_level / max_salary_limit / status / state / blacklist_status / marital_fertility_status / conflict_interest_declaration / conflict_clearance_deadline / gap_reason / previous_level / expected_degree / expected_graduation_date` | L3 only — partner workflow / HR 填,AO 不发不影响 |

### 1.2 命名分歧逐条诊断 + 双向选项

#### ① `work_years` (L2) ↔ `experience_years` (L3)

- **L2**:由 [mappers/robohire-to-raas.ts:64 `calculateWorkYears()`](../resume-parser-agent/lib/mappers/robohire-to-raas.ts#L64) 算出来,值是"累计工作月数 / 12,保留 1 位小数"。
- **L3**:`experience_years: Float, "候选人从首次参加工作至今的总年数"`。
- **同一语义,字段名不同**。
- L1 vendor 既不发 `work_years` 也不发 `experience_years`(RoboHire 只给 `experience[]` 数组)— 所以两边都是**自创**字段名。

| 选项 | 改动 | 代价 |
|---|---|---|
| A: AO 改 `work_years → experience_years` | mapper 一处改名 | 低 |
| B: Allmeta 改 `experience_years → work_years` | properties_json 改名 + 影响所有 consumer | 中 |

**★ 推荐 B(Allmeta 改)**。理由:
- 在 [`Job_Requisition.work_years`](#3-job_requisition) 里已经叫 `work_years`(整数,岗位要求年限)— Allmeta 自己内部都不一致,JR 用 `work_years` Candidate 用 `experience_years` 一头雾水。
- L1 RAAS sync-generated handler 里也用 `work_years` 。
- 行业 SaaS(Greenhouse / Lever / 北森)都用 `years_of_experience` 或 `work_experience_years`,从来没见过 `experience_years`。
- 改名后:Candidate.work_years (Float, 已工作年数) vs JR.work_years (Integer, 岗位要求年数)— **同字段名同语义**,不冲突。

#### ② `current_company` / `current_title` (L2 only)

- L2 [`CandidateNested.current_company`](../resume-parser-agent/lib/inngest/client.ts#L33) / `current_title` — 从最新一段 `experience[]` 里挑出来(currentExp.company / currentExp.title)。
- L3 没字段。
- 同时 L2 还有个 [`RuntimeNested`](../resume-parser-agent/lib/inngest/client.ts#L65) 也只装这俩 — 说明 AO 自己也没想清楚放哪。

| 选项 | 改动 | 代价 |
|---|---|---|
| A: AO 不发(挪到 Resume.work_experience 字符串里隐含)| mapper 把这俩字段去掉 | 低 |
| B: Allmeta 加 `current_company / current_title` 到 Candidate | properties_json + 2 字段 | 低 |

**★ 推荐 B(Allmeta 加)**。理由:
- "在职公司 / 当前职位"是招聘场景**最高频**的展示字段(候选人卡片必显示),不应该埋在 Resume 序列化字符串里。
- 业界都是平铺(Greenhouse `current_company` / `current_title`, BOSS 直聘 `current_position`)。
- Resume 是历史档案性质,Candidate 是主档,这俩字段应该在 Candidate 上。

#### ③ `skills` 位置分歧:Candidate(L2) ↔ Resume.skill_tags(L3)

- L2 [`CandidateNested.skills: string[]`](../resume-parser-agent/lib/inngest/client.ts#L34) — RoboHire 解析的技能列表挂在 Candidate 上。
- L2 又有 [`ResumeNested.skills_extracted: string[]`](../resume-parser-agent/lib/inngest/client.ts#L48) — **同一份数据放了两次**(candidate.skills === resume.skills_extracted, 见 mapper.ts:125)。
- L3 `Candidate` 没 skills 字段,在 `Resume.skill_tags: List<String>`。

| 选项 | 改动 | 代价 |
|---|---|---|
| A: AO 改 — Candidate 不发 skills,只发 Resume.skill_tags(对应 L3)| mapper 删 candidate.skills,改名 skills_extracted → skill_tags | 低 |
| B: Allmeta 加 — Candidate 也加 `skill_tags` | + 1 字段(冗余存储)| 低 |
| C: 两边都改 — 命名统一成 `skill_tags`,只放 Resume | mapper 改名 + 删冗余 | 低 |

**★ 推荐 C**。理由:
- 技能本质属于"这次简历的解析结果",应该跟 Resume 走 — 同一候选人多版简历可能技能不一样。
- AO 现在两个字段重复装一份是历史 bug — 一并清理。
- `skill_tags` 比 `skills_extracted` 短而准。

#### ④ Allmeta `marital_fertility_status` 命名问题(Leader 关注点)

- L3 字段名 `marital_fertility_status: String` — 含"育龄"语义。
- 但描述写的是 `"未婚、已婚未育、已婚已育等"` — 这本来就是"婚姻 + 生育"组合状态。
- **命名问题**:`marital_fertility_status` 业界没人这么命名,标准叫法是 `marital_status`(婚姻状态)和 `fertility_status`(生育状态)分开,或者合并叫 `family_status`。

| 选项 | 改动 |
|---|---|
| A: 拆成两个字段 `marital_status` + `fertility_status` | + 1 字段,改字段含义 |
| B: 改名 `marital_fertility_status → family_status` | 1 改名 |
| C: 保持现状 | 0 |

**★ 推荐 B(改名 `family_status`)**。理由:行业通用术语,招聘场景"家庭状况"涵盖婚育是惯例。拆字段(选项 A)会让 partner 工作流多一个填表字段,投入产出不划算。

#### ⑤ Allmeta `conflict_interest_declaration` 命名问题(Leader 关注点)

- L3 字段名 `conflict_interest_declaration: String`。
- **命名问题**:英文表达不通顺。"利益冲突声明"应该是 `conflict_of_interest_declaration`(`of` 不能省)或者 `coi_declaration`(行业缩写 COI)。
- L1 RoboHire 也叫 `conflict_of_interest_declaration`(类型是 Object,目前 AO 不发到 L2)。

| 选项 | 改动 |
|---|---|
| A: Allmeta 改名 `conflict_interest_declaration → conflict_of_interest_declaration` | 1 改名 |
| B: 改成缩写 `coi_declaration` | 1 改名 |

**★ 推荐 A**。理由:行业标准写法是 `Conflict of Interest`(美国 SEC、ISO 37001 都这么写),AO/L1 vendor 已经这么用,Allmeta 跟齐。缩写 COI 通用度不够。

### 1.3 Candidate 总改动

| 谁 | 改动项 | 数量 |
|---|---|---|
| **L2(AO mapper)** | `skills` 删除(挂 Candidate 那份)· `skills_extracted → skill_tags`(挂 Resume 的)· `RuntimeNested` 整个删除(`current_company / current_title` 直接进 Candidate) | 3 |
| **L3(Allmeta)** | 改名 3 个:`experience_years → work_years` · `marital_fertility_status → family_status` · `conflict_interest_declaration → conflict_of_interest_declaration` · 加 2 个:`current_company` `current_title` | 3 改名 + 2 新增 |

---

## 2. Candidate_Expectation

### 2.1 三层字段并列

| L2 `CandidateExpectationNested` | L3 Allmeta `Candidate_Expectation` | 对齐状态 |
|---|---|---|
| `expected_salary_monthly_min: number\|null` | `expected_salary_range: String` | ❌ 拆字段 vs 单字符串 |
| `expected_salary_monthly_max: number\|null` | (合并在 expected_salary_range)| 同上 |
| `expected_cities: string[]` | `expected_location: String` | ❌ List vs String + 命名 |
| `expected_industries: string[]` | `expected_industry: String` | ❌ 同上 |
| `expected_roles: string[]` | `expected_position: String` | ❌ List vs String + 命名 |
| `expected_work_mode: string\|null` | `outsourcing_acceptance_level: String` | ❌ **完全不同含义** |
| (无)| `expected_company_size: String` | L3 only |
| (无)| `constraints: List<String>`(夜班/出差/群面接受度) | L3 only |
| (无)| `updated_time: Timestamp` | L3 only |

### 2.2 命名 + 类型 + 含义分歧

**这是问题最严重的对象** — L2 设计偏"程序逻辑友好"(数字 / 数组),L3 设计偏"自由文本",几乎每个字段都不对齐。

#### ① 薪资:`expected_salary_monthly_min/max: number` (L2) ↔ `expected_salary_range: String` (L3)

| 选项 | 改动 |
|---|---|
| A: AO 在 mapper 拼字符串发 L3 格式("15K-25K/月")| mapper 加 join 函数 |
| B: Allmeta 拆成 `expected_salary_monthly_min: Float` + `expected_salary_monthly_max: Float` + `salary_currency: String` | properties_json 拆字段 |
| C: 两个都保留(L3 加 min/max + 保留 range)| properties_json 加字段 |

**★ 推荐 B(Allmeta 拆)**。理由:
- 数值字段才能做范围筛选/排序("我要 15K 以上"无法用字符串实现)。
- L1/L2 vendor 已经是 number,Allmeta 拼回字符串等于丢精度。
- 拿到 number 后 UI 自己 format 成 "15K-25K/月" 是常规做法。

#### ② 地点 / 行业 / 职位:String 单值 → List<String>

L3 现在三个字段全用 String 单数(`expected_location` / `expected_industry` / `expected_position`),但**候选人期望本来就是多选**(候选人会同时考虑"上海/杭州"和"AI/教育"两个城市/行业)。

| 选项 | 改动 |
|---|---|
| A: AO mapper join 成逗号分隔字符串 | mapper 加 `.join(',')` × 3 |
| B: Allmeta 改成 `List<String>` + 复数命名 `expected_locations / expected_industries / expected_positions` | properties_json 改 3 字段类型 + 改名 |

**★ 推荐 B(Allmeta 改)**。理由:
- 单数命名 + String 单值是错误设计 — 招聘业务从一开始就需要多选。
- 改名复数化(`expected_position → expected_positions` 等)同时让命名和类型自洽。
- L2 已经是 `expected_cities / expected_industries / expected_roles`(注意 L2 用的是 `roles` 不是 `positions` — 见下条)。

#### ③ `expected_roles` (L2) ↔ `expected_position` (L3) 命名分歧

- L2 用 `expected_roles: string[]`(roles 复数)。
- L3 用 `expected_position: String`(position 单数)。

| 选项 | 改动 |
|---|---|
| A: 统一成 `expected_positions`(复数) | L2 改名 + L3 改名 |
| B: 统一成 `expected_roles` | L3 改名 |

**★ 推荐 A(统一成 `expected_positions`)**。理由:
- `position` 在 HR 业界是"岗位/职位"的标准词(JR 里也用 position 派生词)。
- `role` 偏组织角色含义(更通用),容易和 `Standard_Job_Role`(L3 已有的标准岗位 DataObject)概念混淆。
- L2 改 `expected_roles → expected_positions` + L3 改 `expected_position → expected_positions`(配合上一条改成 List)。

#### ④ `expected_work_mode` (L2) vs `outsourcing_acceptance_level` (L3) — **完全不同语义**(关键 bug)

- L2 [`expected_work_mode: string\|null`](../resume-parser-agent/lib/inngest/client.ts#L43) — 工作模式(remote / hybrid / onsite)。
- L3 `outsourcing_acceptance_level: String` — 对**人力资源外包**模式的接受度("接受/不接受/中立")。
- 这是**两件不同的事**,目前 mapper [robohire-to-raas.ts:134](../resume-parser-agent/lib/mappers/robohire-to-raas.ts#L134) 也只是把 `expected_work_mode: null` 写死,根本没填到 outsourcing_acceptance_level。

| 选项 | 改动 |
|---|---|
| A: 加两个字段都保留 | L3 加 `expected_work_mode: String`,L2 加 `outsourcing_acceptance_level: String\|null` |
| B: AO 不发 outsourcing(留给 partner workflow 填),Allmeta 加 `expected_work_mode` | L3 加 1 字段 |

**★ 推荐 B**。理由:
- `outsourcing_acceptance_level` 是 RAAS 业务字段(中软国际外包业务专用),应该由 hsm/partner workflow 收集,不是简历上能解析出来的。AO 不发,留给人填。
- `expected_work_mode` 是简历期望,行业通用,L3 应该补。

### 2.3 Candidate_Expectation 总改动

| 谁 | 改动项 | 数量 |
|---|---|---|
| **L2(AO mapper)** | `expected_roles → expected_positions` | 1 改名 |
| **L3(Allmeta)** | 改 3 个 String → List<String>:`expected_location → expected_locations` · `expected_industry → expected_industries` · `expected_position → expected_positions` · 拆 1 个:`expected_salary_range` → `expected_salary_monthly_min: Float` + `expected_salary_monthly_max: Float` + `salary_currency: String` · 加 1 个:`expected_work_mode` | 3 改名+类型 + 1 拆字段(净 +2) + 1 新增 |

---

## 3. Resume

### 3.1 三层字段并列

| L2 `ResumeNested` | L3 Allmeta `Resume` | 对齐状态 |
|---|---|---|
| `summary: string\|null` | (无) | ❌ L2 有 L3 没 |
| `skills_extracted: string[]` | `skill_tags: List<String>` | ❌ 命名 |
| `work_history: Array<Object>` | `work_experience: String` | ❌ 类型 + 命名 |
| `education_history: Array<Object>` | `education_experience: String` | ❌ 类型 + 命名 |
| `project_history: unknown[]\|null` | `project_experience: String` | ❌ 类型 + 命名 |
| (无,但 L1 RoboHire 有 `certifications`) | `certificate: String` | L3 only |
| (无) | `language_skills: String` | L3 only |
| (无,RAAS upload 阶段有 `upload_id`)| `file_path: String`(MinIO 路径) | ❌ L3 没 upload_id |
| — | `resume_id / candidate_id / job_requisition_id / sourcing_channel_id / employee_id / is_original / skill_ranking / highlight_keywords / recommendation_reason / project_description_validity / portfolio_attachment / language / created_time / updated_time` | L3 only — DB / 业务字段 |

### 3.2 命名分歧诊断

#### ① `work_history` vs `work_experience`(命名 + 类型)

- L2:`work_history: Array<{title, company, startDate, endDate, description}>` — 结构化数组。
- L3:`work_experience: String` — 序列化文本。

**命名分析**:
- `experience` 含义偏"经验"(总年数 / 经历过什么),`history` 含义偏"履历"(时间线 + 详细条目)— 后者更准。
- 但 Allmeta `Resume.work_experience` 描述是 `"简历的详细工作履历及职责描述"`,实际表达的是 history,**字段名词不达意**。

| 选项 | 改动 |
|---|---|
| A: AO 改 — 序列化成字符串,改名为 `work_experience` | mapper 加序列化 + 改名 |
| B: Allmeta 改 — 改成 `List<Object>` 结构化 + 改名 `work_experience → work_history` | properties_json 改类型 + 改名 |
| C: 折中 — Allmeta 类型不变(String),只改名 `work_experience → work_history`,AO 仍要序列化 | properties_json 改名 |

**★ 推荐 C**。理由:
- Allmeta 用 String 装履历是 Neo4j 节点不擅长存嵌套对象的妥协,改 List<Object> 性价比低(Neo4j 不支持嵌套 Map,要么拆子节点要么 JSON 字符串,最后还是字符串)。
- 但**命名 history 更准** — `work_experience` 让人误以为是"工作年数"(和 Candidate.experience_years 混)。
- 同理 `education_experience → education_history`,`project_experience → project_history`。

#### ② `skills_extracted` vs `skill_tags`

(已在 §1.2 ③ 决策:统一成 `skill_tags`,只挂 Resume)

#### ③ `summary` 缺失

L2 有,L3 没。简历摘要是基本字段,Allmeta 应补。

#### ④ `upload_id` 缺失

L3 `Resume.file_path` 装的是 MinIO URI(`s3://bucket/object_key`),但 RAAS upload 流程有个独立的 `upload_id` 主键(看 [SaveCandidateInput.upload_id](../resume-parser-agent/lib/raas-api-client.ts#L367))— 这是 MinIO 上传记录的稳定 ID,跟 `file_path` 语义不同(file_path 可能多版本,upload_id 是单次上传事件)。

**★ 推荐 Allmeta 加 `upload_id: String`**。

### 3.3 Resume 总改动

| 谁 | 改动项 | 数量 |
|---|---|---|
| **L2(AO mapper)** | 序列化 work/education/project history 为 String · 改名 `skills_extracted → skill_tags` · 加 summary 透传 | 4 处 |
| **L3(Allmeta)** | 改名 3 个:`work_experience → work_history` · `education_experience → education_history` · `project_experience → project_history` · 加 2 个:`summary` `upload_id` | 3 改名 + 2 新增 |

---

## 4. Job_Requisition

### 4.1 三层字段并列(按用途分组)

L1 `RaasRequirement` 类型只列了常用 21 字段,实际 RAAS API `GET /requirements/:id` 返回 64 字段(`[k:string]: unknown` 兜底)。L3 `Job_Requisition` 39 字段。

#### 完全对齐(L2 写,L3 收,字段名一致)— **17 字段无改动**

```
job_requisition_id, job_requisition_specification_id, client_id,
client_department_id, client_job_id, client_job_title, job_responsibility,
job_requirement, must_have_skills, nice_to_have_skills, negative_requirement,
language_requirements, headcount, work_years, degree_requirement,
education_requirement, interview_mode, expected_level, recruitment_type
```

(实际 19 个全对得上)

#### 字段名分歧 — 需要决策

| L2/L1 | L3 | 选项 | ★ 推荐 |
|---|---|---|---|
| `city: string` (单数 String) | `city: String` (单数,但 [JD generated 用 `city: string[]`](../resume-parser-agent/lib/inngest/client.ts#L191)) | 统一 List<String> | **★ Allmeta 改 `city: List<String>`** — 多地点办公是常态(深圳 + 上海 + 北京) |
| `salary_range: string` ("1-1.5万/月") | `salary_range: String` | 同 §2.2 ① 拆字段 | **★ Allmeta 拆** `salary_range_monthly_min: Float` + `salary_range_monthly_max: Float` + `salary_currency: String` + 保留 `salary_range: String` 兼容 |
| (L1) `publish_date` | `open_date` | 改名 | **★ Allmeta 改 `open_date → publish_date`** — 行业用 publish |
| (L1) `expected_arrival_date` | `required_arrival_date` | 改名 | **★ Allmeta 改 `required_arrival_date → expected_arrival_date`** |
| (L1) `hsm_employee_id`(在 spec) | (无,spec_id FK 链过去) | 不改 | ★ 保持 FK 设计 |
| (L1) `priority / status / hc_status / fill_difficulty / urgency_level / completion_time / created_at / our_application_count` 等流程态 | 部分有 (`hc_status / fill_difficulty / urgency_level` 在 L3) / 部分无(动态状态)| — | ★ 动态状态走事件流不进 DataObject |

#### Allmeta 独有(partner 填)— 保留不动

`evaluation_model_id / standard_job_role_id / csi_department_id / client_job_temp_id / clarify_questions / recruitment_strategies / interview_process / age_range / gender / require_foreigner / work_address / work_schedule_type`

### 4.2 JR 命名问题盘点(Leader 关注)

| L3 当前 | 问题 | 推荐改名 |
|---|---|---|
| `open_date` | 行业惯例叫 publish_date | `publish_date` |
| `required_arrival_date` | required 偏强制语义,实际是预期 | `expected_arrival_date` |
| `csi_department_id` | "CSI" 是公司缩写,ontology 不该带租户名 | `recruiting_department_id` 或 `internal_department_id` |
| `city: String` | 类型应该是 List | 类型改 List + 保持名 |
| `headcount` | 行业常用 `headcount` 没问题 | (不动) |
| `hc_status` | hc 缩写应展开 | `headcount_status` |
| `expected_level` | 模糊 — "期望级别"指岗位职级 | `target_job_level` |

### 4.3 JR 总改动

| 谁 | 改动项 | 数量 |
|---|---|---|
| **L2(AO mapper)** | mapper 投影 — RAAS 64 字段只挑 ontology 对得上的 19 个核心 + 4 FK 进 Allmeta,丢弃流程状态 11 项 / 客户身份冗余 5 项 / 人员分配冗余 8 项(走 FK→Employee/Client) | mapper 1 处 |
| **L3(Allmeta)** | 改名 5 个(open_date / required_arrival_date / csi_department_id / hc_status / expected_level)· 改类型 1 个(city: String → List<String>)· 拆字段 1 个(salary_range)| 5 改名 + 1 改类型 + 1 拆字段(净 +2) |

---

## 5. Candidate_Match_Result

### 5.1 三层字段并列

| L2 emit `MatchPassedNeedInterviewData` | L1 RoboHire `MatchResultItem` 透传 | L3 Allmeta `Candidate_Match_Result` | 对齐状态 |
|---|---|---|---|
| `upload_id: string` | — | (无 upload_id, 通过 candidate_id 关联) | L2 only(AO 用 upload_id 让 RAAS 反查) |
| `job_requisition_id: string` | `job_requisition_id` 或 `job_id` | `job_position_id` | ❌ **命名分歧** |
| (RAAS 写时填) | `candidate_id` | `candidate_id` | ✅ |
| (RAAS 写时填) | `client_id` | `client_id` | ✅ |
| (RAAS 写时填) | `candidate_match_result_id` | `candidate_match_result_id` (PK) | ✅ |
| `data.matchScore` | `matchScore: number` | (无) | ❌ |
| `data.recommendation` | `recommendation: string` | (无,有 `result: String`)| ❌ 命名 + 取值 |
| `data.summary` | `summary: string` | `reason: String` | ❌ 命名 |
| `data.matchAnalysis / mustHaveAnalysis / niceToHaveAnalysis` | 同 | (无) | ❌ |
| `data.skillMatch / skillMatchScore / experienceMatch / experienceValidation / candidatePotential` | 同 | (无) | ❌ |
| `data.transferableSkills / experienceBreakdown / hardRequirementGaps` | 同 | (无) | ❌ |
| `data.overallMatchScore / overallFit / recommendations / suggestedInterviewQuestions / areasToProbeDeeper / preferenceAlignment / candidateSummary` | 同 | (无) | ❌ |
| (rule-check 阶段产物 — 见旧 gap doc 4.1) | — | (无) | ❌ AO 自创字段无落地 |

L3 字段总共 6 个:`candidate_match_result_id / client_id / candidate_id / job_position_id / result / reason`。AO 实际产出 23+ 个字段,**绝大多数无法落地**。

### 5.2 命名分歧诊断(Leader 关注)

#### ① `job_position_id` (L3) vs `job_requisition_id`(其他所有 DataObject)

- L3 `Candidate_Match_Result.job_position_id: String` → references `Job_Requisition`(注意 references 是 Job_Requisition 而不是某个 Job_Position 对象)。
- 但 ontology 里**根本没有 Job_Position 这个 DataObject**(只有 Job_Requisition / Job_Posting 两个),所以 `job_position_id` 这个名字是**孤儿** — 不知道 position 指什么。
- 其他 DataObject 全部用 `job_requisition_id`(Job_Offer / Resume / Job_Posting / Application / Interview_Model 等)。

**★ 推荐 Allmeta 强制改名 `job_position_id → job_requisition_id`** — Leader 反映的命名问题在这条体现得最明显。这个名字是历史遗留 bug。

#### ② `result` (L3) vs `recommendation` (L1/L2)

- L3 `result: String` 取值 `"匹配 / 不匹配 / 待定"`(中文枚举)。
- L1/L2 `recommendation: 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH'`(英文 4 级)。
- 含义部分重叠但**粒度不同**:L3 三档结论,L1/L2 四档推荐。

| 选项 | 改动 |
|---|---|
| A: 全用 L1 4 档 — Allmeta 改 `result` 类型为 `STRONG_MATCH/GOOD_MATCH/PARTIAL_MATCH/WEAK_MATCH` | properties_json 改取值 |
| B: 全用 L3 3 档 — AO mapper 把 4 档收敛成 3 档 (STRONG/GOOD→匹配, PARTIAL→待定, WEAK→不匹配) | mapper 加映射函数 |
| C: 两个都保留 — Allmeta 加 `recommendation` 字段,`result` 保留(更人性化) | + 1 字段 |

**★ 推荐 C**。理由:
- `result` 是给 partner UI / report 看的人类可读结论(中文短词),保留有价值。
- `recommendation` 是 AI 模型的算法分级,精度更高,要存原始的供后续模型训练。
- 同时也让其他业务规则(如"WEAK_MATCH 自动拒绝")可读。

#### ③ `reason` (L3) vs `summary` (L1/L2)

- L3 `reason: String` "候选人匹配结果的原因"。
- L1/L2 `summary: string` 是评估的 1-2 句概述。

含义一致(自由文本评估),命名分歧。

| 选项 | 改动 |
|---|---|
| A: AO mapper 改名 `summary → reason` | mapper 改名 |
| B: Allmeta 改名 `reason → summary` | properties_json 改名 |

**★ 推荐 A**。理由:`reason` 在业务上下文里更准(为什么得出这个结论),L3 命名更好。AO mapper 改名成本低。

### 5.3 Match_Result 大量 RoboHire 字段无处可写 — 关键决策

L1 RoboHire 返回 23+ 字段(matchAnalysis / skillMatch / experienceValidation / overallFit / recommendations / suggestedInterviewQuestions / ...),L3 只 6 字段,**21+ 字段无字段对应**。

#### 选项

| 选项 | 改动 | 评价 |
|---|---|---|
| A: AO 把所有 RoboHire 字段序列化成一坨 JSON 进 `Candidate_Match_Result.match_breakdown_json: String` | + 1 字段 | ★ 推荐 |
| B: Allmeta 平铺加 21 字段 | properties_json + 21 字段 | 投入大,字段多数低用率 |
| C: AO 丢弃,只保留核心 4 字段 | mapper 裁剪 | 数据丢失,后续训练 / 复盘没素材 |

**★ 推荐 A 为主 + 关键字段单独平铺**:
- 加 `match_breakdown_json: String` 装全部 RoboHire 原始 data。
- 同时把以下高用率字段单独平铺(查询 / 筛选要用):
  - `match_score: Float`(评分,核心 metric)
  - `recommendation: String`(STRONG/GOOD/PARTIAL/WEAK)
  - `must_have_gaps: List<String>`(从 hardRequirementGaps 提取,做"硬性条件不达标"筛选)
  - `transferable_skills: List<String>`(从 transferableSkills 提取,猎头要看)
  - `raas_match_request_id: String`(跟 RoboHire 日志关联)
  - `decided_at: Timestamp`(决策时间)

#### Rule-check 审计字段(AO 自创,L3 完全没)

`rule_check_audit_id / rule_check_decision / failure_reason_codes / rules_evaluated_count / terminal_rule_hits / parent_match_result_id / final_decision / final_decision_reason`

— 这些是 AO 业务定义的(rule-check 阶段独立结论 + 谱系追踪),L3 完全没字段。

| 选项 | 改动 |
|---|---|
| A: Allmeta 加 8 字段,完全落地审计链 | + 8 字段 |
| B: AO 不写,审计链留在 AO Inngest 事件里查 | 0 |
| C: Allmeta 加关键 3 字段(audit_id / decision / failure_codes)其他 AO 内部消化 | + 3 字段 |

**★ 推荐 C**。理由:
- audit_id + decision + failure_codes 是 partner UI 必须能拿到的(用户想知道"为啥不通过"),要落 ontology。
- rules_evaluated_count / terminal_rule_hits / parent_match_result_id 是 AO 内部 debug 用,留在 Inngest event metadata 里查就好,不必污染 ontology。

### 5.4 Match_Result 总改动

| 谁 | 改动项 | 数量 |
|---|---|---|
| **L2(AO mapper)** | 透传 RoboHire data 整段进 `match_breakdown_json` · `summary → reason` 改名 · 把 hardRequirementGaps / transferableSkills 拍平 · rule-check audit 字段单独写 | 4 处 |
| **L3(Allmeta)** | 改名 1 个:`job_position_id → job_requisition_id` · 加 9 字段:`match_score / recommendation / match_breakdown_json / must_have_gaps / transferable_skills / raas_match_request_id / decided_at / rule_check_audit_id / rule_check_decision / failure_reason_codes` | 1 改名 + 9 新增(注:这里实际是 10 个,之前打字算错) |

---

## 6. 总汇:谁改多少 + Leader 关注的命名问题

### 6.1 改动统计

| DataObject | L2 (AO mapper) 改动 | L3 (Allmeta) 改动 |
|---|---|---|
| Candidate | 3 处 | 3 改名 + 2 新增 |
| Candidate_Expectation | 1 处 | 3 改名+类型 + 1 拆字段(+2) + 1 新增 |
| Resume | 4 处 | 3 改名 + 2 新增 |
| Job_Requisition | 1 处(投影) | 5 改名 + 1 改类型 + 1 拆字段(+2) |
| Candidate_Match_Result | 4 处 | 1 改名 + 10 新增 |
| **合计** | **13 处 mapping** | **15 改名/改类型 + 17 新增** |

### 6.2 ★ Leader 关注的"DataObject 命名不好"逐条清单

| # | L3 当前命名 | 问题 | 改成 | DataObject |
|---|---|---|---|---|
| 1 | `experience_years` | 与 JR.work_years 不一致 | `work_years` | Candidate |
| 2 | `marital_fertility_status` | 业界没人这么写 | `family_status` | Candidate |
| 3 | `conflict_interest_declaration` | 英文不通顺(漏 of) | `conflict_of_interest_declaration` | Candidate |
| 4 | `expected_position` | 单数,实际多选 | `expected_positions` (List) | Candidate_Expectation |
| 5 | `expected_location` | 单数 + String | `expected_locations` (List) | Candidate_Expectation |
| 6 | `expected_industry` | 单数 + String | `expected_industries` (List) | Candidate_Expectation |
| 7 | `expected_salary_range` | String 装数值丢精度 | 拆 `expected_salary_monthly_min/max: Float` | Candidate_Expectation |
| 8 | `outsourcing_acceptance_level` | 含义太窄,且 AO 永远填 null | (不动,加 `expected_work_mode` 给简历用) | Candidate_Expectation |
| 9 | `work_experience` | 命名指向"年数",实际是履历 | `work_history` | Resume |
| 10 | `education_experience` | 同上 | `education_history` | Resume |
| 11 | `project_experience` | 同上 | `project_history` | Resume |
| 12 | `open_date` | 行业用 publish_date | `publish_date` | Job_Requisition |
| 13 | `required_arrival_date` | required 太强 | `expected_arrival_date` | Job_Requisition |
| 14 | `csi_department_id` | 带租户名 (中软国际) | `recruiting_department_id` | Job_Requisition |
| 15 | `hc_status` | 缩写 | `headcount_status` | Job_Requisition |
| 16 | `expected_level` | 模糊 | `target_job_level` | Job_Requisition |
| 17 | `city` (String 单数) | 类型应是 List | `city: List<String>` | Job_Requisition |
| 18 | `salary_range` (String) | 同 #7 拆数值 | 拆 `salary_range_monthly_min/max` | Job_Requisition |
| 19 | `job_position_id` | 孤儿命名(没 Job_Position 对象) | `job_requisition_id` | Candidate_Match_Result |
| 20 | `result` (3 档枚举) | 与 L1 4 档 recommendation 重叠 | 加 `recommendation` 字段共存 | Candidate_Match_Result |
| 21 | `reason` | 字段名 OK,L2 命名要改 | (L2 改 summary→reason) | Candidate_Match_Result |

### 6.3 优先级建议

| 优先级 | 任务 | 谁 | 估时 |
|---|---|---|---|
| **P0** | Allmeta 修 strict validation bug(properties_json 字段也被拒)| 陈洋 | 1-2h |
| **P1** | Allmeta 高影响命名修复:`job_position_id→job_requisition_id`(MR 链路必经)+ Candidate_Match_Result 加 `match_score / recommendation / match_breakdown_json / decided_at`(评分 / 审计)| 陈洋 | 1h |
| **P1** | Allmeta Candidate 命名修复:3 个改名(work_years / family_status / conflict_of_...)+ 2 加字段(current_company / current_title)| 陈洋 | 30min |
| **P2** | Allmeta Candidate_Expectation 拆字段 + 复数化(7 处改动) | 陈洋 | 1h |
| **P2** | Allmeta Resume 改名 _experience → _history + 加 summary/upload_id | 陈洋 | 30min |
| **P2** | Allmeta JR 改名 5 + 改 city 类型 + 拆 salary_range | 陈洋 | 1h |
| **P3** | AO 写新版 mapper(`lib/mappers/ao-to-allmeta.ts`),按对齐后字段名/类型 1:1 输出,删除 RuntimeNested,补 candidate.current_company/title 平铺 | Steven | 3-4h |
| **P3** | Match_Result writer 加 RoboHire data 整段透传 + rule-check audit 字段写入 | Steven | 2h |
| **P4** | E2E 联调:江银行链路 → 写入 Allmeta → drawer 显示新字段(work_years / current_company / match_score) | 双方 | 1h |

---

## 7. 推荐总方案 — 一句话版

**Leader 反馈成立**:L3 ontology 有 **21 处命名 / 类型 / 设计问题**,集中在三类:
1. **行业惯例不一致**(work_years / publish_date / job_requisition_id) — Allmeta 自己内部都不统一,L3 跟齐 L1+L2 即可。
2. **类型用错**(单数 String 装 List / 自由文本装数值) — Candidate_Expectation 和 JR 的 city/salary 都该改 List 或拆字段。
3. **缩写 / 含义不准**(csi_ / hc_ / outsourcing_acceptance_level) — 拼出来 + 重新命名。

**改动总量**:
- L3 (Allmeta) 15 改名/改类型 + 17 新增 — 一次性投入 ~5h,影响所有 consumer 但 ontology 干净一辈子。
- L2 (AO mapper) 13 处 — 在新 `lib/mappers/ao-to-allmeta.ts` 集中处理,~5h。

**最终对接面**:
```
RoboHire / RAAS  ──►  AO L1 vendor schema  ──►  AO L2 emit (CandidateNested 等)
   (现状不动)        (现状不动,RaaS 客户端)        (现状不动,Inngest event)
                                                          │
                                                          │  lib/mappers/ao-to-allmeta.ts
                                                          ▼
                                                ┌─────────────────────┐
                                                │  Allmeta DataObject │  改名 15 + 加 17 后,L2/L3
                                                │  (改名+类型修复)    │  字段 1:1 对得上,strict
                                                └─────────────────────┘  validation 直接收
```

---

## 8. 文档关系

| 文档 | 范围 | 状态 |
|---|---|---|
| **本文** [docs/ao-runtime-vs-allmeta-alignment-v2.md](ao-runtime-vs-allmeta-alignment-v2.md) | ★ L1/L2/L3 三层对照 + Leader 命名问题逐条 + 双向选项 | 当前 |
| [docs/ao-runtime-vs-allmeta-dataobject-gap.md](ao-runtime-vs-allmeta-dataobject-gap.md) | 旧版 — L1 vs L3 对比(忽略了 L2 mapper 已经做的工作) | 已被本文取代 |
| [docs/ontology-schema-changes-for-chenyang.md](ontology-schema-changes-for-chenyang.md)(if exists) | 单边推 Allmeta 改 | 旧版 |
| [resume-parser-agent/lib/mappers/robohire-to-raas.ts](../resume-parser-agent/lib/mappers/robohire-to-raas.ts) | 现有 L1→L2 mapper | 待补 L2→L3 mapper |
