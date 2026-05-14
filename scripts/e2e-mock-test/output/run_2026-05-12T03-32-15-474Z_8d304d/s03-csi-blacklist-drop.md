# s03-csi-blacklist-drop ✅

> scenario: candidate=`c03-wangwu-csi-blacklist` × jd=`jr-tencent-pcg-frontend`
> rationale: 王五在中软国际离职原因 A15(劳动纠纷),命中 10-17 通用黑名单高风险类型,系统自动判定不予录用,立即终止匹配流程。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-17 | 10-17:high_risk_blacklist, 10-5:hard_requirement_mismatch, 10-7:salary_mismatch, 10-9:gap_period_unexplained |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-17**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (19)** — wrote=19 expected=19
- ✅ **evidence verifiable rate ≥ 0.8 (got 89%)** — verified=17 / total=19

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 89%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长约 1.5 年（2020-03至2023-05, 2023-06至2026-04），未命中稳定性风险。 | 平均每段工作时长约, 未命中稳定性风险, 2020-03 | 2020-03, 2023-05 | 平均每段工作时长约, 未命中稳定性风险 | ✓ |
| 10-12 | 出生1988年，本科毕业2014年，毕业年龄26岁，对比基准23岁偏差3岁，触发人工核查。 | 出生, 本科毕业, 毕业年龄 | — | 出生, 本科毕业 | ✗ |
| 10-14 | 岗位要求CET-6 480以上，候选人仅提供CET-4，分数未提供，判定不匹配。 | 岗位要求, 以上, 候选人仅提供 | CET-4, CET | 岗位要求, 以上 | ✓ |
| 10-16 | 候选人曾就职于华腾，离职原因为有犯罪记录(YCH)，虽包含B8编码但规则要求非高风险编码才放行，此处命中风险。 | 候选人曾就职于华腾, 离职原因为有犯罪记录, 虽包含 | YCH | 候选人曾就职于华腾, 离职原因为有犯罪记录 | ✓ |
| 10-17 | 候选人曾就职于华腾，离职编码为B8（有犯罪记录），属于高风险类型，判定不予录用。 | 候选人曾就职于华腾, 离职编码为, 有犯罪记录 | 有犯罪记录 | 候选人曾就职于华腾, 离职编码为 | ✓ |
| 10-18 | 离职编码为B8，非A13(1)EHS类。 | 离职编码为, A13, EHS | — | 离职编码为, A13 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_x99。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-25 | 工作经历中不包含华为、荣耀记录。 | 工作经历中不包含华为, 荣耀记录 | — | 工作经历中不包含华为, 荣耀记录 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米记录。 | 工作经历中不包含, 小米记录, OPPO | — | 工作经历中不包含, 小米记录 | ✓ |
| 10-5 | 技能不匹配：岗位要求React/TypeScript，候选人简历仅包含Java/Spring Boot；语言不匹配：要求CET-6，候选人为CET-4。 | 岗位要求React/TypeScript, 要求CET-6, 技能不匹配 | CET-4, Java | 岗位要求React/TypeScript, 要求CET-6 | ✓ |
| 10-54 | 负向要求为不接受外包超过2年，候选人最近一段为互联网公司，前一段华腾为3年，虽命中但非最近一段，按规则降低优先级或判定。 | 负向要求为不接受外包超过, 候选人最近一段为互联网公司, 前一段华腾为 | — | 负向要求为不接受外包超过, 候选人最近一段为互联网公司 | ✓ |
| 10-6 | 未命中任何加分项（Next.js/GraphQL）。 | 未命中任何加分项, Next, GraphQL | — | 未命中任何加分项, Next | ✓ |
| 10-7 | 期望薪资35k-45k，岗位上限50k，虽在范围内但因10-5硬性技能不符导致综合得分必然低于90分，判定不匹配。 | 期望薪资, 岗位上限, 虽在范围内但因 | 35k-45k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 外包接受度为“接受”。 | 外包接受度为, 接受 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 2014年毕业至2020年首份工作之间存在长达6年的空窗期，且未提供原因说明。 | 年毕业至, 年首份工作之间存在长达, 年的空窗期 | — | 年毕业至, 年首份工作之间存在长达 | ✓ |
| 10-27 | conflict_of_interest 为空。 | 为空 | — | 为空 | ✓ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-45 | 无腾讯正式岗位经历。 | 无腾讯正式岗位经历 | — | 无腾讯正式岗位经历 | ✓ |
| 10-53 | 目标岗位为PCG，符合跳过条件。 | 目标岗位为, 符合跳过条件, PCG | — | 目标岗位为, 符合跳过条件 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_72d5a5",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-17:high_risk_blacklist",
    "10-5:hard_requirement_mismatch",
    "10-7:salary_mismatch",
    "10-9:gap_period_unexplained"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长约 1.5 年（2020-03至2023-05, 2023-06至2026-04），未命中稳定性风险。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "出生1988年，本科毕业2014年，毕业年龄26岁，对比基准23岁偏差3岁，触发人工核查。",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求CET-6 480以上，候选人仅提供CET-4，分数未提供，判定不匹配。",
      "next_action": "block"
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
      "result": "FAIL",
      "evidence": "候选人曾就职于华腾，离职原因为有犯罪记录(YCH)，虽包含B8编码但规则要求非高风险编码才放行，此处命中风险。",
      "next_action": "block"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人曾就职于华腾，离职编码为B8（有犯罪记录），属于高风险类型，判定不予录用。",
      "next_action": "block"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "离职编码为B8，非A13(1)EHS类。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历已关联至原始需求 jr_x99。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历中不包含华为、荣耀记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历中不包含OPPO、小米记录。",
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
      "result": "FAIL",
      "evidence": "技能不匹配：岗位要求React/TypeScript，候选人简历仅包含Java/Spring Boot；语言不匹配：要求CET-6，候选人为CET-4。",
      "next_action": "block"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "负向要求为不接受外包超过2年，候选人最近一段为互联网公司，前一段华腾为3年，虽命中但非最近一段，按规则降低优先级或判定。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "未命中任何加分项（Next.js/GraphQL）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "期望薪资35k-45k，岗位上限50k，虽在范围内但因10-5硬性技能不符导致综合得分必然低于90分，判定不匹配。",
      "next_action": "block"
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
      "result": "FAIL",
      "evidence": "2014年毕业至2020年首份工作之间存在长达6年的空窗期，且未提供原因说明。",
      "next_action": "block"
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
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中未包含腾讯或腾讯外包经历（华腾非腾讯外包公司）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HSM核实反馈。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无腾讯正式岗位经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "未被标记为正编转外包受控。",
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
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无腾讯历史从业经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标岗位为PCG，符合跳过条件。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-12 ✗] 学历年龄逻辑校验与风险预警 — 毕业年龄26岁(偏差3岁)\n- [10-14 ✗] 语言能力硬性门槛判断 — 仅CET-4不满足CET-6要求\n- [10-17 ✗] 通用黑名单检验规则-高风险回流人员 — 命中B8犯罪记录黑名单\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 已关联 jr_x99\n- [10-5 ✗] 简历匹配硬性要求一票否决 — 技能(React/TS)与语言均不符\n- [10-7 ✗] 候选人期望薪资校验 — 技能不符导致综合得分低，薪资判定不匹配\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-9 ✗] 简历履历空窗期检测与标记 — 毕业后存在6年未说明空窗期\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — PCG事业群默认跳过",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-12",
      "message": "候选人王五本科毕业年龄为26岁，超出基准3岁，请核实教育经历真实性。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-17",
      "message": "候选人王五命中黑名单：曾就职华腾，离职原因B8(有犯罪记录)，系统已终止匹配。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-32-15-474Z_8d304d_s03-csi-blacklist-drop`
  - run_id: `run_2026-05-12T03-32-15-474Z_8d304d`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=20103 ms tokens=10226/3530
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 19 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=FAIL next=notify_recruiter
  - `10-14` [terminal] result=FAIL next=block
  - `10-16` [terminal] result=FAIL next=block
  - `10-17` [terminal] result=FAIL next=block
  - `10-18` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=FAIL next=block
  - `10-54` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=FAIL next=block
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-45` [flag_only] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 20.11 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 20 ms |
| **total** | **20.13 s** |
