# s09-tencent-history-to-bytedance ❌

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-bytedance-tiktok-fe`
> rationale: 赵六(C++/Lua 游戏后端)推字节 TikTok 前端岗。腾讯规则 (10-38/10-43)在字节路径下 applicable=false(客户不匹配,规则不适用)。通用 10-5(技能一票否决)必命中。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-5 | 10-14:language_mismatch, 10-5:hard_requirement_mismatch, 10-7:salary_exceeds_limit, 10-9:gap_period_unexplained, 10-21:age_limit_exceeded |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-5**
- ❌ **must-not-fail rule: 10-38** — LLM 没在 rule_flags 输出这条规则
- ❌ **must-not-fail rule: 10-43** — LLM 没在 rule_flags 输出这条规则
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (10)** — wrote=10 expected=10
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=10 / total=10

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长约3.3年（2019-08至2025-02为5.5年，2025-03至2026-04为1.1年），不属于稳定性风险。 | 平均每段工作时长约, 不属于稳定性风险, 2019-08 | 2019-08, 2025-02 | 平均每段工作时长约, 不属于稳定性风险 | ✓ |
| 10-12 | 1990年出生，2019年硕士毕业，毕业年龄29岁。硕士基准24-26岁，偏差3岁，但规则判定逻辑中未明确硕士偏差3岁必须FAIL，且简历逻辑自洽。 | 年出生, 年硕士毕业, 毕业年龄 | — | 年出生, 年硕士毕业 | ✓ |
| 10-14 | 岗位要求CET-6 480以上，候选人提供CET-6 510，但岗位标签含“外语”，候选人简历中未提供其他外语证书，且核心技能为后端，与前端岗位语言要求匹配度待定。 | 岗位要求, 以上, 候选人提供 | CET-6, CET | 岗位要求, 以上 | ✓ |
| 10-24 | 简历已关联至jr_w66需求。 | 简历已关联至, 需求 | — | 简历已关联至, 需求 | ✓ |
| 10-5 | 必备技能不符：岗位要求React, TypeScript；候选人技能为C++, Lua, Redis, UnrealEngine。职能不符：岗位为Web前端，候选人为游戏后端。 | 岗位要求React, 岗位为Web前端, 必备技能不符 | Lua, Redis | 岗位要求React, 岗位为Web前端 | ✓ |
| 10-7 | 候选人期望45k-58k，岗位上限50k。由于硬性技能不匹配，综合得分必然低于90分，判定为薪资不匹配。 | 候选人期望, 岗位上限, 由于硬性技能不匹配 | 45k-58k | 候选人期望, 岗位上限 | ✓ |
| 10-8 | 候选人接受外包/正编（labor_form_preference: 正编, outsourcing_acceptance: 接受）。 | 正编, 接受, 候选人接受外包 | 正编, 接受 | 候选人接受外包 | ✓ |
| 10-9 | 2019年毕业至2019-08首份工作起始，存在约2-7个月空窗（具体取决于毕业月份），且简历未提供空窗期原因说明。 | 年毕业至, 首份工作起始, 存在约 | 2019-08 | 年毕业至, 首份工作起始 | ✓ |
| 10-11 | 候选人意愿为正编，符合岗位招聘类型。 | 候选人意愿为正编, 符合岗位招聘类型 | — | 候选人意愿为正编, 符合岗位招聘类型 | ✓ |
| 10-21 | 岗位年龄上限32岁，候选人出生于1990-04-15，当前年龄36岁（以2026-05计算），超过上限。 | 岗位年龄上限, 候选人出生于, 当前年龄 | 计算, 1990-04 | 岗位年龄上限, 候选人出生于 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_50b89b7a",
  "job_requisition_id": "jr_w66",
  "client_id": "CLI_BYTEDANCE",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-14:language_mismatch",
    "10-5:hard_requirement_mismatch",
    "10-7:salary_exceeds_limit",
    "10-9:gap_period_unexplained",
    "10-21:age_limit_exceeded"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长约3.3年（2019-08至2025-02为5.5年，2025-03至2026-04为1.1年），不属于稳定性风险。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1990年出生，2019年硕士毕业，毕业年龄29岁。硕士基准24-26岁，偏差3岁，但规则判定逻辑中未明确硕士偏差3岁必须FAIL，且简历逻辑自洽。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求CET-6 480以上，候选人提供CET-6 510，但岗位标签含“外语”，候选人简历中未提供其他外语证书，且核心技能为后端，与前端岗位语言要求匹配度待定。",
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
      "evidence": "简历已关联至jr_w66需求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "工作经历中不包含华为、荣耀。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
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
      "evidence": "无我司任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "FAIL",
      "evidence": "必备技能不符：岗位要求React, TypeScript；候选人技能为C++, Lua, Redis, UnrealEngine。职能不符：岗位为Web前端，候选人为游戏后端。",
      "next_action": "block"
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
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人未通过硬性要求校验。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人期望45k-58k，岗位上限50k。由于硬性技能不匹配，综合得分必然低于90分，判定为薪资不匹配。",
      "next_action": "block"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人接受外包/正编（labor_form_preference: 正编, outsourcing_acceptance: 接受）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "2019年毕业至2019-08首份工作起始，存在约2-7个月空窗（具体取决于毕业月份），且简历未提供空窗期原因说明。",
      "next_action": "block"
    },
    {
      "rule_id": "10-1",
      "rule_name": "字节新需求下发滞留简历优先转推",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非滞留简历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人意愿为正编，符合岗位招聘类型。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-2",
      "rule_name": "字节新需求下发HC冻结候选人召回",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HC冻结记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位年龄上限32岁，候选人出生于1990-04-15，当前年龄36岁（以2026-05计算），超过上限。",
      "next_action": "block"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位已设定年龄上限，不适用隐形门槛规则。",
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
      "evidence": "简历中未发现通过友商派驻字节的经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-36",
      "rule_name": "字节婚育风险审视与推荐要点",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人为男性。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-49",
      "rule_name": "字节正编员工回流标记与凭证校验",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中未包含字节跳动正式雇员经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-51",
      "rule_name": "字节正编回流客户BP确认放行",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "未触发正编回流校验。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-10 ✓] 简历履历空窗期与职业稳定性风险判定 — 平均每段工作时长约3.3年，稳定性良好。\n- [10-12 ✓] 学历年龄逻辑校验与风险预警 — 毕业年龄29岁，逻辑基本合理。\n- [10-14 ✗] 语言能力硬性门槛判断 — 岗位要求外语证书，候选人仅提供CET-6，且职能不匹配。\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 已关联至jr_w66。\n- [10-5 ✗] 简历匹配硬性要求一票否决 — 技能不符（后端vs前端），必备技能React/TS缺失。\n- [10-7 ✗] 候选人期望薪资校验 — 期望薪资45k-58k超过岗位上限50k且匹配度低。\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包形式。\n- [10-9 ✗] 简历履历空窗期检测与标记 — 毕业后存在未说明的空窗期。\n- [10-11 ⓘ] 求职意向劳务形式校验 — 意向正编符合要求。\n- [10-21 ✗] 岗位年龄红线与隐形门槛判定 — 候选人36岁超过岗位32岁上限。",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-9",
      "message": "候选人赵六存在毕业后空窗期，请核实原因。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-16-14-096Z_f1e135_s09-tencent-history-to-bytedance`
  - run_id: `run_2026-05-12T04-16-14-096Z_f1e135`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=19096 ms tokens=10102/3685
  - rules_evaluated: 28 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, labor_form_preference, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 10 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=FAIL next=block
  - `10-24` [flag_only] result=PASS next=continue
  - `10-5` [flag_only] result=FAIL next=block
  - `10-7` [terminal] result=FAIL next=block
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=FAIL next=block

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 0 ms |
| rule check (LLM) | 19.10 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 107 ms |
| **total** | **19.21 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_f1e135_s09-te_09a92f` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c04-zhaoliu-tencent-ieg jd=jr-bytedance-tiktok-fe |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s09-tencent-history-to-bytedance_1da795 |
| +2ms | `raas-api-resp` | candidate_id=C_50b89b7a resume_id=R_5e94c510 |
| +2ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_50b89b7a jr=jr_w66 |
| +2ms | `raas-api-call` | GET /api/v1/requirements/jr_w66 |
| +3ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_BYTEDANCE bg=TikTok) |
| +3ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +19101ms | `llm-response` | model=google/gemini-3-flash-preview latency=19096ms tokens=10102/3685 |
| +19101ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=28/51 failures=10-14:language_mismatch,10-5:hard_requirement_mismatch,10-7:salary_exceeds_li |
| +19208ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-16-14-096Z_f1e135_s09-tencent-history-to-bytedance + 10 flags |
| +19208ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-14:language_mismatch,10-5:hard_requirement_mismatch,10-7:salary_exceeds_limit,10-9:gap_period_unexpla |
