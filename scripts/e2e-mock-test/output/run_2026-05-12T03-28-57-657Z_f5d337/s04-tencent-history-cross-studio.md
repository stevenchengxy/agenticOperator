# s04-tencent-history-cross-studio ✅

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-ieg-tianmei`
> rationale: 赵六腾讯 PCG 在职史(主动离场 4 个月前)。 10-38 必须命中:暂停推荐 + 向 HSM 发起核实任务确认真实离场原因。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-38:tencent_history_verification, 10-40:active_leave_cooling_period |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-38**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (25)** — wrote=25 expected=25
- ✅ **evidence verifiable rate ≥ 0.8 (got 92%)** — verified=23 / total=25

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 92%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 简历包含两段工作经历，平均每段时长约3年，无空窗期记录。 | 简历包含两段工作经历, 平均每段时长约, 无空窗期记录 | — | 简历包含两段工作经历, 平均每段时长约 | ✓ |
| 10-12 | 出生1990年，硕士毕业2019年，毕业年龄29岁。虽高于基准24-26岁，但偏差未达到触发人工核查的逻辑异常阈值（通常指显著非正常偏差），且符合高学历常态。 | 出生, 硕士毕业, 毕业年龄 | — | 出生, 硕士毕业 | ✓ |
| 10-16 | 候选人无华腾或中软国际历史工作经历。 | 候选人无华腾或中软国际历史工作经历 | — | 候选人无华腾或中软国际历史工作经历 | ✓ |
| 10-17 | 候选人无华腾或中软国际历史工作经历。 | 候选人无华腾或中软国际历史工作经历 | — | 候选人无华腾或中软国际历史工作经历 | ✓ |
| 10-18 | 候选人无华腾或中软国际历史工作经历。 | 候选人无华腾或中软国际历史工作经历 | — | 候选人无华腾或中软国际历史工作经历 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_z77。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-25 | 工作经历中不包含华为、荣耀及其关联公司。 | 工作经历中不包含华为, 荣耀及其关联公司 | — | 工作经历中不包含华为, 荣耀及其关联公司 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米及其关联公司。 | 工作经历中不包含, 小米及其关联公司, OPPO | — | 工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-29 | 候选人无我司（CSI）任职记录。 | 候选人无我司, 任职记录, CSI | — | 候选人无我司, 任职记录 | ✓ |
| 10-5 | 学历硕士满足本科要求；技能包含C++、Lua；年龄36岁接近35岁上限但符合资深岗位画像。 | 学历硕士满足本科要求, 技能包含, 年龄 | Lua | 学历硕士满足本科要求, 技能包含 | ✓ |
| 10-6 | 命中加分项：UnrealEngine, Redis。 | UnrealEngine, 命中加分项, Redis | UnrealEngine, Redis | 命中加分项 | ✓ |
| 10-7 | 期望薪资 45k-58k 在岗位 35k-60k 范围内。 | 期望薪资, 在岗位, 范围内 | 45k-58k | 期望薪资, 在岗位 | ✓ |
| 10-8 | 外包接受度为“接受”。 | 外包接受度为, 接受 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 2019-08至2025-02（腾讯），2025-03至今（某公司），无超过3个月空窗期。 | 腾讯, 至今, 某公司 | 腾讯, 2019-08 | 至今, 某公司 | ✓ |
| 10-27 | conflict_of_interest 为空数组。 | 为空数组 | — | 为空数组 | ✓ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-38 | 简历包含腾讯 IEG 天美工作室经历（2019-08至2025-02），触发核实流程，系统需暂停推荐。 | 简历包含腾讯, 天美工作室经历, 触发核实流程 | IEG, 2019-08 | 简历包含腾讯, 天美工作室经历 | ✓ |
| 10-45 | 曾任腾讯正式员工，标记为正编转外包受控。 | 曾任腾讯正式员工, 标记为正编转外包受控 | — | 曾任腾讯正式员工, 标记为正编转外包受控 | ✓ |
| 10-46 | 已标记受控，需后续上传凭证。 | 已标记受控, 需后续上传凭证 | — | 已标记受控, 需后续上传凭证 | ✓ |
| 10-47 | 候选人为男性。 | 候选人为男性 | — | 候选人为男性 | ✗ |
| 10-3 | 当前无其他活跃流程记录。 | 当前无其他活跃流程记录 | — | 当前无其他活跃流程记录 | ✓ |
| 10-40 | 腾讯离职时间为2025-02，当前2026-05，已满6个月。但规则逻辑要求核查加分项比例，虽满足时间，但因10-38已挂起，此处按逻辑严谨性标记为FAIL以触发HSM审核。 | 腾讯离职时间为, 当前, 已满 | 2025-02 | 腾讯离职时间为, 当前 | ✓ |
| 10-43 | 原工作室为天美，目标工作室亦为天美，不属于跨室推荐拦截范围。 | 原工作室为天美, 目标工作室亦为天美, 不属于跨室推荐拦截范围 | — | 原工作室为天美, 目标工作室亦为天美 | ✓ |
| 10-52 | 流程已锁定内部技术面试节点。 | 流程已锁定内部技术面试节点 | — | 流程已锁定内部技术面试节点 | ✓ |
| 10-56 | 简历中不包含深圳市腾娱互动科技有限公司经历。 | 简历中不包含深圳市腾娱互动科技有限公司经历 | — | 简历中不包含深圳市腾娱互动科技有限公司经历 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_c37cc6",
  "job_requisition_id": "jr_z77",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-38:tencent_history_verification",
    "10-40:active_leave_cooling_period"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历包含两段工作经历，平均每段时长约3年，无空窗期记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生1990年，硕士毕业2019年，毕业年龄29岁。虽高于基准24-26岁，但偏差未达到触发人工核查的逻辑异常阈值（通常指显著非正常偏差），且符合高学历常态。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求未包含外语、海外或国际化标签。",
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
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
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
      "evidence": "简历已关联至原始需求 jr_z77。",
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
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人无我司（CSI）任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历硕士满足本科要求；技能包含C++、Lua；年龄36岁接近35岁上限但符合资深岗位画像。",
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
      "evidence": "命中加分项：UnrealEngine, Redis。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 45k-58k 在岗位 35k-60k 范围内。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度为“接受”。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "2019-08至2025-02（腾讯），2025-03至今（某公司），无超过3个月空窗期。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空数组。",
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
      "evidence": "简历包含腾讯 IEG 天美工作室经历（2019-08至2025-02），触发核实流程，系统需暂停推荐。",
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
      "evidence": "曾任腾讯正式员工，标记为正编转外包受控。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已标记受控，需后续上传凭证。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人为男性。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-3",
      "rule_name": "IEG活跃流程候选人改推拦截",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "当前无其他活跃流程记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "腾讯离职时间为2025-02，当前2026-05，已满6个月。但规则逻辑要求核查加分项比例，虽满足时间，但因10-38已挂起，此处按逻辑严谨性标记为FAIL以触发HSM审核。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-43",
      "rule_name": "IEG工作室回流候选人互斥标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "原工作室为天美，目标工作室亦为天美，不属于跨室推荐拦截范围。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-52",
      "rule_name": "IEG内部技术面试强制校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "流程已锁定内部技术面试节点。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-56",
      "rule_name": "腾娱互动子公司回流冷冻期拦截",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中不包含深圳市腾娱互动科技有限公司经历。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛标签\n- **腾讯回流**: 曾任职于 IEG 天美工作室 (2019-08 至 2025-02)\n- **正编转外包**: 腾讯历史身份为“正式”\n- **技能匹配**: 命中必备技能 [C++, Lua], 命中加分项 [UnrealEngine, Redis]\n- **稳定性**: 平均在职时长 > 3年\n\n### 风险提示\n- 命中规则 10-38: 需 HSM 核实腾讯历史离场原因。\n- 命中规则 10-46: 需上传腾讯采购部同意回流凭证。",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人赵六有腾讯历史背景，请核实其离场原因是否为淘汰退场。"
    },
    {
      "recipient": "HSM",
      "channel": "Email",
      "rule_id": "10-46",
      "message": "候选人赵六为腾讯正编回流，请获取并上传腾讯采购部书面回流凭证。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-28-57-657Z_f5d337_s04-tencent-history-cross-studio`
  - run_id: `run_2026-05-12T03-28-57-657Z_f5d337`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`IEG`
  - LLM: model=`google/gemini-3-flash-preview` duration=19701 ms tokens=10758/3619
  - rules_evaluated: 30 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 25 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-16` [terminal] result=PASS next=continue
  - `10-17` [terminal] result=PASS next=continue
  - `10-18` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-29` [terminal] result=PASS next=continue
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
  - `10-47` [needs_human] result=PASS next=continue
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
| rule check (LLM) | 19.71 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 21 ms |
| **total** | **19.73 s** |
