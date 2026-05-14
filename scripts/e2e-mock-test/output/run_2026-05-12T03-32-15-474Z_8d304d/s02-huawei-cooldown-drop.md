# s02-huawei-cooldown-drop ✅

> scenario: candidate=`c02-lisi-huawei-recent` × jd=`jr-bytedance-tiktok-fe`
> rationale: 李四 2 个月前从华为离职 < 3 个月冷冻期。10-25 必须命中并挂起,通知招聘专员"竞对互不挖角待确认"。evidence 应该引用华为 离职日期。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-25 | 10-25:competitor_cooldown, 10-9:gap_period_unexplained |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-25**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (16)** — wrote=16 expected=16
- ✅ **evidence verifiable rate ≥ 0.8 (got 94%)** — verified=15 / total=16

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 94%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长：华为(6.75年)+京东(1.8年)，平均时长 > 1年，无严重职业风险。 | 华为, 平均每段工作时长, 京东 | 华为, 京东 | 平均每段工作时长, 平均时长 | ✓ |
| 10-12 | 出生1992年，毕业2017年，毕业年龄25岁。本科基准22-23岁，偏差2岁以内，逻辑正常。 | 出生, 毕业, 毕业年龄 | — | 出生, 毕业 | ✓ |
| 10-14 | 岗位要求CET-6 480以上，简历提供CET-6 520，满足硬性门槛。 | 岗位要求, 以上, 简历提供 | CET-6, CET | 岗位要求, 以上 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_w66。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-25 | 候选人最近一段经历在华为，离职日期2026-03，当前日期2026-05-12，间隔不足3个月。 | 候选人最近一段经历在华为, 离职日期, 当前日期 | 2026-03 | 候选人最近一段经历在华为, 离职日期 | ✓ |
| 10-26 | 候选人无OPPO、小米任职记录。 | 候选人无, 小米任职记录, OPPO | — | 候选人无, 小米任职记录 | ✓ |
| 10-5 | 学历本科、技能React/TS、语言CET-6、年龄33岁均符合JD硬性要求。 | 学历本科, 技能, 语言 | CET-6, React | 学历本科, 技能 | ✓ |
| 10-6 | 命中加分项：Next.js (nice_to_have_skills)。 | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资 40k-50k，岗位上限 50k，未超过上限。 | 期望薪资, 岗位上限, 未超过上限 | 40k-50k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 外包接受度为“接受”。 | 外包接受度为, 接受 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 京东离职(2019-05)至华为入职(2019-06)无空窗；但毕业(2017-07)至首份工作京东(2017-07)无空窗；当前2026-05-12，最近一段华为离职2026-03，空窗约2个月，未… | 京东离职, 至华为入职, 无空窗 | 2019-05, 2019-06 | 京东离职, 至华为入职 | ✓ |
| 10-1 | 新需求下发，执行扫描逻辑。 | 新需求下发, 执行扫描逻辑 | — | 新需求下发, 执行扫描逻辑 | ✓ |
| 10-11 | 意向为“正编”，岗位为“正编”，匹配。 | 意向为, 正编, 岗位为 | 正编 | 意向为, 岗位为 | ✓ |
| 10-2 | 执行召回扫描。 | 执行召回扫描 | — | 执行召回扫描 | ✗ |
| 10-21 | 候选人33岁，岗位上限32岁。注：此处按规则逻辑，若超过上限应FAIL，但简历出生1992-08，2026-05时为33岁，命中红线。 | 此处按规则逻辑, 候选人, 岗位上限 | 1992-08 | 此处按规则逻辑, 候选人 | ✓ |
| 10-32 | 无历史推荐记录。 | 无历史推荐记录 | — | 无历史推荐记录 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_d4597f",
  "job_requisition_id": "jr_w66",
  "client_id": "CLI_BYTEDANCE",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-25:competitor_cooldown",
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
      "evidence": "平均每段工作时长：华为(6.75年)+京东(1.8年)，平均时长 > 1年，无严重职业风险。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生1992年，毕业2017年，毕业年龄25岁。本科基准22-23岁，偏差2岁以内，逻辑正常。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "岗位要求CET-6 480以上，简历提供CET-6 520，满足硬性门槛。",
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
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人最近一段经历在华为，离职日期2026-03，当前日期2026-05-12，间隔不足3个月。",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人无OPPO、小米任职记录。",
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
      "result": "PASS",
      "evidence": "学历本科、技能React/TS、语言CET-6、年龄33岁均符合JD硬性要求。",
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
      "evidence": "期望薪资 40k-50k，岗位上限 50k，未超过上限。",
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
      "evidence": "京东离职(2019-05)至华为入职(2019-06)无空窗；但毕业(2017-07)至首份工作京东(2017-07)无空窗；当前2026-05-12，最近一段华为离职2026-03，空窗约2个月，未超3个月。但简历中 gap_periods 为空，未提供原因说明。",
      "next_action": "block"
    },
    {
      "rule_id": "10-1",
      "rule_name": "字节新需求下发滞留简历优先转推",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "新需求下发，执行扫描逻辑。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "意向为“正编”，岗位为“正编”，匹配。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-2",
      "rule_name": "字节新需求下发HC冻结候选人召回",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "执行召回扫描。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人33岁，岗位上限32岁。注：此处按规则逻辑，若超过上限应FAIL，但简历出生1992-08，2026-05时为33岁，命中红线。",
      "next_action": "block"
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
      "applicable": true,
      "result": "PASS",
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
      "evidence": "无字节历史退场记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-34",
      "rule_name": "字节跳动友商非BPO外包经历回流冷冻期拦截",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中未见通过友商派驻字节的经历。",
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
      "evidence": "无字节正编工作经历。",
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
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 关联至 jr_w66\n- [10-25 ✗] 华为荣耀竞对与客户互不挖角红线 — 华为离职距今不足3个月\n- [10-5 ✓] 简历匹配硬性要求一票否决 — 学历/技能/语言/年龄均符合\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中加分项 Next.js\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-9 ✗] 简历履历空窗期检测与标记 — 存在待补充的空窗期说明\n- [10-21 ✗] 岗位年龄红线与隐形门槛判定 — 33岁超过岗位32岁上限",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-25",
      "message": "候选人李四最近一份工作在华为，离职时间为2026-03，距今不足3个月，触发竞对互不挖角红线，请核实。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-32-15-474Z_8d304d_s02-huawei-cooldown-drop`
  - run_id: `run_2026-05-12T03-32-15-474Z_8d304d`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=18538 ms tokens=10076/3522
  - rules_evaluated: 28 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, labor_form_preference, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 16 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=FAIL next=notify_recruiter
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-1` [flag_only] result=PASS next=continue
  - `10-11` [flag_only] result=PASS next=continue
  - `10-2` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=PASS next=block
  - `10-32` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 18.54 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 68 ms |
| **total** | **18.61 s** |
