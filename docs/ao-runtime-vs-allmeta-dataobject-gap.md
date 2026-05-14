# AO 运行 schema ↔ Allmeta DataObject schema — 对比分析

> **目的**:对比 AO 端实际跑出来的"出/入参数 schema"和 Allmeta DataObject 声明的字段,给出双向改动选项,让决策方按取舍判断"哪边改更合理"。
>
> **每个字段差异都给两个选项**:
> 1. **AO 端改**(写个 mapping 层把 AO 字段名转 Allmeta 字段名)
> 2. **Allmeta 端改**(改 DataObject properties_json,影响所有 consumer)
> + 标注 ★ 推荐项 + 理由
>
> 来源数据:
> - AO 出参:`parsed_resume.data`(RoboHire 真实返回 29 字段)、`getRequirementDetail` JR(RAAS 真实返回 64 字段)、`writeCandidateMatchResult` 入参(AO 业务定义 15 字段)
> - Allmeta 现状:`GET /api/v1/ontology/objects/{label}?domain=RAAS-v1` 返回的 `properties_json`

---

## 决策框架(给每个字段差异打分)

| 维度 | "AO 改"代价 | "Allmeta 改"代价 |
|---|---|---|
| 改动范围 | AO 一处 mapping(`lib/allmeta-client.ts` 已经在做)| 影响所有 consumer(AO + partner 仪表盘 + 其他将来接入的 agent)|
| 数据源约束 | RoboHire / RAAS 返回的字段名是 vendor schema,AO **改不了源头** | Allmeta 是我们自己 ontology,可控 |
| 命名权威性 | AO 字段名常常来自 vendor(可能是行业俗称)| Allmeta 字段名是经过 ontology 设计的(可能更规范)|
| 语义清晰度 | AO 字段名通常更生活化(`marital_status`)| Allmeta 字段名通常更明确(`marital_fertility_status` 强调含育)|
| 维护成本 | mapping 表一份,RoboHire/RAAS 改字段时 AO 跟改 | properties_json 改一处全平台对齐 |

**通则**:
- **vendor 源头字段名** → ★ Allmeta 改(AO 改不了源头,加 mapping 反而维护负担)
- **AO 自创字段名** → 看哪边命名更好,通常 ★ AO 改(我们说了算就让 ontology 主导)
- **语义偏差**(同名但含义不同)→ ★ 两边都明确化,加一个新字段而不是改名

---

## 1. Candidate

### 1.1 AO 字段现状(29,来自 RoboHire `POST /parse-resume`)

```
name, gender, nationality, birth_date, email, phone, address,
marital_status, conflict_of_interest_declaration (Object),
expected_salary_range, willing_to_outsource_employment, summary,
education[], experience[], skills (Object), certifications[], languages[],
awards[], patents[], projects[], publications[], volunteerWork[],
linkedin, github, portfolio,
rawText, documentId, cached, savedAs, otherSections
```

来源:**RoboHire vendor schema**,29 字段里 23 是行业通用字段名,6 是 RoboHire 内部字段(`documentId`、`cached`、`savedAs`、`otherSections`、`rawText`、`patents`)。

### 1.2 Allmeta Candidate DataObject(28 字段)

```
candidate_id, employee_id (FK→Employee), is_locked, lock_start_time, referrer_employee_id (FK),
id_number, name, nationality, gender, birth_date,
mobile, email, current_location,
highest_acquired_degree, unified_enrollment, experience_years,
flight_risk_level, max_salary_limit, status, state, blacklist_status,
marital_fertility_status, conflict_interest_declaration (String),
conflict_clearance_deadline, gap_reason,
previous_level, expected_degree, expected_graduation_date
```

来源:陈洋的 ontology 设计 — 偏向 RAAS 业务字段(employee_id / is_locked / flight_risk_level / blacklist_status),HR 业务化命名(`marital_fertility_status` 含育语义)。

### 1.3 字段差异 + 双向选项

