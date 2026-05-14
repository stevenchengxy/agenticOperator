# s04-tencent-history-cross-studio ❌

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-ieg-tianmei`
> rationale: 赵六腾讯 PCG 在职史(主动离场 4 个月前)。 10-38 必须命中:暂停推荐 + 向 HSM 发起核实任务确认真实离场原因。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | PAUSE | PAUSE |
| must-fail rules | 10-38 | 10-12:age_logic_anomaly, 10-40:active_leave_cooling_period, 10-46:official_to_outsource_verification |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (PAUSE)**
- ❌ **must-fail rule fired: 10-38** — LLM 没有把 10-38 标为 fail/pause/hit
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (19)** — wrote=19 expected=19
- ❌ **evidence verifiable rate ≥ 0.8 (got 63%)** — verified=12 / total=19

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 63%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 学历:硕士(JD:本科); 技能:C++, Lua(JD:C++, Lua); 年龄:36岁(JD:22-35), 虽略超但规则10-5通常执行准入比对, 核心技能与学历均符合。 | 硕士, 本科, 36岁 | 硕士, Lua | 本科, 36岁 | ✓ |
| 10-6 | 命中加分项: UnrealEngine, Redis | UnrealEngine, 命中加分项, Redis | UnrealEngine, Redis | 命中加分项 | ✓ |
| 10-7 | 期望薪资: 45k-58k; 岗位薪资: 35k-60k | 45k-58k, 35k-60k, 期望薪资 | 45k-58k | 35k-60k, 期望薪资 | ✓ |
| 10-8 | 外包接受度: 接受 | 接受, 外包接受度 | 接受 | 外包接受度 | ✓ |
| 10-9 | 2019-07毕业, 2019-08入职腾讯; 2025-02离职腾讯, 2025-03入职某公司。无超过3个月空窗。 | 毕业, 入职腾讯, 离职腾讯 | 2019-08, 2025-02 | 毕业, 入职腾讯 | ✓ |
| 10-10 | 平均每段工作时长: 腾讯经历5.5年, 某公司经历1.1年, 稳定性良好。 | 腾讯经历5.5年, 平均每段工作时长, 腾讯经历 | — | 腾讯经历5.5年, 平均每段工作时长 | ✗ |
| 10-12 | 1990年出生, 2019年硕士毕业, 毕业年龄29岁。硕士基准24-26岁, 偏差3-5岁, 大于2岁。 | 年出生, 年硕士毕业, 毕业年龄 | — | 年出生, 年硕士毕业 | ✗ |
| 10-24 | 关联至原始需求: TC-IEG-GAME-2026-005 | TC-IEG-GAME-2026-005, 关联至原始需求, IEG | IEG | TC-IEG-GAME-2026-005, 关联至原始需求 | ✓ |
| 10-27 | conflict_of_interest 为空 | 为空 | — | 为空 | ✗ |
| 10-35 | 国籍: 中国 | 中国, 国籍 | 中国 | 国籍 | ✓ |
| 10-38 | 包含腾讯经历, 离场类型为'主动离场', 需HSM核实但非淘汰退场。 | 主动离场, 包含腾讯经历, 离场类型为 | 主动离场 | 包含腾讯经历, 离场类型为 | ✓ |
| 10-45 | 腾讯经历 employment_type: 正式 | 正式, 腾讯经历 | 正式 | 腾讯经历 | ✓ |
| 10-46 | 候选人为正编转外包受控状态, 需上传同意回流书面凭证。 | 候选人为正编转外包受控状态, 需上传同意回流书面凭证 | — | 候选人为正编转外包受控状态, 需上传同意回流书面凭证 | ✗ |
| 10-47 | 性别: 男 | 性别 | — | 性别 | ✗ |
| 10-3 | 当前无活跃流程记录 | 当前无活跃流程记录 | — | 当前无活跃流程记录 | ✗ |
| 10-40 | 腾讯离职时间: 2025-02, 当前日期: 2026-05, 间隔已超6个月。但规则描述中若涉及IEG工作室回流需综合判定, 此处因10-43冲突需人工介入。 | 2025-02, 2026-05, 腾讯离职时间 | 2025-02, IEG | 2026-05, 腾讯离职时间 | ✓ |
| 10-43 | 原工作室: 天美, 目标工作室: 天美。允许回流原工作室。 | 天美, 原工作室, 目标工作室 | 天美 | 原工作室, 目标工作室 | ✓ |
| 10-52 | 推荐至IEG, 锁定内部技面节点。 | 推荐至, 锁定内部技面节点, IEG | IEG | 推荐至, 锁定内部技面节点 | ✓ |
| 10-56 | 无腾娱互动任职记录 | 无腾娱互动任职记录 | — | 无腾娱互动任职记录 | ✗ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_85b69f",
  "job_requisition_id": "jr_z77",
  "client_id": "CLI_TENCENT",
  "overall_decision": "PAUSE",
  "drop_reasons": [],
  "pause_reasons": [
    "10-12:age_logic_anomaly",
    "10-40:active_leave_cooling_period",
    "10-46:official_to_outsource_verification"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历:硕士(JD:本科); 技能:C++, Lua(JD:C++, Lua); 年龄:36岁(JD:22-35), 虽略超但规则10-5通常执行准入比对, 核心技能与学历均符合。",
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
      "evidence": "期望薪资: 45k-58k; 岗位薪资: 35k-60k",
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
      "evidence": "2019-07毕业, 2019-08入职腾讯; 2025-02离职腾讯, 2025-03入职某公司。无超过3个月空窗。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长: 腾讯经历5.5年, 某公司经历1.1年, 稳定性良好。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "REVIEW",
      "evidence": "1990年出生, 2019年硕士毕业, 毕业年龄29岁。硕士基准24-26岁, 偏差3-5岁, 大于2岁。",
      "next_action": "pause"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "JD未明确要求语言证书类型",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位未带有轮班、夜班、倒班或长期出差标签",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未提供华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未提供华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未提供华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "关联至原始需求: TC-IEG-GAME-2026-005",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未提供华为、荣耀任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未提供OPPO、小米任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未提供曾在我司(CSI)任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "JD负向要求为空",
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
      "evidence": "国籍: 中国",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "包含腾讯经历, 离场类型为'主动离场', 需HSM核实但非淘汰退场。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HSM反馈结果",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "腾讯经历 employment_type: 正式",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "REVIEW",
      "evidence": "候选人为正编转外包受控状态, 需上传同意回流书面凭证。",
      "next_action": "pause"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "性别: 男",
      "next_action": "continue"
    },
    {
      "rule_id": "10-3",
      "rule_name": "IEG活跃流程候选人改推拦截",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "当前无活跃流程记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "REVIEW",
      "evidence": "腾讯离职时间: 2025-02, 当前日期: 2026-05, 间隔已超6个月。但规则描述中若涉及IEG工作室回流需综合判定, 此处因10-43冲突需人工介入。",
      "next_action": "pause"
    },
    {
      "rule_id": "10-43",
      "rule_name": "IEG工作室回流候选人互斥标记",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "原工作室: 天美, 目标工作室: 天美。允许回流原工作室。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-52",
      "rule_name": "IEG内部技术面试强制校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "推荐至IEG, 锁定内部技面节点。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-56",
      "rule_name": "腾娱互动子公司回流冷冻期拦截",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无腾娱互动任职记录",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 简历预筛分析报告\n\n**核心匹配项:**\n- **加分项命中:** 候选人具备 `UnrealEngine` 和 `Redis` 经验，符合 JD Nice-to-have 要求。\n- **腾讯背景:** 候选人曾任职于腾讯 IEG 天美工作室（正式员工），负责《王者荣耀》后端，与目标岗位高度对标。\n\n**风险预警:**\n- **学历年龄异常 (10-12):** 候选人 29 岁硕士毕业，超出常规教育周期基准，需核实是否存在复读或工作后考研情况。\n- **正编转外包 (10-46):** 候选人为腾讯正编离职，需 HSM 获取并上传腾讯采购部同意回流的书面凭证。\n- **稳定性:** 腾讯任职超过 5 年，职业稳定性极佳。",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-12",
      "message": "候选人赵六毕业年龄(29岁)与硕士学历基准偏差较大，请人工核查教育周期年限。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-46",
      "message": "候选人赵六属于腾讯正编转外包受控人员，请获取并上传腾讯采购部门出具的同意回流书面凭证。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T02-36-07-829Z_15f9dd_s04-tencent-history-cross-studio`
  - run_id: `run_2026-05-12T02-36-07-829Z_15f9dd`
  - decision: FAIL / PAUSE
  - dims: client=`腾讯` BG=`IEG`
  - LLM: model=`google/gemini-3-flash-preview` duration=17244 ms tokens=9731/3745
  - rules_evaluated: 30 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 19 (applicable=true 的全部):
  - `10-5` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=REVIEW next=pause
  - `10-24` [flag_only] result=PASS next=continue
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [needs_human] result=PASS next=continue
  - `10-38` [terminal] result=PASS next=continue
  - `10-45` [flag_only] result=PASS next=continue
  - `10-46` [needs_human] result=REVIEW next=pause
  - `10-47` [needs_human] result=PASS next=continue
  - `10-3` [flag_only] result=PASS next=continue
  - `10-40` [needs_human] result=REVIEW next=pause
  - `10-43` [terminal] result=PASS next=continue
  - `10-52` [flag_only] result=PASS next=continue
  - `10-56` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 3 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 17.24 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 20 ms |
| **total** | **17.27 s** |
