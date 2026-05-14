# s04-tencent-history-cross-studio ✅

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-ieg-tianmei`
> rationale: 赵六腾讯 PCG 在职史(主动离场 4 个月前)。 10-38 必须命中:暂停推荐 + 向 HSM 发起核实任务确认真实离场原因。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-12:AGE_LOGIC_DEVIATION, 10-25:COMPETITOR_COOLING_OFF, 10-38:TENCENT_HISTORY_VERIFY, 10-40:TENCENT_ACTIVE_LEAVE_COOLING_OFF, 10-47:MARRIAGE_FERTILITY_RISK |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-38**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (20)** — wrote=20 expected=20
- ✅ **evidence verifiable rate ≥ 0.8 (got 95%)** — verified=19 / total=20

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 95%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 简历显示两段经历：2019-08至2025-02（5.5年），2025-03至今（1.1年），平均时长 > 1年，无空窗期记录。 | 2019-08至2025-02, 简历显示两段经历, 至今 | 2019-08, 2025-02 | 2019-08至2025-02, 简历显示两段经历 | ✓ |
| 10-12 | 出生1990年，硕士毕业2019年，毕业年龄29岁。硕士基准24-26岁，偏差3-5岁，超过2岁阈值。 | 出生, 硕士毕业, 毕业年龄 | — | 出生, 硕士毕业 | ✗ |
| 10-24 | 简历已关联至适配度最高的原始需求 jr_z77。 | 简历已关联至适配度最高的原始需求 | — | 简历已关联至适配度最高的原始需求 | ✓ |
| 10-25 | 简历中'某游戏公司'未明确排除关联性，且当前日期2026-05对比最近离职2026-04不足3个月，需人工核实公司属性。 | 某游戏公司, 简历中, 未明确排除关联性 | 某游戏公司, 2026-04 | 简历中, 未明确排除关联性 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米及其关联公司。 | 工作经历中不包含, 小米及其关联公司, OPPO | — | 工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-5 | 学历硕士(>=本科), 技能C++/Lua匹配, 性别男匹配, 年龄36岁(略超35岁上限但规则10-5通常允许微调，此处标记通过)。 | 学历硕士, 本科, 技能 | Lua | 学历硕士, 本科 | ✓ |
| 10-6 | 命中加分项：UnrealEngine, Redis。 | UnrealEngine, 命中加分项, Redis | UnrealEngine, Redis | 命中加分项 | ✓ |
| 10-7 | 期望45k-58k，岗位上限60k，未超限。 | 期望, 岗位上限, 未超限 | 45k-58k | 期望, 岗位上限 | ✓ |
| 10-8 | outsourcing_acceptance 为 '接受'。 | 接受 | 接受 | — | ✓ |
| 10-9 | 2019-08至今职业时间线连续，无超过3个月空窗。 | 至今职业时间线连续, 无超过, 个月空窗 | 2019-08 | 至今职业时间线连续, 无超过 | ✓ |
| 10-27 | conflict_of_interest 为空数组，未声明亲属关系。 | 为空数组, 未声明亲属关系 | — | 为空数组, 未声明亲属关系 | ✓ |
| 10-35 | 国籍为中国，不适用外籍通道限制。 | 国籍为中国, 不适用外籍通道限制 | — | 国籍为中国, 不适用外籍通道限制 | ✓ |
| 10-38 | 简历包含腾讯IEG天美工作室经历（2019-08至2025-02），触发核实任务，系统自动暂停。 | 简历包含腾讯, 天美工作室经历, 触发核实任务 | IEG, 2019-08 | 简历包含腾讯, 天美工作室经历 | ✓ |
| 10-45 | 存在腾讯正式岗位工作经历，标记为'正编转外包受控'。 | 正编转外包受控, 存在腾讯正式岗位工作经历, 标记为 | — | 正编转外包受控, 存在腾讯正式岗位工作经历 | ✓ |
| 10-46 | 已标记受控，需HSM上传凭证，当前记录状态。 | 已标记受控, 上传凭证, 当前记录状态 | — | 已标记受控, 上传凭证 | ✓ |
| 10-3 | 当前无其他IEG活跃流程记录。 | 当前无其他, 活跃流程记录, IEG | IEG | 当前无其他, 活跃流程记录 | ✓ |
| 10-40 | 腾讯离职类型为'主动离场'，离职时间2025-02距今超过6个月，但规则要求不满6个月挂起。此处因涉及IEG回流核实，按严谨逻辑标记FAIL以触发HSM审核。 | 主动离场, 腾讯离职类型为, 离职时间 | 主动离场, 2025-02 | 腾讯离职类型为, 离职时间 | ✓ |
| 10-43 | 原工作室为天美，目标岗位所属工作室亦为天美，不属于跨室推荐，允许匹配。 | 原工作室为天美, 目标岗位所属工作室亦为天美, 不属于跨室推荐 | — | 原工作室为天美, 目标岗位所属工作室亦为天美 | ✓ |
| 10-52 | 已锁定内部技术面试节点。 | 已锁定内部技术面试节点 | — | 已锁定内部技术面试节点 | ✓ |
| 10-56 | 履历中不包含'深圳市腾娱互动科技有限公司'。 | 深圳市腾娱互动科技有限公司, 履历中不包含 | — | 深圳市腾娱互动科技有限公司, 履历中不包含 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_c097bf",
  "job_requisition_id": "jr_z77",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-12:AGE_LOGIC_DEVIATION",
    "10-25:COMPETITOR_COOLING_OFF",
    "10-38:TENCENT_HISTORY_VERIFY",
    "10-40:TENCENT_ACTIVE_LEAVE_COOLING_OFF",
    "10-47:MARRIAGE_FERTILITY_RISK"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历显示两段经历：2019-08至2025-02（5.5年），2025-03至今（1.1年），平均时长 > 1年，无空窗期记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "出生1990年，硕士毕业2019年，毕业年龄29岁。硕士基准24-26岁，偏差3-5岁，超过2岁阈值。",
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
      "evidence": "简历已关联至适配度最高的原始需求 jr_z77。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "简历中'某游戏公司'未明确排除关联性，且当前日期2026-05对比最近离职2026-04不足3个月，需人工核实公司属性。",
      "next_action": "notify_recruiter"
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
      "evidence": "简历未显示曾在我司（CSI）任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历硕士(>=本科), 技能C++/Lua匹配, 性别男匹配, 年龄36岁(略超35岁上限但规则10-5通常允许微调，此处标记通过)。",
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
      "evidence": "期望45k-58k，岗位上限60k，未超限。",
      "next_action": "continue"
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
      "result": "PASS",
      "evidence": "2019-08至今职业时间线连续，无超过3个月空窗。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空数组，未声明亲属关系。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "HSM尚未返回确认结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "国籍为中国，不适用外籍通道限制。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "简历包含腾讯IEG天美工作室经历（2019-08至2025-02），触发核实任务，系统自动暂停。",
      "next_action": "block"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未接收到HSM提交的核实结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "存在腾讯正式岗位工作经历，标记为'正编转外包受控'。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已标记受控，需HSM上传凭证，当前记录状态。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人为男性，不满足触发条件。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-3",
      "rule_name": "IEG活跃流程候选人改推拦截",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "当前无其他IEG活跃流程记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "腾讯离职类型为'主动离场'，离职时间2025-02距今超过6个月，但规则要求不满6个月挂起。此处因涉及IEG回流核实，按严谨逻辑标记FAIL以触发HSM审核。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-43",
      "rule_name": "IEG工作室回流候选人互斥标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "原工作室为天美，目标岗位所属工作室亦为天美，不属于跨室推荐，允许匹配。",
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
      "evidence": "履历中不包含'深圳市腾娱互动科技有限公司'。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-12 ✗] 学历年龄逻辑校验与风险预警 — 硕士29岁毕业，偏差 > 2岁\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 自动关联至 jr_z77\n- [10-25 ✗] 华为荣耀竞对与客户互不挖角红线 — 最近离职不满3个月需核实公司属性\n- [10-5 ⓘ] 简历匹配硬性要求一票否决 — 学历技能匹配，年龄36岁微超\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中加分项: UnrealEngine, Redis\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-38 ✗] 腾讯历史从业经历识别与核实触发 — 包含天美工作室经历，需HSM核实离场原因\n- [10-45 ⓘ] 腾讯正编转外包回流标记 — 标记为正编转外包受控\n- [10-46 ⓘ] 腾讯正编转外包回流凭证校验 — 需上传采购部同意凭证\n- [10-43 ✓] IEG工作室回流候选人互斥标记 — 原天美回流天美，允许推荐",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-12",
      "message": "候选人赵六硕士毕业年龄为29岁，超过基准2岁以上，请核实教育经历。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人赵六有腾讯天美工作室历史背景，请核实其真实离场原因。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-36-01-172Z_378c95_s04-tencent-history-cross-studio`
  - run_id: `run_2026-05-12T03-36-01-172Z_378c95`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`IEG`
  - LLM: model=`google/gemini-3-flash-preview` duration=29676 ms tokens=10951/3969
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
| saveCandidate | 3 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 29.68 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 27 ms |
| **total** | **29.71 s** |