| AO 字段 | Allmeta 字段 | 差异 | 选项 A:AO 改 | 选项 B:Allmeta 改 | ★ 推荐 | 理由 |
|---|---|---|---|---|---|---|
| `phone` | `mobile` | 字段名 | AO mapping 加 `phone → mobile` 转换 | Allmeta `mobile → phone` | **★ AO 改** | `mobile` 是国际通用名(招聘行业更标准),Allmeta 命名权威性 |
| `address` | `current_location` | 字段名 | AO `address → current_location` | Allmeta `current_location → address` | **★ AO 改** | `current_location` 更准确(候选人可能多地址),Allmeta 命名好 |
| `marital_status` | `marital_fertility_status` | 字段名 + 语义略不同 | AO `marital_status → marital_fertility_status` | Allmeta `marital_fertility_status → marital_status` | **★ AO 改** | Allmeta 含"育龄"语义更精确,业务上"婚育"是一个组合判定;AO 跟 RoboHire 字段名是行业通用但偏窄 |
| `conflict_of_interest_declaration` (Object) | `conflict_interest_declaration` (String) | 字段名 **+ 类型不同** | AO 把 Object JSON.stringify + 改名 | Allmeta 改名 + 类型 → Object | **★ 两端协调** | 字段名 → Allmeta 加 `of`(`conflict_of_interest_declaration` 更易懂)· 类型 → AO 序列化成 String(Neo4j 不存 nested object,迟早要序列化)|
| `expected_salary_range` | (无,但 `Candidate_Expectation` DataObject 有)| AO 放在 Candidate,Allmeta 想分离到 Expectation | AO 写 Allmeta 时拆到 Candidate_Expectation | Allmeta 给 Candidate 加同名字段 | **★ AO 改** | ontology 拆 Candidate / Candidate_Expectation 设计合理(候选人多份期望可能不同),AO 写时拆 |
| `willing_to_outsource_employment` | (无,Candidate_Expectation 有 `outsourcing_acceptance_level`)| 字段名 + 类型(Bool vs String) | AO 写 Allmeta 时改名 + 改类型 | Allmeta `outsourcing_acceptance_level → willing_to_outsource_employment: Boolean` | **★ AO 改** | Allmeta 用 enum String("accept"/"reject"/"neutral")信息量更大(AO 现在只 true/false 太粗),适应 ontology |
| `summary` | (无)| AO 有 Allmeta 没 | ❌(AO 已经在用)| Allmeta 加 `summary: String` | **★ Allmeta 加** | 简历摘要是基本字段,缺失是 ontology 遗漏 |
| `education` (List<Object>) | (无,在 Resume.education_experience 是 String)| 位置 + 类型 | AO 把 education 序列化成 Resume.education_experience | Allmeta Candidate 加 `education_json` | **★ AO 改** | ontology 把履历放 Resume 节点设计合理,AO 序列化即可 |
| `experience` (List<Object>) | 同上 | 同上 | AO 序列化成 Resume.work_experience | Allmeta Candidate 加 `experience_json` | **★ AO 改** | 同上 |
| `skills` (Object: technical/soft/...) | (在 Resume.skill_tags List<String>) | 结构差异 | AO flatten 成 string[] 进 Resume.skill_tags | Allmeta Candidate 加 `skills_json: String` | **★ AO 改** | 大部分使用场景只需要 flat 标签,Resume.skill_tags 设计够用 |
| `certifications` (List<Object>) | (在 Resume.certificate String)| 位置 + 类型 | AO 序列化进 Resume.certificate | Allmeta 加 list 字段 | **★ AO 改** | 同上 |
| `languages` (List)| (在 Resume.language_skills String)| 位置 + 类型 | AO `.join(', ')` 进 Resume.language_skills | Allmeta 改 list | **★ AO 改** | 同上 |
| `linkedin` / `github` / `portfolio` | (无)| AO 有 Allmeta 没 | ❌ | Allmeta 加 3 个 String 或合并 `online_profiles_json` | **★ Allmeta 加** | 是简历常见字段,ontology 该有 |
| `awards` / `patents` / `projects` / `publications` / `volunteerWork` | (无)| AO 有 Allmeta 没 | AO 合并序列化进现有字段(如 summary 附加)| Allmeta 加 `additional_sections_json` 1 个总字段 | **★ Allmeta 加 1 字段** | 这些低用率,合并成 1 个 JSON 字段(`additional_sections_json`)装这 5 类,ontology 不用为每个低用率字段单加 |
| `rawText` / `documentId` / `cached` / `savedAs` / `otherSections` | (无)| AO 有,**纯 RoboHire 内部字段** | AO mapping 时丢弃(strict validation 自然过滤即可)| (Allmeta 不该加这些 vendor 内部字段) | **★ AO 端丢弃** | 这些是 RoboHire 解析过程的内部 metadata,不属于业务实体的 ontology 字段 |
| Allmeta `id_number` | AO 不发(PII 已脱敏)| Allmeta 有 AO 没 | (无操作)| (保留)| ★ 保留 | id_number 留给 partner / hsm UI 填,AO 不传无影响 |
| Allmeta `employee_id / is_locked / flight_risk_level / blacklist_status / ...` 11 个 | AO 不发 | Allmeta 有 AO 没 | (无操作)| 保留 | ★ 保留 | RAAS 业务字段,partner workflow 填,AO 不传无影响 |

