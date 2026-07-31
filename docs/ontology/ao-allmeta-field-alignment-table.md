# AO 写入实例 ↔ Allmeta DataObject — 字段对齐总表

> **用途**:一张表查一个字段 — AO 写出来的是什么形状、Allmeta 收的是什么形状、怎么对齐。
>
> **数据源**:
>
> - AO 实例字段:[resume-parser-agent/lib/inngest/client.ts](../../resume-parser-agent/lib/inngest/client.ts) (`CandidateNested` / `CandidateExpectationNested` / `ResumeNested` / `JdGeneratedPayload` / `MatchPassedNeedInterviewData`) + [resume-parser-agent/lib/raas-api-client.ts](../../resume-parser-agent/lib/raas-api-client.ts) (`RaasRequirement` / `MatchResultItem` 透传字段)
> - Allmeta 字段:`/Users/yuhancheng/allmetaOntology/apps/events-builder/data copy/dataobjects_20260408 (1).json`
>
> **对齐方案符号**:
>
> - ✅ = 已对齐(无改动)
> - 🟡 = AO 改 mapper(L2 改字段名/类型/位置)
> - 🟠 = Allmeta 改 properties_json(改名 / 改类型 / 加字段)
> - 🔵 = 双方都要动
> - ⚪ = AO 不写(留给 partner / HR workflow 填,或丢弃)

---

## 1. Candidate

### AO 实例(11 字段,来自 `CandidateNested`,mapper 出)


| #   | AO 字段                     | AO 类型                | Allmeta 字段                 | Allmeta 类型 | 差异                                                           | 对齐方案                                                                                                                            |
| --- | ------------------------- | -------------------- | -------------------------- | ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `name`                    | string|null          | `name`                     | String     | —                                                            | ✅                                                                                                                               |
| 2   | `mobile`                  | string|null          | `mobile`                   | String     | —                                                            | ✅                                                                                                                               |
| 3   | `email`                   | string|null          | `email`                    | String     | —                                                            | ✅                                                                                                                               |
| 4   | `gender`                  | string|null(永远 null) | `gender`                   | String     | AO 不解析                                                       | ⚪ AO 维持 null,等 RoboHire prompt 加性别识别后再填                                                                                         |
| 5   | `birth_date`              | string|null(永远 null) | `birth_date`               | Date       | AO 不解析                                                       | ⚪ 同上                                                                                                                            |
| 6   | `current_location`        | string|null          | `current_location`         | String     | —                                                            | ✅                                                                                                                               |
| 7   | `highest_acquired_degree` | string|null          | `highest_acquired_degree`  | String     | —                                                            | ✅                                                                                                                               |
| 8   | `work_years`              | number|null          | `experience_years`         | Float      | **字段名分歧**                                                    | 🟠 Allmeta 改名 `experience_years → work_years`(与 JR.work_years 自洽 + 行业用法)                                                        |
| 9   | `current_company`         | string|null          | (无)                        | —          | **L3 缺字段**                                                   | 🟠 Allmeta 加 `current_company: String`                                                                                          |
| 10  | `current_title`           | string|null          | (无)                        | —          | **L3 缺字段**                                                   | 🟠 Allmeta 加 `current_title: String`                                                                                            |
| 11  | `skills`                  | string[]             | (无,L3 在 Resume.skill_tags) | —          | **位置 + 字段冗余**(同份数据 mapper 也写了 ResumeNested.skills_extracted) | 🟡 AO 删除 `Candidate.skills`,只走 `Resume.skill_tags`;同步删除 `[RuntimeNested](../../resume-parser-agent/lib/inngest/client.ts#L65)`(空壳) |


### Allmeta 独有(AO 不写,partner / HR workflow 填)


