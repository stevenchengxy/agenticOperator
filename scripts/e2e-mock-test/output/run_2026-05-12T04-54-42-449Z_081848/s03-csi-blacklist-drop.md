# s03-csi-blacklist-drop ✅

> scenario: candidate=`c03-wangwu-csi-blacklist` × jd=`jr-tencent-pcg-frontend`
> rationale: 王五在中软国际离职原因 A15(劳动纠纷),命中 10-17 通用黑名单高风险类型,系统自动判定不予录用,立即终止匹配流程。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-17 | 10-17:high_risk_blacklist, 10-5:hard_requirement_mismatch, 10-7:salary_mismatch, 10-9:gap_period_unexplained, 10-38:tencent_history_check, 10-40:active_leave_cooldown |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-17**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (22)** — wrote=22 expected=22
- ✅ **evidence verifiable rate ≥ 0.8 (got 95%)** — verified=21 / total=22

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 95%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 候选人平均每段工作时长为 1.5 年（38个月/2段），不满足'不足1年'的风险标记条件。 | 不足1年, 候选人平均每段工作时长为, 个月 | — | 不足1年, 候选人平均每段工作时长为 | ✓ |
| 10-12 | 出生1988年，2014年本科毕业，毕业年龄26岁。对比基准23岁偏差3岁，但规则要求偏差≥2岁暂停，此处逻辑判定为PASS（注：按指令要求二元判定，若无负向分支则PASS）。 | 按指令要求二元判定, 出生, 年本科毕业 | — | 按指令要求二元判定, 出生 | ✓ |
| 10-16 | 候选人曾任职于华腾，离职原因为'有犯罪记录(YCH)'，虽包含YCH但属于B8高风险编码，按逻辑应走10-17终止。 | 有犯罪记录(YCH), 候选人曾任职于华腾, 离职原因为 | 有犯罪记录(YCH), 有犯罪记录 | 候选人曾任职于华腾, 离职原因为 | ✓ |
| 10-17 | 候选人曾任职于华腾，离职原因编码为 B8 有犯罪记录（YCH），命中高风险类型，判定不予录用。 | 候选人曾任职于华腾, 离职原因编码为, 有犯罪记录 | 有犯罪记录, YCH | 候选人曾任职于华腾, 离职原因编码为 | ✓ |
| 10-18 | 离职原因为B8，非A13(1)EHS类，不命中此规则。 | 离职原因为, 不命中此规则, A13 | — | 离职原因为, 不命中此规则 | ✓ |
| 10-24 | 简历已解析并关联至原始需求 jr_x99。 | 简历已解析并关联至原始需求 | — | 简历已解析并关联至原始需求 | ✓ |
| 10-25 | 工作经历中不包含华为、荣耀及其关联公司。 | 工作经历中不包含华为, 荣耀及其关联公司 | — | 工作经历中不包含华为, 荣耀及其关联公司 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米及其关联公司。 | 工作经历中不包含, 小米及其关联公司, OPPO | — | 工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-5 | 必备技能不符：岗位要求 React, TypeScript, Webpack，候选人技能为 Java, Spring Boot 等，完全不匹配。 | 岗位要求 React, 必备技能不符, 岗位要求 | Java, Spring | 岗位要求 React, 必备技能不符 | ✓ |
| 10-54 | 负向要求为'不接受外包从业经历超过 2 年'，候选人华腾经历为3年2个月，命中负向要求，判定为FAIL。 | 不接受外包从业经历超过 2 年, 负向要求为, 不接受外包从业经历超过 | — | 不接受外包从业经历超过 2 年, 负向要求为 | ✓ |
| 10-6 | 未命中任何加分项（Next.js, GraphQL）。 | 未命中任何加分项, Next, GraphQL | — | 未命中任何加分项, Next | ✓ |
| 10-7 | 期望薪资 35k-45k，虽在岗位 30k-50k 范围内，但因 10-5 技能匹配度极低（远低于90分），按逻辑判定为薪资不匹配。 | 期望薪资, 虽在岗位, 范围内 | 35k-45k | 期望薪资, 虽在岗位 | ✓ |
| 10-8 | 外包接受度为'接受'。 | 接受, 外包接受度为 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 2014年毕业至2020年首份工作间存在长达6年的空窗期，且未提供原因说明。 | 年毕业至, 年首份工作间存在长达, 年的空窗期 | — | 年毕业至, 年首份工作间存在长达 | ✓ |
| 10-27 | 利益冲突声明为空，未发现亲属在腾讯任职。 | 利益冲突声明为空, 未发现亲属在腾讯任职 | — | 利益冲突声明为空, 未发现亲属在腾讯任职 | ✓ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-38 | 简历包含'华腾'经历，属于腾讯外包，触发核实任务并暂停流程。 | 华腾, 简历包含, 经历 | 华腾 | 简历包含, 经历 | ✓ |
| 10-45 | 未发现腾讯正式岗位工作经历。 | 未发现腾讯正式岗位工作经历 | — | 未发现腾讯正式岗位工作经历 | ✓ |
| 10-46 | 非正编转外包受控状态。 | 非正编转外包受控状态 | — | 非正编转外包受控状态 | ✓ |
| 10-47 | 候选人为男性，不适用此规则。 | 候选人为男性, 不适用此规则 | — | 候选人为男性, 不适用此规则 | ✓ |
| 10-40 | 具备腾讯外包（华腾）经历，离职时间2023-05距今超过6个月，但因10-38已挂起且技能加分项为0，维持禁止推荐。 | 具备腾讯外包, 华腾, 经历 | 华腾, 2023-05 | 具备腾讯外包, 经历 | ✓ |
| 10-53 | 目标岗位为 PCG，符合跳过面试条件。 | 目标岗位为, 符合跳过面试条件, PCG | — | 目标岗位为, 符合跳过面试条件 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_14067cca",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-17:high_risk_blacklist",
    "10-5:hard_requirement_mismatch",
    "10-7:salary_mismatch",
    "10-9:gap_period_unexplained",
    "10-38:tencent_history_check",
    "10-40:active_leave_cooldown"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人平均每段工作时长为 1.5 年（38个月/2段），不满足'不足1年'的风险标记条件。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生1988年，2014年本科毕业，毕业年龄26岁。对比基准23岁偏差3岁，但规则要求偏差≥2岁暂停，此处逻辑判定为PASS（注：按指令要求二元判定，若无负向分支则PASS）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位标签未包含'外语'、'海外'或'国际化'，规则不触发。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位未带有'轮班'、'夜班'、'倒班'或'长期出差'标签。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人曾任职于华腾，离职原因为'有犯罪记录(YCH)'，虽包含YCH但属于B8高风险编码，按逻辑应走10-17终止。",
      "next_action": "block"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人曾任职于华腾，离职原因编码为 B8 有犯罪记录（YCH），命中高风险类型，判定不予录用。",
      "next_action": "block"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "离职原因为B8，非A13(1)EHS类，不命中此规则。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历已解析并关联至原始需求 jr_x99。",
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
      "evidence": "必备技能不符：岗位要求 React, TypeScript, Webpack，候选人技能为 Java, Spring Boot 等，完全不匹配。",
      "next_action": "block"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "负向要求为'不接受外包从业经历超过 2 年'，候选人华腾经历为3年2个月，命中负向要求，判定为FAIL。",
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
      "evidence": "期望薪资 35k-45k，虽在岗位 30k-50k 范围内，但因 10-5 技能匹配度极低（远低于90分），按逻辑判定为薪资不匹配。",
      "next_action": "block"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度为'接受'。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "2014年毕业至2020年首份工作间存在长达6年的空窗期，且未提供原因说明。",
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
      "evidence": "简历包含'华腾'经历，属于腾讯外包，触发核实任务并暂停流程。",
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
      "evidence": "未发现腾讯正式岗位工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "非正编转外包受控状态。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人为男性，不适用此规则。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "具备腾讯外包（华腾）经历，离职时间2023-05距今超过6个月，但因10-38已挂起且技能加分项为0，维持禁止推荐。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标岗位为 PCG，符合跳过面试条件。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-17 ✗] 通用黑名单检验规则-高风险回流人员 — 命中 B8 有犯罪记录(YCH)\n- [10-5 ✗] 简历匹配硬性要求一票否决 — 必备技能(React/TS)完全不匹配\n- [10-7 ✗] 候选人期望薪资校验 — 综合匹配度过低导致薪资不匹配\n- [10-9 ✗] 简历履历空窗期检测与标记 — 毕业后存在6年未说明空窗期\n- [10-38 ✗] 腾讯历史从业经历识别与核实触发 — 包含华腾(腾讯外包)经历需核实\n- [10-40 ✗] 腾讯主动离职人员紧急回流审核 — 技能加分项不足且存在历史风险\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 已关联 jr_x99\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — PCG 事业群适用",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人王五存在华腾(腾讯外包)历史经历，请核实真实离场原因。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-40",
      "message": "候选人王五腾讯回流审核未通过：命中加分项不足半数。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-54-42-449Z_081848_s03-csi-blacklist-drop`
  - run_id: `run_2026-05-12T04-54-42-449Z_081848`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=21320 ms tokens=10245/3624
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 22 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-16` [terminal] result=FAIL next=block
  - `10-17` [terminal] result=FAIL next=block
  - `10-18` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=FAIL next=block
  - `10-54` [terminal] result=PASS next=block
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=FAIL next=block
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=FAIL next=block
  - `10-45` [flag_only] result=PASS next=continue
  - `10-46` [flag_only] result=PASS next=continue
  - `10-47` [needs_human] result=PASS next=continue
  - `10-40` [needs_human] result=FAIL next=notify_hsm
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 21.32 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 26 ms |
| **total** | **21.35 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_081848_s03-cs_91fa3f` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c03-wangwu-csi-blacklist jd=jr-tencent-pcg-frontend |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s03-csi-blacklist-drop_2f3107 |
| +2ms | `raas-api-resp` | candidate_id=C_14067cca resume_id=R_22b9d751 |
| +2ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_14067cca jr=jr_x99 |
| +2ms | `raas-api-call` | GET /api/v1/requirements/jr_x99 |
| +3ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_TENCENT bg=PCG) |
| +3ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +21325ms | `llm-response` | model=google/gemini-3-flash-preview latency=21320ms tokens=10245/3624 |
| +21325ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=27/51 failures=10-17:high_risk_blacklist,10-5:hard_requirement_mismatch,10-7:salary_mismatch |
| +21351ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-54-42-449Z_081848_s03-csi-blacklist-drop + 22 flags + :Candidate / :Resume / :JR anchors |
| +21351ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-17:high_risk_blacklist,10-5:hard_requirement_mismatch,10-7:salary_mismatch,10-9:gap_period_unexplaine |
