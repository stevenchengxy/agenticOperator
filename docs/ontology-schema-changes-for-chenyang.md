# Ontology DataObject Schema 改动建议 — 给陈洋(Allmeta)

> 基于 AO 运行时实际数据 + Neo4j 实例对比 ontology DataObject 定义,发现 3 个 schema 跟实际跑出来的数据对不齐。本文列具体需要补 / 改的 properties。

- **作者**:Steven(AO 端)
- **日期**:2026-05-13
- **依据**:AO Prisma 22 条 audit · Neo4j 11 个 Candidate · 真实候选人江银行(04bcaedb) → 腾讯 R20260401429 的端到端数据
- **影响范围**:Allmeta ontology DataObject 定义 + 同步到本地 Neo4j 实例图
- **RAAS partner 影响**:几乎为 0 — 见 §5

---

## 1. 当前问题

AO 跑完整条 rule-check + Robohire 链路后:

| ontology DataObject | 实例节点数 | 问题 |
|---|---|---|
| `Candidate` | 11 | ✅ 写入正常,但缺关键 properties(`marital_status` / `former_csi_employment` / `conflict_of_interest_declaration` 等) |
| `Resume` | 11 | ✅ 写入正常,但缺 `has_gap_periods` / `gap_periods_json` |
| `Job_Requisition` | 8 | ✅ 写入正常 |
| **`Candidate_Expectation`** | **0** | ❌ **完全未实例化** — `expected_salary_range` 等字段被错误地扁平写到 Candidate 节点 |
| **`Candidate_Match_Result`** | **0** | ❌ **完全未实例化** — rule-check + Robohire 跑完没存结果 |

根因:
1. AO 端 Neo4j writer 没有 `Candidate_Expectation` / `Candidate_Match_Result` 的写入逻辑(AO 这边会补)
2. ontology DataObject schema 跟 RoboHire 实际产出的字段对不齐(本文请陈洋这边调整)

---

## 2. `Candidate_Expectation` — 改动建议

### 现状(ontology)

```json
[
  {"name": "candidate_expectation_id",        "type": "String"},
  {"name": "candidate_id",                    "type": "String", "is_foreign_key": true, "references": "Candidate"},
  {"name": "expected_position",               "type": "String"},
  {"name": "expected_location",               "type": "String"},
  {"name": "expected_salary_range",           "type": "String"},
  {"name": "outsourcing_acceptance_level",    "type": "String"},
  {"name": "expected_industry",               "type": "String"},
  {"name": "expected_company_size",           "type": "String"},
  {"name": "constraints",                     "type": "List<String>"},
  {"name": "updated_time",                    "type": "Timestamp"}
]
```

### 改动

| 操作 | property | 类型 | 理由 |
|---|---|---|---|
| ✏️ **改名** | `outsourcing_acceptance_level` → `outsourcing_acceptance` | String | RoboHire 实际输出用 `outsourcing_acceptance`,无 `_level` 后缀。改名后跟简历解析自然对齐 |
| ➕ **新增** | `labor_form_preference` | String | 实习/兼职/正式偏好。AO rule 10-11 (劳务形式校验) 已在用 |
| ➕ **新增** | `source` | String | 来源标识:`resume_parsing` / `recruiter_form` / `manual_admin`(便于审计期望从哪来的) |
| 👍 保留 | 其他字段不动 | | |

### 改动后完整 schema

```json
[
  {"name": "candidate_expectation_id", "type": "String",       "description": "候选人求职期望的编号(建议 EXP_<candidate_id>)"},
  {"name": "candidate_id",             "type": "String",       "is_foreign_key": true, "references": "Candidate"},
  {"name": "expected_position",        "type": "String",       "description": "候选人期望从事的职位名称"},
  {"name": "expected_location",        "type": "String",       "description": "候选人期望工作的城市或地区列表"},
  {"name": "expected_salary_range",    "type": "String",       "description": "候选人期望的薪资范围,格式如 '15k-18k'"},
  {"name": "outsourcing_acceptance",   "type": "String",       "description": "候选人对人力资源外包模式的接受程度(枚举:accept/reject/neutral/unknown)"},
  {"name": "labor_form_preference",    "type": "String",       "description": "劳务形式偏好(枚举:full_time/internship/part_time)"},
  {"name": "expected_industry",        "type": "String",       "description": "候选人希望进入的目标行业"},
  {"name": "expected_company_size",    "type": "String",       "description": "候选人期望的企业规模大小"},
  {"name": "constraints",              "type": "List<String>", "description": "限制条件:夜班/轮班/出差/群面接受程度"},
  {"name": "source",                   "type": "String",       "description": "来源:resume_parsing / recruiter_form / manual_admin"},
  {"name": "updated_time",             "type": "Timestamp",    "description": "该期望信息最后一次确认或更新的时间"}
]
```

