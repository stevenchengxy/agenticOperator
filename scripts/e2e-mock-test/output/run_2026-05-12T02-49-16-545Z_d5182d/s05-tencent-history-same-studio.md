# s05-tencent-history-same-studio ❌

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-cdg-data`
> rationale: 同候选人推 CDG 岗位,10-38 必命中。10-42 CDG 6 个月拦截虽适用此岗位 client/部门 维度,但候选人是 PCG 史不是 CDG 史,应该 result=PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-5:SKILL_MISMATCH, 10-7:SALARY_EXCEEDED, 10-38:TENCENT_HISTORY_VERIFY, 10-42:CDG_COOLING_OFF_VIOLATION, 10-46:TENCENT_INTERNAL_TRANSFER_LOCKED |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-38**
- ❌ **must-pass rule applicable+PASS: 10-42** — applicable=true result=FAIL
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (15)** — wrote=15 expected=15
- ❌ **evidence verifiable rate ≥ 0.8 (got 53%)** — verified=8 / total=15

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 53%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | JD要求必备技能 Python, SQL; 简历技能为 C++, Lua, Redis, UnrealEngine。不包含 Python/SQL。 | 要求必备技能, 简历技能为, 不包含 | Lua, Redis | 要求必备技能, 简历技能为 | ✓ |
| 10-6 | 候选人拥有北京大学硕士学历，符合JD本科要求。 | 候选人拥有北京大学硕士学历, 符合, 本科要求 | — | 候选人拥有北京大学硕士学历, 符合 | ✗ |
| 10-7 | 候选人期望薪资 45k-58k，高于岗位上限 40k。由于技能不匹配(10-5)，综合得分无法达到90分，判定为薪资不匹配。 | 候选人期望薪资, 高于岗位上限, 由于技能不匹配 | 45k-58k | 候选人期望薪资, 高于岗位上限 | ✓ |
| 10-8 | outsourcing_acceptance: 接受 | 接受 | 接受 | — | ✓ |
| 10-9 | 毕业时间2019，首份工作2019-08；两段工作间无超过3个月空窗。 | 毕业时间, 首份工作, 两段工作间无超过 | 2019-08 | 毕业时间, 首份工作 | ✓ |
| 10-10 | 平均每段工作时长超过1年（第一段5.5年，第二段1.1年）。 | 平均每段工作时长超过, 第一段, 第二段 | — | 平均每段工作时长超过, 第一段 | ✗ |
| 10-12 | 1990年出生，2019年硕士毕业，毕业年龄29岁。硕士基准24-26岁，偏差3岁。虽有偏差但逻辑基本合理，按规则偏差≥2岁需人工，此处标记为PASS因不属于拒绝项，但需注意逻辑。 | 年出生, 年硕士毕业, 毕业年龄 | — | 年出生, 年硕士毕业 | ✗ |
| 10-24 | 简历已关联至原始需求 jr_y88。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✗ |
| 10-27 | conflict_of_interest 为空数组。 | 为空数组 | — | 为空数组 | ✗ |
| 10-35 | nationality: 中国 | 中国, nationality | 中国, nationality | — | ✓ |
| 10-38 | 简历包含腾讯 IEG 天美工作室经历。系统需暂停并由 HSM 核实离场原因。 | 简历包含腾讯, 天美工作室经历, 系统需暂停并由 | IEG | 简历包含腾讯, 天美工作室经历 | ✓ |
| 10-45 | former_tencent_employment.employment_type: 正式 | 正式 | 正式 | — | ✓ |
| 10-46 | 候选人为腾讯正编回流，系统锁定流程，需上传采购部同意回流凭证。 | 候选人为腾讯正编回流, 系统锁定流程, 需上传采购部同意回流凭证 | — | 候选人为腾讯正编回流, 系统锁定流程 | ✗ |
| 10-42 | 目标岗位为 CDG，候选人最近一次腾讯离职日期为 2025-02，当前日期 2026-05，虽已满6个月，但规则要求核实历史经历，且 10-38 已触发拦截。 | 目标岗位为, 候选人最近一次腾讯离职日期为, 当前日期 | 2025-02 | 目标岗位为, 候选人最近一次腾讯离职日期为 | ✓ |
| 10-53 | 目标事业群为 CDG，符合跳过面试条件。 | 目标事业群为, 符合跳过面试条件, CDG | — | 目标事业群为, 符合跳过面试条件 | ✗ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_18a8d5",
  "job_requisition_id": "jr_y88",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-5:SKILL_MISMATCH",
    "10-7:SALARY_EXCEEDED",
    "10-38:TENCENT_HISTORY_VERIFY",
    "10-42:CDG_COOLING_OFF_VIOLATION",
    "10-46:TENCENT_INTERNAL_TRANSFER_LOCKED"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "JD要求必备技能 Python, SQL; 简历技能为 C++, Lua, Redis, UnrealEngine。不包含 Python/SQL。",
      "next_action": "block"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人拥有北京大学硕士学历，符合JD本科要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人期望薪资 45k-58k，高于岗位上限 40k。由于技能不匹配(10-5)，综合得分无法达到90分，判定为薪资不匹配。",
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
      "evidence": "毕业时间2019，首份工作2019-08；两段工作间无超过3个月空窗。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长超过1年（第一段5.5年，第二段1.1年）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1990年出生，2019年硕士毕业，毕业年龄29岁。硕士基准24-26岁，偏差3岁。虽有偏差但逻辑基本合理，按规则偏差≥2岁需人工，此处标记为PASS因不属于拒绝项，但需注意逻辑。",
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
      "evidence": "former_csi_employment 为 null。",
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
      "evidence": "简历包含腾讯 IEG 天美工作室经历。系统需暂停并由 HSM 核实离场原因。",
      "next_action": "block"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未收到 HSM 核实结果。",
      "next_action": "continue"
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
      "evidence": "候选人为腾讯正编回流，系统锁定流程，需上传采购部同意回流凭证。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "gender: 男",
      "next_action": "continue"
    },
    {
      "rule_id": "10-42",
      "rule_name": "CDG事业群6个月回流冷冻期绝对拦截",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "目标岗位为 CDG，候选人最近一次腾讯离职日期为 2025-02，当前日期 2026-05，虽已满6个月，但规则要求核实历史经历，且 10-38 已触发拦截。",
      "next_action": "block"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标事业群为 CDG，符合跳过面试条件。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛风险提示\n- **硬性技能不符**: 简历缺少 JD 要求的 Python 和 SQL 技能。\n- **薪资超限**: 期望薪资 (45k-58k) 显著高于岗位预算 (25k-40k)。\n- **腾讯回流受控**: 候选人为腾讯 IEG 前正式员工，推荐至 CDG 需核实离场原因并上传采购部回流凭证。\n- **流程优化**: 该岗位属于 CDG，已自动标记跳过内部技术面试环节。",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人赵六有腾讯历史经历，请核实其在天美工作室的真实离场原因。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-46",
      "message": "候选人赵六为腾讯正编转外包回流，请上传腾讯采购部出具的同意回流书面凭证。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T02-49-16-545Z_d5182d_s05-tencent-history-same-studio`
  - run_id: `run_2026-05-12T02-49-16-545Z_d5182d`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`google/gemini-3-flash-preview` duration=18345 ms tokens=9777/3377
  - rules_evaluated: 27 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 15 (applicable=true 的全部):
  - `10-5` [terminal] result=FAIL next=block
  - `10-6` [flag_only] result=PASS next=continue
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
| rule check (LLM) | 18.34 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 69 ms |
| **total** | **18.42 s** |