### 1.4 Candidate 总改动

| 谁 | 改动 | 数量 |
|---|---|---|
| **AO**(写 mapping 层,在 `lib/allmeta-client.ts` 加翻译表)| `phone→mobile` · `address→current_location` · `marital_status→marital_fertility_status` · `willing_to_outsource_employment(bool)→outsourcing_acceptance_level(string)` · `expected_salary_range` 拆到 Candidate_Expectation · `education[]→Resume.education_experience(String)` · `experience[]→Resume.work_experience` · `skills→Resume.skill_tags` · `certifications→Resume.certificate` · `languages→Resume.language_skills` · 丢弃 vendor 内部 5 字段 | 10 处 mapping |
| **Allmeta**(改 properties_json)| 改名 `conflict_interest_declaration → conflict_of_interest_declaration` · 加 `summary` `linkedin` `github` `portfolio` `additional_sections_json` | 1 改名 + 5 新增 |

---

## 2. Resume

### 2.1 AO 实际写 Resume 字段

AO `lib/rule-check/neo4j-instance-writer.ts` 现在写的:`resume_id / candidate_id / work_experience(序列化) / education_experience(序列化) / skill_tags / language_skills / is_original`。再加 `upload_id`(MinIO 文件关联,Allmeta 没字段)。

### 2.2 Allmeta Resume(21 字段)

跟 AO 期望写的字段**基本对得上**,只缺 `upload_id`。

### 2.3 字段差异

| AO 字段 | Allmeta 字段 | 选项 A:AO 改 | 选项 B:Allmeta 改 | ★ 推荐 |
|---|---|---|---|---|
| `upload_id` | (无)| AO 不写,改用 file_path 字段塞 MinIO URI | Allmeta 加 `upload_id: String` | **★ Allmeta 加** | upload_id 是 MinIO 的稳定主键,跟 file_path(URI)语义不同 |

其他全对得上。

### 2.4 Resume 总改动

| 谁 | 改动 |
|---|---|
| **AO** | 0(已经在 `lib/rule-check/neo4j-instance-writer.ts` 序列化好了)|
| **Allmeta** | 加 1 字段 `upload_id` |

---

## 3. Job_Requisition

### 3.1 AO 实际拿到 JR 字段(64,RAAS `GET /requirements/:id` 返回)

来源:**RAAS API vendor schema** — partner 的字段定义,AO 改不了。但 AO **不一定要全写进 Allmeta**(很多字段是流程状态 / 申请数等运营元信息,跟"招聘岗位"实体本质无关)。

### 3.2 Allmeta JR(39 字段)

陈洋的 ontology 设计 — 偏向"岗位本质"语义(jobResponsibility / mustHaveSkills / workYears / city)。

### 3.3 差异分析(逐字段太长,按用途分类)

