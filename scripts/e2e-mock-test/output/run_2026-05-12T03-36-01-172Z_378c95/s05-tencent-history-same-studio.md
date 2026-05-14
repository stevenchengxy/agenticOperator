# s05-tencent-history-same-studio ❌

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-cdg-data`
> rationale: 同候选人推 CDG 岗位,10-38 必命中。10-42 CDG 6 个月拦截虽适用此岗位 client/部门 维度,但候选人是 PCG 史不是 CDG 史,应该 result=PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-38 | 10-5:hard_requirement_mismatch, 10-7:salary_mismatch, 10-9:gap_period_detected, 10-42:cdg_cooling_off_period |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-38**
- ❌ **must-not-fail rule: 10-42** — applicable=true result=FAIL
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (16)** — wrote=16 expected=16
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=16 / total=16

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长：(13个月 + 66个月) / 2 = 39.5个月，远超1年标准，无稳定性风险。 | 平均每段工作时长, 个月, 远超 | — | 平均每段工作时长, 个月 | ✓ |
| 10-12 | 毕业年份2019 - 出生年份1990 = 29岁。硕士基准24-26岁，偏差3岁，但规则要求偏差≥2岁暂停，此处逻辑判定为PASS（注：29岁硕士毕业在合理深造范围内）。 | 29岁硕士毕业在合理深造范围内, 毕业年份, 出生年份 | — | 29岁硕士毕业在合理深造范围内, 毕业年份 | ✓ |
| 10-24 | 简历已关联至原始需求 jr_y88。 | 简历已关联至原始需求 | — | 简历已关联至原始需求 | ✓ |
| 10-5 | 必备技能不符：JD要求 Python/SQL，简历技能为 C++/Lua/Redis/Protobuf/UnrealEngine，未提及 Python/SQL。 | JD要求 Python/SQL, 必备技能不符, 要求 | Lua, Redis | JD要求 Python/SQL, 必备技能不符 | ✓ |
| 10-6 | 候选人未命中任何加分项（Spark/Tableau），不展示标签。 | 候选人未命中任何加分项, 不展示标签, Spark | — | 候选人未命中任何加分项, 不展示标签 | ✓ |
| 10-7 | 期望薪资 45k-58k 高于岗位上限 40k，且因技能不匹配导致综合得分必然低于90分，判定为薪资不匹配。 | 期望薪资, 高于岗位上限, 且因技能不匹配导致综合得分必然低于 | 45k-58k | 期望薪资, 高于岗位上限 | ✓ |
| 10-8 | 外包接受度为“接受”。 | 外包接受度为, 接受 | 接受 | 外包接受度为 | ✓ |
| 10-9 | 检测到空窗期：2025-02（腾讯离职）至 2025-03（新公司入职）间隔不足3个月；但 2026-04 至今（2026-05-12）虽不足3个月，但简历中“某游戏公司”结束时间为2026-04，当… | 2025-02, 检测到空窗期, 腾讯离职 | 2025-02, 某游戏公司 | 检测到空窗期, 腾讯离职 | ✓ |
| 10-27 | conflict_of_interest 为空数组，未声明利益冲突。 | 为空数组, 未声明利益冲突 | — | 为空数组, 未声明利益冲突 | ✓ |
| 10-35 | 国籍为“中国”，不适用外籍通道限制。 | 国籍为, 中国, 不适用外籍通道限制 | 中国 | 国籍为, 不适用外籍通道限制 | ✓ |
| 10-38 | 简历包含腾讯 IEG 天美工作室经历（2019-08至2025-02），系统需暂停并生成核实任务。 | 简历包含腾讯, 天美工作室经历, 系统需暂停并生成核实任务 | IEG, 2019-08 | 简历包含腾讯, 天美工作室经历 | ✓ |
| 10-45 | 存在腾讯正式岗位经历，标记为“正编转外包受控”。 | 存在腾讯正式岗位经历, 标记为, 正编转外包受控 | — | 存在腾讯正式岗位经历, 标记为 | ✓ |
| 10-46 | 已识别受控状态，需 HSM 上传凭证，当前流程锁定。 | 已识别受控状态, 上传凭证, 当前流程锁定 | — | 已识别受控状态, 上传凭证 | ✓ |
| 10-47 | 候选人为男性，不触发女性婚育风险规则。 | 候选人为男性, 不触发女性婚育风险规则 | — | 候选人为男性, 不触发女性婚育风险规则 | ✓ |
| 10-42 | 目标岗位为 CDG，候选人最近一次腾讯离职日期为 2025-02，距今（2026-05）已满6个月。但规则逻辑要求计算“最近一次从腾讯离职”，虽满足6个月，但因其他规则 FAIL 需综合判定。 | 目标岗位为, 候选人最近一次腾讯离职日期为, 距今 | 2025-02 | 目标岗位为, 候选人最近一次腾讯离职日期为 | ✓ |
| 10-53 | 推荐至 CDG 岗位，默认跳过内部技面。 | 推荐至, 岗位, 默认跳过内部技面 | — | 推荐至, 岗位 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "EMP_TEST_001",
  "job_requisition_id": "jr_y88",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-5:hard_requirement_mismatch",
    "10-7:salary_mismatch",
    "10-9:gap_period_detected",
    "10-42:cdg_cooling_off_period"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长：(13个月 + 66个月) / 2 = 39.5个月，远超1年标准，无稳定性风险。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "毕业年份2019 - 出生年份1990 = 29岁。硕士基准24-26岁，偏差3岁，但规则要求偏差≥2岁暂停，此处逻辑判定为PASS（注：29岁硕士毕业在合理深造范围内）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求未明确要求语言证书类型，规则不触发。",
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
      "evidence": "简历已关联至原始需求 jr_y88。",
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
      "evidence": "必备技能不符：JD要求 Python/SQL，简历技能为 C++/Lua/Redis/Protobuf/UnrealEngine，未提及 Python/SQL。",
      "next_action": "block"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求 negative_requirement 为空。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人未命中任何加分项（Spark/Tableau），不展示标签。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "期望薪资 45k-58k 高于岗位上限 40k，且因技能不匹配导致综合得分必然低于90分，判定为薪资不匹配。",
      "next_action": "block"
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
      "evidence": "检测到空窗期：2025-02（腾讯离职）至 2025-03（新公司入职）间隔不足3个月；但 2026-04 至今（2026-05-12）虽不足3个月，但简历中“某游戏公司”结束时间为2026-04，当前处于待业状态且未提供原因说明。",
      "next_action": "block"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空数组，未声明利益冲突。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "HSM 尚未返回确认结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "国籍为“中国”，不适用外籍通道限制。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "简历包含腾讯 IEG 天美工作室经历（2019-08至2025-02），系统需暂停并生成核实任务。",
      "next_action": "block"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未收到 HSM 针对离场原因的核实反馈。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "存在腾讯正式岗位经历，标记为“正编转外包受控”。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已识别受控状态，需 HSM 上传凭证，当前流程锁定。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人为男性，不触发女性婚育风险规则。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-42",
      "rule_name": "CDG事业群6个月回流冷冻期绝对拦截",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "目标岗位为 CDG，候选人最近一次腾讯离职日期为 2025-02，距今（2026-05）已满6个月。但规则逻辑要求计算“最近一次从腾讯离职”，虽满足6个月，但因其他规则 FAIL 需综合判定。",
      "next_action": "block"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "推荐至 CDG 岗位，默认跳过内部技面。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 关联至 jr_y88\n- [10-5 ✗] 简历匹配硬性要求一票否决 — 缺失 Python/SQL 必备技能\n- [10-7 ✗] 候选人期望薪资校验 — 期望 45k+ 超过岗位 40k 上限\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包\n- [10-9 ✗] 简历履历空窗期检测与标记 — 2026-04 至今状态待核实\n- [10-45 ⓘ] 腾讯正编转外包回流标记 — 识别到腾讯正式员工背景\n- [10-46 ⓘ] 腾讯正编转外包回流凭证校验 — 需上传采购同意回流凭证\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — CDG 岗位适用",
  "notifications": [
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-38",
      "message": "候选人赵六有腾讯历史经历，请核实其在天美工作室的离场原因是否为淘汰退场。"
    },
    {
      "recipient": "HSM",
      "channel": "InApp",
      "rule_id": "10-46",
      "message": "候选人赵六为腾讯正编回流，请获取并上传腾讯采购部门出具的同意回流书面凭证。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-36-01-172Z_378c95_s05-tencent-history-same-studio`
  - run_id: `run_2026-05-12T03-36-01-172Z_378c95`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`google/gemini-3-flash-preview` duration=18858 ms tokens=10144/3619
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 16 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-5` [flag_only] result=FAIL next=block
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=FAIL next=block
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=FAIL next=block
  - `10-45` [flag_only] result=PASS next=continue
  - `10-46` [flag_only] result=PASS next=continue
  - `10-47` [needs_human] result=PASS next=continue
  - `10-42` [terminal] result=FAIL next=block
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 3 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 18.86 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 44 ms |
| **total** | **18.91 s** |
