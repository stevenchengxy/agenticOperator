# s01-clean-tencent-pcg-keep ❌

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-tencent-pcg-frontend`
> rationale: 张三 5y 前端,阿里 + 字节背景,无任何红线/CSI/腾讯历史。 腾讯 PCG 岗位下,binary 模式应该全部规则 PASS / NOT_APPLICABLE → KEEP/PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | PASS | FAIL ✗ |
| llm_decision | PASS | FAIL |
| must-fail rules | (none) | 10-9:gap_detected |
| augmentation injected | yes | no |

## 2. Assertions

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (PASS)**
- ✅ **must-not-fail rule: 10-25** — applicable=false result=NOT_APPLICABLE
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (14)** — wrote=14 expected=14
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=14 / total=14

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长约3年（2018-07至2021-02, 2021-03至2024-08），稳定性良好。 | 平均每段工作时长约, 稳定性良好, 2018-07 | 2018-07, 2021-02 | 平均每段工作时长约, 稳定性良好 | ✓ |
| 10-12 | 出生1996年，2018年本科毕业，毕业年龄22岁，符合基准，偏差为0。 | 出生, 年本科毕业, 毕业年龄 | — | 出生, 年本科毕业 | ✓ |
| 10-14 | 简历提供英语 CET-6 580分，满足岗位 CET-6 480分要求。 | 简历提供英语, 满足岗位, 分要求 | CET-6, CET | 简历提供英语, 满足岗位 | ✓ |
| 10-24 | 简历已关联至适配度最高的原始需求 jr_x99。 | 简历已关联至适配度最高的原始需求 | — | 简历已关联至适配度最高的原始需求 | ✓ |
| 10-5 | 学历本科、技能React/TS/Webpack、年龄30岁均符合硬性要求。 | 学历本科, 技能, 年龄 | React, Webpack | 学历本科, 技能 | ✓ |
| 10-54 | 负向要求为不接受外包超2年，候选人经历为阿里、字节，非外包，通过。 | 负向要求为不接受外包超, 候选人经历为阿里, 字节 | 字节 | 负向要求为不接受外包超, 候选人经历为阿里 | ✓ |
| 10-6 | 命中加分项：Next.js, GraphQL。 | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望35k-50k与岗位30k-50k重合，未超上限。 | 期望, 与岗位, 重合 | 35k-50k | 期望, 与岗位 | ✓ |
| 10-8 | outsourcing_acceptance 为 “接受”。 | 接受 | 接受 | — | ✓ |
| 10-9 | 2024-08 至今（2026-05）存在超过3个月空窗期且未提供原因说明。 | 至今, 存在超过, 个月空窗期且未提供原因说明 | 2024-08 | 至今, 存在超过 | ✓ |
| 10-27 | conflict_of_interest 为空，未声明亲属关系。 | 为空, 未声明亲属关系 | — | 为空, 未声明亲属关系 | ✓ |
| 10-35 | 国籍为中国，不涉及外籍通道限制。 | 国籍为中国, 不涉及外籍通道限制 | — | 国籍为中国, 不涉及外籍通道限制 | ✓ |
| 10-38 | 工作经历中不包含腾讯或腾讯外包。 | 工作经历中不包含腾讯或腾讯外包 | — | 工作经历中不包含腾讯或腾讯外包 | ✓ |
| 10-53 | 目标部门为 PCG，符合跳过面试条件。 | 目标部门为, 符合跳过面试条件, PCG | — | 目标部门为, 符合跳过面试条件 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_b7ac71",
  "job_requisition_id": "jr_x99",
  "client_id": "CLI_TENCENT",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-9:gap_detected"
  ],
  "rule_flags": [
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长约3年（2018-07至2021-02, 2021-03至2024-08），稳定性良好。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生1996年，2018年本科毕业，毕业年龄22岁，符合基准，偏差为0。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历提供英语 CET-6 580分，满足岗位 CET-6 480分要求。",
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
      "evidence": "简历已关联至适配度最高的原始需求 jr_x99。",
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
      "evidence": "学历本科、技能React/TS/Webpack、年龄30岁均符合硬性要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "负向要求为不接受外包超2年，候选人经历为阿里、字节，非外包，通过。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项：Next.js, GraphQL。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望35k-50k与岗位30k-50k重合，未超上限。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "outsourcing_acceptance 为 “接受”。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "2024-08 至今（2026-05）存在超过3个月空窗期且未提供原因说明。",
      "next_action": "block"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "conflict_of_interest 为空，未声明亲属关系。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无 HSM 反馈结果。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "国籍为中国，不涉及外籍通道限制。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历中不包含腾讯或腾讯外包。",
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
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无腾讯历史从业经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "未被标记为正编转外包受控。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人为男性，不适用此规则。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-40",
      "rule_name": "腾讯主动离职人员紧急回流审核",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "无腾讯历史从业经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "目标部门为 PCG，符合跳过面试条件。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 自动关联至 jr_x99\n- [10-5 ⓘ] 简历匹配硬性要求一票否决 — 学历、技能、年龄均符合\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中 Next.js, GraphQL 加分项\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包模式\n- [10-9 ✗] 简历履历空窗期检测与标记 — 2024-08 至今存在超长空窗且无说明\n- [10-35 ⓘ] 腾讯外籍候选人实名与通道限制规范 — 中国籍无需锁定通道\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — PCG 事业群默认跳过内面",
  "notifications": []
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-42-35-303Z_e8a292_s01-clean-tencent-pcg-keep`
  - run_id: `run_2026-05-12T03-42-35-303Z_e8a292`
  - decision: FAIL / FAIL
  - dims: client=`腾讯` BG=`PCG`
  - LLM: model=`google/gemini-3-flash-preview` duration=17759 ms tokens=10196/3188
  - rules_evaluated: 27 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 14 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-5` [flag_only] result=PASS next=continue
  - `10-54` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-27` [needs_human] result=PASS next=continue
  - `10-35` [flag_only] result=PASS next=continue
  - `10-38` [terminal] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 13 ms |
| fetch requirement | 2 ms |
| rule check (LLM) | 17.77 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 53 ms |
| **total** | **17.84 s** |
