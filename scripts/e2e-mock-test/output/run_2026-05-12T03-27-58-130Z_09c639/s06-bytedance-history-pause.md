# s06-bytedance-history-pause ✅

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-bytedance-tiktok-fe`
> rationale: 张三 work_history[1] 显示曾在字节跳动任前端工程师(2018-2021,正式职位),配字节 TikTok 岗位时 10-49(字节正编员工回流标记)必命中,需上传客户 BP 同意回流凭证后才能继续推荐。binary 模式 → FAIL。

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
- ✅ **must-pass rule applicable+PASS: 10-25** — applicable=true result=PASS
- ✅ **must-pass rule applicable+PASS: 10-26** — applicable=true result=PASS
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (16)** — wrote=16 expected=16
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=16 / total=16

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长：阿里(3.4年)+字节(2.6年)，均大于1年；无消极空窗理由。 | 阿里, 平均每段工作时长, 字节 | 阿里, 字节 | 平均每段工作时长, 均大于 | ✓ |
| 10-12 | 毕业年份2018 - 出生年份1996 = 22岁。符合本科22-23岁基准，偏差为0。 | 毕业年份, 出生年份, 符合本科 | — | 毕业年份, 出生年份 | ✓ |
| 10-14 | 岗位要求CET-6 480以上，候选人提供CET-6 580，满足要求。 | 岗位要求, 以上, 候选人提供 | CET-6, CET | 岗位要求, 以上 | ✓ |
| 10-24 | 简历已解析并关联至jr_w66需求。 | 简历已解析并关联至, 需求 | — | 简历已解析并关联至, 需求 | ✓ |
| 10-25 | 工作经历中不包含华为、荣耀及其关联公司。 | 工作经历中不包含华为, 荣耀及其关联公司 | — | 工作经历中不包含华为, 荣耀及其关联公司 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米及其关联公司。 | 工作经历中不包含, 小米及其关联公司, OPPO | — | 工作经历中不包含, 小米及其关联公司 | ✓ |
| 10-5 | 学历本科达标；技能React/TS达标；语言达标；年龄30岁在22-32范围内。 | 学历本科达标, 技能, 达标 | React | 学历本科达标, 技能 | ✓ |
| 10-6 | 命中加分项：Next.js, 海外业务经验(字节跳动抖音电商经历)。 | Next.js, 命中加分项, 海外业务经验 | Next.js, Next | 命中加分项, 海外业务经验 | ✓ |
| 10-7 | 期望35k-50k与岗位30k-50k重合，未超过上限。 | 期望, 与岗位, 重合 | 35k-50k | 期望, 与岗位 | ✓ |
| 10-8 | 劳务形式偏好为“正编”，外包接受度为“接受”。 | 劳务形式偏好为, 正编, 外包接受度为 | 正编, 接受 | 劳务形式偏好为, 外包接受度为 | ✓ |
| 10-9 | 2021-02(字节结束)至2021-03(阿里开始)间隔1个月；但2024-08至今(2026-05)存在长达21个月空窗且无原因说明。 | 字节结束, 阿里开始, 间隔 | 2021-02, 2021-03 | 字节结束, 阿里开始 | ✓ |
| 10-1 | 新需求下发，符合扫描条件。 | 新需求下发, 符合扫描条件 | — | 新需求下发, 符合扫描条件 | ✓ |
| 10-11 | 候选人接受正编，岗位为正编，匹配。 | 候选人接受正编, 岗位为正编, 匹配 | — | 候选人接受正编, 岗位为正编 | ✓ |
| 10-21 | 候选人30岁，未超过岗位上限32岁。 | 候选人, 未超过岗位上限 | — | 候选人, 未超过岗位上限 | ✓ |
| 10-34 | 候选人曾任职于字节跳动，但未显示是通过友商外包派驻。 | 候选人曾任职于字节跳动, 但未显示是通过友商外包派驻 | — | 候选人曾任职于字节跳动, 但未显示是通过友商外包派驻 | ✓ |
| 10-49 | 候选人 2018-07 至 2021-02 在字节跳动任职前端工程师，属于正编回流，需凭证校验。 | 候选人, 在字节跳动任职前端工程师, 属于正编回流 | 2018-07, 2021-02 | 候选人, 在字节跳动任职前端工程师 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_1e5c57",
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
      "evidence": "平均每段工作时长：阿里(3.4年)+字节(2.6年)，均大于1年；无消极空窗理由。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业年份2018 - 出生年份1996 = 22岁。符合本科22-23岁基准，偏差为0。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "岗位要求CET-6 480以上，候选人提供CET-6 580，满足要求。",
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
      "evidence": "简历已解析并关联至jr_w66需求。",
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
      "result": "PASS",
      "evidence": "学历本科达标；技能React/TS达标；语言达标；年龄30岁在22-32范围内。",
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
      "evidence": "命中加分项：Next.js, 海外业务经验(字节跳动抖音电商经历)。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望35k-50k与岗位30k-50k重合，未超过上限。",
      "next_action": "continue"
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
      "evidence": "2021-02(字节结束)至2021-03(阿里开始)间隔1个月；但2024-08至今(2026-05)存在长达21个月空窗且无原因说明。",
      "next_action": "block"
    },
    {
      "rule_id": "10-1",
      "rule_name": "字节新需求下发滞留简历优先转推",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "新需求下发，符合扫描条件。",
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
      "result": "PASS",
      "evidence": "候选人30岁，未超过岗位上限32岁。",
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
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人曾任职于字节跳动，但未显示是通过友商外包派驻。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-36",
      "rule_name": "字节婚育风险审视与推荐要点",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人性别为男，不触发此规则。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-49",
      "rule_name": "字节正编员工回流标记与凭证校验",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人 2018-07 至 2021-02 在字节跳动任职前端工程师，属于正编回流，需凭证校验。",
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
  "resume_augmentation": "### 预筛标签\n- **硬性匹配**: 学历(本科)、语言(CET-6 580)、技能(React/TS) 全部达标。\n- **加分项**: 命中 `Next.js`、`海外业务经验`。\n- **风险提示**: \n    - [!] **空窗风险**: 2024-08 至今存在超过 20 个月的职业空窗期，原因待补。\n    - [!] **回流限制**: 识别到字节跳动前正编员工经历，需补充合规凭证并经 BP 确认。",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-49",
      "message": "候选人张三存在字节跳动历史正编经历，请获取并上传合规凭证以继续流程。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-27-58-130Z_09c639_s06-bytedance-history-pause`
  - run_id: `run_2026-05-12T03-27-58-130Z_09c639`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=24062 ms tokens=9916/3365
  - rules_evaluated: 28 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, labor_form_preference, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 16 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-1` [flag_only] result=PASS next=continue
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=PASS next=continue
  - `10-34` [terminal] result=PASS next=continue
  - `10-49` [needs_human] result=FAIL next=notify_recruiter

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 15 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 24.18 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 55 ms |
| **total** | **24.25 s** |
