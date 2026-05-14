# s07-foreign-marital-tencent ❌

> scenario: candidate=`c05-zhouqi-foreign-data` × jd=`jr-tencent-cdg-data`
> rationale: 周七 nationality="美国"(外籍)+ gender="女" + age=28 + marital="未婚"。腾讯客户场景 10-35(外籍通道限制)+ 10-47(女>26 未婚/已婚未育 HSM 审视)都必须命中。复合多规则 → FAIL。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-35, 10-47 | 10-9:gap_unexplained, 10-47:gender_age_marital_risk |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ❌ **must-fail rule fired: 10-35** — LLM 没有把 10-35 标为 fail/pause/hit
- ✅ **must-fail rule fired: 10-47**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (17)** — wrote=17 expected=17
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=17 / total=17

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长约2.5年（Meta 3.4年, LinkedIn 1.8年），无消极空窗理由。 | 平均每段工作时长约, 无消极空窗理由, Meta | Meta, LinkedIn | 平均每段工作时长约, 无消极空窗理由 | ✓ |
| 10-12 | 1997年出生，2019年硕士毕业，毕业年龄22岁，处于硕士基准24-26岁偏差内（提前毕业），偏差未达2岁异常阈值。 | 年出生, 年硕士毕业, 毕业年龄 | — | 年出生, 年硕士毕业 | ✓ |
| 10-24 | 简历已关联至jr_y88数据分析工程师需求。 | 简历已关联至, 数据分析工程师需求 | — | 简历已关联至, 数据分析工程师需求 | ✓ |
| 10-25 | 工作经历中不包含华为、荣耀及其关联公司。 | 工作经历中不包含华为, 荣耀及其关联公司 | — | 工作经历中不包含华为, 荣耀及其关联公司 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米及其关联公司。 | 工作经历中不包含, 小米及其关联公司, OPPO | — | 工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-5 | 学历硕士符合本科要求；技能Python/SQL/Spark符合；年龄28岁符合22-35岁要求。 | 学历硕士符合本科要求, 技能, 符合 | SQL, Python | 学历硕士符合本科要求, 技能 | ✓ |
| 10-6 | 命中加分项：Spark, Tableau。 | Spark, 命中加分项, Tableau | Spark, Tableau | 命中加分项 | ✓ |
| 10-7 | 期望薪资30k-40k，未超过岗位上限40k。 | 期望薪资, 未超过岗位上限, 30k-40k | 30k-40k | 期望薪资, 未超过岗位上限 | ✓ |
| 10-8 | outsourcing_acceptance为“接受”。 | 接受 | 接受 | — | ✓ |
| 10-9 | LinkedIn(2021-06离职)与Meta(2021-07入职)无空窗；但2024-12至今已超过3个月且未提供空窗期原因说明。 | 离职, 入职, 无空窗 | 2021-06, 2021-07 | 离职, 入职 | ✓ |
| 10-27 | conflict_of_interest为空，未声明亲属关系。 | 为空, 未声明亲属关系 | — | 为空, 未声明亲属关系 | ✓ |
| 10-35 | 国籍为美国，标记为外籍人在国内工作品类通道。 | 国籍为美国, 标记为外籍人在国内工作品类通道 | — | 国籍为美国, 标记为外籍人在国内工作品类通道 | ✓ |
| 10-38 | 简历履历中不包含腾讯或腾讯外包经历。 | 简历履历中不包含腾讯或腾讯外包经历 | — | 简历履历中不包含腾讯或腾讯外包经历 | ✓ |
| 10-45 | 无腾讯正式岗位工作经历。 | 无腾讯正式岗位工作经历 | — | 无腾讯正式岗位工作经历 | ✓ |
| 10-47 | 候选人为女性，28岁(>26岁)，未婚。命中加分项(Spark, Tableau)占总加分项100%(>50%)，需HSM审核确认。 | 候选人为女性, 未婚, 命中加分项 | 未婚, Spark | 候选人为女性, 命中加分项 | ✓ |
| 10-42 | 候选人无腾讯相关工作经历。 | 候选人无腾讯相关工作经历 | — | 候选人无腾讯相关工作经历 | ✓ |
| 10-53 | 推荐至CDG事业群，跳过内部技面。 | 推荐至, 事业群, 跳过内部技面 | — | 推荐至, 事业群 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_e1ce66",
  "job_requisition_id": "jr_y88",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-9:gap_unexplained",
    "10-47:gender_age_marital_risk"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长约2.5年（Meta 3.4年, LinkedIn 1.8年），无消极空窗理由。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1997年出生，2019年硕士毕业，毕业年龄22岁，处于硕士基准24-26岁偏差内（提前毕业），偏差未达2岁异常阈值。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求未明确要求语言证书类型。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位未带有轮班、夜班、倒班或长期出差标签。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未见华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未见华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未见华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历已关联至jr_y88数据分析工程师需求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历中不包含华为、荣耀及其关联公司。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历中不包含OPPO、小米及其关联公司。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未显示曾在我司（CSI）任职。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历硕士符合本科要求；技能Python/SQL/Spark符合；年龄28岁符合22-35岁要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求中不存在已定义的负向要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项：Spark, Tableau。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资30k-40k，未超过岗位上限40k。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "outsourcing_acceptance为“接受”。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "LinkedIn(2021-06离职)与Meta(2021-07入职)无空窗；但2024-12至今已超过3个月且未提供空窗期原因说明。",
      "next_action": "block"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest为空，未声明亲属关系。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "hsm_feedback为null，无确认结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "国籍为美国，标记为外籍人在国内工作品类通道。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历履历中不包含腾讯或腾讯外包经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无核实任务反馈。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无腾讯正式岗位工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "未被标记为正编转外包受控状态。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人为女性，28岁(>26岁)，未婚。命中加分项(Spark, Tableau)占总加分项100%(>50%)，需HSM审核确认。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-42",
      "rule_name": "CDG事业群6个月回流冷冻期绝对拦截",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人无腾讯相关工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "推荐至CDG事业群，跳过内部技面。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 关联至jr_y88数据分析工程师\n- [10-5 ⓘ] 简历匹配硬性要求一票否决 — 学历、技能、年龄均符合硬性门槛\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中加分项: Spark, Tableau\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-9 ✗] 简历履历空窗期检测与标记 — 2024-12至今空窗超3个月且无说明\n- [10-35 ⓘ] 腾讯外籍候选人实名与通道限制规范 — 美国国籍，锁定外籍通道\n- [10-45 ⓘ] 腾讯正编转外包回流标记 — 无腾讯正编经历，未受控\n- [10-47 ✗] 腾讯婚育风险审视与推荐要点 — 女性28岁未婚，高加分项占比需HSM审核\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — CDG事业群默认跳过技面",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-47",
      "message": "候选人 周七 命中婚育风险审视规则（女性28岁未婚），其加分项命中率为100%，请审核是否准予推荐。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-42-35-303Z_e8a292_s07-foreign-marital-tencent`
  - run_id: `run_2026-05-12T03-42-35-303Z_e8a292`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`google/gemini-3-flash-preview` duration=19237 ms tokens=10061/3406
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 17 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=PASS next=continue
  - `10-45` [flag_only] result=PASS next=continue
  - `10-47` [needs_human] result=FAIL next=notify_hsm
  - `10-42` [terminal] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 1 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 19.24 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 21 ms |
| **total** | **19.26 s** |