| AO 字段类别 | Allmeta 有? | 选项 | ★ 推荐 |
|---|---|---|---|
| **核心岗位语义**(17 项): `client_job_title / client_job_type / job_responsibility / job_requirement / job_type / recruitment_type / work_years / city / work_address / salary_range / must_have_skills / nice_to_have_skills / language_requirements / interview_mode / expected_level / age_range / degree_requirement` | ✅ 全有 | 直接对得上 | ★ 无改动 |
| **客户身份**(5 项): `client_id / client_name / client_code / csi_department_name` 等 | ❌ Allmeta 通过 FK 链到 Client / Client_Department DataObject | A: AO 不写,只写 FK · B: Allmeta 加冗余字段 | **★ AO 改 — 写 FK 即可** · client_id 已经在 Candidate_Match_Result 是 FK,JR 也可以走 FK + Allmeta GET 时 JOIN |
| **人员分配**(8 项): `hsm_employee_id / assigned_hsm_name / recruiter_employee_id / assigned_recruiter_name / create_by / first_interviewer_name / final_interviewer_name / contract_*` | ❌ 部分有 FK 但没冗余字段 | A: AO 不写 · B: Allmeta 加冗余 | **★ AO 改 — 走 FK→Employee 即可** |
| **流程状态**(11 项): `status / hc_status / jd_status / analysis_status / priority / headcount_filled / our_application_count / competitor_application_count / number_of_competitors / analysis_version / analysis_updated_at / completion_time / publish_date / start_date / expected_arrival_date / deadline / create_time / created_at` | ❌ Allmeta 不存这些"动态状态" | A: AO 不写 · B: Allmeta 加状态字段 | **★ AO 改** · ontology 节点存"事实",状态变化用 Event 流追,不进 DataObject |
| **重命名**: AO `publish_date` vs Allmeta `open_date` · AO `expected_arrival_date` vs Allmeta `required_arrival_date` | 都有,字段名不同 | A: AO mapping 改名 · B: Allmeta 改名 | **★ Allmeta 改** · `publish_date` / `expected_arrival_date` 更通用,RAAS 也是这俩名字 |
| **Allmeta 独有字段**(9 项): `evaluation_model_id / client_job_temp_id / negative_requirement / fill_difficulty / urgency_level / work_schedule_type / clarify_questions / recruitment_strategies / job_requisition_specification_id` | Allmeta 有 AO 没 | (保留)| ★ 保留 · partner workflow 填 |

### 3.4 JR 总改动

| 谁 | 改动 |
|---|---|
| **AO** | mapping:不写流程状态 11 项 / 不写客户身份 5 项 / 不写人员分配 8 项 → AO 写 17 个核心字段 + FK,**所有 vendor 字段经 mapping 投影后只写跟 ontology 对应的部分** |
| **Allmeta** | 改 2 字段名:`open_date → publish_date` · `required_arrival_date → expected_arrival_date` |

---

## 4. Candidate_Match_Result

### 4.1 AO 实际写 Match_Result 入参(15)

```
candidate_match_result_id (PK, "cmr_<audit_id>")
candidate_id, job_requisition_id, client_id
rule_check_audit_id, rule_check_decision, failure_reason_codes (List), rules_evaluated_count, terminal_rule_hits (List)
match_score, match_recommendation, match_breakdown_json, raas_match_request_id
final_decision, final_decision_reason, decided_at, parent_match_result_id
```

这是 **AO 自创 schema**(AO 业务定义,源头就是 AO 自己写的 writer 函数签名),所以"AO 改"代价低。

### 4.2 Allmeta Match_Result(6 字段)

```
candidate_match_result_id, client_id, candidate_id, job_position_id, result, reason
```

陈洋的 ontology 设计 — 偏向"最终结论":`result` 中文标签("匹配"/"不匹配"/"待定")+ `reason` 自由文本。

### 4.3 字段差异 + 双向选项

