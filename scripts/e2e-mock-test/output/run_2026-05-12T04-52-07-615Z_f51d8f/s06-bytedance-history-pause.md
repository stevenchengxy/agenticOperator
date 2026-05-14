# s06-bytedance-history-pause ✅

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-bytedance-tiktok-fe`
> rationale: 张三 work_history[1] 显示曾在字节跳动任前端工程师(2018-2021,正式职位),配字节 TikTok 岗位时 10-49(字节正编员工回流标记)必命中,需上传客户 BP 同意回流凭证后才能继续推荐。binary 模式 → FAIL。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-49 | 10-49:former_bytedance_employee |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-49**
- ✅ **must-not-fail rule: 10-25** — applicable=false result=NOT_APPLICABLE
- ✅ **must-not-fail rule: 10-26** — applicable=false result=NOT_APPLICABLE
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (13)** — wrote=13 expected=13
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=13 / total=13

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 简历包含两段工作经历：阿里巴巴(2021-03至2024-08)及字节跳动(2018-07至2021-02)。平均每段时长约3年，无空窗期记录。 | 阿里巴巴, 简历包含两段工作经历, 及字节跳动 | 阿里巴巴, 2021-03 | 简历包含两段工作经历, 及字节跳动 | ✓ |
| 10-12 | 出生年份1996，本科毕业年份2018。毕业年龄22岁，符合本科基准22-23岁，偏差为0。 | 出生年份, 本科毕业年份, 毕业年龄 | — | 出生年份, 本科毕业年份 | ✓ |
| 10-14 | 岗位要求CET-6 480以上，候选人提供证书为CET-6 580，满足要求。 | 岗位要求, 以上, 候选人提供证书为 | CET-6, CET | 岗位要求, 以上 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_w66。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-5 | 学历本科满足；技能含React, TypeScript满足；语言CET-6满足；年龄30岁在22-32范围内满足。 | 学历本科满足, 技能含, 满足 | CET-6, React | 学历本科满足, 技能含 | ✓ |
| 10-6 | 命中加分项：Next.js (nice_to_have_skills)。 | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资35k-50k，岗位薪资30k-50k，上限一致，未超过框架上限。 | 期望薪资, 岗位薪资, 上限一致 | 35k-50k | 期望薪资, 岗位薪资 | ✓ |
| 10-8 | 外包接受度为“接受”。 | 外包接受度为, 接受 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 2018-07至今职业时间线连续，无超过3个月空窗期。 | 至今职业时间线连续, 无超过, 个月空窗期 | 2018-07 | 至今职业时间线连续, 无超过 | ✓ |
| 10-11 | 劳务形式偏好为“正编”，岗位为“正编”，匹配。 | 劳务形式偏好为, 正编, 岗位为 | 正编 | 劳务形式偏好为, 岗位为 | ✓ |
| 10-21 | 候选人30岁，岗位上限32岁，未超限。 | 候选人, 岗位上限, 未超限 | — | 候选人, 岗位上限 | ✓ |
| 10-36 | 候选人虽为女性且大于28岁，但婚育状态为“已婚已育”，不触发风险判定。 | 候选人虽为女性且大于, 但婚育状态为, 已婚已育 | 已婚已育 | 候选人虽为女性且大于, 但婚育状态为 | ✓ |
| 10-49 | 候选人曾于2018-07至2021-02在字节跳动任职前端工程师，识别为正编回流，需挂起流程校验凭证。 | 候选人曾于, 在字节跳动任职前端工程师, 识别为正编回流 | 2018-07, 2021-02 | 候选人曾于, 在字节跳动任职前端工程师 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_7aea7a1e",
  "job_requisition_id": "jr_w66",
  "client_id": "CLI_BYTEDANCE",
  "overall_decision": "FAIL",
  "failure_reasons": [
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
      "evidence": "简历包含两段工作经历：阿里巴巴(2021-03至2024-08)及字节跳动(2018-07至2021-02)。平均每段时长约3年，无空窗期记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生年份1996，本科毕业年份2018。毕业年龄22岁，符合本科基准22-23岁，偏差为0。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "岗位要求CET-6 480以上，候选人提供证书为CET-6 580，满足要求。",
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
      "evidence": "简历已关联至原始需求 jr_w66。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人工作经历中不包含华为、荣耀及其关联公司。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人工作经历中不包含OPPO、小米及其关联公司。",
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
      "result": "PASS",
      "evidence": "学历本科满足；技能含React, TypeScript满足；语言CET-6满足；年龄30岁在22-32范围内满足。",
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
      "evidence": "命中加分项：Next.js (nice_to_have_skills)。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资35k-50k，岗位薪资30k-50k，上限一致，未超过框架上限。",
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
      "result": "PASS",
      "evidence": "2018-07至今职业时间线连续，无超过3个月空窗期。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-1",
      "rule_name": "字节新需求下发滞留简历优先转推",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非滞留简历，为新解析简历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "劳务形式偏好为“正编”，岗位为“正编”，匹配。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-2",
      "rule_name": "字节新需求下发HC冻结候选人召回",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无历史HC冻结记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人30岁，岗位上限32岁，未超限。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位已设定年龄上限，本规则不适用。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-32",
      "rule_name": "岗位冷冻期规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无历史推荐记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-33",
      "rule_name": "字节客户退场回流约束规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无历史退场记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-34",
      "rule_name": "字节跳动友商非BPO外包经历回流冷冻期拦截",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中字节经历为2018-2021年，且未注明为友商外包派驻。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-36",
      "rule_name": "字节婚育风险审视与推荐要点",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人虽为女性且大于28岁，但婚育状态为“已婚已育”，不触发风险判定。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-49",
      "rule_name": "字节正编员工回流标记与凭证校验",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人曾于2018-07至2021-02在字节跳动任职前端工程师，识别为正编回流，需挂起流程校验凭证。",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-51",
      "rule_name": "字节正编回流客户BP确认放行",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未通过合规凭证校验。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 关联至 jr_w66\n- [10-5 ⓘ] 简历匹配硬性要求一票否决 — 学历、技能、语言、年龄均符合\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中加分项 Next.js\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包形式\n- [10-11 ⓘ] 求职意向劳务形式校验 — 正编意向匹配\n- [10-49 ✗] 字节正编员工回流标记与凭证校验 — 曾任职于字节跳动(2018-2021)",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-49",
      "message": "候选人张三存在字节跳动历史正编工作经历，请获取并上传合规凭证以继续流程。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-52-07-615Z_f51d8f_s06-bytedance-history-pause`
  - run_id: `run_2026-05-12T04-52-07-615Z_f51d8f`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=20195 ms tokens=10127/3451
  - rules_evaluated: 28 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, labor_form_preference, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 13 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=PASS next=continue
  - `10-36` [needs_human] result=PASS next=continue
  - `10-49` [needs_human] result=FAIL next=notify_recruiter

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 14 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 20.20 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 226 ms |
| **total** | **20.45 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_f51d8f_s06-by_c6c4e2` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c01-zhangsan-clean jd=jr-bytedance-tiktok-fe |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s06-bytedance-history-pause_d88cdd |
| +14ms | `raas-api-resp` | candidate_id=C_7aea7a1e resume_id=R_7624948c |
| +14ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_7aea7a1e jr=jr_w66 |
| +14ms | `raas-api-call` | GET /api/v1/requirements/jr_w66 |
| +15ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_BYTEDANCE bg=TikTok) |
| +15ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +20219ms | `llm-response` | model=google/gemini-3-flash-preview latency=20195ms tokens=10127/3451 |
| +20219ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=28/51 failures=10-49:former_bytedance_employee |
| +20445ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-52-07-615Z_f51d8f_s06-bytedance-history-pause + 13 flags + :Candidate / :Resume / :JR anchors |
| +20445ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-49:former_bytedance_employee |
