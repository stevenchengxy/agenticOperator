# s07-foreign-marital-tencent ❌

> scenario: candidate=`c05-zhouqi-foreign-data` × jd=`jr-tencent-cdg-data`
> rationale: 周七 nationality="美国"(外籍)+ gender="女" + age=28 + marital="未婚"。腾讯客户场景 10-35(外籍通道限制)+ 10-47(女>26 未婚/已婚未育 HSM 审视)都必须命中。复合多规则 → FAIL。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-35, 10-47 | 10-9:gap_detected, 10-47:gender_age_marital_risk |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ❌ **must-fail rule fired: 10-35** — LLM 没有把 10-35 标为 fail/pause/hit
- ✅ **must-fail rule fired: 10-47**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (17)** — wrote=17 expected=17
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=17 / total=17

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 简历包含两段工作经历：Meta (2021-07至2024-12) 和 LinkedIn (2019-08至2021-06)，平均每段时长超过1年，无消极空窗理由。 | Meta, 简历包含两段工作经历, 平均每段时长超过 | Meta, 2021-07 | 简历包含两段工作经历, 平均每段时长超过 | ✓ |
| 10-12 | 出生1997年，2019年硕士毕业，毕业年龄22岁。对比硕士基准24-26岁，偏差为-2岁，未达到≥2岁的异常判定阈值（向下偏差通常视为优秀或早学）。 | 出生, 年硕士毕业, 毕业年龄 | — | 出生, 年硕士毕业 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_y88 (数据分析工程师)。 | 简历已关联至原始需求, 数据分析工程师 | — | 简历已关联至原始需求, 数据分析工程师 | ✓ |
| 10-25 | 工作经历中不包含华为、荣耀及其关联公司。 | 工作经历中不包含华为, 荣耀及其关联公司 | — | 工作经历中不包含华为, 荣耀及其关联公司 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米及其关联公司。 | 工作经历中不包含, 小米及其关联公司, OPPO | — | 工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-5 | 学历硕士满足本科要求；技能包含Python/SQL/Spark；年龄28岁在22-35范围内；性别无限制。 | 学历硕士满足本科要求, 技能包含, 年龄 | SQL, Python | 学历硕士满足本科要求, 技能包含 | ✓ |
| 10-6 | 命中加分项：Spark, Tableau。 | Spark, 命中加分项, Tableau | Spark, Tableau | 命中加分项 | ✓ |
| 10-7 | 期望薪资 30k-40k，岗位上限 40k，未超过上限。 | 期望薪资, 岗位上限, 未超过上限 | 30k-40k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 外包接受度为“接受”。 | 外包接受度为, 接受 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 2024-12 至今（2026-05）存在超过3个月空窗期，且简历未提供空窗期原因说明。 | 至今, 存在超过, 个月空窗期 | 2024-12 | 至今, 存在超过 | ✓ |
| 10-27 | conflict_of_interest 为空，未声明亲属关系。 | 为空, 未声明亲属关系 | — | 为空, 未声明亲属关系 | ✓ |
| 10-35 | 国籍为“美国”，已标记需走外籍通道。 | 国籍为, 美国, 已标记需走外籍通道 | 美国 | 国籍为, 已标记需走外籍通道 | ✓ |
| 10-38 | 简历中不包含腾讯或腾讯外包工作经历。 | 简历中不包含腾讯或腾讯外包工作经历 | — | 简历中不包含腾讯或腾讯外包工作经历 | ✓ |
| 10-45 | 无腾讯历史从业经历。 | 无腾讯历史从业经历 | — | 无腾讯历史从业经历 | ✓ |
| 10-47 | 候选人为女性，28岁(>26岁)，未婚。命中加分项(Spark, Tableau)占总加分项(2/2)比例100%，需HSM审核。 | 候选人为女性, 未婚, 命中加分项 | 未婚, Spark | 候选人为女性, 命中加分项 | ✓ |
| 10-42 | 无腾讯相关工作经历。 | 无腾讯相关工作经历 | — | 无腾讯相关工作经历 | ✓ |
| 10-53 | 推荐至 CDG 事业群，默认跳过内面。 | 推荐至, 事业群, 默认跳过内面 | — | 推荐至, 事业群 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_5eacb369",
  "job_requisition_id": "jr_y88",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-9:gap_detected",
    "10-47:gender_age_marital_risk"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历包含两段工作经历：Meta (2021-07至2024-12) 和 LinkedIn (2019-08至2021-06)，平均每段时长超过1年，无消极空窗理由。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生1997年，2019年硕士毕业，毕业年龄22岁。对比硕士基准24-26岁，偏差为-2岁，未达到≥2岁的异常判定阈值（向下偏差通常视为优秀或早学）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求未明确要求特定语言证书类型及分数。",
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
      "evidence": "简历已关联至原始需求 jr_y88 (数据分析工程师)。",
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
      "evidence": "简历未显示曾在我司（CSI）任职。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历硕士满足本科要求；技能包含Python/SQL/Spark；年龄28岁在22-35范围内；性别无限制。",
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
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项：Spark, Tableau。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 30k-40k，岗位上限 40k，未超过上限。",
      "next_action": "continue"
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
      "evidence": "2024-12 至今（2026-05）存在超过3个月空窗期，且简历未提供空窗期原因说明。",
      "next_action": "block"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空，未声明亲属关系。",
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
      "evidence": "国籍为“美国”，已标记需走外籍通道。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中不包含腾讯或腾讯外包工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "未触发 10-38 核实任务。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无腾讯历史从业经历。",
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
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人为女性，28岁(>26岁)，未婚。命中加分项(Spark, Tableau)占总加分项(2/2)比例100%，需HSM审核。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-42",
      "rule_name": "CDG事业群6个月回流冷冻期绝对拦截",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "无腾讯相关工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "推荐至 CDG 事业群，默认跳过内面。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 关联至 jr_y88\n- [10-5 ✓] 简历匹配硬性要求一票否决 — 学历、技能、年龄均符合\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中加分项: Spark, Tableau\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-9 ✗] 简历履历空窗期检测与标记 — 2024-12至今空窗且无说明\n- [10-35 ⓘ] 腾讯外籍候选人实名与通道限制规范 — 美国国籍，锁定外籍通道\n- [10-47 ✗] 腾讯婚育风险审视与推荐要点 — 女性28岁未婚，需HSM确认加分项覆盖情况\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — CDG事业群跳过内面",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-47",
      "message": "候选人 周七 (C_5eacb369) 命中婚育风险审视规则（女性>26岁且未婚），其加分项命中率为100% (Spark, Tableau)，请审核是否继续推进。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-54-42-449Z_081848_s07-foreign-marital-tencent`
  - run_id: `run_2026-05-12T04-54-42-449Z_081848`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`google/gemini-3-flash-preview` duration=19714 ms tokens=10081/3412
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 17 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=PASS next=continue
  - `10-45` [flag_only] result=PASS next=continue
  - `10-47` [needs_human] result=FAIL next=notify_hsm
  - `10-42` [terminal] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 1 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 19.72 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 25 ms |
| **total** | **19.74 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_081848_s07-fo_703ea1` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c05-zhouqi-foreign-data jd=jr-tencent-cdg-data |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s07-foreign-marital-tencent_8626b3 |
| +1ms | `raas-api-resp` | candidate_id=C_5eacb369 resume_id=R_db53c458 |
| +1ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_5eacb369 jr=jr_y88 |
| +1ms | `raas-api-call` | GET /api/v1/requirements/jr_y88 |
| +2ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_TENCENT bg=CDG) |
| +2ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +19719ms | `llm-response` | model=google/gemini-3-flash-preview latency=19714ms tokens=10081/3412 |
| +19719ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=27/51 failures=10-9:gap_detected,10-47:gender_age_marital_risk |
| +19744ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-54-42-449Z_081848_s07-foreign-marital-tencent + 17 flags + :Candidate / :Resume / :JR anchors |
| +19744ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-9:gap_detected,10-47:gender_age_marital_risk |
