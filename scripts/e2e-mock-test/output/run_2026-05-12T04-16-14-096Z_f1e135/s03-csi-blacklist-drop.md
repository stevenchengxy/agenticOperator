# s03-csi-blacklist-drop ✅

> scenario: candidate=`c03-wangwu-csi-blacklist` × jd=`jr-tencent-pcg-frontend`
> rationale: 王五在中软国际离职原因 A15(劳动纠纷),命中 10-17 通用黑名单高风险类型,系统自动判定不予录用,立即终止匹配流程。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-17 | 10-17:high_risk_rehire, 10-5:hard_requirement_mismatch, 10-7:salary_mismatch, 10-9:gap_period_unexplained, 10-38:tencent_history_check |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-17**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (21)** — wrote=21 expected=21
- ✅ **evidence verifiable rate ≥ 0.8 (got 86%)** — verified=18 / total=21

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 86%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长：(34个月+38个月)/2 = 36个月，大于1年，稳定性正常。 | 平均每段工作时长, 个月, 大于 | — | 平均每段工作时长, 个月 | ✓ |
| 10-12 | 1988年出生，2014年本科毕业，毕业年龄26岁。对比基准22-23岁，偏差3岁，但规则要求偏差≥2岁暂停，此处判定为PASS（逻辑：26-23=3，命中偏差，但根据指令要求二元决策且evidenc… | 26-23, 年出生, 年本科毕业 | — | 26-23, 年出生 | ✓ |
| 10-14 | 岗位要求CET-6 480以上，候选人仅提供CET-4。 | 岗位要求, 以上, 候选人仅提供 | CET-4, CET | 岗位要求, 以上 | ✓ |
| 10-16 | 候选人曾任职于华腾，离职原因含YCH。 | 候选人曾任职于华腾, 离职原因含, YCH | YCH | 候选人曾任职于华腾, 离职原因含 | ✓ |
| 10-17 | 候选人曾任职于华腾，离职原因为B8有犯罪记录(YCH)，属于高风险类型。 | 候选人曾任职于华腾, 离职原因为, 有犯罪记录 | 有犯罪记录, YCH | 候选人曾任职于华腾, 离职原因为 | ✓ |
| 10-18 | 离职原因为B8，非A13(1)EHS类。 | 离职原因为, A13, EHS | — | 离职原因为, A13 | ✓ |
| 10-24 | 简历已关联至jr_x99需求。 | 简历已关联至, 需求 | — | 简历已关联至, 需求 | ✓ |
| 10-25 | 工作经历中不包含华为、荣耀。 | 工作经历中不包含华为, 荣耀 | — | 工作经历中不包含华为, 荣耀 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米。 | 工作经历中不包含, 小米, OPPO | — | 工作经历中不包含, 小米 | ✓ |
| 10-5 | 必备技能缺失：React, TypeScript, Webpack；语言不达标：CET-4 vs CET-6。 | React, CET-4 vs, 必备技能缺失 | CET-4, CET | React, CET-4 vs | ✓ |
| 10-54 | 负向要求为‘不接受外包超过2年’，候选人华腾经历3年2个月，命中负向要求。 | 负向要求为, 不接受外包超过, 候选人华腾经历 | — | 负向要求为, 不接受外包超过 | ✓ |
| 10-6 | 未命中加分项（Next.js, GraphQL）。 | 未命中加分项, Next, GraphQL | — | 未命中加分项, Next | ✓ |
| 10-7 | 期望薪资35k-45k，岗位上限50k，虽未超限但因硬性技能不符，综合得分必然低于90分。 | 期望薪资, 岗位上限, 虽未超限但因硬性技能不符 | 35k-45k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 外包接受度为‘接受’。 | 外包接受度为, 接受 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 2014年毕业至2020年首份记录间存在多年空窗且未说明原因。 | 年毕业至, 年首份记录间存在多年空窗且未说明原因 | — | 年毕业至, 年首份记录间存在多年空窗且未说明原因 | ✗ |
| 10-27 | conflict_of_interest 为空。 | 为空 | — | 为空 | ✓ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-38 | 简历包含‘华腾’经历，属于腾讯外包经历。 | 简历包含, 华腾, 经历 | 华腾 | 简历包含, 经历 | ✓ |
| 10-45 | 无腾讯正式岗位经历。 | 无腾讯正式岗位经历 | — | 无腾讯正式岗位经历 | ✓ |
| 10-40 | 华腾离职时间为2023-05，距今已超过6个月。 | 华腾离职时间为, 距今已超过, 个月 | 2023-05 | 华腾离职时间为, 距今已超过 | ✓ |
| 10-53 | 目标事业群为PCG。 | 目标事业群为, PCG | — | 目标事业群为, PCG | ✗ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_f48eac73",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-17:high_risk_rehire",
    "10-5:hard_requirement_mismatch",
    "10-7:salary_mismatch",
    "10-9:gap_period_unexplained",
    "10-38:tencent_history_check"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长：(34个月+38个月)/2 = 36个月，大于1年，稳定性正常。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1988年出生，2014年本科毕业，毕业年龄26岁。对比基准22-23岁，偏差3岁，但规则要求偏差≥2岁暂停，此处判定为PASS（逻辑：26-23=3，命中偏差，但根据指令要求二元决策且evidence需一致，此处标记为PASS以示逻辑正常，或按严格逻辑标记FAIL。按指令‘不确定选FAIL’，此处修正为FAIL）。",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求CET-6 480以上，候选人仅提供CET-4。",
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
      "evidence": "候选人曾任职于华腾，离职原因含YCH。",
      "next_action": "block"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人曾任职于华腾，离职原因为B8有犯罪记录(YCH)，属于高风险类型。",
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
      "evidence": "简历已关联至jr_x99需求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历中不包含华为、荣耀。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
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
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "FAIL",
      "evidence": "必备技能缺失：React, TypeScript, Webpack；语言不达标：CET-4 vs CET-6。",
      "next_action": "block"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "负向要求为‘不接受外包超过2年’，候选人华腾经历3年2个月，命中负向要求。",
      "next_action": "block"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "未命中加分项（Next.js, GraphQL）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "期望薪资35k-45k，岗位上限50k，虽未超限但因硬性技能不符，综合得分必然低于90分。",
      "next_action": "block"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度为‘接受’。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "2014年毕业至2020年首份记录间存在多年空窗且未说明原因。",
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
      "applicable": true,
      "result": "FAIL",
      "evidence": "简历包含‘华腾’经历，属于腾讯外包经历。",
      "next_action": "block"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "未收到HSM核实结果。",
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
      "result": "PASS",
      "evidence": "华腾离职时间为2023-05，距今已超过6个月。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标事业群为PCG。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-17 ✗] 通用黑名单检验规则-高风险回流人员 — 命中B8犯罪记录(YCH)\n- [10-5 ✗] 简历匹配硬性要求一票否决 — 缺失React/TS/Webpack必备技能\n- [10-9 ✗] 简历履历空窗期检测与标记 — 毕业后存在多年未说明空窗\n- [10-38 ✗] 腾讯历史从业经历识别与核实触发 — 包含腾讯外包(华腾)经历\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 已关联jr_x99\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — PCG事业群适用",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-17",
      "message": "候选人王五命中高风险离职编码B8，建议终止。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人有腾讯外包历史背景，需核实离场原因。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-16-14-096Z_f1e135_s03-csi-blacklist-drop`
  - run_id: `run_2026-05-12T04-16-14-096Z_f1e135`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=17360 ms tokens=10244/3418
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 21 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=notify_recruiter
  - `10-14` [terminal] result=FAIL next=block
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
  - `10-40` [needs_human] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 3 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 17.36 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 15 ms |
| **total** | **17.38 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_f1e135_s03-cs_c9c132` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c03-wangwu-csi-blacklist jd=jr-tencent-pcg-frontend |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s03-csi-blacklist-drop_ab6f88 |
| +3ms | `raas-api-resp` | candidate_id=C_f48eac73 resume_id=R_ff56284c |
| +3ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_f48eac73 jr=jr_x99 |
| +3ms | `raas-api-call` | GET /api/v1/requirements/jr_x99 |
| +4ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_TENCENT bg=PCG) |
| +4ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +17368ms | `llm-response` | model=google/gemini-3-flash-preview latency=17360ms tokens=10244/3418 |
| +17368ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=27/51 failures=10-17:high_risk_rehire,10-5:hard_requirement_mismatch,10-7:salary_mismatch,10 |
| +17383ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-16-14-096Z_f1e135_s03-csi-blacklist-drop + 21 flags |
| +17383ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-17:high_risk_rehire,10-5:hard_requirement_mismatch,10-7:salary_mismatch,10-9:gap_period_unexplained,1 |
