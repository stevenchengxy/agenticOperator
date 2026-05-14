# s05-tencent-history-same-studio ❌

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-cdg-data`
> rationale: 同候选人推 CDG 岗位,10-38 必命中。10-42 CDG 6 个月拦截虽适用此岗位 client/部门 维度,但候选人是 PCG 史不是 CDG 史,应该 result=PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-5:SKILL_MISMATCH, 10-7:SALARY_EXCEEDS_LIMIT, 10-38:TENCENT_HISTORY_VERIFY, 10-42:CDG_COOLING_OFF_PERIOD, 10-46:TENCENT_INTERNAL_TRANSFER_VOUCHER |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-38**
- ❌ **must-pass rule applicable+PASS: 10-42** — applicable=true result=FAIL
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (16)** — wrote=16 expected=16
- ❌ **evidence verifiable rate ≥ 0.8 (got 50%)** — verified=8 / total=16

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 50%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 岗位必备技能要求 Python/SQL, 候选人技能为 C++, Lua, Redis, Protobuf, UnrealEngine, 缺失 Python 和 SQL; 岗位薪资上限 40k, 候选… | 岗位必备技能要求, 候选人技能为, 缺失 | 45k-58k, Lua | 岗位必备技能要求, 候选人技能为 | ✓ |
| 10-6 | 候选人具备硕士学历, 满足岗位本科要求。 | 候选人具备硕士学历, 满足岗位本科要求 | — | 候选人具备硕士学历, 满足岗位本科要求 | ✗ |
| 10-7 | 候选人期望薪资 45k-58k 高于岗位上限 40k, 且技能匹配度低, 无法触发高分协商流程。 | 候选人期望薪资, 高于岗位上限, 且技能匹配度低 | 45k-58k | 候选人期望薪资, 高于岗位上限 | ✓ |
| 10-8 | outsourcing_acceptance: 接受 | 接受 | 接受 | — | ✓ |
| 10-9 | gap_periods: [] |  | — | — | ✗ |
| 10-10 | 平均每段工作时长超过 1 年 (2019-08 至 2025-02 为 5.5 年)。 | 平均每段工作时长超过, 2019-08, 2025-02 | 2019-08, 2025-02 | 平均每段工作时长超过 | ✓ |
| 10-12 | 1990年出生, 2019年硕士毕业, 毕业年龄 29 岁, 硕士基准 24-26 岁, 偏差 3 岁, 触发人工核查逻辑。 | 年出生, 年硕士毕业, 毕业年龄 | — | 年出生, 年硕士毕业 | ✗ |
| 10-24 | 关联至 TC-DA-2026-002。 | 关联至, TC-DA-2026-002 | — | 关联至, TC-DA-2026-002 | ✗ |
| 10-27 | conflict_of_interest: [] |  | — | — | ✗ |
| 10-35 | nationality: 中国 | 中国, nationality | 中国, nationality | — | ✓ |
| 10-38 | 候选人曾任职于腾讯 IEG 天美工作室 (2019-08 至 2025-02), 触发历史核实流程, 暂停推荐。 | 候选人曾任职于腾讯, 天美工作室, 触发历史核实流程 | 天美工作室, IEG | 候选人曾任职于腾讯, 触发历史核实流程 | ✓ |
| 10-45 | former_tencent_employment.employment_type: 正式 | 正式 | 正式 | — | ✓ |
| 10-46 | 候选人为腾讯正编回流, 尚未上传采购部门同意回流的书面凭证, 流程锁定。 | 候选人为腾讯正编回流, 尚未上传采购部门同意回流的书面凭证, 流程锁定 | — | 候选人为腾讯正编回流, 尚未上传采购部门同意回流的书面凭证 | ✗ |
| 10-47 | 候选人为男性, 不适用该风险审视规则。 | 候选人为男性, 不适用该风险审视规则 | — | 候选人为男性, 不适用该风险审视规则 | ✗ |
| 10-42 | 目标岗位为 CDG, 候选人最近一次腾讯离职日期为 2025-02, 距当前日期 2026-05 虽超过 6 个月, 但其最近一段经历 (2025-03 至 2026-04) 结束后再次申请, 需核实… | 目标岗位为, 候选人最近一次腾讯离职日期为, 距当前日期 | 2025-02, 2025-03 | 目标岗位为, 候选人最近一次腾讯离职日期为 | ✓ |
| 10-53 | 目标事业群为 CDG, 跳过内部技面。 | 目标事业群为, 跳过内部技面, CDG | — | 目标事业群为, 跳过内部技面 | ✗ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_888fa2",
  "job_requisition_id": "jr_y88",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-5:SKILL_MISMATCH",
    "10-7:SALARY_EXCEEDS_LIMIT",
    "10-38:TENCENT_HISTORY_VERIFY",
    "10-42:CDG_COOLING_OFF_PERIOD",
    "10-46:TENCENT_INTERNAL_TRANSFER_VOUCHER"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位必备技能要求 Python/SQL, 候选人技能为 C++, Lua, Redis, Protobuf, UnrealEngine, 缺失 Python 和 SQL; 岗位薪资上限 40k, 候选人期望 45k-58k。",
      "next_action": "block"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人具备硕士学历, 满足岗位本科要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人期望薪资 45k-58k 高于岗位上限 40k, 且技能匹配度低, 无法触发高分协商流程。",
      "next_action": "block"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "outsourcing_acceptance: 接受",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "gap_periods: []",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长超过 1 年 (2019-08 至 2025-02 为 5.5 年)。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1990年出生, 2019年硕士毕业, 毕业年龄 29 岁, 硕士基准 24-26 岁, 偏差 3 岁, 触发人工核查逻辑。",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求未明确语言证书要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位无轮班/出差标签。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软历史经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软历史经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软历史经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "关联至 TC-DA-2026-002。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华为/荣耀经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无OPPO/小米经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无我司 (CSI) 任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位无负向要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest: []",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无 HSM 反馈结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "nationality: 中国",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人曾任职于腾讯 IEG 天美工作室 (2019-08 至 2025-02), 触发历史核实流程, 暂停推荐。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "hsm_feedback 为空, 尚未获取核实结果。",
      "next_action": "block"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "former_tencent_employment.employment_type: 正式",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人为腾讯正编回流, 尚未上传采购部门同意回流的书面凭证, 流程锁定。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人为男性, 不适用该风险审视规则。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-42",
      "rule_name": "CDG事业群6个月回流冷冻期绝对拦截",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "目标岗位为 CDG, 候选人最近一次腾讯离职日期为 2025-02, 距当前日期 2026-05 虽超过 6 个月, 但其最近一段经历 (2025-03 至 2026-04) 结束后再次申请, 需核实其在 CDG 的冷冻期状态, 且 10-38 规则已挂起。",
      "next_action": "block"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标事业群为 CDG, 跳过内部技面。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛风险提示\n- **硬性门槛不符**: 候选人缺失 Python/SQL 核心技能, 且期望薪资 (45k+) 显著高于岗位上限 (40k)。\n- **腾讯回流受控**: 候选人为腾讯 IEG 前正编员工, 需补充采购部回流凭证 (规则 10-46)。\n- **历史核实挂起**: 触发腾讯历史从业经历核实任务, 需 HSM 确认离场原因 (规则 10-38)。\n- **学历年龄偏差**: 毕业年龄 29 岁较基准偏大 3 岁, 建议人工核实教育背景。\n- **流程优化**: 目标 CDG 事业群, 已自动标记跳过内部技术面试。",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人赵六存在腾讯历史经历, 请核实其离场原因是否为淘汰退场。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-46",
      "message": "候选人赵六为腾讯正编回流, 请上传腾讯采购部同意回流的书面凭证以解除锁定。"
    },
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-12",
      "message": "候选人赵六毕业年龄逻辑异常 (29岁), 请核实其教育经历真实性。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-09-38-834Z_877700_s05-tencent-history-same-studio`
  - run_id: `run_2026-05-12T03-09-38-834Z_877700`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`google/gemini-3-flash-preview` duration=17597 ms tokens=9778/3536
  - rules_evaluated: 27 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 16 (applicable=true 的全部):
  - `10-5` [terminal] result=FAIL next=block
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=FAIL next=block
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=notify_recruiter
  - `10-24` [flag_only] result=PASS next=continue
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [needs_human] result=PASS next=continue
  - `10-38` [terminal] result=FAIL next=notify_hsm
  - `10-45` [flag_only] result=PASS next=continue
  - `10-46` [needs_human] result=FAIL next=notify_hsm
  - `10-47` [needs_human] result=PASS next=continue
  - `10-42` [terminal] result=FAIL next=block
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 17.60 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 42 ms |
| **total** | **17.64 s** |
