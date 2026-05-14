# s02-huawei-cooldown-drop ❌

> scenario: candidate=`c02-lisi-huawei-recent` × jd=`jr-bytedance-tiktok-fe`
> rationale: 李四 2 个月前从华为离职 < 3 个月冷冻期。10-25 必须命中并挂起,通知招聘专员"竞对互不挖角待确认"。evidence 应该引用华为 离职日期。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | PAUSE | PAUSE |
| must-fail rules | 10-25 | 10-12:age_logic_anomaly, 10-25:huawei_cooldown_check |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (PAUSE)**
- ✅ **must-fail rule fired: 10-25**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (12)** — wrote=12 expected=12
- ❌ **evidence verifiable rate ≥ 0.8 (got 67%)** — verified=8 / total=12

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 67%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 学历：本科（哈尔滨工业大学）；技能：React, TypeScript；语言：CET-6 520；性别：男；年龄：33岁（1992-08-20） | 本科, React, CET-6 520 | 本科, React | 33岁, 学历 | ✓ |
| 10-6 | 命中加分项：Next.js | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资 40k-50k，在岗位薪资 30k-50k 范围内 | 期望薪资, 在岗位薪资, 范围内 | 40k-50k | 期望薪资, 在岗位薪资 | ✓ |
| 10-8 | 外包接受度：接受 | 接受, 外包接受度 | 接受 | 外包接受度 | ✓ |
| 10-9 | 2017-07毕业至2017-07入职京东，2019-05离职京东至2019-06入职华为，无超过3个月空窗 | 毕业至, 入职京东, 离职京东至 | 2017-07, 2019-05 | 毕业至, 入职京东 | ✓ |
| 10-10 | 平均每段工作时长：京东(1年10个月)，华为(6年9个月)，稳定性良好 | 京东, 平均每段工作时长, 个月 | 京东, 华为 | 平均每段工作时长, 个月 | ✓ |
| 10-12 | 1992年出生，2017年本科毕业，毕业年龄25岁，超出基准22-23岁范围2岁 | 年出生, 年本科毕业, 毕业年龄 | — | 年出生, 年本科毕业 | ✗ |
| 10-14 | CET-6 520分，满足JD要求的CET-6 480分以上 | 满足, 要求的, 分以上 | CET-6, CET | 满足, 要求的 | ✓ |
| 10-24 | 已关联至 jr_w66 | 已关联至 | — | 已关联至 | ✗ |
| 10-25 | 最近一段经历在华为，离职日期2026-03，当前日期2026-05-12，间隔不足3个月 | 最近一段经历在华为, 离职日期, 当前日期 | 2026-03 | 最近一段经历在华为, 离职日期 | ✓ |
| 10-11 | 偏好正编，符合岗位正编要求 | 偏好正编, 符合岗位正编要求 | — | 偏好正编, 符合岗位正编要求 | ✗ |
| 10-21 | 候选人33岁，JD上限32岁 | 候选人, 上限 | — | 候选人, 上限 | ✗ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_0e5e23",
  "job_requisition_id": "jr_w66",
  "client_id": "字节",
  "overall_decision": "PAUSE",
  "drop_reasons": [],
  "pause_reasons": [
    "10-12:age_logic_anomaly",
    "10-25:huawei_cooldown_check"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历：本科（哈尔滨工业大学）；技能：React, TypeScript；语言：CET-6 520；性别：男；年龄：33岁（1992-08-20）",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项：Next.js",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 40k-50k，在岗位薪资 30k-50k 范围内",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度：接受",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "2017-07毕业至2017-07入职京东，2019-05离职京东至2019-06入职华为，无超过3个月空窗",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长：京东(1年10个月)，华为(6年9个月)，稳定性良好",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "REVIEW",
      "evidence": "1992年出生，2017年本科毕业，毕业年龄25岁，超出基准22-23岁范围2岁",
      "next_action": "pause"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "CET-6 520分，满足JD要求的CET-6 480分以上",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位无轮班/出差标签",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已关联至 jr_w66",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "REVIEW",
      "evidence": "最近一段经历在华为，离职日期2026-03，当前日期2026-05-12，间隔不足3个月",
      "next_action": "pause"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无OPPO/小米任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无我司任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位无负向要求",
      "next_action": "continue"
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
      "rule_id": "10-2",
      "rule_name": "字节新需求下发HC冻结候选人召回",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非召回候选人",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "偏好正编，符合岗位正编要求",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人33岁，JD上限32岁",
      "next_action": "block"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "JD已设定年龄上限，不适用隐形门槛",
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
      "evidence": "无友商派驻字节经历",
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
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无字节正编工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-51",
      "rule_name": "字节正编回流客户BP确认放行",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "不涉及正编回流",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 简历预筛分析\n- **加分项命中**: 具备 `Next.js` 技能。\n- **风险提示**: \n    - 候选人年龄 (33岁) 略微超过 JD 设定的上限 (32岁)。\n    - 候选人最近一份工作在华为，离职至今不足3个月，存在竞对互不挖角红线风险。\n    - 毕业年龄 (25岁) 较常规本科毕业年龄偏大，需核实教育经历。",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-12",
      "message": "候选人李四毕业年龄异常（25岁本科毕业），请核实是否存在复读或学制差异。"
    },
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-25",
      "message": "候选人李四华为离职不足3个月，请确认是否触发竞对互不挖角红线。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T02-36-07-829Z_15f9dd_s02-huawei-cooldown-drop`
  - run_id: `run_2026-05-12T02-36-07-829Z_15f9dd`
  - decision: FAIL / PAUSE
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=22629 ms tokens=8855/3344
  - rules_evaluated: 28 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, labor_form_preference, former_csi_employment, marital_status]`

- **RuleCheckFlag** × 12 (applicable=true 的全部):
  - `10-5` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=REVIEW next=pause
  - `10-14` [terminal] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=REVIEW next=pause
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=FAIL next=block

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 2 ms |
| rule check (LLM) | 22.63 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 87 ms |
| **total** | **22.72 s** |
