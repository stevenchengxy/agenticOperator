# s06-clean-bytedance-keep ❌

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-bytedance-tiktok-fe`
> rationale: 张三干净背景配字节路径。腾讯专属规则(10-38/10-43/10-47 等)applicable=false,字节专属(10-1/10-2/10-33/10-34/10-49/10-50 等)applicable=true 且全 PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | PASS | FAIL ✗ |
| llm_decision | PASS | FAIL |
| must-fail rules | (none) | 10-49:former_bytedance_employee |
| augmentation injected | yes | no |

## 2. Assertions

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (PASS)**
- ✅ **must-pass rule applicable+PASS: 10-25** — applicable=true result=PASS
- ✅ **must-pass rule applicable+PASS: 10-26** — applicable=true result=PASS
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (18)** — wrote=18 expected=18
- ❌ **evidence verifiable rate ≥ 0.8 (got 44%)** — verified=8 / total=18

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 44%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 学历:本科(JD:本科); 技能:React,TypeScript(JD:React,TypeScript); 语言:CET-6 580(JD:CET-6 480); 年龄:30岁(JD:22-32) | 本科, React, CET-6 580 | 本科, React | CET-6 480, 30岁 | ✓ |
| 10-6 | 命中加分项:Next.js, 海外业务经验(字节跳动经历) | Next.js, 命中加分项, 海外业务经验 | Next.js, Next | 命中加分项, 海外业务经验 | ✓ |
| 10-7 | 期望薪资 35k-50k, 岗位薪资 30k-50k, 处于范围内 | 期望薪资, 岗位薪资, 处于范围内 | 35k-50k | 期望薪资, 岗位薪资 | ✓ |
| 10-8 | 外包接受度:接受 | 接受, 外包接受度 | 接受 | 外包接受度 | ✓ |
| 10-9 | 2018-07至今工作连续,无超过3个月空窗期 | 至今工作连续, 无超过, 个月空窗期 | 2018-07 | 至今工作连续, 无超过 | ✓ |
| 10-10 | 平均每段工作时长约3年,稳定性良好 | 平均每段工作时长约, 稳定性良好 | — | 平均每段工作时长约, 稳定性良好 | ✗ |
| 10-12 | 1996年出生,2018年本科毕业,毕业年龄22岁,符合基准 | 年出生, 年本科毕业, 毕业年龄 | — | 年出生, 年本科毕业 | ✗ |
| 10-14 | 持有 CET-6 580分,满足 JD 480分要求 | 持有, 满足, 分要求 | CET-6, CET | 持有, 满足 | ✓ |
| 10-16 | 无华腾或中软国际历史背景 | 无华腾或中软国际历史背景 | — | 无华腾或中软国际历史背景 | ✗ |
| 10-17 | 无华腾或中软国际历史背景 | 无华腾或中软国际历史背景 | — | 无华腾或中软国际历史背景 | ✗ |
| 10-18 | 无华腾或中软国际历史背景 | 无华腾或中软国际历史背景 | — | 无华腾或中软国际历史背景 | ✗ |
| 10-24 | 已关联至 jr_w66 | 已关联至 | — | 已关联至 | ✗ |
| 10-25 | 无华为/荣耀任职记录 | 无华为, 荣耀任职记录 | — | 无华为, 荣耀任职记录 | ✗ |
| 10-26 | 无OPPO/小米任职记录 | 小米任职记录, OPPO | — | 小米任职记录, OPPO | ✗ |
| 10-11 | 意向劳务形式:正编 | 正编, 意向劳务形式 | 正编 | 意向劳务形式 | ✓ |
| 10-21 | 候选人30岁,未超过JD上限32岁 | 候选人, 未超过, 上限 | — | 候选人, 未超过 | ✗ |
| 10-34 | 简历显示曾为字节跳动正式员工(2018-2021),非友商外包派驻经历 | 简历显示曾为字节跳动正式员工, 非友商外包派驻经历, 2018-2021 | — | 简历显示曾为字节跳动正式员工, 非友商外包派驻经历 | ✗ |
| 10-49 | 工作经历包含:字节跳动(2018-07至2021-02),需上传合规凭证 | 字节跳动, 工作经历包含, 需上传合规凭证 | 字节跳动, 2018-07 | 工作经历包含, 需上传合规凭证 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_9c95f4",
  "job_requisition_id": "jr_w66",
  "client_id": "CLI_BYTEDANCE",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-49:former_bytedance_employee"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历:本科(JD:本科); 技能:React,TypeScript(JD:React,TypeScript); 语言:CET-6 580(JD:CET-6 480); 年龄:30岁(JD:22-32)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项:Next.js, 海外业务经验(字节跳动经历)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 35k-50k, 岗位薪资 30k-50k, 处于范围内",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度:接受",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "2018-07至今工作连续,无超过3个月空窗期",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长约3年,稳定性良好",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1996年出生,2018年本科毕业,毕业年龄22岁,符合基准",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "持有 CET-6 580分,满足 JD 480分要求",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位无特殊工时标签",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "无华腾或中软国际历史背景",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "无华腾或中软国际历史背景",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "无华腾或中软国际历史背景",
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
      "result": "PASS",
      "evidence": "无华为/荣耀任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
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
      "evidence": "无我司(CSI)任职记录",
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
      "evidence": "无HC冻结召回记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "意向劳务形式:正编",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人30岁,未超过JD上限32岁",
      "next_action": "continue"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位已设定年龄上限",
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
      "applicable": true,
      "result": "PASS",
      "evidence": "简历显示曾为字节跳动正式员工(2018-2021),非友商外包派驻经历",
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
      "applicable": true,
      "result": "FAIL",
      "evidence": "工作经历包含:字节跳动(2018-07至2021-02),需上传合规凭证",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-51",
      "rule_name": "字节正编回流客户BP确认放行",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未通过凭证校验",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛标签\n- **加分项**: 命中 Next.js 技能, 拥有字节跳动(TikTok相关)工作背景。\n- **风险提示**: 候选人曾为字节跳动正式员工(2018-2021), 触发回流合规校验流程。\n- **稳定性**: 平均单段工作时长 > 2.5年, 职业稳定性良好。",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-49",
      "message": "候选人张三曾任职于字节跳动(正编),请获取并上传合规凭证以继续流程。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T02-49-16-545Z_d5182d_s06-clean-bytedance-keep`
  - run_id: `run_2026-05-12T02-49-16-545Z_d5182d`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=17209 ms tokens=9693/3188
  - rules_evaluated: 28 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, labor_form_preference, former_csi_employment, marital_status]`

- **RuleCheckFlag** × 18 (applicable=true 的全部):
  - `10-5` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=PASS next=continue
  - `10-16` [terminal] result=PASS next=continue
  - `10-17` [terminal] result=PASS next=continue
  - `10-18` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=PASS next=continue
  - `10-34` [terminal] result=PASS next=continue
  - `10-49` [needs_human] result=FAIL next=notify_recruiter

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 2 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 17.21 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 30 ms |
| **total** | **17.24 s** |
