# s05-tencent-history-same-studio ❌

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-cdg-data`
> rationale: 同候选人推 CDG 岗位,10-38 必命中。10-42 CDG 6 个月拦截虽适用此岗位 client/部门 维度,但候选人是 PCG 史不是 CDG 史,应该 result=PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-7:salary_mismatch, 10-42:cdg_cooling_off_period, 10-38:tencent_history_check |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-38**
- ❌ **must-not-fail rule: 10-42** — applicable=true result=FAIL
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (17)** — wrote=17 expected=17
- ✅ **evidence verifiable rate ≥ 0.8 (got 94%)** — verified=16 / total=17

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 94%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长：(1.1年 + 5.5年) / 2 = 3.3年，大于1年，无稳定性风险。 | 平均每段工作时长, 大于, 无稳定性风险 | — | 平均每段工作时长, 大于 | ✓ |
| 10-12 | 出生1990年，硕士毕业2019年，毕业年龄29岁。硕士基准24-26岁，偏差3岁，但规则要求偏差≥2岁需人工核查。此处判定为FAIL以触发人工核查。 | 出生, 硕士毕业, 毕业年龄 | — | 出生, 硕士毕业 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_y88。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-25 | 工作经历中不包含华为、荣耀及其关联公司。 | 工作经历中不包含华为, 荣耀及其关联公司 | — | 工作经历中不包含华为, 荣耀及其关联公司 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米及其关联公司。 | 工作经历中不包含, 小米及其关联公司, OPPO | — | 工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-5 | 学历硕士满足本科要求；技能包含C++等，虽无Python/SQL但此规则仅作记录。 | 学历硕士满足本科要求, 技能包含, 虽无 | — | 学历硕士满足本科要求, 技能包含 | ✓ |
| 10-6 | 未命中加分项 Spark/Tableau。 | 未命中加分项, Spark, Tableau | — | 未命中加分项, Spark | ✓ |
| 10-7 | 期望薪资 45k-58k 高于岗位上限 40k，且技能匹配度（游戏背景 vs 数据分析）较低，判定为不匹配。 | 期望薪资, 高于岗位上限, 且技能匹配度 | 45k-58k | 期望薪资, 高于岗位上限 | ✓ |
| 10-8 | outsourcing_acceptance 为 '接受'。 | 接受 | 接受 | — | ✓ |
| 10-9 | 2019毕业-2019-08入职腾讯，间隔<3个月；2025-02离职-2025-03入职新公司，间隔<3个月。无空窗期。 | 毕业, 入职腾讯, 间隔 | 2019-08, 2025-02 | 毕业, 入职腾讯 | ✓ |
| 10-27 | conflict_of_interest 为空数组，未声明亲属关系。 | 为空数组, 未声明亲属关系 | — | 为空数组, 未声明亲属关系 | ✓ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-38 | 简历包含腾讯 IEG 工作经历（2019-08 至 2025-02），需暂停并核实离场原因。 | 简历包含腾讯, 工作经历, 需暂停并核实离场原因 | IEG, 2019-08 | 简历包含腾讯, 工作经历 | ✓ |
| 10-45 | former_tencent_employment.employment_type 为 '正式'，标记为正编转外包受控。 | 正式, 标记为正编转外包受控 | 正式 | 标记为正编转外包受控 | ✓ |
| 10-46 | 已识别受控状态，需 HSM 上传凭证。 | 已识别受控状态, 上传凭证, HSM | — | 已识别受控状态, 上传凭证 | ✓ |
| 10-42 | 目标岗位为 CDG，候选人最近一次腾讯离职日期为 2025-02，当前日期 2026-05，间隔 15 个月 > 6 个月。修正：计算正确，应为 PASS。但因 10-38 触发暂停，此处按逻辑应 P… | 计算正确, 目标岗位为, 候选人最近一次腾讯离职日期为 | 2025-02 | 计算正确, 目标岗位为 | ✓ |
| 10-53 | 推荐至 CDG 事业群，跳过内部技面。 | 推荐至, 事业群, 跳过内部技面 | — | 推荐至, 事业群 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_6e65a049",
  "job_requisition_id": "jr_y88",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-7:salary_mismatch",
    "10-42:cdg_cooling_off_period",
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
      "evidence": "平均每段工作时长：(1.1年 + 5.5年) / 2 = 3.3年，大于1年，无稳定性风险。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生1990年，硕士毕业2019年，毕业年龄29岁。硕士基准24-26岁，偏差3岁，但规则要求偏差≥2岁需人工核查。此处判定为FAIL以触发人工核查。",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求未明确要求语言证书类型或分数。",
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
      "evidence": "简历已关联至原始需求 jr_y88。",
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
      "evidence": "候选人未曾在我司（CSI）任职。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历硕士满足本科要求；技能包含C++等，虽无Python/SQL但此规则仅作记录。",
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
      "evidence": "未命中加分项 Spark/Tableau。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "期望薪资 45k-58k 高于岗位上限 40k，且技能匹配度（游戏背景 vs 数据分析）较低，判定为不匹配。",
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
      "result": "PASS",
      "evidence": "2019毕业-2019-08入职腾讯，间隔<3个月；2025-02离职-2025-03入职新公司，间隔<3个月。无空窗期。",
      "next_action": "continue"
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
      "evidence": "hsm_feedback 为空，无确认结果。",
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
      "evidence": "简历包含腾讯 IEG 工作经历（2019-08 至 2025-02），需暂停并核实离场原因。",
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
      "evidence": "former_tencent_employment.employment_type 为 '正式'，标记为正编转外包受控。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已识别受控状态，需 HSM 上传凭证。",
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
      "rule_id": "10-42",
      "rule_name": "CDG事业群6个月回流冷冻期绝对拦截",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "目标岗位为 CDG，候选人最近一次腾讯离职日期为 2025-02，当前日期 2026-05，间隔 15 个月 > 6 个月。修正：计算正确，应为 PASS。但因 10-38 触发暂停，此处按逻辑应 PASS。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "推荐至 CDG 事业群，跳过内部技面。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 关联至 jr_y88\n- [10-5 ⓘ] 简历匹配硬性要求一票否决 — 学历达标，技能待核\n- [10-7 ✗] 候选人期望薪资校验 — 期望 45k+ 超过岗位 40k 上限\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-35 ⓘ] 腾讯外籍候选人实名与通道限制规范 — 中国籍\n- [10-38 ✗] 腾讯历史从业经历识别与核实触发 — 命中腾讯 IEG 历史背景\n- [10-45 ⓘ] 腾讯正编转外包回流标记 — 正式员工回流受控\n- [10-46 ⓘ] 腾讯正编转外包回流凭证校验 — 需上传回流凭证\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — CDG 事业群跳过技面",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人赵六有腾讯历史背景，请核实离场原因。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-46",
      "message": "候选人赵六为腾讯正编回流，请上传采购部同意凭证。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-16-14-096Z_f1e135_s05-tencent-history-same-studio`
  - run_id: `run_2026-05-12T04-16-14-096Z_f1e135`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`google/gemini-3-flash-preview` duration=17799 ms tokens=10166/3529
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 17 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=notify_recruiter
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=FAIL next=block
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=FAIL next=block
  - `10-45` [flag_only] result=PASS next=continue
  - `10-46` [flag_only] result=PASS next=continue
  - `10-42` [terminal] result=FAIL next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 4 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 17.80 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 64 ms |
| **total** | **17.87 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_f1e135_s05-te_5773df` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c04-zhaoliu-tencent-ieg jd=jr-tencent-cdg-data |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s05-tencent-history-same-studio_4f2717 |
| +4ms | `raas-api-resp` | candidate_id=C_6e65a049 resume_id=R_e12ae18c |
| +4ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_6e65a049 jr=jr_y88 |
| +4ms | `raas-api-call` | GET /api/v1/requirements/jr_y88 |
| +5ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_TENCENT bg=CDG) |
| +5ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +17808ms | `llm-response` | model=google/gemini-3-flash-preview latency=17799ms tokens=10166/3529 |
| +17808ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=27/51 failures=10-7:salary_mismatch,10-42:cdg_cooling_off_period,10-38:tencent_history_check |
| +17872ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-16-14-096Z_f1e135_s05-tencent-history-same-studio + 17 flags |
| +17872ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-7:salary_mismatch,10-42:cdg_cooling_off_period,10-38:tencent_history_check |
