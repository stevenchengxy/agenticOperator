# s05-tencent-history-same-studio ❌

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-cdg-data`
> rationale: 同候选人推 CDG 岗位,10-38 必命中。10-42 CDG 6 个月拦截虽适用此岗位 client/部门 维度,但候选人是 PCG 史不是 CDG 史,应该 result=PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | PAUSE | DROP |
| must-fail rules | 10-38 | 10-5:SKILL_MISMATCH, 10-7:SALARY_EXCEEDED, 10-42:CDG_COOLING_PERIOD, 10-12:AGE_LOGIC_EXCEPTION, 10-46:TX_OFFICIAL_RETURN_VOUCHER |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (PAUSE)**
- ❌ **must-fail rule fired: 10-38** — LLM 没有把 10-38 标为 fail/pause/hit
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
| 10-5 | 岗位要求必备技能 Python, SQL; 简历技能为 C++, Lua, Redis, Protobuf, UnrealEngine。不匹配。 | 岗位要求必备技能, 简历技能为, 不匹配 | Lua, Redis | 岗位要求必备技能, 简历技能为 | ✓ |
| 10-6 | 候选人未通过硬性要求校验，不适用加分项识别。 | 候选人未通过硬性要求校验, 不适用加分项识别 | — | 候选人未通过硬性要求校验, 不适用加分项识别 | ✗ |
| 10-7 | 候选人期望薪资 45k-58k，岗位上限 40k。且因技能不匹配得分低于90分。 | 候选人期望薪资, 岗位上限, 且因技能不匹配得分低于 | 45k-58k | 候选人期望薪资, 岗位上限 | ✓ |
| 10-8 | outsourcing_acceptance: 接受 | 接受 | 接受 | — | ✓ |
| 10-9 | 2019年毕业即入职腾讯，2025年2月离职后2025年3月入职新公司，无超过3个月空窗期。 | 年毕业即入职腾讯, 月离职后, 月入职新公司 | — | 年毕业即入职腾讯, 月离职后 | ✗ |
| 10-10 | 平均每段工作时长超过1年（腾讯经历5.5年）。 | 平均每段工作时长超过, 腾讯经历 | — | 平均每段工作时长超过, 腾讯经历 | ✗ |
| 10-12 | 1990年出生，2019年硕士毕业，毕业年龄29岁。硕士基准24-26岁，偏差3-5岁，大于2岁。 | 年出生, 年硕士毕业, 毕业年龄 | — | 年出生, 年硕士毕业 | ✗ |
| 10-24 | 已关联至原始需求 jr_y88。 | 已关联至原始需求 | — | 已关联至原始需求 | ✗ |
| 10-27 | conflict_of_interest 为空。 | 为空 | — | 为空 | ✗ |
| 10-35 | nationality: 中国 | 中国, nationality | 中国, nationality | — | ✓ |
| 10-38 | former_tencent_employment.leave_type: 主动离场 | 主动离场 | 主动离场 | — | ✓ |
| 10-45 | former_tencent_employment.employment_type: 正式 | 正式 | 正式 | — | ✓ |
| 10-46 | 候选人为正编转外包受控状态，简历未提供回流凭证。 | 候选人为正编转外包受控状态, 简历未提供回流凭证 | — | 候选人为正编转外包受控状态, 简历未提供回流凭证 | ✓ |
| 10-42 | 目标岗位CDG；候选人腾讯离职日期2025-02，当前日期2026-05，间隔已满6个月。但规则逻辑要求计算最近一次腾讯离职，此处PASS。修正：逻辑判定为PASS。 | 逻辑判定为PASS, 目标岗位, 候选人腾讯离职日期 | 2025-02 | 逻辑判定为PASS, 目标岗位 | ✓ |
| 10-53 | 目标事业群为 CDG。 | 目标事业群为, CDG | — | 目标事业群为, CDG | ✗ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_1e76e7",
  "job_requisition_id": "jr_y88",
  "client_id": "CLI_TENCENT",
  "overall_decision": "DROP",
  "drop_reasons": [
    "10-5:SKILL_MISMATCH",
    "10-7:SALARY_EXCEEDED",
    "10-42:CDG_COOLING_PERIOD"
  ],
  "pause_reasons": [
    "10-12:AGE_LOGIC_EXCEPTION",
    "10-46:TX_OFFICIAL_RETURN_VOUCHER"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求必备技能 Python, SQL; 简历技能为 C++, Lua, Redis, Protobuf, UnrealEngine。不匹配。",
      "next_action": "block"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人未通过硬性要求校验，不适用加分项识别。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人期望薪资 45k-58k，岗位上限 40k。且因技能不匹配得分低于90分。",
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
      "evidence": "2019年毕业即入职腾讯，2025年2月离职后2025年3月入职新公司，无超过3个月空窗期。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长超过1年（腾讯经历5.5年）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "REVIEW",
      "evidence": "1990年出生，2019年硕士毕业，毕业年龄29岁。硕士基准24-26岁，偏差3-5岁，大于2岁。",
      "next_action": "pause"
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
      "evidence": "岗位未带有轮班、出差等特殊工作制标签。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已关联至原始需求 jr_y88。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "工作经历中不包含华为、荣耀。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "工作经历中不包含OPPO、小米。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无我司（CSI）任职记录。",
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
      "evidence": "无HSM反馈结果。",
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
      "result": "PASS",
      "evidence": "former_tencent_employment.leave_type: 主动离场",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HSM反馈结果。",
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
      "result": "REVIEW",
      "evidence": "候选人为正编转外包受控状态，简历未提供回流凭证。",
      "next_action": "pause"
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
      "evidence": "目标岗位CDG；候选人腾讯离职日期2025-02，当前日期2026-05，间隔已满6个月。但规则逻辑要求计算最近一次腾讯离职，此处PASS。修正：逻辑判定为PASS。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标事业群为 CDG。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 简历预筛标签\n- **薪资超限**: 期望 45k-58k 远超岗位 40k 上限\n- **技能不符**: 缺少 Python/SQL 核心技能\n- **年龄逻辑异常**: 29岁硕士毕业，需核实\n- **腾讯正编背景**: 曾任职腾讯IEG天美工作室（正式）\n- **免内测**: 投递CDG事业群，跳过内部技术面试",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-12",
      "message": "候选人赵六毕业年龄(29岁)与硕士学历基准偏差较大，请核实教育经历。"
    },
    {
      "recipient": "HSM",
      "channel": "Email",
      "rule_id": "10-46",
      "message": "候选人赵六为腾讯正编回流，请获取并上传腾讯采购部同意回流凭证。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T02-36-07-829Z_15f9dd_s05-tencent-history-same-studio`
  - run_id: `run_2026-05-12T02-36-07-829Z_15f9dd`
  - decision: FAIL / DROP
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`google/gemini-3-flash-preview` duration=18594 ms tokens=8955/3303
  - rules_evaluated: 27 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 15 (applicable=true 的全部):
  - `10-5` [terminal] result=FAIL next=block
  - `10-6` [flag_only] result=NOT_APPLICABLE next=continue
  - `10-7` [terminal] result=FAIL next=block
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
  - `10-42` [terminal] result=FAIL next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 18.59 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 18 ms |
| **total** | **18.62 s** |
