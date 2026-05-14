# s06-bytedance-history-pause ❌

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-bytedance-tiktok-fe`
> rationale: 张三 work_history[1] 显示曾在字节跳动任前端工程师(2018-2021,正式职位),配字节 TikTok 岗位时 10-49(字节正编员工回流标记)必命中,需上传客户 BP 同意回流凭证后才能继续推荐。binary 模式 → FAIL。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-49 | 10-49:bytedance_former_employee |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-49**
- ❌ **must-pass rule applicable+PASS: 10-25** — applicable=false result=NOT_APPLICABLE
- ❌ **must-pass rule applicable+PASS: 10-26** — applicable=false result=NOT_APPLICABLE
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (12)** — wrote=12 expected=12
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=12 / total=12

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 工作经历包含两段记录。第一段 2021-03 至 2024-08 (41个月)，第二段 2018-07 至 2021-02 (31个月)，平均时长约 36 个月，远超 1 年阈值，无稳定性风险。 | 工作经历包含两段记录, 第一段, 个月 | 2021-03, 2024-08 | 工作经历包含两段记录, 第一段 | ✓ |
| 10-12 | 出生年份 1996，本科毕业年份 2018。毕业年龄 22 岁，符合本科基准 22-23 岁，偏差为 0，逻辑正常。 | 出生年份, 本科毕业年份, 毕业年龄 | — | 出生年份, 本科毕业年份 | ✓ |
| 10-14 | 岗位要求 CET-6 480 以上。候选人提供证书为 CET-6 580，高于最低分数线，匹配通过。 | 岗位要求, 以上, 候选人提供证书为 | CET-6, CET | 岗位要求, 以上 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_w66。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-5 | 学历本科符合；必备技能 React, TypeScript 均具备；语言 CET-6 符合；年龄 30 岁在 22-32 范围内。 | 学历本科符合, 必备技能, 均具备 | CET-6, React | 学历本科符合, 必备技能 | ✓ |
| 10-6 | 命中加分项：Next.js (nice_to_have_skills)。 | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资 35k-50k，岗位上限 50k，未超过上限。 | 期望薪资, 岗位上限, 未超过上限 | 35k-50k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 外包接受度为“接受”，无排斥意愿。 | 外包接受度为, 接受, 无排斥意愿 | 接受 | 外包接受度为, 无排斥意愿 | ✓ |
| 10-9 | 毕业 2018-06 至首份工作 2018-07 间隔 1 个月；两段工作间 2021-02 至 2021-03 间隔 1 个月。均未超过 3 个月。 | 毕业, 至首份工作, 间隔 | 2018-07, 2021-02 | 毕业, 至首份工作 | ✓ |
| 10-11 | 劳务形式偏好为“正编”，与岗位招聘类型“正编”匹配。 | 劳务形式偏好为, 正编, 与岗位招聘类型 | 正编 | 劳务形式偏好为, 与岗位招聘类型 | ✓ |
| 10-21 | 岗位上限 32 岁，候选人 30 岁，未超限。 | 岗位上限, 候选人, 未超限 | — | 岗位上限, 候选人 | ✓ |
| 10-49 | 工作经历显示 2018-07 至 2021-02 在“字节跳动”担任“前端工程师”，识别为正编回流，需挂起流程核验凭证。 | 工作经历显示, 字节跳动, 担任 | 字节跳动, 前端工程师 | 工作经历显示, 担任 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_423814",
  "job_requisition_id": "jr_w66",
  "client_id": "CLI_BYTEDANCE",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-49:bytedance_former_employee"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历包含两段记录。第一段 2021-03 至 2024-08 (41个月)，第二段 2018-07 至 2021-02 (31个月)，平均时长约 36 个月，远超 1 年阈值，无稳定性风险。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生年份 1996，本科毕业年份 2018。毕业年龄 22 岁，符合本科基准 22-23 岁，偏差为 0，逻辑正常。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "岗位要求 CET-6 480 以上。候选人提供证书为 CET-6 580，高于最低分数线，匹配通过。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求中未提及轮班、夜班、倒班或长期出差标签。",
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
      "evidence": "工作经历中不包含华为、荣耀及其关联公司。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
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
      "evidence": "无我司（CSI）历史任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历本科符合；必备技能 React, TypeScript 均具备；语言 CET-6 符合；年龄 30 岁在 22-32 范围内。",
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
      "evidence": "期望薪资 35k-50k，岗位上限 50k，未超过上限。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度为“接受”，无排斥意愿。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业 2018-06 至首份工作 2018-07 间隔 1 个月；两段工作间 2021-02 至 2021-03 间隔 1 个月。均未超过 3 个月。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-1",
      "rule_name": "字节新需求下发滞留简历优先转推",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非滞留简历，为新上传简历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "劳务形式偏好为“正编”，与岗位招聘类型“正编”匹配。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-2",
      "rule_name": "字节新需求下发HC冻结候选人召回",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无历史 HC 冻结记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "岗位上限 32 岁，候选人 30 岁，未超限。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位已设定年龄上限，不适用隐形门槛判定。",
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
      "evidence": "候选人曾在字节跳动任职，但简历未显示是通过友商派驻（描述为前端工程师），且该规则主要针对非BPO外包回流，正编回流由10-49处理。",
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
      "result": "FAIL",
      "evidence": "工作经历显示 2018-07 至 2021-02 在“字节跳动”担任“前端工程师”，识别为正编回流，需挂起流程核验凭证。",
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
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 已关联至 jr_w66\n- [10-5 ✓] 简历匹配硬性要求一票否决 — 学历、技能、语言、年龄均符合\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中加分项 Next.js\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-11 ⓘ] 求职意向劳务形式校验 — 意向正编匹配\n- [10-49 ✗] 字节正编员工回流标记与凭证校验 — 存在 2018-2021 字节跳动任职经历，需人工核验凭证",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-49",
      "message": "候选人张三存在字节跳动历史正编工作经历（2018-07至2021-02），已触发回流限制，请获取并上传合规凭证以继续流程。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-32-15-474Z_8d304d_s06-bytedance-history-pause`
  - run_id: `run_2026-05-12T03-32-15-474Z_8d304d`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=18918 ms tokens=10109/3570
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
  - `10-9` [terminal] result=PASS next=continue
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=PASS next=continue
  - `10-49` [needs_human] result=FAIL next=notify_recruiter

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 2 ms |
| rule check (LLM) | 18.92 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 15 ms |
| **total** | **18.94 s** |
