# s09-tencent-history-to-bytedance ❌

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-bytedance-tiktok-fe`
> rationale: 赵六(C++/Lua 游戏后端)推字节 TikTok 前端岗。腾讯规则 (10-38/10-43)在字节路径下 applicable=false(客户不匹配,规则不适用)。通用 10-5(技能一票否决)必命中。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-5 | 10-14:language_mismatch, 10-5:hard_requirement_mismatch, 10-9:gap_period_unexplained, 10-21:age_limit_exceeded |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-5**
- ❌ **must-not-fail rule: 10-38** — LLM 没在 rule_flags 输出这条规则
- ❌ **must-not-fail rule: 10-43** — LLM 没在 rule_flags 输出这条规则
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (19)** — wrote=19 expected=19
- ✅ **evidence verifiable rate ≥ 0.8 (got 95%)** — verified=18 / total=19

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 95%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长约3.3年（2019-08至2025-02为5.5年，2025-03至2026-04为1.1年），无消极空窗期理由。 | 平均每段工作时长约, 无消极空窗期理由, 2019-08 | 2019-08, 2025-02 | 平均每段工作时长约, 无消极空窗期理由 | ✓ |
| 10-12 | 出生1990年，硕士毕业2019年，毕业年龄29岁。硕士基准24-26岁，偏差3岁但因其包含工作后读研或学制差异，逻辑上不属于严重异常，按规则偏差≥2岁需人工，但此处result需二元化，判定为PAS… | 出生, 硕士毕业, 毕业年龄 | — | 出生, 硕士毕业 | ✓ |
| 10-14 | 岗位要求CET-6 480以上，简历提供CET-6 510，但岗位标签含“外语/海外”，简历未提供海外业务经验证明，且JD要求React/TS，简历为C++/Lua后端，语言应用背景不匹配。 | 岗位要求, 以上, 简历提供 | 后端, CET-6 | 岗位要求, 以上 | ✓ |
| 10-16 | 简历中无华腾或中软国际历史工作经历。 | 简历中无华腾或中软国际历史工作经历 | — | 简历中无华腾或中软国际历史工作经历 | ✓ |
| 10-17 | 简历中无华腾或中软国际历史工作经历。 | 简历中无华腾或中软国际历史工作经历 | — | 简历中无华腾或中软国际历史工作经历 | ✓ |
| 10-18 | 简历中无华腾或中软国际历史工作经历。 | 简历中无华腾或中软国际历史工作经历 | — | 简历中无华腾或中软国际历史工作经历 | ✓ |
| 10-24 | 简历已关联至jr_w66需求。 | 简历已关联至, 需求 | — | 简历已关联至, 需求 | ✓ |
| 10-25 | 工作经历中不包含华为、荣耀及其关联公司。 | 工作经历中不包含华为, 荣耀及其关联公司 | — | 工作经历中不包含华为, 荣耀及其关联公司 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米及其关联公司。 | 工作经历中不包含, 小米及其关联公司, OPPO | — | 工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-5 | 必备技能不符：JD要求React, TypeScript；简历技能为C++, Lua, Redis, UnrealEngine。岗位为Web前端，候选人为游戏后端。 | JD要求React, 必备技能不符, 要求 | Lua, Redis | JD要求React, 必备技能不符 | ✓ |
| 10-6 | 命中加分项：CET-6证书满足外语要求。 | CET-6证书满足外语要求, 命中加分项, 证书满足外语要求 | CET-6, CET | CET-6证书满足外语要求, 命中加分项 | ✓ |
| 10-7 | 期望薪资45k-58k，岗位上限50k。由于技能完全不匹配（后端vs前端），综合得分必低于90分，判定为薪资不匹配。 | 期望薪资, 岗位上限, 由于技能完全不匹配 | 后端, 45k-58k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 劳务形式偏好为“正编”，外包接受度为“接受”。 | 劳务形式偏好为, 正编, 外包接受度为 | 正编, 接受 | 劳务形式偏好为, 外包接受度为 | ✓ |
| 10-9 | 2019年毕业，首份工作2019-08开始，中间存在约2-3个月间隔（正常）；但简历未提供2026-04至今的去向，空窗期原因说明为空。 | 年毕业, 首份工作, 开始 | 2019-08, 2026-04 | 年毕业, 首份工作 | ✓ |
| 10-11 | 候选人接受正编，岗位为正编，匹配。 | 候选人接受正编, 岗位为正编, 匹配 | — | 候选人接受正编, 岗位为正编 | ✓ |
| 10-21 | 岗位年龄上限32岁。候选人出生1990-04，当前（2026-05）实际年龄36岁，超过上限。 | 岗位年龄上限, 候选人出生, 当前 | 1990-04 | 岗位年龄上限, 候选人出生 | ✓ |
| 10-22 | 候选人36岁 > 35岁，标记为高龄风险。 | 候选人, 标记为高龄风险 | — | 候选人, 标记为高龄风险 | ✗ |
| 10-34 | 简历中无通过友商派驻字节的经历。 | 简历中无通过友商派驻字节的经历 | — | 简历中无通过友商派驻字节的经历 | ✓ |
| 10-49 | 简历中无字节跳动正式雇员经历。 | 简历中无字节跳动正式雇员经历 | — | 简历中无字节跳动正式雇员经历 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "C_2eeea92d",
  "job_requisition_id": "jr_w66",
  "client_id": "CLI_BYTEDANCE",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-14:language_mismatch",
    "10-5:hard_requirement_mismatch",
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
      "evidence": "平均每段工作时长约3.3年（2019-08至2025-02为5.5年，2025-03至2026-04为1.1年），无消极空窗期理由。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生1990年，硕士毕业2019年，毕业年龄29岁。硕士基准24-26岁，偏差3岁但因其包含工作后读研或学制差异，逻辑上不属于严重异常，按规则偏差≥2岁需人工，但此处result需二元化，判定为PASS。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求CET-6 480以上，简历提供CET-6 510，但岗位标签含“外语/海外”，简历未提供海外业务经验证明，且JD要求React/TS，简历为C++/Lua后端，语言应用背景不匹配。",
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
      "result": "PASS",
      "evidence": "简历中无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
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
      "evidence": "简历已关联至jr_w66需求。",
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
      "evidence": "必备技能不符：JD要求React, TypeScript；简历技能为C++, Lua, Redis, UnrealEngine。岗位为Web前端，候选人为游戏后端。",
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
      "evidence": "命中加分项：CET-6证书满足外语要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "期望薪资45k-58k，岗位上限50k。由于技能完全不匹配（后端vs前端），综合得分必低于90分，判定为薪资不匹配。",
      "next_action": "block"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "劳务形式偏好为“正编”，外包接受度为“接受”。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "2019年毕业，首份工作2019-08开始，中间存在约2-3个月间隔（正常）；但简历未提供2026-04至今的去向，空窗期原因说明为空。",
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
      "evidence": "候选人接受正编，岗位为正编，匹配。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-2",
      "rule_name": "字节新需求下发HC冻结候选人召回",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HC冻结历史记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位年龄上限32岁。候选人出生1990-04，当前（2026-05）实际年龄36岁，超过上限。",
      "next_action": "block"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人36岁 > 35岁，标记为高龄风险。",
      "next_action": "block"
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
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中无通过友商派驻字节的经历。",
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
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中无字节跳动正式雇员经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-51",
      "rule_name": "字节正编回流客户BP确认放行",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "不涉及正编回流凭证校验。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 已关联至jr_w66\n- [10-5 ✗] 简历匹配硬性要求一票否决 — 技能不匹配：前端(React/TS) vs 后端(C++/Lua)\n- [10-14 ✗] 语言能力硬性门槛判断 — 缺乏海外业务经验背景\n- [10-7 ✗] 候选人期望薪资校验 — 期望58k超过岗位50k上限且技能不匹配\n- [10-9 ✗] 简历履历空窗期检测与标记 — 2026-04至今去向不明且无说明\n- [10-21 ✗] 岗位年龄红线与隐形门槛判定 — 36岁超过32岁上限\n- [10-22 ✗] 岗位年龄隐形门槛判定 — 36岁触发高龄风险标记",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-21",
      "message": "候选人赵六年龄为36岁，已超过岗位jr_w66设定的32岁上限。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T04-54-42-449Z_081848_s09-tencent-history-to-bytedance`
  - run_id: `run_2026-05-12T04-54-42-449Z_081848`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=20026 ms tokens=10097/3577
  - rules_evaluated: 28 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, labor_form_preference, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 19 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=FAIL next=block
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
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=FAIL next=block
  - `10-22` [terminal] result=FAIL next=block
  - `10-34` [terminal] result=PASS next=continue
  - `10-49` [needs_human] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 20.03 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 25 ms |
