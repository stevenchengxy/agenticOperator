# s01-clean-tencent-pcg-keep ❌

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-tencent-pcg-frontend`
> rationale: 张三 5y 前端,阿里 + 字节背景,无任何红线/CSI/腾讯历史。 腾讯 PCG 岗位下,通用 + 客户级规则都应该 PASS / NOT_APPLICABLE。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | PASS | FAIL ✗ |
| llm_decision | KEEP | PAUSE |
| must-fail rules | (none) | 10-12:age_logic_anomaly |
| augmentation injected | yes | no |

## 2. Assertions

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (KEEP)**
- ✅ **must-pass rule applicable+PASS: 10-25** — applicable=true result=PASS
- ✅ **must-pass rule applicable+PASS: 10-38** — applicable=true result=PASS
- ✅ **must-pass rule applicable+PASS: 10-26** — applicable=true result=PASS
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (23)** — wrote=23 expected=23
- ❌ **evidence verifiable rate ≥ 0.8 (got 30%)** — verified=7 / total=23

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 30%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 学历:本科; 技能:React, TypeScript, Webpack; 语言:CET-6 580; 年龄:30岁(1996-05-12) | 本科, React, CET-6 580 | 本科, React | 30岁, 学历 | ✓ |
| 10-6 | 命中加分项: Next.js, GraphQL | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资: 35k-50k; 岗位上限: 50k | 35k-50k, 50k, 期望薪资 | 35k-50k, 50k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 外包接受度: 接受 | 接受, 外包接受度 | 接受 | 外包接受度 | ✓ |
| 10-9 | 毕业2018-07, 首份工作2018-07; 阿里离职2024-08, 当前2026-05(简历未更新或目前在职), 历史段间无超3月空窗 | 毕业, 首份工作, 阿里离职 | 2018-07, 2024-08 | 毕业, 首份工作 | ✓ |
| 10-10 | 平均工作时长: 3年+ | 平均工作时长 | — | 平均工作时长 | ✗ |
| 10-12 | 出生1996, 本科毕业2018, 毕业年龄22岁, 逻辑正常。但规则要求偏差判定, 此处标记为REVIEW以供人工确认基准 | 出生, 本科毕业, 毕业年龄 | — | 出生, 本科毕业 | ✗ |
| 10-14 | CET-6 580, 满足 JD 480 要求 | 满足, 要求, CET-6 | CET-6, CET | 满足, 要求 | ✓ |
| 10-16 | 无华腾或中软经历 | 无华腾或中软经历 | — | 无华腾或中软经历 | ✗ |
| 10-17 | 无华腾或中软经历 | 无华腾或中软经历 | — | 无华腾或中软经历 | ✗ |
| 10-18 | 无华腾或中软经历 | 无华腾或中软经历 | — | 无华腾或中软经历 | ✗ |
| 10-24 | 关联至 jr_x99 | 关联至 | — | 关联至 | ✗ |
| 10-25 | 无华为荣耀经历 | 无华为荣耀经历 | — | 无华为荣耀经历 | ✗ |
| 10-26 | 无OPPO小米经历 | 小米经历, OPPO | — | 小米经历, OPPO | ✗ |
| 10-29 | 无本司任职记录 | 无本司任职记录 | — | 无本司任职记录 | ✗ |
| 10-54 | 最近经历为阿里巴巴, 不属于负向要求(外包经历超2年) | 最近经历为阿里巴巴, 不属于负向要求, 外包经历超 | — | 最近经历为阿里巴巴, 不属于负向要求 | ✗ |
| 10-27 | conflict_of_interest 为空 | 为空 | — | 为空 | ✗ |
| 10-35 | 国籍: 中国 | 中国, 国籍 | 中国 | 国籍 | ✓ |
| 10-38 | 无腾讯相关经历 | 无腾讯相关经历 | — | 无腾讯相关经历 | ✗ |
| 10-45 | 无腾讯历史经历 | 无腾讯历史经历 | — | 无腾讯历史经历 | ✗ |
| 10-47 | 性别: 男 | 性别 | — | 性别 | ✗ |
| 10-40 | 无腾讯历史经历 | 无腾讯历史经历 | — | 无腾讯历史经历 | ✗ |
| 10-53 | 目标部门: PCG | PCG, 目标部门 | — | PCG, 目标部门 | ✗ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_f2dab0",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "PAUSE",
  "drop_reasons": [],
  "pause_reasons": [
    "10-12:age_logic_anomaly"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历:本科; 技能:React, TypeScript, Webpack; 语言:CET-6 580; 年龄:30岁(1996-05-12)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项: Next.js, GraphQL",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资: 35k-50k; 岗位上限: 50k",
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
      "evidence": "毕业2018-07, 首份工作2018-07; 阿里离职2024-08, 当前2026-05(简历未更新或目前在职), 历史段间无超3月空窗",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均工作时长: 3年+",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "REVIEW",
      "evidence": "出生1996, 本科毕业2018, 毕业年龄22岁, 逻辑正常。但规则要求偏差判定, 此处标记为REVIEW以供人工确认基准",
      "next_action": "pause"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "CET-6 580, 满足 JD 480 要求",
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
      "applicable": true,
      "result": "PASS",
      "evidence": "无华腾或中软经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "无华腾或中软经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "无华腾或中软经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "关联至 jr_x99",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "无华为荣耀经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "无OPPO小米经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "无本司任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "最近经历为阿里巴巴, 不属于负向要求(外包经历超2年)",
      "next_action": "continue"
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
      "evidence": "无HSM反馈结果",
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
      "evidence": "无腾讯相关经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无HSM反馈结果",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无腾讯历史经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非受控状态",
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
      "evidence": "无腾讯历史经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标部门: PCG",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 候选人画像增强\n- **加分项命中**: Next.js, GraphQL\n- **稳定性评估**: 优秀 (平均任职 3 年+)\n- **流程提醒**: 目标部门 PCG，已自动跳过内部技术面试环节。\n- **风险提示**: 需人工复核学历年龄逻辑基准。",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-12",
      "message": "候选人张三毕业年龄逻辑需人工复核：1996年出生，2018年本科毕业。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T02-36-07-829Z_15f9dd_s01-clean-tencent-pcg-keep`
  - run_id: `run_2026-05-12T02-36-07-829Z_15f9dd`
  - decision: FAIL / PAUSE
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=15548 ms tokens=8990/3010
  - rules_evaluated: 27 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 23 (applicable=true 的全部):
  - `10-5` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=REVIEW next=pause
  - `10-14` [terminal] result=PASS next=continue
  - `10-16` [terminal] result=PASS next=continue
  - `10-17` [terminal] result=PASS next=continue
  - `10-18` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-29` [terminal] result=PASS next=continue
  - `10-54` [terminal] result=PASS next=continue
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
| saveCandidate | 20 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 15.55 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 35 ms |
| **total** | **15.61 s** |
