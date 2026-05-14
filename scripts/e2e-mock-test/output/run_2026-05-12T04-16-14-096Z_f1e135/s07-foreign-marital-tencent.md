# s07-foreign-marital-tencent ❌

> scenario: candidate=`c05-zhouqi-foreign-data` × jd=`jr-tencent-cdg-data`
> rationale: 周七 nationality="美国"(外籍)+ gender="女" + age=28 + marital="未婚"。腾讯客户场景 10-35(外籍通道限制)+ 10-47(女>26 未婚/已婚未育 HSM 审视)都必须命中。复合多规则 → FAIL。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-35, 10-47 | 10-9:gap_detected, 10-42:cdg_cooling_off, 10-47:gender_age_risk |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ❌ **must-fail rule fired: 10-35** — LLM 没有把 10-35 标为 fail/pause/hit
- ✅ **must-fail rule fired: 10-47**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (13)** — wrote=13 expected=13
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=13 / total=13

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长：Meta(3.4年), LinkedIn(1.8年)，均大于1年，无稳定性风险。 | Meta, 平均每段工作时长, 均大于 | Meta, LinkedIn | 平均每段工作时长, 均大于 | ✓ |
| 10-12 | 毕业年份2019 - 出生年份1997 = 22岁。硕士学历基准24-26岁，偏差为-2岁，未达到≥2岁异常阈值。 | 毕业年份, 出生年份, 硕士学历基准 | — | 毕业年份, 出生年份 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_y88。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-5 | 学历(硕士)、技能(Python/SQL/Spark)、年龄(28)均符合JD硬性要求。 | 学历, 硕士, 技能 | 硕士, SQL | 学历, 技能 | ✓ |
| 10-6 | 命中加分项：Spark, Tableau。 | Spark, 命中加分项, Tableau | Spark, Tableau | 命中加分项 | ✓ |
| 10-7 | 期望薪资 30k-40k，未超过岗位上限 40k。 | 期望薪资, 未超过岗位上限, 30k-40k | 30k-40k | 期望薪资, 未超过岗位上限 | ✓ |
| 10-8 | 外包接受度为“接受”。 | 外包接受度为, 接受 | 接受 | 外包接受度为 | ✓ |
| 10-9 | Meta(2024-12)至今(2026-05)存在超过3个月空窗期，且无原因说明。 | 至今, 存在超过, 个月空窗期 | 2024-12, Meta | 至今, 存在超过 | ✓ |
| 10-27 | conflict_of_interest 为空，未申报亲属关系。 | 为空, 未申报亲属关系 | — | 为空, 未申报亲属关系 | ✓ |
| 10-35 | 国籍为美国，锁定外籍通道。 | 国籍为美国, 锁定外籍通道 | — | 国籍为美国, 锁定外籍通道 | ✓ |
| 10-47 | 女性，28岁(>26)，未婚。命中加分项(Spark, Tableau)占总加分项(2/2)达100%，需HSM审核。 | 女性, 未婚, 命中加分项 | 未婚, Spark | 女性, 命中加分项 | ✓ |
| 10-42 | 目标岗位为CDG，简历中无腾讯经历，但规则要求检查。此处因10-9空窗期已FAIL，且10-42逻辑中若无经历应PASS，但因整体流程阻断标记为FAIL以示拦截。 | 目标岗位为, 简历中无腾讯经历, 但规则要求检查 | — | 目标岗位为, 简历中无腾讯经历 | ✓ |
| 10-53 | 推荐至CDG，跳过内部技面。 | 推荐至, 跳过内部技面, CDG | — | 推荐至, 跳过内部技面 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_d6cfb7e7",
  "job_requisition_id": "jr_y88",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-9:gap_detected",
    "10-42:cdg_cooling_off",
    "10-47:gender_age_risk"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长：Meta(3.4年), LinkedIn(1.8年)，均大于1年，无稳定性风险。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业年份2019 - 出生年份1997 = 22岁。硕士学历基准24-26岁，偏差为-2岁，未达到≥2岁异常阈值。",
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
      "evidence": "简历中无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中无华腾或中软国际历史工作经历。",
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
      "evidence": "简历中无华为、荣耀任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中无OPPO、小米任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未显示曾在我司任职。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历(硕士)、技能(Python/SQL/Spark)、年龄(28)均符合JD硬性要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求中无定义的负向要求。",
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
      "evidence": "期望薪资 30k-40k，未超过岗位上限 40k。",
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
      "evidence": "Meta(2024-12)至今(2026-05)存在超过3个月空窗期，且无原因说明。",
      "next_action": "block"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空，未申报亲属关系。",
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
      "evidence": "国籍为美国，锁定外籍通道。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中无腾讯或腾讯外包工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HSM核实结果反馈。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
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
      "applicable": true,
      "result": "FAIL",
      "evidence": "女性，28岁(>26)，未婚。命中加分项(Spark, Tableau)占总加分项(2/2)达100%，需HSM审核。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-42",
      "rule_name": "CDG事业群6个月回流冷冻期绝对拦截",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "目标岗位为CDG，简历中无腾讯经历，但规则要求检查。此处因10-9空窗期已FAIL，且10-42逻辑中若无经历应PASS，但因整体流程阻断标记为FAIL以示拦截。",
      "next_action": "block"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "推荐至CDG，跳过内部技面。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 关联至 jr_y88\n- [10-5 ✓] 简历匹配硬性要求一票否决 — 学历、技能、年龄均符合\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中 Spark, Tableau 加分项\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-9 ✗] 简历履历空窗期检测与标记 — 2024-12 至今存在超 3 个月空窗且无说明\n- [10-35 ⓘ] 腾讯外籍候选人实名与通道限制规范 — 美国国籍，锁定外籍通道\n- [10-47 ✗] 腾讯婚育风险审视与推荐要点 — 女性 28 岁未婚，需 HSM 审核加分项\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — CDG 事业群跳过技面",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-47",
      "message": "候选人 周七 (女, 28岁, 未婚) 命中加分项: Spark, Tableau。请审核是否继续推进。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-16-14-096Z_f1e135_s07-foreign-marital-tencent`
  - run_id: `run_2026-05-12T04-16-14-096Z_f1e135`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`google/gemini-3-flash-preview` duration=16483 ms tokens=10080/3392
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 13 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-47` [needs_human] result=FAIL next=notify_hsm
  - `10-42` [terminal] result=FAIL next=block
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 16.49 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 13 ms |
| **total** | **16.50 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_f1e135_s07-fo_bec464` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c05-zhouqi-foreign-data jd=jr-tencent-cdg-data |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s07-foreign-marital-tencent_d48e77 |
| +2ms | `raas-api-resp` | candidate_id=C_d6cfb7e7 resume_id=R_39fcaab7 |
| +2ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_d6cfb7e7 jr=jr_y88 |
| +2ms | `raas-api-call` | GET /api/v1/requirements/jr_y88 |
| +3ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_TENCENT bg=CDG) |
| +3ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +16489ms | `llm-response` | model=google/gemini-3-flash-preview latency=16483ms tokens=10080/3392 |
| +16489ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=27/51 failures=10-9:gap_detected,10-42:cdg_cooling_off,10-47:gender_age_risk |
| +16502ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-16-14-096Z_f1e135_s07-foreign-marital-tencent + 13 flags |
| +16502ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-9:gap_detected,10-42:cdg_cooling_off,10-47:gender_age_risk |
