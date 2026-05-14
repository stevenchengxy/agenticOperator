# s10-clean-tencent-cdg ✅

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-tencent-cdg-data`
> rationale: 张三是 React/TS 前端工程师,推腾讯 CDG 数据分析岗 → 技能完全不匹配,10-5 硬性要求一票否决必命中。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-5 | 10-5:hard_requirement_mismatch, 10-7:salary_mismatch, 10-9:gap_period_unexplained |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-5**
- ✅ **must-not-fail rule: 10-25** — applicable=true result=PASS
- ✅ **must-not-fail rule: 10-38** — applicable=true result=PASS
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (20)** — wrote=20 expected=20
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=20 / total=20

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长：(2024-08至2021-03=41个月) + (2021-02至2018-07=31个月) / 2 = 36个月，远超1年稳定性要求。 | 平均每段工作时长, 个月, 远超 | 2024-08, 2021-03 | 平均每段工作时长, 个月 | ✓ |
| 10-12 | 毕业年份2018 - 出生年份1996 = 22岁。符合本科基准22-23岁，偏差为0。 | 毕业年份, 出生年份, 符合本科基准 | — | 毕业年份, 出生年份 | ✓ |
| 10-16 | 候选人历史公司为阿里巴巴、字节跳动，无华腾或中软国际经历。 | 候选人历史公司为阿里巴巴, 字节跳动, 无华腾或中软国际经历 | 字节跳动 | 候选人历史公司为阿里巴巴, 无华腾或中软国际经历 | ✓ |
| 10-17 | 候选人无华腾或中软国际历史工作经历。 | 候选人无华腾或中软国际历史工作经历 | — | 候选人无华腾或中软国际历史工作经历 | ✓ |
| 10-18 | 候选人无华腾或中软国际历史工作经历。 | 候选人无华腾或中软国际历史工作经历 | — | 候选人无华腾或中软国际历史工作经历 | ✓ |
| 10-24 | 简历已解析并关联至原始需求 jr_y88。 | 简历已解析并关联至原始需求 | — | 简历已解析并关联至原始需求 | ✓ |
| 10-25 | 工作经历中不包含华为、荣耀及其关联公司。 | 工作经历中不包含华为, 荣耀及其关联公司 | — | 工作经历中不包含华为, 荣耀及其关联公司 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米及其关联公司。 | 工作经历中不包含, 小米及其关联公司, OPPO | — | 工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-5 | 必备技能不符：岗位要求 Python/SQL，候选人技能列表为 React/TypeScript/Node.js 等前端技术，未提及 Python/SQL。 | 岗位要求 Python/SQL, 必备技能不符, 岗位要求 | React, TypeScript | 岗位要求 Python/SQL, 必备技能不符 | ✓ |
| 10-6 | 候选人未命中加分项（Spark/Tableau），不展示高亮标签。 | 候选人未命中加分项, 不展示高亮标签, Spark | — | 候选人未命中加分项, 不展示高亮标签 | ✓ |
| 10-7 | 期望薪资 35k-50k 高于岗位上限 40k，且候选人技能匹配度低，判定为薪资不匹配。 | 期望薪资, 高于岗位上限, 且候选人技能匹配度低 | 35k-50k | 期望薪资, 高于岗位上限 | ✓ |
| 10-8 | outsourcing_acceptance 为 '接受'。 | 接受 | 接受 | — | ✓ |
| 10-9 | 2021-02（字节结束）至 2021-03（阿里开始）间隔1个月；但 2024-08 至今已超过3个月且无原因说明。 | 字节结束, 阿里开始, 间隔 | 2021-02, 2021-03 | 字节结束, 阿里开始 | ✓ |
| 10-27 | conflict_of_interest 为空数组，未声明亲属关系。 | 为空数组, 未声明亲属关系 | — | 为空数组, 未声明亲属关系 | ✓ |
| 10-35 | nationality 为 '中国'。 | 中国, nationality | 中国, nationality | — | ✓ |
| 10-38 | 简历中不包含腾讯或腾讯外包工作经历。 | 简历中不包含腾讯或腾讯外包工作经历 | — | 简历中不包含腾讯或腾讯外包工作经历 | ✓ |
| 10-45 | 不存在腾讯历史从业经历。 | 不存在腾讯历史从业经历 | — | 不存在腾讯历史从业经历 | ✓ |
| 10-47 | 候选人为男性，不适用该性别限制规则。 | 候选人为男性, 不适用该性别限制规则 | — | 候选人为男性, 不适用该性别限制规则 | ✓ |
| 10-42 | 候选人无腾讯相关工作经历。 | 候选人无腾讯相关工作经历 | — | 候选人无腾讯相关工作经历 | ✓ |
| 10-53 | 目标岗位属于 CDG，符合跳过面试条件。 | 目标岗位属于, 符合跳过面试条件, CDG | — | 目标岗位属于, 符合跳过面试条件 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_6d3db5ae",
  "job_requisition_id": "jr_y88",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
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
      "evidence": "平均每段工作时长：(2024-08至2021-03=41个月) + (2021-02至2018-07=31个月) / 2 = 36个月，远超1年稳定性要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业年份2018 - 出生年份1996 = 22岁。符合本科基准22-23岁，偏差为0。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求未明确要求语言证书类型或包含外语/海外标签。",
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
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人历史公司为阿里巴巴、字节跳动，无华腾或中软国际经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
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
      "evidence": "简历已解析并关联至原始需求 jr_y88。",
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
      "evidence": "简历未显示曾在我司（CSI）任职过。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "FAIL",
      "evidence": "必备技能不符：岗位要求 Python/SQL，候选人技能列表为 React/TypeScript/Node.js 等前端技术，未提及 Python/SQL。",
      "next_action": "block"
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
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人未命中加分项（Spark/Tableau），不展示高亮标签。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "期望薪资 35k-50k 高于岗位上限 40k，且候选人技能匹配度低，判定为薪资不匹配。",
      "next_action": "block"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "outsourcing_acceptance 为 '接受'。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "2021-02（字节结束）至 2021-03（阿里开始）间隔1个月；但 2024-08 至今已超过3个月且无原因说明。",
      "next_action": "block"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空数组，未声明亲属关系。",
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
      "evidence": "nationality 为 '中国'。",
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
      "evidence": "未触发核实任务。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "不存在腾讯历史从业经历。",
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
      "result": "PASS",
      "evidence": "候选人为男性，不适用该性别限制规则。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-42",
      "rule_name": "CDG事业群6个月回流冷冻期绝对拦截",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人无腾讯相关工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标岗位属于 CDG，符合跳过面试条件。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 关联至 jr_y88\n- [10-5 ✗] 简历匹配硬性要求一票否决 — 缺失 Python/SQL 必备技能\n- [10-7 ✗] 候选人期望薪资校验 — 期望 35k-50k 偏高且技能不匹配\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-9 ✗] 简历履历空窗期检测与标记 — 2024-08 至今空窗未说明\n- [10-35 ⓘ] 腾讯外籍候选人实名与通道限制规范 — 中国籍\n- [10-45 ⓘ] 腾讯正编转外包回流标记 — 无腾讯背景\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — CDG 事业群适用",
  "notifications": []
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-54-42-449Z_081848_s10-clean-tencent-cdg`
  - run_id: `run_2026-05-12T04-54-42-449Z_081848`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`google/gemini-3-flash-preview` duration=18361 ms tokens=10107/3275
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 20 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-16` [terminal] result=PASS next=continue
  - `10-17` [terminal] result=PASS next=continue
  - `10-18` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=FAIL next=block
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=FAIL next=block
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=PASS next=continue
  - `10-45` [flag_only] result=PASS next=continue
  - `10-47` [needs_human] result=PASS next=continue
  - `10-42` [terminal] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 18.41 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 35 ms |
| **total** | **18.45 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_081848_s10-cl_245dd5` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c01-zhangsan-clean jd=jr-tencent-cdg-data |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s10-clean-tencent-cdg_9b1cbb |
| +2ms | `raas-api-resp` | candidate_id=C_6d3db5ae resume_id=R_62ca6f0e |
| +2ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_6d3db5ae jr=jr_y88 |
| +2ms | `raas-api-call` | GET /api/v1/requirements/jr_y88 |
| +3ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_TENCENT bg=CDG) |
| +3ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +18418ms | `llm-response` | model=google/gemini-3-flash-preview latency=18361ms tokens=10107/3275 |
| +18418ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=27/51 failures=10-5:hard_requirement_mismatch,10-7:salary_mismatch,10-9:gap_period_unexplain |
| +18453ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-54-42-449Z_081848_s10-clean-tencent-cdg + 20 flags + :Candidate / :Resume / :JR anchors |
| +18453ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-5:hard_requirement_mismatch,10-7:salary_mismatch,10-9:gap_period_unexplained |
