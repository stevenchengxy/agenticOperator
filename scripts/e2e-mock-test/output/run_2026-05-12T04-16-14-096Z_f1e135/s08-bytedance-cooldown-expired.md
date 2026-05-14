# s08-bytedance-cooldown-expired ✅

> scenario: candidate=`c06-qianba-bytedance-history` × jd=`jr-bytedance-tiktok-fe`
> rationale: 钱八 work_history 含字节跳动正式员工(2 年前主动离职)。10-49 字节正编回流标记仍要求上传客户 BP 凭证。冷冻期已过(>6m),但凭证流程未走完 → needs_human → FAIL。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-49 | 10-9:gap_detected, 10-49:former_bytedance_employee |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-49**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (12)** — wrote=12 expected=12
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=12 / total=12

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均工作时长约2.8年（2020-07至2024-03, 2024-04至2026-04），无消极空窗理由 | 平均工作时长约, 无消极空窗理由, 2020-07 | 2020-07, 2024-03 | 平均工作时长约, 无消极空窗理由 | ✓ |
| 10-12 | 出生1995年，2020年本科毕业，毕业年龄25岁，偏差在2岁以内 | 出生, 年本科毕业, 毕业年龄 | — | 出生, 年本科毕业 | ✓ |
| 10-14 | 岗位要求CET-6 480，候选人提供CET-6 550，满足要求 | 岗位要求, 候选人提供, 满足要求 | CET-6, CET | 岗位要求, 候选人提供 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_w66 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-5 | 学历本科、技能React/TS、语言CET-6、年龄30岁均满足JD硬性要求 | 学历本科, 技能, 语言 | CET-6, React | 学历本科, 技能 | ✓ |
| 10-6 | 命中加分项：Next.js (nice_to_have_skills) | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资 40k-50k 在岗位 30k-50k 范围内 | 期望薪资, 在岗位, 范围内 | 40k-50k | 期望薪资, 在岗位 | ✓ |
| 10-8 | 外包接受程度为“接受” | 外包接受程度为, 接受 | 接受 | 外包接受程度为 | ✓ |
| 10-9 | 毕业时间2020-06至首份工作2020-07无空窗；但2024-03离职字节至2024-04入职美团虽不足3月，但系统检测到毕业至今时间线需核对，且规则要求记录待补充信息 | 毕业时间, 至首份工作, 无空窗 | 2020-07, 2024-03 | 毕业时间, 至首份工作 | ✓ |
| 10-11 | 候选人意向为“正编”，岗位为“正编”，匹配 | 候选人意向为, 正编, 岗位为 | 正编 | 候选人意向为, 岗位为 | ✓ |
| 10-21 | 候选人30岁，在岗位要求22-32岁范围内 | 候选人, 在岗位要求, 岁范围内 | — | 候选人, 在岗位要求 | ✓ |
| 10-49 | 候选人曾于2020-07至2024-03在字节跳动任职，需核实是否为正编并获取凭证 | 候选人曾于, 在字节跳动任职, 需核实是否为正编并获取凭证 | 2020-07, 2024-03 | 候选人曾于, 在字节跳动任职 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_b7def452",
  "job_requisition_id": "jr_w66",
  "client_id": "CLI_BYTEDANCE",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-9:gap_detected",
    "10-49:former_bytedance_employee"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均工作时长约2.8年（2020-07至2024-03, 2024-04至2026-04），无消极空窗理由",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生1995年，2020年本科毕业，毕业年龄25岁，偏差在2岁以内",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "岗位要求CET-6 480，候选人提供CET-6 550，满足要求",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位未带有轮班、夜班、倒班或长期出差标签",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中无华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中无华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中无华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历已关联至原始需求 jr_w66",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中无华为、荣耀任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中无OPPO、小米任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未显示曾在我司任职",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历本科、技能React/TS、语言CET-6、年龄30岁均满足JD硬性要求",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求中无定义的负向要求",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项：Next.js (nice_to_have_skills)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 40k-50k 在岗位 30k-50k 范围内",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受程度为“接受”",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "毕业时间2020-06至首份工作2020-07无空窗；但2024-03离职字节至2024-04入职美团虽不足3月，但系统检测到毕业至今时间线需核对，且规则要求记录待补充信息",
      "next_action": "block"
    },
    {
      "rule_id": "10-1",
      "rule_name": "字节新需求下发滞留简历优先转推",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非滞留简历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人意向为“正编”，岗位为“正编”，匹配",
      "next_action": "continue"
    },
    {
      "rule_id": "10-2",
      "rule_name": "字节新需求下发HC冻结候选人召回",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HC冻结历史记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人30岁，在岗位要求22-32岁范围内",
      "next_action": "continue"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位已设定年龄上限",
      "next_action": "continue"
    },
    {
      "rule_id": "10-32",
      "rule_name": "岗位冷冻期规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无历史推荐记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-33",
      "rule_name": "字节客户退场回流约束规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无历史退场记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-34",
      "rule_name": "字节跳动友商非BPO外包经历回流冷冻期拦截",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中字节经历未显示为通过友商派驻",
      "next_action": "continue"
    },
    {
      "rule_id": "10-36",
      "rule_name": "字节婚育风险审视与推荐要点",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人为男性",
      "next_action": "continue"
    },
    {
      "rule_id": "10-49",
      "rule_name": "字节正编员工回流标记与凭证校验",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人曾于2020-07至2024-03在字节跳动任职，需核实是否为正编并获取凭证",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-51",
      "rule_name": "字节正编回流客户BP确认放行",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未通过合规凭证校验",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 自动关联至 jr_w66\n- [10-5 ✓] 简历匹配硬性要求一票否决 — 学历、技能、语言、年龄均符合\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中加分项 Next.js\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-9 ✗] 简历履历空窗期检测与标记 — 需核实职业时间线连续性\n- [10-11 ⓘ] 求职意向劳务形式校验 — 意向正编匹配岗位性质\n- [10-49 ✗] 字节正编员工回流标记与凭证校验 — 识别到字节跳动历史经历，需人工核查凭证",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-49",
      "message": "候选人 钱八 存在字节跳动历史工作经历，请获取并上传合规凭证以继续流程。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-16-14-096Z_f1e135_s08-bytedance-cooldown-expired`
  - run_id: `run_2026-05-12T04-16-14-096Z_f1e135`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=17556 ms tokens=10085/3447
  - rules_evaluated: 28 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, labor_form_preference, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 12 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=PASS next=continue
  - `10-49` [needs_human] result=FAIL next=notify_recruiter

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 1 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 17.56 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 24 ms |
| **total** | **17.59 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_f1e135_s08-by_03a6ba` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c06-qianba-bytedance-history jd=jr-bytedance-tiktok-fe |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s08-bytedance-cooldown-expired_ac3b91 |
| +1ms | `raas-api-resp` | candidate_id=C_b7def452 resume_id=R_fd17c00b |
| +1ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_b7def452 jr=jr_w66 |
| +1ms | `raas-api-call` | GET /api/v1/requirements/jr_w66 |
| +2ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_BYTEDANCE bg=TikTok) |
| +2ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +17563ms | `llm-response` | model=google/gemini-3-flash-preview latency=17556ms tokens=10085/3447 |
| +17563ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=28/51 failures=10-9:gap_detected,10-49:former_bytedance_employee |
| +17587ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-16-14-096Z_f1e135_s08-bytedance-cooldown-expired + 12 flags |
| +17587ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-9:gap_detected,10-49:former_bytedance_employee |
