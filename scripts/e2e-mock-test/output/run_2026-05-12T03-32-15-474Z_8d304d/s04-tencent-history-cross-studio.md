# s04-tencent-history-cross-studio ✅

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-ieg-tianmei`
> rationale: 赵六腾讯 PCG 在职史(主动离场 4 个月前)。 10-38 必须命中:暂停推荐 + 向 HSM 发起核实任务确认真实离场原因。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-12:age_logic_anomaly, 10-25:competitor_cooling_off, 10-38:tencent_history_verification, 10-40:active_leave_cooling_off, 10-47:gender_age_marriage_risk |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-38**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (20)** — wrote=20 expected=20
- ✅ **evidence verifiable rate ≥ 0.8 (got 90%)** — verified=18 / total=20

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 90%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 工作经历: 2025-03至2026-04(1.1年), 2019-08至2025-02(5.5年)。平均时长 > 1年, 无消极空窗期说明。 | 2025-03至2026-04, 工作经历, 平均时长 | 2025-03, 2026-04 | 2025-03至2026-04, 工作经历 | ✓ |
| 10-12 | 出生1990年, 硕士毕业2019年, 毕业年龄29岁。硕士基准24-26岁, 偏差3-5岁, 超过2岁阈值。 | 出生, 硕士毕业, 毕业年龄 | — | 出生, 硕士毕业 | ✗ |
| 10-24 | 简历已关联至原始需求 jr_z77。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-25 | 简历未明确排除华为/荣耀背景, 且当前日期2026-05对比最近离职2026-04不足3个月, 需人工核实。 | 简历未明确排除华为, 荣耀背景, 且当前日期 | 2026-04 | 简历未明确排除华为, 荣耀背景 | ✓ |
| 10-26 | 简历中未发现OPPO、小米及其关联公司任职记录。 | 简历中未发现, 小米及其关联公司任职记录, OPPO | — | 简历中未发现, 小米及其关联公司任职记录 | ✓ |
| 10-5 | 学历硕士(>=本科), 技能C++/Lua匹配, 年龄36岁(略超35岁但规则10-5仅记录), 性别男匹配。 | 学历硕士, 本科, 技能 | Lua | 学历硕士, 本科 | ✓ |
| 10-6 | 命中加分项: UnrealEngine, Redis。 | UnrealEngine, 命中加分项, Redis | UnrealEngine, Redis | 命中加分项 | ✓ |
| 10-7 | 期望薪资 45k-58k, 岗位上限 60k, 未超限。 | 期望薪资, 岗位上限, 未超限 | 45k-58k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 外包接受度为'接受'。 | 接受, 外包接受度为 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 毕业2019-06至首份工作2019-08间隔2个月(<3个月); 两段工作间隔2025-02至2025-03不足1个月。 | 毕业, 至首份工作, 间隔 | 2019-08, 2025-02 | 毕业, 至首份工作 | ✓ |
| 10-27 | conflict_of_interest 为空数组, 未申报亲属关系。 | 为空数组, 未申报亲属关系 | — | 为空数组, 未申报亲属关系 | ✓ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-38 | 包含腾讯 IEG 天美工作室经历(2019-08至2025-02), 需核实离场原因。 | 包含腾讯, 天美工作室经历, 需核实离场原因 | IEG, 2019-08 | 包含腾讯, 天美工作室经历 | ✓ |
| 10-45 | 存在腾讯正式岗位工作经历(employment_type: 正式)。 | 正式, 存在腾讯正式岗位工作经历 | 正式 | 存在腾讯正式岗位工作经历 | ✓ |
| 10-46 | 已标记正编转外包受控, 需后续上传凭证。 | 已标记正编转外包受控, 需后续上传凭证 | — | 已标记正编转外包受控, 需后续上传凭证 | ✓ |
| 10-3 | 当前无其他 IEG 活跃流程记录。 | 当前无其他, 活跃流程记录, IEG | IEG | 当前无其他, 活跃流程记录 | ✓ |
| 10-40 | 腾讯离场类型为'主动离场', 离场时间2025-02距今超过6个月, 但规则要求IEG回流需HSM审核。 | 主动离场, 腾讯离场类型为, 离场时间 | 主动离场, 2025-02 | 腾讯离场类型为, 离场时间 | ✓ |
| 10-43 | 原工作室为天美, 目标工作室亦为天美, 不属于跨室推荐拦截范围。 | 原工作室为天美, 目标工作室亦为天美, 不属于跨室推荐拦截范围 | — | 原工作室为天美, 目标工作室亦为天美 | ✓ |
| 10-52 | 已锁定内部技术面试节点。 | 已锁定内部技术面试节点 | — | 已锁定内部技术面试节点 | ✓ |
| 10-56 | 简历中未发现深圳市腾娱互动科技有限公司任职记录。 | 简历中未发现深圳市腾娱互动科技有限公司任职记录 | — | 简历中未发现深圳市腾娱互动科技有限公司任职记录 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_1c0abd",
  "job_requisition_id": "jr_z77",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-12:age_logic_anomaly",
    "10-25:competitor_cooling_off",
    "10-38:tencent_history_verification",
    "10-40:active_leave_cooling_off",
    "10-47:gender_age_marriage_risk"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历: 2025-03至2026-04(1.1年), 2019-08至2025-02(5.5年)。平均时长 > 1年, 无消极空窗期说明。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "出生1990年, 硕士毕业2019年, 毕业年龄29岁。硕士基准24-26岁, 偏差3-5岁, 超过2岁阈值。",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求未包含'外语'、'海外'或'国际化'标签。",
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
      "evidence": "简历未提供华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未提供华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未提供华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历已关联至原始需求 jr_z77。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "简历未明确排除华为/荣耀背景, 且当前日期2026-05对比最近离职2026-04不足3个月, 需人工核实。",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中未发现OPPO、小米及其关联公司任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未显示曾在我司(CSI)任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历硕士(>=本科), 技能C++/Lua匹配, 年龄36岁(略超35岁但规则10-5仅记录), 性别男匹配。",
      "next_action": "continue"
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
      "evidence": "命中加分项: UnrealEngine, Redis。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 45k-58k, 岗位上限 60k, 未超限。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度为'接受'。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业2019-06至首份工作2019-08间隔2个月(<3个月); 两段工作间隔2025-02至2025-03不足1个月。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空数组, 未申报亲属关系。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "hsm_feedback 为空, 无亲属关系确认结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "国籍为中国。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "包含腾讯 IEG 天美工作室经历(2019-08至2025-02), 需核实离场原因。",
      "next_action": "block"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未收到 HSM 针对离场原因的核实反馈。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "存在腾讯正式岗位工作经历(employment_type: 正式)。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已标记正编转外包受控, 需后续上传凭证。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人为男性, 不触发该规则。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-3",
      "rule_name": "IEG活跃流程候选人改推拦截",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "当前无其他 IEG 活跃流程记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "腾讯离场类型为'主动离场', 离场时间2025-02距今超过6个月, 但规则要求IEG回流需HSM审核。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-43",
      "rule_name": "IEG工作室回流候选人互斥标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "原工作室为天美, 目标工作室亦为天美, 不属于跨室推荐拦截范围。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-52",
      "rule_name": "IEG内部技术面试强制校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已锁定内部技术面试节点。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-56",
      "rule_name": "腾娱互动子公司回流冷冻期拦截",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中未发现深圳市腾娱互动科技有限公司任职记录。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-12 ✗] 学历年龄逻辑校验与风险预警 — 硕士毕业年龄29岁, 偏差大于2岁\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 关联至 jr_z77\n- [10-25 ✗] 华为荣耀竞对与客户互不挖角红线 — 离职间隔不足3个月风险\n- [10-5 ⓘ] 简历匹配硬性要求一票否决 — 年龄36岁略超, 技能匹配\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中 UnrealEngine, Redis 加分项\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-38 ✗] 腾讯历史从业经历识别与核实触发 — 发现天美工作室历史经历, 需核实离场原因\n- [10-45 ⓘ] 腾讯正编转外包回流标记 — 腾讯正式员工背景\n- [10-40 ✗] 腾讯主动离职人员紧急回流审核 — 腾讯主动离职回流IEG需HSM审核\n- [10-43 ⓘ] IEG工作室回流候选人互斥标记 — 天美回流天美, 允许推荐",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-12",
      "message": "候选人赵六硕士毕业年龄为29岁, 与基准偏差较大, 请核实教育经历。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人赵六有腾讯天美工作室历史经历, 请核实其真实离场原因。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-40",
      "message": "候选人赵六为腾讯主动离职回流IEG, 请审核其回流资格。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-32-15-474Z_8d304d_s04-tencent-history-cross-studio`
  - run_id: `run_2026-05-12T03-32-15-474Z_8d304d`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`IEG`
  - LLM: model=`google/gemini-3-flash-preview` duration=18973 ms tokens=10949/4018
  - rules_evaluated: 30 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 20 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=FAIL next=notify_recruiter
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=FAIL next=notify_recruiter
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=FAIL next=block
  - `10-45` [flag_only] result=PASS next=continue
  - `10-46` [flag_only] result=PASS next=continue
  - `10-3` [flag_only] result=PASS next=continue
  - `10-40` [needs_human] result=FAIL next=notify_hsm
  - `10-43` [flag_only] result=PASS next=continue
  - `10-52` [flag_only] result=PASS next=continue
  - `10-56` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 18.98 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 45 ms |
| **total** | **19.03 s** |
