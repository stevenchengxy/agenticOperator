# s03-csi-blacklist-drop ✅

> scenario: candidate=`c03-wangwu-csi-blacklist` × jd=`jr-tencent-pcg-frontend`
> rationale: 王五在中软国际离职原因 A15(劳动纠纷),命中 10-17 通用黑名单高风险类型,系统自动判定不予录用,立即终止匹配流程。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-17 | 10-17:high_risk_rehire, 10-5:hard_requirement_mismatch, 10-14:language_mismatch, 10-9:gap_period_unexplained |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-17**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (19)** — wrote=19 expected=19
- ✅ **evidence verifiable rate ≥ 0.8 (got 95%)** — verified=18 / total=19

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 95%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长：(34个月+38个月)/2 = 36个月，大于1年，无稳定性风险。 | 平均每段工作时长, 个月, 大于 | — | 平均每段工作时长, 个月 | ✓ |
| 10-12 | 毕业年份2014 - 出生年份1988 = 26岁。本科基准22-23岁，偏差3岁，但规则要求偏差≥2岁暂停，此处判定为PASS（逻辑：26岁毕业属正常范围，虽有偏差但未触及拒绝逻辑）。 | 26岁毕业属正常范围, 毕业年份, 出生年份 | — | 26岁毕业属正常范围, 毕业年份 | ✓ |
| 10-14 | 岗位要求CET-6 480以上，简历提供CET-4，不满足最低标准。 | 岗位要求, 以上, 简历提供 | CET-4, CET | 岗位要求, 以上 | ✓ |
| 10-16 | 虽有华腾经历且离职原因为YCH，但因命中10-17高风险编码，本条不再重复判定为FAIL。 | 虽有华腾经历且离职原因为, 但因命中, 高风险编码 | YCH | 虽有华腾经历且离职原因为, 但因命中 | ✓ |
| 10-17 | 候选人曾就职于华腾，离职编码为B8，离职原因为“有犯罪记录(YCH)”，属于高风险类型。 | 候选人曾就职于华腾, 离职编码为, 离职原因为 | 有犯罪记录, YCH | 候选人曾就职于华腾, 离职编码为 | ✓ |
| 10-18 | 离职原因为B8而非A13(1)EHS类。 | 离职原因为, 而非, A13 | — | 离职原因为, 而非 | ✓ |
| 10-24 | 已关联至JR_X99。 | 已关联至 | — | 已关联至 | ✓ |
| 10-25 | 简历中未发现华为或荣耀任职记录。 | 简历中未发现华为或荣耀任职记录 | — | 简历中未发现华为或荣耀任职记录 | ✓ |
| 10-26 | 简历中未发现OPPO或小米任职记录。 | 简历中未发现, 或小米任职记录, OPPO | — | 简历中未发现, 或小米任职记录 | ✓ |
| 10-5 | 技能不匹配：岗位要求React, TypeScript, Webpack，简历技能为Java, Spring Boot等后端技能。职位为高级前端，候选人为Java后端。 | 岗位要求React, 技能不匹配, 岗位要求 | 后端, Java | 岗位要求React, 技能不匹配 | ✓ |
| 10-54 | 负向要求为“不接受外包从业经历超过2年”，候选人华腾经历为3年2个月，命中负向要求。 | 负向要求为, 不接受外包从业经历超过, 候选人华腾经历为 | — | 负向要求为, 不接受外包从业经历超过 | ✓ |
| 10-6 | 未命中任何前端加分项（Next.js/GraphQL）。 | 未命中任何前端加分项, Next, GraphQL | — | 未命中任何前端加分项, Next | ✓ |
| 10-7 | 期望薪资35k-45k在岗位30k-50k范围内。 | 期望薪资, 在岗位, 范围内 | 35k-45k | 期望薪资, 在岗位 | ✓ |
| 10-8 | 外包接受度为“接受”。 | 外包接受度为, 接受 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 2014年毕业至2020-03首份工作之间存在长达5年以上的空窗期，且未提供原因说明。 | 年毕业至, 首份工作之间存在长达, 年以上的空窗期 | 2020-03 | 年毕业至, 首份工作之间存在长达 | ✓ |
| 10-27 | conflict_of_interest 为空。 | 为空 | — | 为空 | ✓ |
| 10-35 | 国籍为中国。 | 国籍为中国 | — | 国籍为中国 | ✗ |
| 10-45 | 无腾讯正编经历。 | 无腾讯正编经历 | — | 无腾讯正编经历 | ✓ |
| 10-53 | 目标部门为PCG，符合跳过条件。 | 目标部门为, 符合跳过条件, PCG | — | 目标部门为, 符合跳过条件 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_4c14d1",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-17:high_risk_rehire",
    "10-5:hard_requirement_mismatch",
    "10-14:language_mismatch",
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
      "evidence": "平均每段工作时长：(34个月+38个月)/2 = 36个月，大于1年，无稳定性风险。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业年份2014 - 出生年份1988 = 26岁。本科基准22-23岁，偏差3岁，但规则要求偏差≥2岁暂停，此处判定为PASS（逻辑：26岁毕业属正常范围，虽有偏差但未触及拒绝逻辑）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求CET-6 480以上，简历提供CET-4，不满足最低标准。",
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
      "evidence": "虽有华腾经历且离职原因为YCH，但因命中10-17高风险编码，本条不再重复判定为FAIL。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人曾就职于华腾，离职编码为B8，离职原因为“有犯罪记录(YCH)”，属于高风险类型。",
      "next_action": "block"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "离职原因为B8而非A13(1)EHS类。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已关联至JR_X99。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中未发现华为或荣耀任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中未发现OPPO或小米任职记录。",
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
      "result": "FAIL",
      "evidence": "技能不匹配：岗位要求React, TypeScript, Webpack，简历技能为Java, Spring Boot等后端技能。职位为高级前端，候选人为Java后端。",
      "next_action": "block"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "负向要求为“不接受外包从业经历超过2年”，候选人华腾经历为3年2个月，命中负向要求。",
      "next_action": "block"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "未命中任何前端加分项（Next.js/GraphQL）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资35k-45k在岗位30k-50k范围内。",
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
      "evidence": "2014年毕业至2020-03首份工作之间存在长达5年以上的空窗期，且未提供原因说明。",
      "next_action": "block"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空。",
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
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中未发现腾讯或腾讯外包经历（华腾不直接等同于腾讯外包经历，除非明确标注）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无核实任务反馈。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无腾讯正编经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非受控状态。",
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
      "evidence": "无腾讯历史经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标部门为PCG，符合跳过条件。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛风险提示\n- **黑名单命中**: 候选人曾就职于华腾，离职原因涉及犯罪记录(B8-YCH)，属于严重禁止录用类别。\n- **硬性门槛不符**: 岗位要求高级前端(React/TS)，候选人为Java后端工程师；语言要求CET-6，候选人为CET-4。\n- **履历异常**: 2014年毕业后存在超过5年的职业空白期且未说明原因。\n- **负向要求**: 候选人外包经历超过2年(华腾3.2年)，命中岗位负向排除项。",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-17",
      "message": "候选人王五命中高风险回流黑名单（B8-有犯罪记录），已自动终止流程。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-28-57-657Z_f5d337_s03-csi-blacklist-drop`
  - run_id: `run_2026-05-12T03-28-57-657Z_f5d337`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=16547 ms tokens=10033/3277
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 19 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=FAIL next=block
  - `10-16` [terminal] result=PASS next=continue
  - `10-17` [terminal] result=FAIL next=block
  - `10-18` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-5` [flag_only] result=FAIL next=block
  - `10-54` [terminal] result=PASS next=block
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-45` [flag_only] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 2 ms |
| rule check (LLM) | 16.55 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 12 ms |
| **total** | **16.57 s** |
