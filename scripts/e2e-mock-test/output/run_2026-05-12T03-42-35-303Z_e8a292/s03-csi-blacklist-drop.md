# s03-csi-blacklist-drop ❌

> scenario: candidate=`c03-wangwu-csi-blacklist` × jd=`jr-tencent-pcg-frontend`
> rationale: 王五在中软国际离职原因 A15(劳动纠纷),命中 10-17 通用黑名单高风险类型,系统自动判定不予录用,立即终止匹配流程。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-17 | 10-17:high_risk_blacklist, 10-5:hard_requirement_mismatch, 10-54:negative_requirement_hit, 10-7:salary_mismatch, 10-9:gap_period_unexplained, 10-38:tencent_history_check, 10-40:tencent_active_leave_cooldown |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-17**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (19)** — wrote=19 expected=19
- ❌ **evidence verifiable rate ≥ 0.8 (got 74%)** — verified=14 / total=19

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 74%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长约 3 年（2020-03至2023-05，2023-06至2026-04），稳定性良好。 | 平均每段工作时长约, 稳定性良好, 2020-03 | 2020-03, 2023-05 | 平均每段工作时长约, 稳定性良好 | ✓ |
| 10-12 | 出生1988年，本科毕业2014年，毕业年龄26岁，较基准22-23岁偏差3岁。 | 出生, 本科毕业, 毕业年龄 | — | 出生, 本科毕业 | ✗ |
| 10-14 | 岗位要求CET-6 480分以上，简历仅提供CET-4，不满足硬性门槛。 | 岗位要求, 分以上, 简历仅提供 | CET-4, CET | 岗位要求, 分以上 | ✓ |
| 10-16 | 虽有华腾经历且离职原因为YCH，但命中10-17高风险编码，本条不重复触发FAIL。 | 虽有华腾经历且离职原因为, 但命中, 高风险编码 | YCH | 虽有华腾经历且离职原因为, 但命中 | ✓ |
| 10-17 | 曾任职华腾，离职编码B8，原因为“有犯罪记录(YCH)”，属于高风险类型。 | 曾任职华腾, 离职编码, 原因为 | 有犯罪记录, YCH | 曾任职华腾, 离职编码 | ✓ |
| 10-18 | 离职原因为B8，非A13(1)EHS类。 | 离职原因为, A13, EHS | — | 离职原因为, A13 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_x99。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-5 | 技能不符：岗位要求React/TypeScript，简历为Java后端；语言不符：要求CET-6，简历为CET-4。 | 岗位要求React/TypeScript, 要求CET-6, 技能不符 | 后端, CET-4 | 岗位要求React/TypeScript, 要求CET-6 | ✓ |
| 10-54 | 命中负向要求：不接受外包经历超2年。候选人在华腾（外包）任职3年2个月。 | 不接受外包经历超2年, 命中负向要求, 不接受外包经历超 | — | 不接受外包经历超2年, 命中负向要求 | ✗ |
| 10-6 | 未命中任何加分项（Next.js, GraphQL）。 | 未命中任何加分项, Next, GraphQL | — | 未命中任何加分项, Next | ✓ |
| 10-7 | 期望薪资35k-45k，虽在30k-50k范围内，但因硬性技能不匹配导致综合得分必然低于90分。 | 期望薪资, 虽在, 范围内 | 35k-45k | 期望薪资, 虽在 | ✓ |
| 10-8 | 外包接受度为“接受”。 | 外包接受度为, 接受 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 2014年毕业至2020年首份工作间存在长达6年的空窗期且无原因说明。 | 年毕业至, 年首份工作间存在长达, 年的空窗期且无原因说明 | — | 年毕业至, 年首份工作间存在长达 | ✗ |
| 10-27 | 利益冲突声明为空，未发现亲属在腾讯任职。 | 利益冲突声明为空, 未发现亲属在腾讯任职 | — | 利益冲突声明为空, 未发现亲属在腾讯任职 | ✓ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-38 | 曾任职华腾（腾讯外包），需核实离场原因，系统自动挂起。 | 曾任职华腾, 腾讯外包, 需核实离场原因 | — | 曾任职华腾, 腾讯外包 | ✗ |
| 10-45 | 历史经历为华腾（外包），非腾讯正编。 | 历史经历为华腾, 外包, 非腾讯正编 | — | 历史经历为华腾, 外包 | ✓ |
| 10-40 | 曾任职华腾（腾讯外包），离职时间2023-05距今已超6个月，但因10-38挂起且加分项命中不足50%，判定为FAIL。 | 曾任职华腾, 腾讯外包, 离职时间 | 2023-05 | 曾任职华腾, 腾讯外包 | ✓ |
| 10-53 | 目标事业群为PCG，符合跳过条件。 | 目标事业群为, 符合跳过条件, PCG | — | 目标事业群为, 符合跳过条件 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_678b04",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-17:high_risk_blacklist",
    "10-5:hard_requirement_mismatch",
    "10-54:negative_requirement_hit",
    "10-7:salary_mismatch",
    "10-9:gap_period_unexplained",
    "10-38:tencent_history_check",
    "10-40:tencent_active_leave_cooldown"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长约 3 年（2020-03至2023-05，2023-06至2026-04），稳定性良好。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "出生1988年，本科毕业2014年，毕业年龄26岁，较基准22-23岁偏差3岁。",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求CET-6 480分以上，简历仅提供CET-4，不满足硬性门槛。",
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
      "result": "PASS",
      "evidence": "虽有华腾经历且离职原因为YCH，但命中10-17高风险编码，本条不重复触发FAIL。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "曾任职华腾，离职编码B8，原因为“有犯罪记录(YCH)”，属于高风险类型。",
      "next_action": "block"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "离职原因为B8，非A13(1)EHS类。",
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
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中未发现华为、荣耀任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中未发现OPPO、小米任职记录。",
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
      "evidence": "技能不符：岗位要求React/TypeScript，简历为Java后端；语言不符：要求CET-6，简历为CET-4。",
      "next_action": "block"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "命中负向要求：不接受外包经历超2年。候选人在华腾（外包）任职3年2个月。",
      "next_action": "block"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "未命中任何加分项（Next.js, GraphQL）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "期望薪资35k-45k，虽在30k-50k范围内，但因硬性技能不匹配导致综合得分必然低于90分。",
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
      "evidence": "2014年毕业至2020年首份工作间存在长达6年的空窗期且无原因说明。",
      "next_action": "block"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "利益冲突声明为空，未发现亲属在腾讯任职。",
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
      "applicable": true,
      "result": "FAIL",
      "evidence": "曾任职华腾（腾讯外包），需核实离场原因，系统自动挂起。",
      "next_action": "block"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未收到HSM核实反馈。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "历史经历为华腾（外包），非腾讯正编。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "未标记为正编转外包受控。",
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
      "applicable": true,
      "result": "FAIL",
      "evidence": "曾任职华腾（腾讯外包），离职时间2023-05距今已超6个月，但因10-38挂起且加分项命中不足50%，判定为FAIL。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标事业群为PCG，符合跳过条件。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-12 ✗] 学历年龄逻辑校验与风险预警 — 毕业年龄26岁，偏差3岁\n- [10-14 ✗] 语言能力硬性门槛判断 — 仅CET-4，不符CET-6要求\n- [10-17 ✗] 通用黑名单检验规则-高风险回流人员 — 华腾离职编码B8(犯罪记录)\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 关联至 jr_x99\n- [10-5 ✗] 简历匹配硬性要求一票否决 — 技能(Java vs React)及语言不匹配\n- [10-54 ✗] 对标公司/行业画像库匹配与定向猎挖规则 — 外包经历3.2年超过2年限制\n- [10-7 ✗] 候选人期望薪资校验 — 技能不匹配导致综合分低，薪资不予支持\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-9 ✗] 简历履历空窗期检测与标记 — 毕业后存在6年空白且无说明\n- [10-38 ✗] 腾讯历史从业经历识别与核实触发 — 发现华腾(腾讯外包)经历\n- [10-40 ✗] 腾讯主动离职人员紧急回流审核 — 加分项不足且存在历史风险\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — PCG事业群跳过内测",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-12",
      "message": "候选人王五毕业年龄26岁，与本科基准偏差3岁，请核实教育经历。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人王五有腾讯外包(华腾)经历，请核实真实离场原因。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-42-35-303Z_e8a292_s03-csi-blacklist-drop`
  - run_id: `run_2026-05-12T03-42-35-303Z_e8a292`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=20635 ms tokens=10226/3693
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 19 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=FAIL next=notify_recruiter
  - `10-14` [terminal] result=FAIL next=block
  - `10-16` [terminal] result=PASS next=continue
  - `10-17` [terminal] result=FAIL next=block
  - `10-18` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-5` [flag_only] result=FAIL next=block
  - `10-54` [terminal] result=FAIL next=block
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=FAIL next=block
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=FAIL next=block
  - `10-45` [flag_only] result=PASS next=continue
  - `10-40` [needs_human] result=FAIL next=notify_hsm
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 4 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 20.64 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 18 ms |
| **total** | **20.66 s** |