| AO 字段 | Allmeta 字段 | 差异 | 选项 A:AO 改 | 选项 B:Allmeta 改 | ★ 推荐 |
|---|---|---|---|---|---|
| `candidate_match_result_id` | ✅ | 同 | — | — | 无 |
| `client_id` / `candidate_id` | ✅ | 同 | — | — | 无 |
| `job_requisition_id` | `job_position_id` | 字段名 | AO mapping `job_requisition_id → job_position_id` | Allmeta `job_position_id → job_requisition_id` | **★ Allmeta 改** · 其他所有 DataObject 都用 `job_requisition_id`,Allmeta 这个名字是历史遗留(`job_position` 在 ontology 别处不出现)|
| `final_decision_reason` | `reason` | 字段名 | AO `final_decision_reason → reason` | Allmeta `reason → final_decision_reason` | **★ AO 改** · `reason` 更简洁(reason 字段在其他 ontology 处也用);AO 这边 `final_decision_reason` 是冗长版,改 mapping 即可 |
| `final_decision` (PASS/FAIL) | `result` ("匹配"/"不匹配"/"待定") | **语义不同** | AO writer 输出时同时填 `final_decision` 和 `result` 两个值 | Allmeta 改 `result` 类型 PASS/FAIL 英文 | **★ AO 改 — 同时填两个** · 两个字段语义不重叠:`result` 给中文 UI / report 用,`final_decision` 给程序判断。AO writer 加一个 `result` 中文映射输出 |
| `rule_check_audit_id` | (无)| AO 有 | (无操作)| Allmeta 加 `rule_check_audit_id: String` | **★ Allmeta 加** · audit 谱系必备 |
| `rule_check_decision` (PASS/FAIL) | (无)| AO 有 | (无操作)| Allmeta 加 | **★ Allmeta 加** · 跟 final_decision 分离的语义(rule-check 阶段独立结论 vs 综合决策)|
| `failure_reason_codes` (List)| (无)| AO 有 | AO 写成 `reason` 字段 join 字符串 | Allmeta 加 List<String> | **★ Allmeta 加** · 结构化查询需要(`MATCH WHERE "10-5" IN failure_reason_codes`)|
| `rules_evaluated_count` | (无)| AO 有 | (无操作)| Allmeta 加 Integer | **★ Allmeta 加** · 审计 metric |
| `terminal_rule_hits` (List)| (无)| AO 有 | AO 不写 | Allmeta 加 List<String> | **★ Allmeta 加** · 同 failure_reason_codes |
| `match_score` (Float)| (无)| AO 有 | (无操作)| Allmeta 加 Float | **★ Allmeta 加** · Robohire 评分是核心数据 |
| `match_recommendation` | (无)| AO 有 | (无操作)| Allmeta 加 String | **★ Allmeta 加** |
| `match_breakdown_json` | (无)| AO 有 | (无操作)| Allmeta 加 String | **★ Allmeta 加** |
| `raas_match_request_id` | (无)| AO 有 | (无操作)| Allmeta 加 String | **★ Allmeta 加** · 跟 RAAS API 日志关联 |
| `decided_at` | (无)| AO 有 | (无操作)| Allmeta 加 Timestamp | **★ Allmeta 加** |
| `parent_match_result_id` (FK 自引用)| (无)| AO 有 | (无操作)| Allmeta 加 String + FK→Candidate_Match_Result | **★ Allmeta 加** · 补全后重判谱系必备 |

### 4.4 Match_Result 总改动

| 谁 | 改动 | 数量 |
|---|---|---|
| **AO**(`lib/rule-check/neo4j-match-result-writer.ts`)| `final_decision_reason → reason`(mapping)· 加 result 中文映射(PASS→"匹配", FAIL→"不匹配")| 2 处 |
| **Allmeta**(properties_json)| 改名 `job_position_id → job_requisition_id` · 加 11 字段 | 1 改名 + 11 新增 |

---

## 5. 总汇:谁改多少

| DataObject | AO 改动数 | Allmeta 改动数 |
|---|---|---|
| Candidate | 10 处 mapping | 1 改名 + 5 加字段 |
| Resume | 0 | 1 加字段 |
| Job_Requisition | mapping 投影 28 字段(不写) | 2 改名 |
| Candidate_Match_Result | 2 处 mapping | 1 改名 + 11 加字段 |
| **合计** | **~12 处 mapping(AO 加一个 alias.ts)** | **4 改名 + 18 加字段** |

---

## 6. 各方决策对比表