### 关系

```
(Candidate)-[:HAS_EXPECTATION]->(Candidate_Expectation)
```

---

## 3. `Candidate` — 补字段

### 现状

`Candidate` 已有 `candidate_id / employee_id / is_locked / id_number / name / nationality / gender / birth_date / ...`(完整列表略)。

### 需要补的 properties

AO rule-check 用到这些字段做底线判定,但 ontology 没声明,导致同步时字段会被丢:

| property | 类型 | 描述 | 用在哪条 rule |
|---|---|---|---|
| `marital_status` | String | 婚育情况(未婚/已婚未育/已婚已育/离异)| 10-47(腾讯婚育风险)· 10-36(字节婚育风险)· 10-37(婚育人工管控) |
| `former_csi_employment` | JSON | 中软国际历史从业记录(高风险离场编码)| 10-16, 10-17, 10-18, 10-19, 10-20 |
| `former_tencent_employment` | JSON | 腾讯历史从业记录(正编/外包/工作室)| 10-38, 10-39, 10-40 |
| `has_conflict_of_interest` | Boolean | 是否有亲属在客户单位 | 10-27(腾讯亲属回避)|
| `conflict_of_interest_declaration` | JSON | 亲属回避声明详情(有/无 + 关系 + 声明时间 + source)| 10-27 |

### 建议 JSON schema 片段

```json
[
  {"name": "marital_status",
   "type": "String",
   "description": "婚育情况(枚举:unmarried/married_no_child/married_with_child/divorced)"},
  {"name": "former_csi_employment",
   "type": "JSON",
   "description": "中软国际历史从业记录,数组元素:{ company_branch, employment_type, exit_code, exit_date }"},
  {"name": "former_tencent_employment",
   "type": "JSON",
   "description": "腾讯历史从业记录,数组元素:{ business_group, employment_type(formal/outsourced/studio), exit_type(active/passive), exit_date }"},
  {"name": "has_conflict_of_interest",
   "type": "Boolean",
   "description": "是否有亲属在客户单位"},
  {"name": "conflict_of_interest_declaration",
   "type": "JSON",
   "description": "亲属回避声明详情:{ has_relatives_in_client_company, declared, declared_at, source }"}
]
```

---

## 4. `Resume` — 补字段

### 需要补的 properties

| property | 类型 | 描述 | 用在哪条 rule |
|---|---|---|---|
| `has_gap_periods` | Boolean | 是否存在 >3 个月空窗期 | 10-9, 10-10 |
| `gap_periods_json` | String(serialized JSON)| 空窗期明细:`[{ start_date, end_date, duration_months, reason }]` | 10-9, 10-10 |

(Resume 节点的属性不能直接存 nested map,所以空窗期清单用 JSON 字符串。)

---

## 5. `Candidate_Match_Result` — 改动建议

### 现状(ontology)

```json
[
  {"name": "candidate_match_result_id", "type": "String"},
  {"name": "client_id",                 "type": "String"},
  {"name": "candidate_id",              "type": "String"},
  {"name": "job_position_id",           "type": "String"},
  {"name": "result",                    "type": "String"},
  {"name": "reason",                    "type": "String"}
]
```

### 改动

| 操作 | property | 理由 |
|---|---|---|
| ✏️ **改名** | `job_position_id` → `job_requisition_id` | 跟 ontology 其他 DataObject(Resume / Job_Posting)用的是 `job_requisition_id`,统一命名 |
| ✏️ **改名** | `reason` → `final_decision_reason` | 区分跟其他 `reason` 字段的语义边界(这个是最终结论理由) |
| ➕ **新增 5 个** | rule-check 维度字段 | rule-check 结果信息完全没存在 ontology |
| ➕ **新增 3 个** | Robohire 维度字段 | Robohire 评分结果完全没存 |
| ➕ **新增 3 个** | 决策元信息 | 包括决策时间、谱系(补全后重判)|