| Allmeta 字段                                                        | 类型                   | 处理                                                              |
| ----------------------------------------------------------------- | -------------------- | --------------------------------------------------------------- |
| `candidate_id`                                                    | String (PK)          | ⚪ DB 生成                                                         |
| `employee_id`                                                     | String (FK→Employee) | ⚪ partner 填                                                     |
| `referrer_employee_id`                                            | String (FK)          | ⚪ partner 填(内推)                                                 |
| `is_locked` / `lock_start_time`                                   | Boolean / Timestamp  | ⚪ 系统态                                                           |
| `id_number`                                                       | String               | ⚪ HR 入职阶段填(PII)                                                 |
| `nationality`                                                     | String               | ⚪ partner / HR 填                                                |
| `unified_enrollment`                                              | Boolean              | ⚪ partner 填(统招标志)                                               |
| `flight_risk_level`                                               | String               | ⚪ AO 评估模型未来产出                                                   |
| `max_salary_limit`                                                | Float                | ⚪ AO 评估模型未来产出                                                   |
| `status` / `state`                                                | String               | ⚪ workflow 状态机                                                  |
| `blacklist_status`                                                | Boolean              | ⚪ Blacklist DataObject 派生                                       |
| `marital_fertility_status`                                        | String               | ⚪ HR 填 — 同时建议 🟠 改名 `family_status`(行业用法 + 英文通顺)                |
| `conflict_interest_declaration`                                   | String               | ⚪ HR 填 — 同时建议 🟠 改名 `conflict_of_interest_declaration`(英文应有 of) |
| `conflict_clearance_deadline`                                     | Date                 | ⚪ HR 填                                                          |
| `gap_reason`                                                      | String               | ⚪ HR / 顾问填                                                      |
| `previous_level` / `expected_degree` / `expected_graduation_date` | —                    | ⚪ partner 填                                                     |


---

## 2. Candidate_Expectation

### AO 实例(6 字段,来自 `CandidateExpectationNested`)