| 维度 | "AO 主改"路线 | "Allmeta 主改"路线 | 混合(★ 推荐)|
|---|---|---|---|
| 改 vendor 字段名 | ❌ 改不了源头(RoboHire/RAAS) | ✅ ontology 跟随 vendor 命名 | 部分按 vendor 命名(Allmeta 改)|
| 改 AO 自创字段名 | ✅ 我们说了算 | ❌ 让 ontology 主导 | ★ 看哪边命名更合理 |
| ontology 设计权 | 弱(AO 决定全部)| 强(ontology 决定全部)| ★ ontology 主导核心结构,vendor 命名优先具体字段 |
| 维护成本 | 高(每次 vendor 改字段 AO 跟改 mapping)| 低 | ★ mapping 表锁定在 vendor 表面,中等 |

---

## 7. ★ 推荐总方案

### AO 端建 `lib/allmeta-field-mapper.ts`

负责把 AO 原 schema 翻译到 Allmeta DataObject 字段名:

```typescript
export const CANDIDATE_FIELD_MAP: Record<string, string> = {
  // AO key (RoboHire) → Allmeta DataObject key
  phone: 'mobile',
  address: 'current_location',
  marital_status: 'marital_fertility_status',
  // 拆字段
  expected_salary_range: '__candidate_expectation__',  // 写到另一个 DataObject
  willing_to_outsource_employment: '__candidate_expectation__',
  // 序列化嵌套
  education: '__resume.education_experience__',
  experience: '__resume.work_experience__',
  skills: '__resume.skill_tags__',
  certifications: '__resume.certificate__',
  languages: '__resume.language_skills__',
  // 类型转换 + 改名
  conflict_of_interest_declaration: 'conflict_of_interest_declaration',  // ★ Allmeta 改名后,AO 直接对得上 + JSON.stringify
  // 丢弃
  rawText: null,
  documentId: null,
  cached: null,
  savedAs: null,
  otherSections: null,
};

export const MATCH_RESULT_FIELD_MAP: Record<string, string> = {
  final_decision_reason: 'reason',
  // 其他全用 Allmeta 加的新字段名,1:1 对得上
};

export const JR_FIELD_MAP: Record<string, string> = {
  // AO 收到 RAAS 的 64 字段,只投影 17 个 ontology 核心字段 + 4 FK 字段;其他丢弃
  // 详见 §3
};
```

### Allmeta 端(给陈洋)

**3 改名 + 17 加字段**,详见 §1.4 / §2.4 / §3.4 / §4.4 每节末尾的总改动表。

### 最终对接面

```
RoboHire / RAAS  ──►  AO 原 schema  ──►  AO field mapper  ──►  Allmeta API
                       (现状不动)         (新增,12 处)      (写入按 ontology
                                                            字段名,strict 接受)
```

---

## 8. 实施顺序

| 优先级 | 任务 | 谁 | 预估工时 |
|---|---|---|---|
| **P0** | Allmeta 修 strict validation bug(properties_json 字段也被拒)| 陈洋 | 1-2 小时 |
| **P1** | Allmeta 加 Candidate `summary / linkedin / github / portfolio / additional_sections_json` + 改名 `conflict_interest_declaration → conflict_of_interest_declaration` | 陈洋 | 30 分钟 |
| **P1** | Allmeta 加 Candidate_Match_Result 11 字段 + 改名 `job_position_id → job_requisition_id` | 陈洋 | 30 分钟 |
| **P2** | Allmeta 加 Resume `upload_id` + 改 JR 2 个字段名 | 陈洋 | 30 分钟 |
| **P2** | AO 写 `lib/allmeta-field-mapper.ts` + 用到 instance-writer / match-result-writer | Steven | 2-3 小时 |
| **P3** | 联调 e2e:江银行 → 写入 Allmeta → drawer UI 显示完整 Candidate / Match_Result | 双方 | 1 小时 |

---

## 9. 文档关系

| 文档 | 范围 |
|---|---|
| **本文** [docs/ao-runtime-vs-allmeta-dataobject-gap.md](ao-runtime-vs-allmeta-dataobject-gap.md) | ★ **双向对比 + 每字段双选项**(本文)|
| [docs/ontology-schema-changes-for-chenyang.md](ontology-schema-changes-for-chenyang.md) | 旧版,只推 Allmeta 改 |
| [docs/full-event-chain-end-to-end.md](full-event-chain-end-to-end.md) | 全链路事件流 + API 调用细节 |
| Allmeta API doc | `~/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md` |