### 改动后完整 schema

```json
[
  {"name": "candidate_match_result_id", "type": "String",       "description": "唯一编号,建议格式 cmr_<rule_check_audit_id>"},
  {"name": "candidate_id",              "type": "String",       "is_foreign_key": true, "references": "Candidate"},
  {"name": "job_requisition_id",        "type": "String",       "is_foreign_key": true, "references": "Job_Requisition"},
  {"name": "client_id",                 "type": "String",       "is_foreign_key": true, "references": "Client"},

  // ── rule-check 维度 ──
  {"name": "rule_check_audit_id",       "type": "String",       "description": "对应 AO 本地 Prisma RuleCheckAudit 主键(如 rca_01KRE2FHKY...)"},
  {"name": "rule_check_decision",       "type": "String",       "description": "PASS / FAIL(LLM 预筛结论)"},
  {"name": "failure_reason_codes",      "type": "List<String>", "description": "失败规则 short code 列表,如 ['10-5:DEGREE_MISMATCH', '10-7:SALARY_OVER']"},
  {"name": "rules_evaluated_count",     "type": "Integer",      "description": "applicable=true 的规则数量"},
  {"name": "terminal_rule_hits",        "type": "List<String>", "description": "命中的底线规则 id 列表(severity=terminal)"},

  // ── Robohire 维度 ──
  {"name": "robohire_match_score",      "type": "Float",        "description": "Robohire 综合得分 0-100,rule-check FAIL 时为 null"},
  {"name": "robohire_request_id",       "type": "String",       "description": "Robohire /match-resume API 的 request_id,便于回溯"},
  {"name": "robohire_breakdown_json",   "type": "String",       "description": "Robohire 各维度得分 JSON(skills/experience/education/...)"},

  // ── 决策合并 ──
  {"name": "final_decision",            "type": "String",       "description": "PASS / FAIL / NEEDS_HUMAN(rule-check 跟 Robohire 综合判断)"},
  {"name": "final_decision_reason",     "type": "String",       "description": "最终决策的一句话理由(给 leader / 客户看)"},
  {"name": "decided_at",                "type": "Timestamp",    "description": "决策时间"},

  // ── 谱系(补全重判)──
  {"name": "parent_match_result_id",    "type": "String",       "description": "若本次是补全后重判,指向上一次结果 id;否则 null"}
]
```

### 关系

```
(Candidate)-[:HAS_MATCH_RESULT]->(Candidate_Match_Result)
(Candidate_Match_Result)-[:FOR_JOB_REQUISITION]->(Job_Requisition)
(Candidate_Match_Result)-[:DERIVED_FROM_AUDIT {audit_id}]->(...)   // 可选,链回 RuleCheckAudit(但 audit 在 Prisma 不在 Neo4j)
```

---

## 6. RAAS partner 端需要改动吗?

**几乎不需要**,具体如下:

| 项目 | RAAS 是否要改 | 原因 |
|---|---|---|
| **ingest API event schema** | ❌ **不需要** | `RESUME_PROCESSED.payload.parsed.data` 是 RoboHire 原始输出的透传,跟 ontology DataObject schema 解耦。schema 改不改不影响事件结构 |
| **HITL mapping** | ❌ **不需要** | 跟 ontology DataObject 无关 |
| **RAAS 内部 DB schema** | ❓ 看 RAAS 是否本地存 | 如果 RAAS 自己存 `parsed_resume_json`,字段名跟 ontology 不一致也没问题(本地存全文)。如果 RAAS 内部有 ORM 模型映射这些 entity,可能需要 align(陈洋这边发出 ontology schema 改动通知后,partner 自己决定) |
| **RAAS UI / 表单** | ⚠️ **可能要改** | 如果 RAAS 有"录入 / 编辑候选人求职期望"表单,字段名需要跟 ontology 对齐(`outsourcing_acceptance_level` → `outsourcing_acceptance`)|
| **Neo4j writer** | ❌ **不需要** | 目前 `Candidate` / `Resume` / `Job_Requisition` / 即将的 `Candidate_Expectation` / `Candidate_Match_Result` 都由 **AO 写**,RAAS 不直接写 Neo4j 实例节点(只有 `Job_Requisition` 是 AO 的 createJdAgent 在写)|

