# s06-bytedance-history-pause ❌

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-bytedance-tiktok-fe`
> rationale: 张三 work_history[1] 显示曾在字节跳动任前端工程师(2018-2021,正式职位),配字节 TikTok 岗位时 10-49(字节正编员工回流标记)必命中,需上传客户 BP 同意回流凭证后才能继续推荐。binary 模式 → FAIL。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-49 | 10-49:former_bytedance_employee |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-49**
- ✅ **must-pass rule applicable+PASS: 10-25** — applicable=true result=PASS
- ✅ **must-pass rule applicable+PASS: 10-26** — applicable=true result=PASS
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (21)** — wrote=21 expected=21
- ❌ **evidence verifiable rate ≥ 0.8 (got 38%)** — verified=8 / total=21

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 38%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 学历:本科(浙大); 技能:React, TypeScript; 语言:CET-6 580; 年龄:30岁(1996-05-12); 均满足JD要求。 | 本科, React, CET-6 580 | 本科, React | 30岁, 学历 | ✓ |
| 10-6 | 命中加分项: Next.js (nice_to_have_skills) | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资 35k-50k 与岗位 30k-50k 存在重合区间。 | 期望薪资, 与岗位, 存在重合区间 | 35k-50k | 期望薪资, 与岗位 | ✓ |
| 10-8 | 外包接受度: 接受; 劳务形式偏好: 正编。 | 接受, 正编, 外包接受度 | 接受, 正编 | 外包接受度, 劳务形式偏好 | ✓ |
| 10-9 | 2018-07至今工作连续，无超过3个月空窗期。 | 至今工作连续, 无超过, 个月空窗期 | 2018-07 | 至今工作连续, 无超过 | ✓ |
| 10-10 | 平均每段工作时长约3年，稳定性良好。 | 平均每段工作时长约, 稳定性良好 | — | 平均每段工作时长约, 稳定性良好 | ✗ |
| 10-12 | 1996年出生，2018年本科毕业，毕业年龄22岁，符合基准。 | 年出生, 年本科毕业, 毕业年龄 | — | 年出生, 年本科毕业 | ✗ |
| 10-14 | 持有 CET-6 580分，高于JD要求的480分。 | 持有, 高于, 要求的 | CET-6, CET | 持有, 高于 | ✓ |
| 10-16 | 无华腾或中软国际历史工作经历。 | 无华腾或中软国际历史工作经历 | — | 无华腾或中软国际历史工作经历 | ✗ |
| 10-17 | 无华腾或中软国际历史工作经历。 | 无华腾或中软国际历史工作经历 | — | 无华腾或中软国际历史工作经历 | ✗ |
| 10-18 | 无华腾或中软国际历史工作经历。 | 无华腾或中软国际历史工作经历 | — | 无华腾或中软国际历史工作经历 | ✗ |
| 10-24 | 已关联至原始需求 jr_w66。 | 已关联至原始需求 | — | 已关联至原始需求 | ✗ |
| 10-25 | 工作经历中不包含华为、荣耀。 | 工作经历中不包含华为, 荣耀 | — | 工作经历中不包含华为, 荣耀 | ✗ |
| 10-26 | 工作经历中不包含OPPO、小米。 | 工作经历中不包含, 小米, OPPO | — | 工作经历中不包含, 小米 | ✗ |
| 10-29 | 无我司(CSI)历史任职记录。 | 无我司, 历史任职记录, CSI | — | 无我司, 历史任职记录 | ✗ |
| 10-54 | 岗位无负向要求。 | 岗位无负向要求 | — | 岗位无负向要求 | ✗ |
| 10-11 | 意向为正编，与岗位招聘类型一致。 | 意向为正编, 与岗位招聘类型一致 | — | 意向为正编, 与岗位招聘类型一致 | ✗ |
| 10-21 | 候选人30岁，在岗位要求 22-32 岁范围内。 | 候选人, 在岗位要求, 岁范围内 | — | 候选人, 在岗位要求 | ✗ |
| 10-34 | 简历中字节跳动经历(2018-07至2021-02)距今已超过6个月。 | 简历中字节跳动经历, 距今已超过, 个月 | 2018-07, 2021-02 | 简历中字节跳动经历, 距今已超过 | ✓ |
| 10-36 | 候选人为男性，不触发婚育风险规则。 | 候选人为男性, 不触发婚育风险规则 | — | 候选人为男性, 不触发婚育风险规则 | ✗ |
| 10-49 | 工作经历包含“字节跳动”(2018-07至2021-02)，需核实是否为正编并获取凭证。 | 工作经历包含, 字节跳动, 需核实是否为正编并获取凭证 | 字节跳动, 2018-07 | 工作经历包含, 需核实是否为正编并获取凭证 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_72f2e4",
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
      "evidence": "学历:本科(浙大); 技能:React, TypeScript; 语言:CET-6 580; 年龄:30岁(1996-05-12); 均满足JD要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项: Next.js (nice_to_have_skills)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 35k-50k 与岗位 30k-50k 存在重合区间。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度: 接受; 劳务形式偏好: 正编。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "2018-07至今工作连续，无超过3个月空窗期。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长约3年，稳定性良好。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1996年出生，2018年本科毕业，毕业年龄22岁，符合基准。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "持有 CET-6 580分，高于JD要求的480分。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位未标注轮班/出差等特殊工时标签。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "无华腾或中软国际历史工作经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "已关联至原始需求 jr_w66。",
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
      "applicable": true,
      "result": "PASS",
      "evidence": "无我司(CSI)历史任职记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "岗位无负向要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-1",
      "rule_name": "字节新需求下发滞留简历优先转推",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非滞留简历。",
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
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "意向为正编，与岗位招聘类型一致。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人30岁，在岗位要求 22-32 岁范围内。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位已设定明确年龄上限，不适用隐形门槛规则。",
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
      "evidence": "简历中字节跳动经历(2018-07至2021-02)距今已超过6个月。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-36",
      "rule_name": "字节婚育风险审视与推荐要点",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人为男性，不触发婚育风险规则。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-49",
      "rule_name": "字节正编员工回流标记与凭证校验",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "工作经历包含“字节跳动”(2018-07至2021-02)，需核实是否为正编并获取凭证。",
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
  "resume_augmentation": "### 简历预筛分析\n- **加分项**: 命中 `Next.js` 技能要求。\n- **语言能力**: CET-6 580分，远超岗位门槛。\n- **风险提示**: 候选人曾有字节跳动工作经历，需按照规则 10-49 进行正编回流凭证核查。",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-49",
      "message": "候选人张三存在字节跳动历史经历，请核实是否为正编员工并上传合规凭证。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-09-38-834Z_877700_s06-bytedance-history-pause`
  - run_id: `run_2026-05-12T03-09-38-834Z_877700`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=15429 ms tokens=9692/3211
  - rules_evaluated: 28 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, labor_form_preference, former_csi_employment, marital_status]`

- **RuleCheckFlag** × 21 (applicable=true 的全部):
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
  - `10-29` [terminal] result=PASS next=continue
  - `10-54` [terminal] result=PASS next=continue
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=PASS next=continue
  - `10-34` [terminal] result=PASS next=continue
  - `10-36` [needs_human] result=PASS next=continue
  - `10-49` [needs_human] result=FAIL next=notify_recruiter

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 1 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 15.43 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 20 ms |
| **total** | **15.45 s** |
