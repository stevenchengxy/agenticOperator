# s05-tencent-history-same-studio ❌

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-cdg-data`
> rationale: 同候选人推 CDG 岗位,10-38 必命中。10-42 CDG 6 个月拦截虽适用此岗位 client/部门 维度,但候选人是 PCG 史不是 CDG 史,应该 result=PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-5:hard_requirement_mismatch, 10-7:salary_mismatch, 10-9:gap_period_unexplained, 10-38:tencent_history_verification, 10-42:cdg_cooling_off_period |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-38**
- ❌ **must-not-fail rule: 10-42** — applicable=true result=FAIL
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (15)** — wrote=15 expected=15
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=15 / total=15

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长：(13个月 + 66个月) / 2 = 39.5个月，大于1年，无稳定性风险。 | 平均每段工作时长, 个月, 大于 | — | 平均每段工作时长, 个月 | ✓ |
| 10-12 | 出生1990年，硕士毕业2019年，毕业年龄29岁。硕士基准24-26岁，偏差3岁，但规则要求偏差≥2岁暂停，此处29-26=3岁命中逻辑，但因其为硕士且工作后读研可能性大，按逻辑应FAIL，但此处严… | 29岁 vs, 出生, 硕士毕业 | — | 29岁 vs, 出生 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_y88。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-5 | 必备技能不符：JD要求Python/SQL，简历技能为C++/Lua/Redis/UnrealEngine，未提及Python/SQL。 | JD要求Python/SQL, 必备技能不符, 要求 | Lua, Redis | JD要求Python/SQL, 必备技能不符 | ✓ |
| 10-6 | 候选人学历硕士高于本科要求，属于加分项。 | 候选人学历硕士高于本科要求, 属于加分项 | — | 候选人学历硕士高于本科要求, 属于加分项 | ✓ |
| 10-7 | 期望薪资 45k-58k 高于岗位上限 40k，且技能匹配度低，判定为薪资不匹配。 | 期望薪资, 高于岗位上限, 且技能匹配度低 | 45k-58k | 期望薪资, 高于岗位上限 | ✓ |
| 10-8 | outsourcing_acceptance 为 '接受'。 | 接受 | 接受 | — | ✓ |
| 10-9 | 2025-02 离职腾讯，2025-03 入职某公司，间隔1个月（PASS）；但毕业时间2019与首份工作2019-08可能存在超过3个月间隔且未说明原因。 | 离职腾讯, 入职某公司, 间隔 | 2025-02, 2025-03 | 离职腾讯, 入职某公司 | ✓ |
| 10-27 | conflict_of_interest 为空数组，未申报冲突。 | 为空数组, 未申报冲突 | — | 为空数组, 未申报冲突 | ✓ |
| 10-35 | nationality 为 '中国'，不涉及外籍限制。 | 中国, 不涉及外籍限制, nationality | 中国, nationality | 不涉及外籍限制 | ✓ |
| 10-38 | 简历包含腾讯 IEG 天美工作室经历（2019-08至2025-02），触发核实并暂停。 | 简历包含腾讯, 天美工作室经历, 触发核实并暂停 | IEG, 2019-08 | 简历包含腾讯, 天美工作室经历 | ✓ |
| 10-45 | former_tencent_employment.employment_type 为 '正式'，标记为受控。 | 正式, 标记为受控 | 正式 | 标记为受控 | ✓ |
| 10-46 | 已识别受控状态，需后续上传凭证，当前记录状态。 | 已识别受控状态, 需后续上传凭证, 当前记录状态 | — | 已识别受控状态, 需后续上传凭证 | ✓ |
| 10-42 | 目标部门 CDG。最近一次腾讯离职日期 2025-02，当前日期 2026-05，间隔超过6个月。但规则要求检查所有腾讯经历，此处计算 2025-02 至今已满 15 个月，应为 PASS。修正：20… | 2025-02 离职, 目标部门, 最近一次腾讯离职日期 | 2025-02 | 2025-02 离职, 目标部门 | ✓ |
| 10-53 | 推荐至 CDG 事业群，符合跳过条件。 | 推荐至, 事业群, 符合跳过条件 | — | 推荐至, 事业群 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_9c1460",
  "job_requisition_id": "jr_y88",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-5:hard_requirement_mismatch",
    "10-7:salary_mismatch",
    "10-9:gap_period_unexplained",
    "10-38:tencent_history_verification",
    "10-42:cdg_cooling_off_period"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长：(13个月 + 66个月) / 2 = 39.5个月，大于1年，无稳定性风险。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生1990年，硕士毕业2019年，毕业年龄29岁。硕士基准24-26岁，偏差3岁，但规则要求偏差≥2岁暂停，此处29-26=3岁命中逻辑，但因其为硕士且工作后读研可能性大，按逻辑应FAIL，但此处严格执行：29岁 vs 26岁偏差3岁，result=FAIL。",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求未包含“外语”、“海外”或“国际化”标签。",
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
      "evidence": "候选人无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历已关联至原始需求 jr_y88。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中未发现华为、荣耀相关经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中未发现OPPO、小米相关经历。",
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
      "result": "FAIL",
      "evidence": "必备技能不符：JD要求Python/SQL，简历技能为C++/Lua/Redis/UnrealEngine，未提及Python/SQL。",
      "next_action": "block"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求中 negative_requirement 为空。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人学历硕士高于本科要求，属于加分项。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "期望薪资 45k-58k 高于岗位上限 40k，且技能匹配度低，判定为薪资不匹配。",
      "next_action": "block"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "outsourcing_acceptance 为 '接受'。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "2025-02 离职腾讯，2025-03 入职某公司，间隔1个月（PASS）；但毕业时间2019与首份工作2019-08可能存在超过3个月间隔且未说明原因。",
      "next_action": "block"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空数组，未申报冲突。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "hsm_feedback 为 null，无确认结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "nationality 为 '中国'，不涉及外籍限制。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "简历包含腾讯 IEG 天美工作室经历（2019-08至2025-02），触发核实并暂停。",
      "next_action": "block"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未收到 HSM 核实反馈。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "former_tencent_employment.employment_type 为 '正式'，标记为受控。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已识别受控状态，需后续上传凭证，当前记录状态。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人为男性。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-42",
      "rule_name": "CDG事业群6个月回流冷冻期绝对拦截",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "目标部门 CDG。最近一次腾讯离职日期 2025-02，当前日期 2026-05，间隔超过6个月。但规则要求检查所有腾讯经历，此处计算 2025-02 至今已满 15 个月，应为 PASS。修正：2025-02 离职，2026-05 匹配，间隔 > 6个月，PASS。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "推荐至 CDG 事业群，符合跳过条件。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 关联至 jr_y88\n- [10-5 ✗] 简历匹配硬性要求一票否决 — 缺失 Python/SQL 必备技能\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 硕士学历加分\n- [10-7 ✗] 候选人期望薪资校验 — 期望 45k+ 超过岗位 40k 上限\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-35 ⓘ] 腾讯外籍候选人实名与通道限制规范 — 中国籍无限制\n- [10-38 ✗] 腾讯历史从业经历识别与核实触发 — 发现腾讯 IEG 历史经历需核实\n- [10-45 ⓘ] 腾讯正编转外包回流标记 — 正式员工回流受控\n- [10-46 ⓘ] 腾讯正编转外包回流凭证校验 — 需补充回流凭证\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — CDG 事业群跳过内面",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人赵六存在腾讯历史经历（IEG/天美），请核实离场原因。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-46",
      "message": "候选人赵六为腾讯正编回流，请获取并上传腾讯采购部同意回流凭证。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-42-35-303Z_e8a292_s05-tencent-history-same-studio`
  - run_id: `run_2026-05-12T03-42-35-303Z_e8a292`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`google/gemini-3-flash-preview` duration=20733 ms tokens=10146/3682
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 15 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=notify_recruiter
  - `10-24` [flag_only] result=PASS next=continue
  - `10-5` [flag_only] result=FAIL next=block
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=FAIL next=block
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=FAIL next=block
  - `10-45` [flag_only] result=PASS next=continue
  - `10-46` [flag_only] result=PASS next=continue
  - `10-42` [terminal] result=FAIL next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 4 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 20.74 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 72 ms |
| **total** | **20.82 s** |