**简单结论**:陈洋这边只发 ontology schema 变更通知给 RAAS partner,partner 收到后**只可能要改 UI 字段名 + 内部表单**(如果有),不影响事件契约和 ingest API。

---

## 7. AO 端配套改动(自查)

陈洋这边 ontology 改完后,AO 这边同步要改 4 处:

1. **新建** `lib/rule-check/neo4j-expectation-writer.ts` — 写 `Candidate_Expectation` 节点
2. **新建** `lib/rule-check/neo4j-match-result-writer.ts` — 写 `Candidate_Match_Result` 节点
3. **改** `lib/rule-check/neo4j-instance-writer.ts:442 buildCandidateSnapshot` — 把 `expected_*` / `labor_form_preference` 等字段**移出** Candidate 节点(改写到 Candidate_Expectation),并把 `marital_status / former_csi_employment / former_tencent_employment / conflict_of_interest_*` 字段**留在** Candidate 节点(跟 ontology 新加的字段对齐)
4. **改** `server/inngest/agents/match-resume-agent.ts` — Step 4a Robohire match 之后加 step `write-match-result-${stepKey}` 调用新 writer

---

## 8. 验证计划

ontology + AO 改完之后:

```cypher
// 1. Candidate_Expectation 应有实例
MATCH (e:Candidate_Expectation) RETURN count(e)  // 期望 ≥ 11(每个候选人一个)

// 2. 跟 Candidate 有 HAS_EXPECTATION 关系
MATCH (c:Candidate)-[:HAS_EXPECTATION]->(e:Candidate_Expectation)
RETURN c.candidate_id, c.name, e.expected_salary_range
// 期望:江银行 04bcaedb 对应 e.expected_salary_range = "15k-18k"

// 3. Candidate_Match_Result 应有实例
MATCH (m:Candidate_Match_Result) RETURN count(m)  // 期望 ≥ 22(对应 22 条 audit)

// 4. 完整三角:Candidate → Match_Result → Job_Requisition
MATCH (c:Candidate {candidate_id: "04bcaedb-b1e8-4863-bee9-3e5c16e0caa3"})
      -[:HAS_MATCH_RESULT]->(m:Candidate_Match_Result)
      -[:FOR_JOB_REQUISITION]->(jr:Job_Requisition)
RETURN c.name, m.rule_check_decision, m.failure_reason_codes,
       m.robohire_match_score, m.final_decision, jr.client_job_title
```

---

## 9. 影响 / 风险

| 类型 | 描述 | 缓解 |
|---|---|---|
| **改名 breaking** | `outsourcing_acceptance_level → outsourcing_acceptance`、`job_position_id → job_requisition_id` — 若有外部消费者按旧名读取会断 | ontology API 发布 v2 字段时同时保留 v1 别名 1 个 sprint;AO 这边没消费旧名,无风险 |
| **新增字段空值** | 老 Candidate 实例缺新 properties(`marital_status` 等)| Neo4j MERGE 不强制 NOT NULL,空值就是 null。AO writer 用 `SET c += $props` 增量写,不会清空 |
| **历史 audit 没 match_result** | 现存 22 条 audit 跑完都没写 match_result | 写一次性回填脚本(从 Prisma audit 表读 → 写 Neo4j Candidate_Match_Result),由 AO 这边负责 |

---

## 10. 时间线建议

| 阶段 | 谁 | 工作量 |
|---|---|---|
| 1. ontology DataObject schema PR(本文 §2-5)| 陈洋 | 1-2 小时 |
| 2. AO 端 4 处改动(§7)| Steven | 4-6 小时 |
| 3. 一次性回填历史 audit → Candidate_Match_Result | Steven | 1 小时 |
| 4. 联调验证(本文 §8 Cypher 查询全过) | 双方 | 1 小时 |

总计约 1 个工作日。

---

## 11. 联系 / 反馈

- ontology 端:陈洋(Allmeta `apps/studio` 仓库)
- AO 端:Steven(agenticOperator 仓库 `Steven` 分支)
- 有问题在共享 ontology 频道 @ 双方
