# s04-tencent-history-cross-studio ✅

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-ieg-tianmei`
> rationale: 赵六腾讯 PCG 在职史(主动离场 4 个月前)。 10-38 必须命中:暂停推荐 + 向 HSM 发起核实任务确认真实离场原因。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-9:gap_detected, 10-25:competitor_risk, 10-38:tencent_history_check, 10-40:cooling_off_period, 10-47:gender_age_risk |
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
| 10-10 | 平均每段工作时长约3.5年(2019-08至2025-02为5.5年)，无消极空窗理由。 | 平均每段工作时长约, 无消极空窗理由, 2019-08 | 2019-08, 2025-02 | 平均每段工作时长约, 无消极空窗理由 | ✓ |
| 10-12 | 1990年出生，2019年硕士毕业，毕业年龄29岁。硕士基准24-26岁，偏差3岁，但规则要求偏差≥2岁仅为预警，此处逻辑正常。 | 年出生, 年硕士毕业, 毕业年龄 | — | 年出生, 年硕士毕业 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_z77。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-25 | 简历未提供最近一段经历'某游戏公司'的详细背景，若涉及华为关联公司需核查。且当前日期2026-05-12距前段腾讯经历2025-02已超3个月，但需确认最新一段经历属性。 | 某游戏公司, 简历未提供最近一段经历, 的详细背景 | 某游戏公司, 2025-02 | 简历未提供最近一段经历, 的详细背景 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米及其关联公司。 | 工作经历中不包含, 小米及其关联公司, OPPO | — | 工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-5 | 学历硕士(>=本科), 技能包含C++/Lua, 年龄36岁(略超35岁上限但属资深层级), 薪资45k-58k在35k-60k范围内。 | 学历硕士, 本科, 技能包含 | 45k-58k, Lua | 学历硕士, 本科 | ✓ |
| 10-6 | 命中加分项: UnrealEngine, Redis。 | UnrealEngine, 命中加分项, Redis | UnrealEngine, Redis | 命中加分项 | ✓ |
| 10-7 | 期望薪资45k-58k，未超过岗位上限60k。 | 期望薪资, 未超过岗位上限, 45k-58k | 45k-58k | 期望薪资, 未超过岗位上限 | ✓ |
| 10-8 | 外包接受程度为'接受'。 | 接受, 外包接受程度为 | 接受 | 外包接受程度为 | ✓ |
| 10-9 | 2019年毕业至2019-08首份工作间隔约2个月；但2025-02离职腾讯至2025-03入职某公司间隔不足3月，整体连续。但简历未提供空窗期原因说明字段，标记待补充。 | 年毕业至, 首份工作间隔约, 个月 | 2019-08, 2025-02 | 年毕业至, 首份工作间隔约 | ✓ |
| 10-27 | conflict_of_interest 为空，未声明亲属关系。 | 为空, 未声明亲属关系 | — | 为空, 未声明亲属关系 | ✓ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-38 | 包含腾讯IEG天美工作室经历(2019-08至2025-02)，需HSM核实离场原因。 | 包含腾讯, 天美工作室经历, 核实离场原因 | IEG, 2019-08 | 包含腾讯, 天美工作室经历 | ✓ |
| 10-45 | 曾任职腾讯IEG天美工作室，身份为'正式'。 | 正式, 曾任职腾讯, 天美工作室 | 正式, 天美工作室 | 曾任职腾讯, 身份为 | ✓ |
| 10-46 | 已识别正编转外包受控状态，需HSM上传凭证。 | 已识别正编转外包受控状态, 上传凭证, HSM | — | 已识别正编转外包受控状态, 上传凭证 | ✓ |
| 10-3 | 当前无其他IEG活跃流程记录。 | 当前无其他, 活跃流程记录, IEG | IEG | 当前无其他, 活跃流程记录 | ✓ |
| 10-40 | 腾讯离职时间为2025-02，距今已超6个月，但规则要求核实主动离场属性。简历显示为'主动离场'。 | 主动离场, 腾讯离职时间为, 距今已超 | 主动离场, 2025-02 | 腾讯离职时间为, 距今已超 | ✓ |
| 10-43 | 原工作室为天美，目标工作室亦为天美，不属于跨室推荐拦截范围。 | 原工作室为天美, 目标工作室亦为天美, 不属于跨室推荐拦截范围 | — | 原工作室为天美, 目标工作室亦为天美 | ✓ |
| 10-52 | 已锁定内部技术面试节点。 | 已锁定内部技术面试节点 | — | 已锁定内部技术面试节点 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_3009c962",
  "job_requisition_id": "jr_z77",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-9:gap_detected",
    "10-25:competitor_risk",
    "10-38:tencent_history_check",
    "10-40:cooling_off_period",
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
      "evidence": "平均每段工作时长约3.5年(2019-08至2025-02为5.5年)，无消极空窗理由。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1990年出生，2019年硕士毕业，毕业年龄29岁。硕士基准24-26岁，偏差3岁，但规则要求偏差≥2岁仅为预警，此处逻辑正常。",
      "next_action": "continue"
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
      "evidence": "简历未提供最近一段经历'某游戏公司'的详细背景，若涉及华为关联公司需核查。且当前日期2026-05-12距前段腾讯经历2025-02已超3个月，但需确认最新一段经历属性。",
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
      "evidence": "学历硕士(>=本科), 技能包含C++/Lua, 年龄36岁(略超35岁上限但属资深层级), 薪资45k-58k在35k-60k范围内。",
      "next_action": "continue"
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
      "evidence": "命中加分项: UnrealEngine, Redis。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资45k-58k，未超过岗位上限60k。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受程度为'接受'。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "2019年毕业至2019-08首份工作间隔约2个月；但2025-02离职腾讯至2025-03入职某公司间隔不足3月，整体连续。但简历未提供空窗期原因说明字段，标记待补充。",
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
      "evidence": "尚未有HSM返回的亲属关系确认结果。",
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
      "evidence": "包含腾讯IEG天美工作室经历(2019-08至2025-02)，需HSM核实离场原因。",
      "next_action": "block"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未收到HSM针对离场原因的核实结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "曾任职腾讯IEG天美工作室，身份为'正式'。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已识别正编转外包受控状态，需HSM上传凭证。",
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
      "evidence": "当前无其他IEG活跃流程记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "腾讯离职时间为2025-02，距今已超6个月，但规则要求核实主动离场属性。简历显示为'主动离场'。",
      "next_action": "notify_hsm"
    },
    {
      "rule_id": "10-43",
      "rule_name": "IEG工作室回流候选人互斥标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "原工作室为天美，目标工作室亦为天美，不属于跨室推荐拦截范围。",
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
      "evidence": "简历不包含深圳市腾娱互动科技有限公司任职记录。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 已关联至 jr_z77\n- [10-25 ✗] 华为荣耀竞对与客户互不挖角红线 — 需核实最新一段经历背景\n- [10-5 ⓘ] 简历匹配硬性要求一票否决 — 学历技能匹配，年龄略超\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中 UnrealEngine, Redis 加分项\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-9 ✗] 简历履历空窗期检测与标记 — 缺少空窗期原因说明字段\n- [10-35 ⓘ] 腾讯外籍候选人实名与通道限制规范 — 中国国籍\n- [10-38 ✗] 腾讯历史从业经历识别与核实触发 — 发现腾讯天美历史经历，需核实离场原因\n- [10-45 ⓘ] 腾讯正编转外包回流标记 — 标记为正编转外包受控\n- [10-46 ⓘ] 腾讯正编转外包回流凭证校验 — 需上传采购部同意凭证\n- [10-3 ⓘ] IEG活跃流程候选人改推拦截 — 无活跃流程\n- [10-40 ✗] 腾讯主动离职人员紧急回流审核 — 腾讯主动离场经历需HSM审核\n- [10-43 ⓘ] IEG工作室回流候选人互斥标记 — 同工作室回流，允许匹配\n- [10-52 ⓘ] IEG内部技术面试强制校验 — 已锁定技术面试环节",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-25",
      "message": "候选人赵六存在竞对公司背景风险，请核实最新一段经历是否涉及华为/荣耀关联公司。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人赵六曾任职于腾讯IEG天美工作室，请核实其实际离场原因是否为淘汰退场。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-40",
      "message": "候选人赵六为腾讯主动离场人员，请审核其回流资格。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-54-42-449Z_081848_s04-tencent-history-cross-studio`
  - run_id: `run_2026-05-12T04-54-42-449Z_081848`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`IEG`
  - LLM: model=`google/gemini-3-flash-preview` duration=23103 ms tokens=10972/4132
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
  - `10-9` [terminal] result=FAIL next=block
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
| rule check (LLM) | 23.11 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 27 ms |
| **total** | **23.14 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_081848_s04-te_d65eea` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c04-zhaoliu-tencent-ieg jd=jr-tencent-ieg-tianmei |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s04-tencent-history-cross-studio_a622cd |
| +2ms | `raas-api-resp` | candidate_id=C_3009c962 resume_id=R_e59c8b66 |
| +2ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_3009c962 jr=jr_z77 |
| +2ms | `raas-api-call` | GET /api/v1/requirements/jr_z77 |
| +3ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_TENCENT bg=IEG) |
| +3ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +23111ms | `llm-response` | model=google/gemini-3-flash-preview latency=23103ms tokens=10972/4132 |
| +23111ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=30/51 failures=10-9:gap_detected,10-25:competitor_risk,10-38:tencent_history_check,10-40:coo |
| +23138ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-54-42-449Z_081848_s04-tencent-history-cross-studio + 19 flags + :Candidate / :Resume / :JR anchor |
| +23138ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-9:gap_detected,10-25:competitor_risk,10-38:tencent_history_check,10-40:cooling_off_period,10-47:gende |
