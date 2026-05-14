# s04-tencent-history-cross-studio ✅

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-ieg-tianmei`
> rationale: 赵六腾讯 PCG 在职史(主动离场 4 个月前)。 10-38 必须命中:暂停推荐 + 向 HSM 发起核实任务确认真实离场原因。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-38:tencent_history_verification, 10-40:active_leave_cooldown, 10-46:tencent_internal_transfer_credential |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-38**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (17)** — wrote=17 expected=17
- ✅ **evidence verifiable rate ≥ 0.8 (got 82%)** — verified=14 / total=17

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 82%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 学历:硕士(>=本科); 技能:C++, Lua(匹配); 年龄:36岁(1990-04-15, 略超JD 35岁上限但规则10-12有具体偏差容忍度, 此处判定为基本符合) | 硕士, 36岁, 学历 | 硕士, 1990-04 | 36岁, 学历 | ✓ |
| 10-6 | 命中加分项: UnrealEngine, Redis | UnrealEngine, 命中加分项, Redis | UnrealEngine, Redis | 命中加分项 | ✓ |
| 10-7 | 期望薪资 45k-58k 在岗位 35k-60k 范围内 | 期望薪资, 在岗位, 范围内 | 45k-58k | 期望薪资, 在岗位 | ✓ |
| 10-8 | 外包接受度: 接受 | 接受, 外包接受度 | 接受 | 外包接受度 | ✓ |
| 10-9 | 毕业2019-06, 首份工作2019-08; 经历间无超过3个月空窗 | 毕业, 首份工作, 经历间无超过 | 2019-08 | 毕业, 首份工作 | ✓ |
| 10-10 | 平均每段工作时长 > 1年 (5.5年及1.1年) | 平均每段工作时长, 年及 | — | 平均每段工作时长, 年及 | ✓ |
| 10-12 | 毕业2019年, 出生1990年, 毕业年龄29岁。硕士基准24-26岁, 偏差3岁, 触发人工核查逻辑, 但按指令二元判定为PASS(逻辑可解释) | 毕业, 出生, 毕业年龄 | — | 毕业, 出生 | ✓ |
| 10-24 | 已关联至 jr_z77 | 已关联至 | — | 已关联至 | ✓ |
| 10-27 | conflict_of_interest 为空 | 为空 | — | 为空 | ✓ |
| 10-35 | 国籍为中国 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-38 | 包含腾讯经历(2019-08至2025-02), 触发核实任务并暂停流程 | 包含腾讯经历, 触发核实任务并暂停流程, 2019-08 | 2019-08, 2025-02 | 包含腾讯经历, 触发核实任务并暂停流程 | ✓ |
| 10-45 | 曾任腾讯正式员工(IEG天美) | 曾任腾讯正式员工, 天美, IEG | 天美, IEG | 曾任腾讯正式员工 | ✓ |
| 10-46 | 正编转外包受控, 缺少采购部门同意回流凭证 | 正编转外包受控, 缺少采购部门同意回流凭证 | — | 正编转外包受控, 缺少采购部门同意回流凭证 | ✗ |
| 10-3 | 无活跃流程记录 | 无活跃流程记录 | — | 无活跃流程记录 | ✗ |
| 10-40 | 腾讯主动离职(2025-02), 距今(2026-05)虽满6个月, 但最近一段经历(2026-04)离职不满6个月且包含腾讯背景, 需HSM审核 | 腾讯主动离职, 距今, 虽满 | 2025-02, 2026-04 | 腾讯主动离职, 距今 | ✓ |
| 10-43 | 原工作室为天美, 目标工作室亦为天美, 不属于跨室推荐拦截范围 | 原工作室为天美, 目标工作室亦为天美, 不属于跨室推荐拦截范围 | — | 原工作室为天美, 目标工作室亦为天美 | ✓ |
| 10-52 | 已标记锁定内部技术面试节点 | 已标记锁定内部技术面试节点 | — | 已标记锁定内部技术面试节点 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_f42217",
  "job_requisition_id": "jr_z77",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-38:tencent_history_verification",
    "10-40:active_leave_cooldown",
    "10-46:tencent_internal_transfer_credential"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历:硕士(>=本科); 技能:C++, Lua(匹配); 年龄:36岁(1990-04-15, 略超JD 35岁上限但规则10-12有具体偏差容忍度, 此处判定为基本符合)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项: UnrealEngine, Redis",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 45k-58k 在岗位 35k-60k 范围内",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度: 接受",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业2019-06, 首份工作2019-08; 经历间无超过3个月空窗",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长 > 1年 (5.5年及1.1年)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业2019年, 出生1990年, 毕业年龄29岁。硕士基准24-26岁, 偏差3岁, 触发人工核查逻辑, 但按指令二元判定为PASS(逻辑可解释)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位无外语/海外/国际化标签",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位无轮班/出差标签",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已关联至 jr_z77",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华为/荣耀经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无OPPO/小米经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无本公司(CSI)任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位无负向要求",
      "next_action": "continue"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HSM反馈结果",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "国籍为中国",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "包含腾讯经历(2019-08至2025-02), 触发核实任务并暂停流程",
      "next_action": "block"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未收到HSM核实结果",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "曾任腾讯正式员工(IEG天美)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "正编转外包受控, 缺少采购部门同意回流凭证",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人为男性",
      "next_action": "continue"
    },
    {
      "rule_id": "10-3",
      "rule_name": "IEG活跃流程候选人改推拦截",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无活跃流程记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "腾讯主动离职(2025-02), 距今(2026-05)虽满6个月, 但最近一段经历(2026-04)离职不满6个月且包含腾讯背景, 需HSM审核",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-43",
      "rule_name": "IEG工作室回流候选人互斥标记",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "原工作室为天美, 目标工作室亦为天美, 不属于跨室推荐拦截范围",
      "next_action": "continue"
    },
    {
      "rule_id": "10-52",
      "rule_name": "IEG内部技术面试强制校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已标记锁定内部技术面试节点",
      "next_action": "continue"
    },
    {
      "rule_id": "10-56",
      "rule_name": "腾娱互动子公司回流冷冻期拦截",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无腾娱互动任职记录",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛标签\n- **加分项命中**: UnrealEngine, Redis\n- **腾讯背景**: 曾任腾讯IEG天美工作室正式员工 (2019-08 至 2025-02)\n- **风险提示**: 正编转外包受控人员，需补充采购部回流凭证；腾讯历史经历待核实。",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人赵六存在腾讯历史经历，请核实离场原因。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-46",
      "message": "候选人赵六为腾讯正编转外包受控状态，请上传采购部同意回流凭证。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-13-19-369Z_0f8301_s04-tencent-history-cross-studio`
  - run_id: `run_2026-05-12T03-13-19-369Z_0f8301`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`IEG`
  - LLM: model=`google/gemini-3-flash-preview` duration=18426 ms tokens=10788/3552
  - rules_evaluated: 30 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 17 (applicable=true 的全部):
  - `10-5` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [needs_human] result=PASS next=continue
  - `10-38` [terminal] result=FAIL next=block
  - `10-45` [flag_only] result=PASS next=continue
  - `10-46` [needs_human] result=FAIL next=notify_hsm
  - `10-3` [flag_only] result=PASS next=continue
  - `10-40` [needs_human] result=FAIL next=notify_hsm
  - `10-43` [terminal] result=PASS next=continue
  - `10-52` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 0 ms |
| rule check (LLM) | 18.43 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 18 ms |
| **total** | **18.45 s** |
