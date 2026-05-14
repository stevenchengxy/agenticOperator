# s03-csi-blacklist-drop ✅

> scenario: candidate=`c03-wangwu-csi-blacklist` × jd=`jr-tencent-pcg-frontend`
> rationale: 王五在中软国际离职原因 A15(劳动纠纷),命中 10-17 通用黑名单高风险类型,系统自动判定不予录用,立即终止匹配流程。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-17 | 10-5:SKILL_MISMATCH, 10-14:LANGUAGE_MISMATCH, 10-17:HIGH_RISK_BLACKLIST, 10-54:NEGATIVE_EXP_MATCH |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-17**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (19)** — wrote=19 expected=19
- ✅ **evidence verifiable rate ≥ 0.8 (got 89%)** — verified=17 / total=19

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 89%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 岗位要求必备技能 React, TypeScript, Webpack; 简历技能为 Java, Spring Boot, MySQL, Redis, Kafka。完全不匹配。 | 岗位要求必备技能, 简历技能为, 完全不匹配 | Java, Spring | 岗位要求必备技能, 简历技能为 | ✓ |
| 10-7 | 期望薪资 35k-45k，岗位上限 50k，在允许范围内。 | 期望薪资, 岗位上限, 在允许范围内 | 35k-45k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 外包接受度为“接受”。 | 外包接受度为, 接受 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 毕业2014年，首份工作2020年（简历未列出2014-2020经历），但最近两段经历2020-03至2023-05，2023-06至2026-04衔接正常，空窗期未超过3个月。 | 毕业, 首份工作, 简历未列出 | 2020-03, 2023-05 | 毕业, 首份工作 | ✓ |
| 10-10 | 平均每段工作时长超过1年（3年及2.8年），无严重职业风险。 | 平均每段工作时长超过, 年及, 无严重职业风险 | — | 平均每段工作时长超过, 年及 | ✓ |
| 10-12 | 1988年出生，2014年本科毕业，毕业年龄26岁。对比基准23岁偏差3岁，触发人工核查逻辑，按规则判定为FAIL（暂停流程）。 | 年出生, 年本科毕业, 毕业年龄 | — | 年出生, 年本科毕业 | ✓ |
| 10-14 | 岗位要求 CET-6 480以上，简历提供 CET-4，不满足最低标准。 | 岗位要求, 以上, 简历提供 | CET-4, CET | 岗位要求, 以上 | ✓ |
| 10-16 | 虽有华腾经历且含YCH，但因命中10-17高风险编码，本条不再重复标记FAIL。 | 虽有华腾经历且含, 但因命中, 高风险编码 | YCH | 虽有华腾经历且含, 但因命中 | ✓ |
| 10-17 | 候选人曾任职华腾，离职编码 B8（有犯罪记录 YCH），属于高风险不予录用类型。 | 候选人曾任职华腾, 离职编码, 有犯罪记录 | 有犯罪记录, YCH | 候选人曾任职华腾, 离职编码 | ✓ |
| 10-18 | 离职编码为 B8，非 A13(1) EHS类。 | 离职编码为, A13, EHS | — | 离职编码为, A13 | ✓ |
| 10-24 | 简历已关联至 jr_x99。 | 简历已关联至 | — | 简历已关联至 | ✓ |
| 10-25 | 工作经历中不包含华为、荣耀。 | 工作经历中不包含华为, 荣耀 | — | 工作经历中不包含华为, 荣耀 | ✓ |
| 10-26 | 工作经历中不包含OPPO、小米。 | 工作经历中不包含, 小米, OPPO | — | 工作经历中不包含, 小米 | ✓ |
| 10-54 | 岗位负向要求：不接受外包从业经历超过 2 年。候选人 2020-03 至 2023-05 在华腾（外包）工作，时长超过 3 年，命中硬性排除项。 | 不接受外包从业经历超过 2, 岗位负向要求, 不接受外包从业经历超过 | 2020-03, 2023-05 | 不接受外包从业经历超过 2, 岗位负向要求 | ✓ |
| 10-27 | 利益冲突声明为空。 | 利益冲突声明为空 | — | 利益冲突声明为空 | ✗ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-38 | 简历中未包含腾讯或腾讯外包工作经历（华腾经历未注明为腾讯项目）。 | 简历中未包含腾讯或腾讯外包工作经历, 华腾经历未注明为腾讯项目 | — | 简历中未包含腾讯或腾讯外包工作经历, 华腾经历未注明为腾讯项目 | ✓ |
| 10-45 | 无腾讯正式岗位工作记录。 | 无腾讯正式岗位工作记录 | — | 无腾讯正式岗位工作记录 | ✓ |
| 10-53 | 目标部门为 PCG，符合跳过条件。 | 目标部门为, 符合跳过条件, PCG | — | 目标部门为, 符合跳过条件 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_3d5bd2",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-5:SKILL_MISMATCH",
    "10-14:LANGUAGE_MISMATCH",
    "10-17:HIGH_RISK_BLACKLIST",
    "10-54:NEGATIVE_EXP_MATCH"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求必备技能 React, TypeScript, Webpack; 简历技能为 Java, Spring Boot, MySQL, Redis, Kafka。完全不匹配。",
      "next_action": "block"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人未通过硬性要求校验，不适用加分项识别。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 35k-45k，岗位上限 50k，在允许范围内。",
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
      "evidence": "毕业2014年，首份工作2020年（简历未列出2014-2020经历），但最近两段经历2020-03至2023-05，2023-06至2026-04衔接正常，空窗期未超过3个月。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长超过1年（3年及2.8年），无严重职业风险。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1988年出生，2014年本科毕业，毕业年龄26岁。对比基准23岁偏差3岁，触发人工核查逻辑，按规则判定为FAIL（暂停流程）。",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求 CET-6 480以上，简历提供 CET-4，不满足最低标准。",
      "next_action": "block"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位未带有轮班、夜班等特殊工时标签。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "虽有华腾经历且含YCH，但因命中10-17高风险编码，本条不再重复标记FAIL。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人曾任职华腾，离职编码 B8（有犯罪记录 YCH），属于高风险不予录用类型。",
      "next_action": "block"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "离职编码为 B8，非 A13(1) EHS类。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历已关联至 jr_x99。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历中不包含华为、荣耀。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
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
      "evidence": "无我司（CSI）任职记录，仅有供应商华腾记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位负向要求：不接受外包从业经历超过 2 年。候选人 2020-03 至 2023-05 在华腾（外包）工作，时长超过 3 年，命中硬性排除项。",
      "next_action": "block"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "利益冲突声明为空。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HSM反馈结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "needs_human",
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
      "result": "PASS",
      "evidence": "简历中未包含腾讯或腾讯外包工作经历（华腾经历未注明为腾讯项目）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "未触发核实任务。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无腾讯正式岗位工作记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "未处于受控状态。",
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
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无腾讯离职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标部门为 PCG，符合跳过条件。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛风险提示\n- **黑名单命中**: 候选人曾任职华腾，离职原因为 B8 (有犯罪记录)，属于腾讯/通用准入红线。\n- **硬性技能缺失**: 岗位要求 React 生态，候选人背景为纯 Java 后端，技术栈不匹配。\n- **负向经历命中**: 候选人外包经历超过 3 年，超过岗位 2 年的限制。\n- **语言不达标**: 仅有 CET-4，未达到 CET-6 要求。\n- **年龄逻辑**: 毕业年龄 26 岁，存在 3 年偏差，需核实教育背景。",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-17",
      "message": "候选人王五命中高风险离职编码 B8，已自动终止流程。"
    },
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-12",
      "message": "候选人毕业年龄逻辑异常（偏差3岁），请核实教育经历真实性。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-13-19-369Z_0f8301_s03-csi-blacklist-drop`
  - run_id: `run_2026-05-12T03-13-19-369Z_0f8301`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=18829 ms tokens=10070/3365
  - rules_evaluated: 27 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 19 (applicable=true 的全部):
  - `10-5` [terminal] result=FAIL next=block
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=notify_recruiter
  - `10-14` [terminal] result=FAIL next=block
  - `10-16` [terminal] result=PASS next=continue
  - `10-17` [terminal] result=FAIL next=block
  - `10-18` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-54` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [needs_human] result=PASS next=continue
  - `10-38` [terminal] result=PASS next=continue
  - `10-45` [flag_only] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 0 ms |
| rule check (LLM) | 18.83 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 16 ms |
| **total** | **18.85 s** |