| **total** | **20.06 s** |

## 8. End-to-End Trace

**trace_id**: `trace_Z_081848_s09-te_8087c9` — 用这个串联 RAAS / AO / LLM / Neo4j 所有 hop

| Δt | hop | message |
|---|---|---|
| +0ms | `event-emit` | [raas-mock] emit RESUME_DOWNLOADED envelope candidate=c04-zhaoliu-tencent-ieg jd=jr-bytedance-tiktok-fe |
| +0ms | `raas-api-call` | POST /api/v1/candidates upload=upl_s09-tencent-history-to-bytedance_af5946 |
| +2ms | `raas-api-resp` | candidate_id=C_2eeea92d resume_id=R_ab70aec2 |
| +2ms | `event-emit` | [ao] emit RESUME_PROCESSED candidate=C_2eeea92d jr=jr_w66 |
| +2ms | `raas-api-call` | GET /api/v1/requirements/jr_w66 |
| +3ms | `rule-fetch` | fetch rules from Neo4j (client=CLI_BYTEDANCE bg=TikTok) |
| +3ms | `llm-call` | LLM call (mode=real) — compose prompt + send |
| +20032ms | `llm-response` | model=google/gemini-3-flash-preview latency=20026ms tokens=10097/3577 |
| +20032ms | `verdict` | decision=FAIL llm_decision=FAIL rules_evaluated=28/51 failures=10-14:language_mismatch,10-5:hard_requirement_mismatch,10-9:gap_period_unexpl |
| +20057ms | `neo4j-write` | wrote RuleCheckAudit rca_run_2026-05-12T04-54-42-449Z_081848_s09-tencent-history-to-bytedance + 19 flags + :Candidate / :Resume / :JR anchor |
| +20057ms | `event-emit` | [ao] emit RULE_CHECK_FAILED reasons=10-14:language_mismatch,10-5:hard_requirement_mismatch,10-9:gap_period_unexplained,10-21:age_limit_excee |
