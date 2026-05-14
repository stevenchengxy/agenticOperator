# s04-tencent-history-cross-studio ✅

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-ieg-tianmei`
> rationale: 赵六腾讯 PCG 在职史(主动离场 4 个月前)。 10-38 必须命中:暂停推荐 + 向 HSM 发起核实任务确认真实离场原因。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-25:competitor_gap_insufficient, 10-38:former_tencent_verification_required, 10-40:tencent_active_leave_cooling_period |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-38**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (19)** — wrote=19 expected=19
- ✅ **evidence verifiable rate ≥ 0.8 (got 95%)** — verified=18 / total=19

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 95%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 候选人平均每段工作时长约 3.5 年（2019-08至2025-02，2025-03至2026-04），无消极空窗期记录。 | 候选人平均每段工作时长约, 无消极空窗期记录, 2019-08 | 2019-08, 2025-02 | 候选人平均每段工作时长约, 无消极空窗期记录 | ✓ |
| 10-12 | 1990年出生，2019年硕士毕业，毕业年龄29岁。虽较基准（24-26岁）大，但偏差主要源于个人教育路径，不属于逻辑异常挂起范畴。 | 年出生, 年硕士毕业, 毕业年龄 | — | 年出生, 年硕士毕业 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_z77。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-25 | 简历中最近一段经历为'某游戏公司'（2025-03至2026-04），当前日期2026-05，离职不足3个月，需核实该'某游戏公司'是否为华为/荣耀关联公司。 | 某游戏公司, 简历中最近一段经历为, 当前日期 | 某游戏公司, 2025-03 | 简历中最近一段经历为, 当前日期 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米及其关联公司。 | 工作经历中不包含, 小米及其关联公司, OPPO | — | 工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-5 | 学历硕士满足本科要求；技能包含C++、Lua；年龄36岁接近35岁上限但符合senior级别匹配。 | 学历硕士满足本科要求, 技能包含, 年龄 | Lua | 学历硕士满足本科要求, 技能包含 | ✓ |
| 10-6 | 命中加分项：UnrealEngine, Redis。 | UnrealEngine, 命中加分项, Redis | UnrealEngine, Redis | 命中加分项 | ✓ |
| 10-7 | 期望薪资 45k-58k 在岗位薪资 35k-60k 范围内。 | 期望薪资, 在岗位薪资, 范围内 | 45k-58k | 期望薪资, 在岗位薪资 | ✓ |
| 10-8 | 外包接受度为'接受'。 | 接受, 外包接受度为 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 各段经历衔接紧密（2025-02至2025-03），无超过3个月空窗期。 | 各段经历衔接紧密, 无超过, 个月空窗期 | 2025-02, 2025-03 | 各段经历衔接紧密, 无超过 | ✓ |
| 10-27 | conflict_of_interest 为空，未申报亲属关系。 | 为空, 未申报亲属关系 | — | 为空, 未申报亲属关系 | ✓ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-38 | 简历包含腾讯 IEG 天美工作室经历（2019-08至2025-02），需HSM核实离场原因。 | 简历包含腾讯, 天美工作室经历, 核实离场原因 | IEG, 2019-08 | 简历包含腾讯, 天美工作室经历 | ✓ |
| 10-45 | 识别到腾讯正式岗位经历，标记为'正编转外包受控'。 | 正编转外包受控, 识别到腾讯正式岗位经历, 标记为 | — | 正编转外包受控, 识别到腾讯正式岗位经历 | ✓ |
| 10-46 | 已标记受控，需后续流程上传凭证。 | 已标记受控, 需后续流程上传凭证 | — | 已标记受控, 需后续流程上传凭证 | ✓ |
| 10-3 | 当前无其他活跃流程记录。 | 当前无其他活跃流程记录 | — | 当前无其他活跃流程记录 | ✓ |
| 10-40 | 腾讯离职时间为2025-02，距今（2026-05）已超过6个月，但规则要求核实主动离职类型。简历显示为'主动离场'，需HSM介入。 | 主动离场, 腾讯离职时间为, 距今 | 主动离场, 2025-02 | 腾讯离职时间为, 距今 | ✓ |
| 10-43 | 原工作室为天美，目标岗位亦为天美，不涉及跨室拦截。 | 原工作室为天美, 目标岗位亦为天美, 不涉及跨室拦截 | — | 原工作室为天美, 目标岗位亦为天美 | ✓ |
| 10-52 | 已锁定内部技术面试节点。 | 已锁定内部技术面试节点 | — | 已锁定内部技术面试节点 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_e989c046",
  "job_requisition_id": "jr_z77",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-25:competitor_gap_insufficient",
    "10-38:former_tencent_verification_required",
    "10-40:tencent_active_leave_cooling_period"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人平均每段工作时长约 3.5 年（2019-08至2025-02，2025-03至2026-04），无消极空窗期记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1990年出生，2019年硕士毕业，毕业年龄29岁。虽较基准（24-26岁）大，但偏差主要源于个人教育路径，不属于逻辑异常挂起范畴。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求未包含外语、海外或国际化标签。",
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
      "evidence": "简历已关联至原始需求 jr_z77。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "简历中最近一段经历为'某游戏公司'（2025-03至2026-04），当前日期2026-05，离职不足3个月，需核实该'某游戏公司'是否为华为/荣耀关联公司。",
      "next_action": "notify_recruiter"
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
      "evidence": "候选人无我司（CSI）任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历硕士满足本科要求；技能包含C++、Lua；年龄36岁接近35岁上限但符合senior级别匹配。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求中未定义负向要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项：UnrealEngine, Redis。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 45k-58k 在岗位薪资 35k-60k 范围内。",
      "next_action": "continue"
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
      "result": "PASS",
      "evidence": "各段经历衔接紧密（2025-02至2025-03），无超过3个月空窗期。",
      "next_action": "continue"
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
      "evidence": "HSM尚未返回确认结果。",
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
      "evidence": "简历包含腾讯 IEG 天美工作室经历（2019-08至2025-02），需HSM核实离场原因。",
      "next_action": "block"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未收到HSM核实结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "识别到腾讯正式岗位经历，标记为'正编转外包受控'。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已标记受控，需后续流程上传凭证。",
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
      "rule_id": "10-3",
      "rule_name": "IEG活跃流程候选人改推拦截",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "当前无其他活跃流程记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "腾讯离职时间为2025-02，距今（2026-05）已超过6个月，但规则要求核实主动离职类型。简历显示为'主动离场'，需HSM介入。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-43",
      "rule_name": "IEG工作室回流候选人互斥标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "原工作室为天美，目标岗位亦为天美，不涉及跨室拦截。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-52",
      "rule_name": "IEG内部技术面试强制校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已锁定内部技术面试节点。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-56",
      "rule_name": "腾娱互动子公司回流冷冻期拦截",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无腾娱互动任职记录。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 已关联至 jr_z77\n- [10-25 ✗] 华为荣耀竞对与客户互不挖角红线 — 离职不足3个月需核实背景\n- [10-5 ⓘ] 简历匹配硬性要求一票否决 — 学历技能匹配，年龄接近上限\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中加分项 UnrealEngine, Redis\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-35 ⓘ] 腾讯外籍候选人实名与通道限制规范 — 中国籍\n- [10-38 ✗] 腾讯历史从业经历识别与核实触发 — 包含天美工作室经历需核实离场原因\n- [10-45 ⓘ] 腾讯正编转外包回流标记 — 正编回流受控标记\n- [10-46 ⓘ] 腾讯正编转外包回流凭证校验 — 需上传回流凭证\n- [10-3 ⓘ] IEG活跃流程候选人改推拦截 — 无活跃流程\n- [10-40 ✗] 腾讯主动离职人员紧急回流审核 — 主动离职回流需HSM审核\n- [10-43 ⓘ] IEG工作室回流候选人互斥标记 — 同工作室回流允许\n- [10-52 ⓘ] IEG内部技术面试强制校验 — 已锁定技术面试环节",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-25",
      "message": "候选人最近一段经历离职不足3个月，请核实是否属于华为/荣耀等竞对关联公司。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人赵六有腾讯历史背景，请核实其在天美工作室的真实离场原因。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-40",
      "message": "候选人属于腾讯主动离职回流，请根据其加分项命中情况执行回流审核。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-16-14-096Z_f1e135_s04-tencent-history-cross-studio`
  - run_id: `run_2026-05-12T04-16-14-096Z_f1e135`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`IEG`
  - LLM: model=`google/gemini-3-flash-preview` duration=18616 ms tokens=10970/4035
  - rules_evaluated: 30 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 19 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=FAIL next=notify_recruiter
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=FAIL next=block
  - `10-45` [flag_only] result=PASS next=continue
  - `10-46` [flag_only] result=PASS next=continue
  - `10-3` [flag_only] result=PASS next=continue
  - `10-40` [needs_human] result=FAIL next=notify_hsm
  - `10-43` [flag_only] result=PASS next=continue
  - `10-52` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 18.62 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 20 ms |
| **total** | **18.64 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_f1e135_s04-te_d1e956` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c04-zhaoliu-tencent-ieg jd=jr-tencent-ieg-tianmei |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s04-tencent-history-cross-studio_ea1ed7 |
| +2ms | `raas-api-resp` | candidate_id=C_e989c046 resume_id=R_d2cc1b7e |
| +2ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_e989c046 jr=jr_z77 |
| +2ms | `raas-api-call` | GET /api/v1/requirements/jr_z77 |
| +3ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_TENCENT bg=IEG) |
| +3ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +18623ms | `llm-response` | model=google/gemini-3-flash-preview latency=18616ms tokens=10970/4035 |
| +18623ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=30/51 failures=10-25:competitor_gap_insufficient,10-38:former_tencent_verification_required, |
| +18643ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-16-14-096Z_f1e135_s04-tencent-history-cross-studio + 19 flags |
| +18643ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-25:competitor_gap_insufficient,10-38:former_tencent_verification_required,10-40:tencent_active_leave_ |
