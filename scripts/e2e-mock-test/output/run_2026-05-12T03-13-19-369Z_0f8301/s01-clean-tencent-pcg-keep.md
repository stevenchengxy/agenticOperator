# s01-clean-tencent-pcg-keep ❌

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-tencent-pcg-frontend`
> rationale: 张三 5y 前端,阿里 + 字节背景,无任何红线/CSI/腾讯历史。 腾讯 PCG 岗位下,binary 模式应该全部规则 PASS / NOT_APPLICABLE → KEEP/PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | PASS | FAIL ✗ |
| llm_decision | PASS | FAIL |
| must-fail rules | (none) | 10-9:GAP_EXCEEDS_3M, 10-10:STABILITY_RISK |
| augmentation injected | yes | no |

## 2. Assertions

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (PASS)**
- ❌ **must-pass rule applicable+PASS: 10-25** — applicable=false result=NOT_APPLICABLE
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (13)** — wrote=13 expected=13
- ✅ **evidence verifiable rate ≥ 0.8 (got 85%)** — verified=11 / total=13

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 85%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 学历:本科(符合); 必备技能:React, TypeScript, Webpack(符合); 语言:CET-6 580(符合); 年龄:30岁(符合) | 本科, React, CET-6 580 | 本科, React | 30岁, 学历 | ✓ |
| 10-6 | 命中加分项: Next.js, GraphQL | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资 35k-50k, 岗位上限 50k, 未超限 | 期望薪资, 岗位上限, 未超限 | 35k-50k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 外包接受度: 接受 | 接受, 外包接受度 | 接受 | 外包接受度 | ✓ |
| 10-9 | 2021-02(字节)至2021-03(阿里)无空窗; 但2024-08至今(2026-05)存在约21个月空窗且无原因说明 | 字节, 阿里, 无空窗 | 字节, 阿里 | 无空窗, 至今 | ✓ |
| 10-10 | 平均每段工作时长: (31个月+32个月)/2 = 31.5个月(>12个月); 但当前空窗期21个月(>1年)且无消极理由说明, 标记为待补充信息, 依规判定为风险 | 平均每段工作时长, 个月, 但当前空窗期 | — | 平均每段工作时长, 个月 | ✗ |
| 10-12 | 1996年出生, 2018年本科毕业, 毕业年龄22岁, 偏差0岁 | 年出生, 年本科毕业, 毕业年龄 | — | 年出生, 年本科毕业 | ✓ |
| 10-24 | 已关联至 jr_x99 | 已关联至 | — | 已关联至 | ✓ |
| 10-54 | 负向要求:不接受外包经历>2年; 候选人经历均为大厂(阿里、字节), 无外包经历 | 不接受外包经历, 负向要求, 候选人经历均为大厂 | 阿里, 字节 | 不接受外包经历, 负向要求 | ✓ |
| 10-27 | conflict_of_interest 为空 | 为空 | — | 为空 | ✓ |
| 10-35 | 国籍:中国 | 中国, 国籍 | 中国 | 国籍 | ✓ |
| 10-38 | 工作经历中不包含腾讯或腾讯外包 | 工作经历中不包含腾讯或腾讯外包 | — | 工作经历中不包含腾讯或腾讯外包 | ✓ |
| 10-53 | 目标事业群:PCG | PCG, 目标事业群 | — | PCG, 目标事业群 | ✗ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_903afa",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-9:GAP_EXCEEDS_3M",
    "10-10:STABILITY_RISK"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历:本科(符合); 必备技能:React, TypeScript, Webpack(符合); 语言:CET-6 580(符合); 年龄:30岁(符合)",
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
      "evidence": "期望薪资 35k-50k, 岗位上限 50k, 未超限",
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
      "result": "FAIL",
      "evidence": "2021-02(字节)至2021-03(阿里)无空窗; 但2024-08至今(2026-05)存在约21个月空窗且无原因说明",
      "next_action": "block"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "平均每段工作时长: (31个月+32个月)/2 = 31.5个月(>12个月); 但当前空窗期21个月(>1年)且无消极理由说明, 标记为待补充信息, 依规判定为风险",
      "next_action": "block"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1996年出生, 2018年本科毕业, 毕业年龄22岁, 偏差0岁",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位标签未包含外语/海外/国际化",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位未带有轮班/夜班/倒班/长期出差标签",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华腾或中软国际经历",
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
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无华为/荣耀经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无OPPO/小米经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无本公司(CSI)任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "负向要求:不接受外包经历>2年; 候选人经历均为大厂(阿里、字节), 无外包经历",
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
      "evidence": "国籍:中国",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历中不包含腾讯或腾讯外包",
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
      "applicable": false,
      "result": "NOT_APPLICABLE",
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
      "evidence": "未标记为正编转外包受控",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "性别:男",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
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
      "evidence": "目标事业群:PCG",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛标签\n- **加分项命中**: Next.js, GraphQL\n- **稳定性提示**: 存在超过21个月的职业空窗期(2024-08至今)\n- **流程说明**: 目标PCG事业群, 依规跳过内部技术面试环节",
  "notifications": []
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-13-19-369Z_0f8301_s01-clean-tencent-pcg-keep`
  - run_id: `run_2026-05-12T03-13-19-369Z_0f8301`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=14408 ms tokens=10043/3049
  - rules_evaluated: 27 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 13 (applicable=true 的全部):
  - `10-5` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-10` [terminal] result=FAIL next=block
  - `10-12` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-54` [terminal] result=PASS next=continue
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [needs_human] result=PASS next=continue
  - `10-38` [terminal] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 13 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 14.41 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 63 ms |
| **total** | **14.49 s** |
