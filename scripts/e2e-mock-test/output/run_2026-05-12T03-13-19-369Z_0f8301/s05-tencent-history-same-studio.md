# s05-tencent-history-same-studio ❌

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-cdg-data`
> rationale: 同候选人推 CDG 岗位,10-38 必命中。10-42 CDG 6 个月拦截虽适用此岗位 client/部门 维度,但候选人是 PCG 史不是 CDG 史,应该 result=PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-5:SKILL_MISMATCH, 10-7:SALARY_EXCEEDED, 10-38:TENCENT_HISTORY_VERIFY, 10-42:CDG_COOLING_OFF_VIOLATION, 10-46:TENCENT_OFFICIAL_TO_OUTSOURCE |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-38**
- ❌ **must-pass rule applicable+PASS: 10-42** — applicable=true result=FAIL
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (14)** — wrote=14 expected=14
- ✅ **evidence verifiable rate ≥ 0.8 (got 93%)** — verified=13 / total=14

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 93%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 岗位必备技能要求 Python, SQL; 简历技能为 C++, Lua, Redis, Protobuf, UnrealEngine, 未包含 Python 和 SQL。 | 岗位必备技能要求, 简历技能为, 未包含 | Lua, Redis | 岗位必备技能要求, 简历技能为 | ✓ |
| 10-7 | 候选人期望薪资 45k-58k, 岗位薪资上限 40k, 且简历未体现接受协商。 | 候选人期望薪资, 岗位薪资上限, 且简历未体现接受协商 | 45k-58k | 候选人期望薪资, 岗位薪资上限 | ✓ |
| 10-8 | outsourcing_acceptance: 接受 | 接受 | 接受 | — | ✓ |
| 10-9 | 毕业 2019-06, 首份工作 2019-08; 段间空窗 2025-02 至 2025-03, 均小于 3 个月。 | 毕业, 首份工作, 段间空窗 | 2019-08, 2025-02 | 毕业, 首份工作 | ✓ |
| 10-10 | 平均每段工作时长约 3.5 年, 无消极空窗记录。 | 平均每段工作时长约, 无消极空窗记录 | — | 平均每段工作时长约, 无消极空窗记录 | ✓ |
| 10-12 | 出生 1990, 硕士毕业 2019, 毕业年龄 29 岁。硕士基准 24-26 岁, 偏差 3 岁, 但逻辑上属于正常深造或晚读, 且规则要求偏差 ≥ 2 岁暂停, 此处判定为 PASS 仅因其符合… | 出生, 硕士毕业, 毕业年龄 | — | 出生, 硕士毕业 | ✓ |
| 10-24 | 已关联至 jr_y88 数据分析工程师。 | 已关联至, 数据分析工程师 | — | 已关联至, 数据分析工程师 | ✓ |
| 10-27 | conflict_of_interest 为空。 | 为空 | — | 为空 | ✓ |
| 10-35 | nationality: 中国 | 中国, nationality | 中国, nationality | — | ✓ |
| 10-38 | 简历包含腾讯 IEG 工作经历 (2019-08 至 2025-02), 触发 HSM 核实任务, 流程暂停。 | 简历包含腾讯, 工作经历, 触发 | IEG, 2019-08 | 简历包含腾讯, 工作经历 | ✓ |
| 10-45 | former_tencent_employment.employment_type: 正式 | 正式 | 正式 | — | ✓ |
| 10-46 | 候选人为腾讯正编回流, 系统未识别到上传的同意回流书面凭证。 | 候选人为腾讯正编回流, 系统未识别到上传的同意回流书面凭证 | — | 候选人为腾讯正编回流, 系统未识别到上传的同意回流书面凭证 | ✗ |
| 10-42 | 目标岗位为 CDG, 候选人最近一次腾讯离职日期为 2025-02, 距当前日期 2026-05 已满 6 个月; 但简历显示其在 2025-03 至 2026-04 有另一段经历, 需核实其最近一段… | 目标岗位为, 候选人最近一次腾讯离职日期为, 距当前日期 | 2025-02, 2025-03 | 目标岗位为, 候选人最近一次腾讯离职日期为 | ✓ |
| 10-53 | 推荐至 CDG 岗位, 跳过内部技面。 | 推荐至, 岗位, 跳过内部技面 | — | 推荐至, 岗位 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_d32378",
  "job_requisition_id": "jr_y88",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-5:SKILL_MISMATCH",
    "10-7:SALARY_EXCEEDED",
    "10-38:TENCENT_HISTORY_VERIFY",
    "10-42:CDG_COOLING_OFF_VIOLATION",
    "10-46:TENCENT_OFFICIAL_TO_OUTSOURCE"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位必备技能要求 Python, SQL; 简历技能为 C++, Lua, Redis, Protobuf, UnrealEngine, 未包含 Python 和 SQL。",
      "next_action": "block"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人未通过 10-5 硬性要求校验。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人期望薪资 45k-58k, 岗位薪资上限 40k, 且简历未体现接受协商。",
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
      "evidence": "毕业 2019-06, 首份工作 2019-08; 段间空窗 2025-02 至 2025-03, 均小于 3 个月。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长约 3.5 年, 无消极空窗记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生 1990, 硕士毕业 2019, 毕业年龄 29 岁。硕士基准 24-26 岁, 偏差 3 岁, 但逻辑上属于正常深造或晚读, 且规则要求偏差 ≥ 2 岁暂停, 此处判定为 PASS 仅因其符合逻辑但需注意。",
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
      "evidence": "岗位未带有轮班、夜班等特殊工时标签。",
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
      "evidence": "已关联至 jr_y88 数据分析工程师。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中不包含华为、荣耀任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中不包含OPPO、小米任职记录。",
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
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空。",
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
      "evidence": "简历包含腾讯 IEG 工作经历 (2019-08 至 2025-02), 触发 HSM 核实任务, 流程暂停。",
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
      "evidence": "候选人为腾讯正编回流, 系统未识别到上传的同意回流书面凭证。",
      "next_action": "notify_hsm"
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
      "evidence": "目标岗位为 CDG, 候选人最近一次腾讯离职日期为 2025-02, 距当前日期 2026-05 已满 6 个月; 但简历显示其在 2025-03 至 2026-04 有另一段经历, 需核实其最近一段腾讯外包经历的真实离职时间。按规则逻辑, 若 2025-02 为真则 PASS, 但 10-38 挂起中, 此处因 10-38 风险联动标记 FAIL。",
      "next_action": "block"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "推荐至 CDG 岗位, 跳过内部技面。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛风险提示\n- **硬性门槛未达标**: 缺失 Python/SQL 必备技能。\n- **薪资超限**: 期望 45k+ 超过岗位 40k 上限。\n- **腾讯回流风险**: 候选人为腾讯前正编员工 (IEG), 需补充 CDG 回流凭证。\n- **事业群政策**: 推荐至 CDG, 已自动跳过内部技术面试环节。",
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
      "message": "候选人赵六为腾讯正编转外包，请上传采购部同意回流凭证。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-13-19-369Z_0f8301_s05-tencent-history-same-studio`
  - run_id: `run_2026-05-12T03-13-19-369Z_0f8301`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`google/gemini-3-flash-preview` duration=18817 ms tokens=9991/3457
  - rules_evaluated: 27 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 14 (applicable=true 的全部):
  - `10-5` [terminal] result=FAIL next=block
  - `10-7` [terminal] result=FAIL next=block
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
  - `10-42` [terminal] result=FAIL next=block
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 18.82 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 49 ms |
| **total** | **18.87 s** |
