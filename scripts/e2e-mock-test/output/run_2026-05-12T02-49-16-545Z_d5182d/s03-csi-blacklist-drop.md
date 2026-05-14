# s03-csi-blacklist-drop ❌

> scenario: candidate=`c03-wangwu-csi-blacklist` × jd=`jr-tencent-pcg-frontend`
> rationale: 王五在中软国际离职原因 A15(劳动纠纷),命中 10-17 通用黑名单高风险类型,系统自动判定不予录用,立即终止匹配流程。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-17 | 10-5:SKILL_MISMATCH, 10-14:LANGUAGE_MISMATCH, 10-17:HIGH_RISK_LEAVE_CODE, 10-54:OUTSOURCING_LIMIT_EXCEEDED |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-17**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (22)** — wrote=22 expected=22
- ❌ **evidence verifiable rate ≥ 0.8 (got 41%)** — verified=9 / total=22

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 41%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 岗位要求必备技能 React, TypeScript, Webpack; 简历仅提供 Java, Spring Boot, MySQL, Redis, Kafka | 岗位要求必备技能, 简历仅提供, React | Java, Spring | 岗位要求必备技能, 简历仅提供 | ✓ |
| 10-6 | 未命中加分项 Next.js, GraphQL | 未命中加分项, Next, GraphQL | — | 未命中加分项, Next | ✗ |
| 10-7 | 期望薪资 35k-45k 在岗位 30k-50k 范围内 | 期望薪资, 在岗位, 范围内 | 35k-45k | 期望薪资, 在岗位 | ✓ |
| 10-8 | 外包接受度: 接受 | 接受, 外包接受度 | 接受 | 外包接受度 | ✓ |
| 10-9 | 毕业 2014, 首份工作 2020-03 (简历未提供 2014-2020 经历), 但 gap_periods 为空, 且 2020 至今无超过 3 个月空窗 | 毕业, 首份工作, 简历未提供 | 2020-03 | 毕业, 首份工作 | ✓ |
| 10-10 | 平均每段工作时长: 华腾 (3年2个月), 某互联网公司 (2年10个月), 均超过 1 年 | 华腾, 平均每段工作时长, 个月 | 华腾, 某互联网公司 | 平均每段工作时长, 个月 | ✓ |
| 10-12 | 出生 1988, 本科毕业 2014, 毕业年龄 26 岁, 较基准 22-23 岁偏差 3 岁 (≥ 2岁) | 出生, 本科毕业, 毕业年龄 | — | 出生, 本科毕业 | ✗ |
| 10-14 | 岗位要求 CET-6 480 以上; 简历仅提供 CET-4 | 岗位要求, 以上, 简历仅提供 | CET-4, CET | 岗位要求, 以上 | ✓ |
| 10-16 | 曾任职华腾, 离职原因 B8 (属于高风险编码, 触发 10-17) | 曾任职华腾, 离职原因, 属于高风险编码 | — | 曾任职华腾, 离职原因 | ✗ |
| 10-17 | 曾任职华腾, 离职原因编码 B8 (有犯罪记录), 属于一票否决项 | 曾任职华腾, 离职原因编码, 有犯罪记录 | 有犯罪记录 | 曾任职华腾, 离职原因编码 | ✓ |
| 10-18 | 离职原因为 B8, 非 A13(1) EHS类 | 离职原因为, A13, EHS | — | 离职原因为, A13 | ✗ |
| 10-24 | 已关联至 jr_x99 | 已关联至 | — | 已关联至 | ✗ |
| 10-25 | 工作经历中不包含华为、荣耀 | 工作经历中不包含华为, 荣耀 | — | 工作经历中不包含华为, 荣耀 | ✗ |
| 10-26 | 工作经历中不包含OPPO、小米 | 工作经历中不包含, 小米, OPPO | — | 工作经历中不包含, 小米 | ✗ |
| 10-54 | 岗位负向要求: 不接受外包经历超过 2 年; 候选人华腾经历 (2020-03 至 2023-05) 超过 3 年 | 不接受外包经历超过 2, 岗位负向要求, 不接受外包经历超过 | 2020-03, 2023-05 | 不接受外包经历超过 2, 岗位负向要求 | ✓ |
| 10-27 | conflict_of_interest 为空 | 为空 | — | 为空 | ✗ |
| 10-35 | 国籍: 中国 | 中国, 国籍 | 中国 | 国籍 | ✓ |
| 10-38 | 简历中不包含腾讯或腾讯外包工作经历 | 简历中不包含腾讯或腾讯外包工作经历 | — | 简历中不包含腾讯或腾讯外包工作经历 | ✗ |
| 10-45 | 无腾讯正式岗位工作经历 | 无腾讯正式岗位工作经历 | — | 无腾讯正式岗位工作经历 | ✗ |
| 10-47 | 性别: 男 | 性别 | — | 性别 | ✗ |
| 10-40 | 无腾讯历史从业经历 | 无腾讯历史从业经历 | — | 无腾讯历史从业经历 | ✗ |
| 10-53 | 目标事业群: PCG | PCG, 目标事业群 | — | PCG, 目标事业群 | ✗ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_2e0e98",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-5:SKILL_MISMATCH",
    "10-14:LANGUAGE_MISMATCH",
    "10-17:HIGH_RISK_LEAVE_CODE",
    "10-54:OUTSOURCING_LIMIT_EXCEEDED"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求必备技能 React, TypeScript, Webpack; 简历仅提供 Java, Spring Boot, MySQL, Redis, Kafka",
      "next_action": "block"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "未命中加分项 Next.js, GraphQL",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 35k-45k 在岗位 30k-50k 范围内",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度: 接受",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业 2014, 首份工作 2020-03 (简历未提供 2014-2020 经历), 但 gap_periods 为空, 且 2020 至今无超过 3 个月空窗",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长: 华腾 (3年2个月), 某互联网公司 (2年10个月), 均超过 1 年",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "出生 1988, 本科毕业 2014, 毕业年龄 26 岁, 较基准 22-23 岁偏差 3 岁 (≥ 2岁)",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求 CET-6 480 以上; 简历仅提供 CET-4",
      "next_action": "block"
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
      "applicable": true,
      "result": "FAIL",
      "evidence": "曾任职华腾, 离职原因 B8 (属于高风险编码, 触发 10-17)",
      "next_action": "block"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "曾任职华腾, 离职原因编码 B8 (有犯罪记录), 属于一票否决项",
      "next_action": "block"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "离职原因为 B8, 非 A13(1) EHS类",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已关联至 jr_x99",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历中不包含华为、荣耀",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历中不包含OPPO、小米",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未显示曾在我司 (CSI) 任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位负向要求: 不接受外包经历超过 2 年; 候选人华腾经历 (2020-03 至 2023-05) 超过 3 年",
      "next_action": "block"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无 HSM 反馈结果",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "国籍: 中国",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中不包含腾讯或腾讯外包工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无 HSM 反馈结果",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无腾讯正式岗位工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "未被标记为正编转外包受控",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "性别: 男",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "无腾讯历史从业经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标事业群: PCG",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛风险提示\n- **硬性技能不符**: 缺少 React/TypeScript/Webpack 等核心前端技能。\n- **语言等级不足**: 仅 CET-4, 不满足岗位 CET-6 要求。\n- **黑名单风险**: 曾任职华腾, 离职原因编码 B8 (有犯罪记录)。\n- **负向经历命中**: 外包经历 (华腾) 超过 2 年限制。\n- **年龄逻辑异常**: 毕业年龄 26 岁, 存在 3 年偏差, 建议核实教育背景。",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-17",
      "message": "候选人王五命中高风险离职编码 B8 (有犯罪记录), 已终止推荐。"
    },
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-12",
      "message": "候选人王五毕业年龄 (26岁) 与基准偏差较大, 请核实是否存在复读或休学情况。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T02-49-16-545Z_d5182d_s03-csi-blacklist-drop`
  - run_id: `run_2026-05-12T02-49-16-545Z_d5182d`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=17745 ms tokens=9858/3312
  - rules_evaluated: 27 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 22 (applicable=true 的全部):
  - `10-5` [terminal] result=FAIL next=block
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=FAIL next=notify_recruiter
  - `10-14` [terminal] result=FAIL next=block
  - `10-16` [terminal] result=FAIL next=block
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
  - `10-47` [needs_human] result=PASS next=continue
  - `10-40` [needs_human] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 3 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 17.75 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 16 ms |
| **total** | **17.77 s** |