> ⚠️ **注意**:目前 mapper 里 6 个字段全部写死 `null` / `[]`,因为 RoboHire 没解析期望相关字段(见 [robohire-to-raas.ts:128](../../resume-parser-agent/lib/mappers/robohire-to-raas.ts#L128))。下表是 schema 设计意图。


| #   | AO 字段                         | AO 类型                             | Allmeta 字段                     | Allmeta 类型 | 差异                                                | 对齐方案                                                                                                                                                       |
| --- | ----------------------------- | --------------------------------- | ------------------------------ | ---------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `expected_salary_monthly_min` | number|null                       | `expected_salary_range` (合并)   | String     | **类型分歧**(数值 vs 字符串)                               | 🟠 Allmeta 拆字段:`expected_salary_monthly_min: Float` + `expected_salary_monthly_max: Float` + `salary_currency: String`                                     |
| 2   | `expected_salary_monthly_max` | number|null                       | (合并在上)                         | —          | 同上                                                | 🟠 同上                                                                                                                                                      |
| 3   | `expected_cities`             | string[]                          | `expected_location`            | String     | **类型 + 单/复数**                                     | 🟠 Allmeta 改 `expected_location: String → expected_locations: List<String>`                                                                                |
| 4   | `expected_industries`         | string[]                          | `expected_industry`            | String     | 同上                                                | 🟠 Allmeta 改 `expected_industry → expected_industries: List<String>`                                                                                       |
| 5   | `expected_roles`              | string[]                          | `expected_position`            | String     | **命名 + 类型 + 单/复数**                                | 🔵 双改:Allmeta `expected_position → expected_positions: List<String>`;AO `expected_roles → expected_positions`(统一用 position,role 容易和 Standard_Job_Role 概念混) |
| 6   | `expected_work_mode`          | string|null(remote/hybrid/onsite) | `outsourcing_acceptance_level` | String     | **完全不同语义**(work_mode = 远程办公;outsourcing = 接受外包用工) | 🟠 Allmeta 加 `expected_work_mode: String`;`outsourcing_acceptance_level` 保留给 hsm/partner 填                                                                 |


### Allmeta 独有(AO 不写)


| Allmeta 字段                     | 类型          | 处理                          |
| ------------------------------ | ----------- | --------------------------- |
| `candidate_expectation_id`     | String (PK) | ⚪ DB 生成                     |
| `candidate_id`                 | String (FK) | ⚪ AO 写 saveCandidate 时关联    |
| `outsourcing_acceptance_level` | String      | ⚪ hsm/partner 填(中软国际外包业务专用) |
| `expected_company_size`        | String      | ⚪ partner 填(简历不解析)          |
| `constraints`                  | List        | ⚪ 顾问沟通后填(夜班/出差/群面接受度)       |
| `updated_time`                 | Timestamp   | ⚪ DB 自动                     |


---

## 3. Resume

### AO 实例(5 字段,来自 `ResumeNested`)


| #   | AO 字段               | AO 类型                                                      | Allmeta 字段             | Allmeta 类型 | 差异                                                        | 对齐方案                                                                                             |
| --- | ------------------- | ---------------------------------------------------------- | ---------------------- | ---------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | `summary`           | string|null                                                | (无)                    | —          | **L3 缺字段**                                                | 🟠 Allmeta 加 `summary: String`                                                                   |
| 2   | `skills_extracted`  | string[]                                                   | `skill_tags`           | List       | **字段名分歧**                                                 | 🟡 AO 改名 `skills_extracted → skill_tags`                                                         |
| 3   | `work_history`      | `Array<{title, company, startDate, endDate, description}>` | `work_experience`      | String     | **类型 + 命名**(history 比 experience 准 — experience 让人误以为是年数) | 🔵 双改:Allmeta 改名 `work_experience → work_history`(类型仍 String,Neo4j 不擅长嵌套);AO 序列化为 JSON String 写入 |
| 4   | `education_history` | `Array<{degree, field, institution, graduationYear}>`      | `education_experience` | String     | 同上                                                        | 🔵 同上:Allmeta `education_experience → education_history`,AO 序列化                                  |
| 5   | `project_history`   | unknown[]|null                                             | `project_experience`   | String     | 同上                                                        | 🔵 同上:Allmeta `project_experience → project_history`,AO 序列化                                      |


### AO 上传层有但 ResumeNested 没体现的字段


| AO 字段                                                                    | 来源                                         | Allmeta 字段                  | 对齐方案                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------- |
| `upload_id`                                                              | `SaveCandidateInput.upload_id`(MinIO 上传主键) | (无,L3 只有 `file_path` 装 URI) | 🟠 Allmeta 加 `upload_id: String`(file_path 是路径,upload_id 是稳定 ID,语义不同)                  |
| `bucket / object_key / etag / mime_type / file_size / original_filename` | 同                                          | 部分对应 `file_path`            | 🟡 AO mapper 把 bucket+object_key 拼成 s3:// URI 写 `file_path`,其他丢弃(metadata 留 RAAS 上传日志) |


### Allmeta 独有(AO 不写)


| Allmeta 字段                                                                                                                                                                                | 类型          | 处理                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| `resume_id`                                                                                                                                                                               | String (PK) | ⚪ DB 生成                                                |
| `candidate_id`                                                                                                                                                                            | String (FK) | ⚪ saveCandidate 关联                                     |
| `job_requisition_id`                                                                                                                                                                      | List (FK)   | ⚪ 投递时关联                                                |
| `sourcing_channel_id`                                                                                                                                                                     | String (FK) | ⚪ 上传时附带                                                |
| `language_skills`                                                                                                                                                                         | String      | ⚪ AO 暂不解析(RoboHire 有 languages[] 但目前 mapper 不写) — 未来可补 |
| `certificate`                                                                                                                                                                             | String      | ⚪ 同上(RoboHire 有 certifications[] 不写) — 未来可补            |
| `is_original`                                                                                                                                                                             | Boolean     | ⚪ AO 写时填 true(原始解析)                                    |
| `skill_ranking` / `highlight_keywords` / `recommendation_reason` / `project_description_validity` / `portfolio_attachment` / `language` / `employee_id` / `created_time` / `updated_time` | —           | ⚪ 顾问 / DB 填                                            |


---

## 4. Job_Requisition

### AO 实例(读自 RAAS,投影写 Allmeta — 19 字段)

> **流向特殊**:JR 是 AO 从 RAAS `GET /requirements/:id` **读取**,然后投影写 Allmeta。L1 RAAS 返回 64 字段,AO 只写下面 19 个核心 + FK 给 Allmeta。


| #   | AO 字段(L1 RAAS)                     | AO 类型      | Allmeta 字段                                  | Allmeta 类型 | 差异                                             | 对齐方案                                                                                                                                          |
| --- | ---------------------------------- | ---------- | ------------------------------------------- | ---------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `job_requisition_id`               | string     | `job_requisition_id` (PK)                   | String     | —                                              | ✅                                                                                                                                             |
| 2   | `job_requisition_specification_id` | string     | `job_requisition_specification_id` (FK)     | String     | —                                              | ✅                                                                                                                                             |
| 3   | `client_id`                        | string     | (无 client_id 字段,但通过 FK→Client_Department 链) | —          | L3 不冗余 client_id                               | ⚪ AO 不直写,走 FK                                                                                                                                 |
| 4   | `client_department_id`             | string     | `client_department_id` (FK)                 | String     | —                                              | ✅                                                                                                                                             |
| 5   | `client_job_id`                    | string     | `client_job_id`                             | String     | —                                              | ✅                                                                                                                                             |
| 6   | `client_job_title`                 | string     | `client_job_title`                          | String     | —                                              | ✅                                                                                                                                             |
| 7   | `job_responsibility`               | string     | `job_responsibility`                        | String     | —                                              | ✅                                                                                                                                             |
| 8   | `job_requirement`                  | string     | `job_requirement`                           | String     | —                                              | ✅                                                                                                                                             |
| 9   | `must_have_skills`                 | string[]   | `must_have_skills`                          | List       | —                                              | ✅                                                                                                                                             |
| 10  | `nice_to_have_skills`              | string[]   | `nice_to_have_skills`                       | List       | —                                              | ✅                                                                                                                                             |
| 11  | `negative_requirement`             | string     | `negative_requirement`                      | String     | —                                              | ✅                                                                                                                                             |
| 12  | `language_requirements`            | string     | `language_requirements`                     | String     | —                                              | ✅                                                                                                                                             |
| 13  | `city`                             | string(单值) | `city`                                      | String(单值) | **类型应是 List**(JdGeneratedPayload 已经用 string[]) | 🟠 Allmeta 改 `city: List<String>`(多地点常态)                                                                                                      |
| 14  | `salary_range`                     | string     | `salary_range`                              | String     | **应拆数值**(同 #2.1)                               | 🟠 Allmeta 拆:`salary_range_monthly_min: Float` + `salary_range_monthly_max: Float` + `salary_currency: String` + 保留 `salary_range: String` 兼容 |
| 15  | `headcount`                        | number     | `headcount`                                 | Integer    | —                                              | ✅                                                                                                                                             |
| 16  | `work_years`                       | number     | `work_years`                                | Integer    | —                                              | ✅(注意和 Candidate.experience_years 改名后才完全自洽)                                                                                                    |
| 17  | `degree_requirement`               | string     | `degree_requirement`                        | String     | —                                              | ✅                                                                                                                                             |
| 18  | `education_requirement`            | string     | `education_requirement`                     | String     | —                                              | ✅                                                                                                                                             |
| 19  | `interview_mode`                   | string     | `interview_mode`                            | String     | —                                              | ✅                                                                                                                                             |
| 20  | `expected_level`                   | string     | `expected_level`                            | String     | **命名模糊**(指岗位职级)                                | 🟠 Allmeta 改名 `expected_level → target_job_level`                                                                                             |
| 21  | `recruitment_type`                 | string     | `recruitment_type`                          | String     | —                                              | ✅                                                                                                                                             |
| 22  | (L1 用 `publish_date`)              | string     | `open_date`                                 | Date       | **字段名分歧**                                      | 🟠 Allmeta 改名 `open_date → publish_date`(行业用法 + RAAS 也用 publish)                                                                              |
| 23  | (L1 用 `expected_arrival_date`)     | string     | `required_arrival_date`                     | Date       | **字段名分歧**(required 太强)                         | 🟠 Allmeta 改名 `required_arrival_date → expected_arrival_date`                                                                                 |


### AO 投影丢弃的 RAAS 字段(L2→L3 mapper 不写)


| 类别           | 字段示例                                                                                                                                    | 为什么不写                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 流程动态状态(11 项) | `status / hc_status / jd_status / analysis_status / priority / headcount_filled / our_application_count / completion_time / created_at` | DataObject 存"事实",状态变化用 Event 流追,不污染 ontology |
| 客户身份冗余(5 项)  | `client_name / client_code / csi_department_name`                                                                                       | Allmeta 走 FK 链(client_id → Client),不冗余字符串    |
| 人员分配冗余(8 项)  | `assigned_hsm_name / assigned_recruiter_name / first_interviewer_name / contract_`*                                                     | 同上,走 FK→Employee                             |


### Allmeta 独有(partner workflow 填)


| Allmeta 字段                          | 类型                            | 处理                                                             |
| ----------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| `csi_department_id`                 | String (FK)                   | ⚪ partner 填 — 同时建议 🟠 改名 `recruiting_department_id`(去掉租户名 csi) |
| `standard_job_role_id`              | String (FK→Standard_Job_Role) | ⚪ partner 填                                                    |
| `evaluation_model_id`               | String (FK→Evaluation_Model)  | ⚪ partner 配                                                    |
| `client_job_temp_id`                | String                        | ⚪ 线下开拓临时号                                                      |
| `client_job_type`                   | String                        | ⚪ partner 填                                                    |
| `job_type`                          | String                        | ⚪ partner 填(产品运营/软件测试)                                         |
| `gender`                            | String                        | ⚪ 岗位性别要求 partner 填                                             |
| `age_range`                         | String                        | ⚪ partner 填                                                    |
| `work_address`                      | List                          | ⚪ partner 填(具体地址)                                              |
| `hc_status`                         | String                        | ⚪ workflow 算 — 同时建议 🟠 改名 `headcount_status`(去缩写)              |
| `fill_difficulty` / `urgency_level` | String                        | ⚪ AI 分析后产出                                                     |
| `work_schedule_type`                | String                        | ⚪ partner 填                                                    |
| `require_foreigner`                 | Boolean                       | ⚪ partner 填                                                    |
| `clarify_questions`                 | List                          | ⚪ AI 澄清 agent 产出                                               |
| `recruitment_strategies`            | String                        | ⚪ AI 策略 agent 产出                                               |
| `interview_process`                 | String                        | ⚪ partner 填                                                    |


---

## 5. Candidate_Match_Result

### AO 实例(23+ 字段,来自 `MatchPassedNeedInterviewData` 平铺 RoboHire `/match-resume` data)


| #   | AO 字段                                         | AO 类型                                                          | Allmeta 字段                             | Allmeta 类型 | 差异                          | 对齐方案                                                                       |
| --- | --------------------------------------------- | -------------------------------------------------------------- | -------------------------------------- | ---------- | --------------------------- | -------------------------------------------------------------------------- |
| 1   | (RAAS 写时分配)                                   | —                                                              | `candidate_match_result_id` (PK)       | String     | —                           | ✅                                                                          |
| 2   | `upload_id`(anchor)                           | string                                                         | (无)                                    | —          | L3 通过 candidate_id 关联       | ⚪ AO 用 upload_id 让 RAAS 反查,不需要进 L3                                         |
| 3   | `job_requisition_id` (anchor)                 | string                                                         | `job_position_id` (FK→Job_Requisition) | String     | **命名孤儿**(没 Job_Position 对象) | 🟠 Allmeta 改名 `job_position_id → job_requisition_id`(L3 内部统一)              |
| 4   | (RAAS 关联)                                     | —                                                              | `candidate_id` (FK)                    | String     | —                           | ✅                                                                          |
| 5   | (RAAS 关联)                                     | —                                                              | `client_id` (FK)                       | String     | —                           | ✅                                                                          |
| 6   | `data.matchScore`                             | number                                                         | (无)                                    | —          | **L3 缺关键 metric**           | 🟠 Allmeta 加 `match_score: Float`                                          |
| 7   | `data.recommendation`                         | 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH' | (无,有 `result: String "匹配/不匹配/待定"`)     | —          | **粒度不同**(4 档 vs 3 档)        | 🟠 Allmeta 加 `recommendation: String`(保留 4 档原值);`result` 保留(L3 中文标签给 UI 用) |
| 8   | `data.summary`                                | string                                                         | `reason`                               | String     | **字段名分歧**                   | 🟡 AO 改名 `summary → reason` 写入(L3 reason 命名更准)                             |
| 9   | `data.matchAnalysis`                          | Object                                                         | (无)                                    | —          | 大 JSON                      | 🟠 进 `match_breakdown_json: String`(下条)                                    |
| 10  | `data.mustHaveAnalysis`                       | Object                                                         | (无)                                    | —          | 同上                          | 同上                                                                         |
| 11  | `data.niceToHaveAnalysis`                     | Object                                                         | (无)                                    | —          | 同上                          | 同上                                                                         |
| 12  | `data.resumeAnalysis`                         | Object                                                         | (无)                                    | —          | 同上                          | 同上                                                                         |
| 13  | `data.jdAnalysis`                             | Object                                                         | (无)                                    | —          | 同上                          | 同上                                                                         |
| 14  | `data.skillMatch / skillMatchScore`           | Object | number                                                | (无)                                    | —          | 同上                          | 同上                                                                         |
| 15  | `data.experienceMatch / experienceValidation` | Object                                                         | (无)                                    | —          | 同上                          | 同上                                                                         |
| 16  | `data.candidatePotential`                     | Object                                                         | (无)                                    | —          | 同上                          | 同上                                                                         |
| 17  | `data.transferableSkills`                     | unknown[]                                                      | (无)                                    | —          | **可结构化用**                   | 🟠 Allmeta 加 `transferable_skills: List<String>`(从这条 pluck)                |
| 18  | `data.experienceBreakdown`                    | Object                                                         | (无)                                    | —          | 大 JSON                      | 进 match_breakdown_json                                                     |
| 19  | `data.hardRequirementGaps`                    | unknown[]                                                      | (无)                                    | —          | **可结构化用**                   | 🟠 Allmeta 加 `must_have_gaps: List<String>`(从这条 pluck — 做"硬条件不达标"筛选)       |
| 20  | `data.overallMatchScore / overallFit`         | Object | number                                                | (无)                                    | —          | 大 JSON                      | 进 match_breakdown_json                                                     |
| 21  | `data.recommendations`                        | Object                                                         | (无)                                    | —          | 同上                          | 同上                                                                         |
| 22  | `data.suggestedInterviewQuestions`            | Object                                                         | (无)                                    | —          | 同上                          | 同上                                                                         |
| 23  | `data.areasToProbeDeeper`                     | unknown[]                                                      | (无)                                    | —          | 同上                          | 同上                                                                         |
| 24  | `data.preferenceAlignment`                    | Object                                                         | (无)                                    | —          | 同上                          | 同上                                                                         |
| 25  | `data.candidateSummary`                       | Object                                                         | (无)                                    | —          | 同上                          | 同上                                                                         |
| 26  | (RoboHire data 整体)                            | Object                                                         | (无)                                    | —          | 21+ 字段无对应                   | 🟠 Allmeta 加 `match_breakdown_json: String` 装整段 RoboHire data              |
| 27  | `requestId` (= robohire_request_id)           | string                                                         | (无)                                    | —          | 跨服务 trace                   | 🟠 Allmeta 加 `raas_match_request_id: String`                               |
| 28  | (mapper 加 timestamp)                          | string                                                         | (无)                                    | —          | 决策时间                        | 🟠 Allmeta 加 `decided_at: Timestamp`                                       |


### Rule-check 审计字段(AO 自创,L3 完全没)


| AO 字段                    | 类型              | 来源                                        | Allmeta 字段    | 对齐方案                                                             |
| ------------------------ | --------------- | ----------------------------------------- | ------------- | ---------------------------------------------------------------- |
| `rule_check_audit_id`    | string          | rule-check pipeline                       | (无)           | 🟠 Allmeta 加 `rule_check_audit_id: String`(partner UI "为啥不通过"必备) |
| `rule_check_decision`    | 'PASS' | 'FAIL' | rule-check pipeline                       | (无)           | 🟠 Allmeta 加 `rule_check_decision: String`                       |
| `failure_reason_codes`   | string[]        | rule-check pipeline(如 `["10-5", "12-3"]`) | (无)           | 🟠 Allmeta 加 `failure_reason_codes: List<String>`(结构化筛选)         |
| `rules_evaluated_count`  | number          | rule-check pipeline                       | (无)           | ⚪ AO 内部 metric,不进 ontology                                       |
| `terminal_rule_hits`     | string[]        | rule-check pipeline                       | (无)           | ⚪ 同上                                                             |
| `final_decision`         | 'PASS' | 'FAIL' | AO 综合(rule + match + 人工)                  | (无)           | ⚪ 同上 — `result` 字段已经能表达                                          |
| `final_decision_reason`  | string          | 同                                         | (无,但有 reason) | 🟡 AO mapper 把 final_decision_reason 当 reason 写(同 #8)            |
| `parent_match_result_id` | string          | 重判谱系                                      | (无)           | ⚪ AO 内部 audit log,不进 ontology                                    |


---

## 6. 改动汇总(按表方向统计)


| DataObject             | 对齐前 AO 字段                        | 对齐前 Allmeta 字段 | AO 改动(🟡)                                   | Allmeta 改动(🟠)                 | 双方改动(🔵)                                                  |
| ---------------------- | -------------------------------- | -------------- | ------------------------------------------- | ------------------------------ | --------------------------------------------------------- |
| Candidate              | 11                               | 28             | 1(删 skills + RuntimeNested)                 | 改名 3 + 加 2                     | 0                                                         |
| Candidate_Expectation  | 6                                | 9              | 0                                           | 改名 3 + 拆 1(净 +2) + 加 1         | 1(expected_roles → expected_positions)                    |
| Resume                 | 5 + 上传层 6                        | 21             | 1(skills_extracted → skill_tags)+ 1(URI 拼接) | 改名 3 + 加 2                     | 3(work/education/project _experience → _history + AO 序列化) |
| Job_Requisition        | ~19 写入                           | 39             | mapper 1(投影丢弃 24 字段)                        | 改名 5 + 改类型 1 + 拆 1             | 0                                                         |
| Candidate_Match_Result | 23+ (RoboHire 透传) + rule-check 8 | 6              | 1(summary → reason)                         | 改名 1 + 加 10                    | 0                                                         |
| **合计**                 | —                                | —              | **5 处 mapper**                              | **改名 15 + 改类型 1 + 拆 2 + 加 17** | **4 处双改**                                                 |


---

## 7. 一图速查 — Leader 关注的"命名不好"21 条


| #   | DataObject             | Allmeta 当前                      | 改成                                                           | 类型            |
| --- | ---------------------- | ------------------------------- | ------------------------------------------------------------ | ------------- |
| 1   | Candidate              | `experience_years`              | `work_years`                                                 | 改名(与 JR 自洽)   |
| 2   | Candidate              | `marital_fertility_status`      | `family_status`                                              | 改名(行业用法)      |
| 3   | Candidate              | `conflict_interest_declaration` | `conflict_of_interest_declaration`                           | 改名(英文通顺)      |
| 4   | Candidate              | (无)                             | `current_company` / `current_title`                          | 加字段(高频展示)     |
| 5   | Candidate_Expectation  | `expected_position` (String 单数) | `expected_positions: List<String>`                           | 改名 + 改类型      |
| 6   | Candidate_Expectation  | `expected_location` (String 单数) | `expected_locations: List<String>`                           | 改名 + 改类型      |
| 7   | Candidate_Expectation  | `expected_industry` (String 单数) | `expected_industries: List<String>`                          | 改名 + 改类型      |
| 8   | Candidate_Expectation  | `expected_salary_range: String` | `expected_salary_monthly_min/max: Float` + `salary_currency` | 拆字段(数值化)      |
| 9   | Candidate_Expectation  | (无 work_mode)                   | `expected_work_mode: String`                                 | 加字段           |
| 10  | Resume                 | `work_experience`               | `work_history`                                               | 改名(命名达意)      |
| 11  | Resume                 | `education_experience`          | `education_history`                                          | 改名            |
| 12  | Resume                 | `project_experience`            | `project_history`                                            | 改名            |
| 13  | Resume                 | (无 summary)                     | `summary: String`                                            | 加字段           |
| 14  | Resume                 | (无 upload_id)                   | `upload_id: String`                                          | 加字段(MinIO 主键) |
| 15  | Job_Requisition        | `open_date`                     | `publish_date`                                               | 改名(行业用法)      |
| 16  | Job_Requisition        | `required_arrival_date`         | `expected_arrival_date`                                      | 改名(语气)        |
| 17  | Job_Requisition        | `csi_department_id`             | `recruiting_department_id`                                   | 改名(去租户名)      |
| 18  | Job_Requisition        | `hc_status`                     | `headcount_status`                                           | 改名(去缩写)       |
| 19  | Job_Requisition        | `expected_level`                | `target_job_level`                                           | 改名(去歧义)       |
| 20  | Job_Requisition        | `city: String`                  | `city: List<String>`                                         | 改类型(多地点)      |
| 21  | Candidate_Match_Result | `job_position_id`               | `job_requisition_id`                                         | 改名(去孤儿命名)     |


---

## 8. 关联文档


| 文档                                                                                      | 用途                                     |
| --------------------------------------------------------------------------------------- | -------------------------------------- |
| [docs/ao-runtime-vs-allmeta-alignment-v2.md](./ao-runtime-vs-allmeta-alignment-v2.md)     | 对齐方案完整版(含 L1/L2/L3 三层模型 + 双向选项 + 实施顺序) |
| **本文**                                                                                  | ★ 字段对照速查表(单表式)                         |
| [docs/ao-runtime-vs-allmeta-dataobject-gap.md](../ao-runtime-vs-allmeta-dataobject-gap.md) | 旧版(L1 vs L3,已被 v2 取代)                  |


