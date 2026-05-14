# s06-clean-bytedance-keep ❌

> scenario: candidate=`c01-zhangsan-clean` × jd=`jr-bytedance-tiktok-fe`
> rationale: 张三干净背景配字节路径。腾讯专属规则(10-38/10-43/10-47 等)applicable=false,字节专属(10-1/10-2/10-33/10-34/10-49/10-50 等)applicable=true 且全 PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | PASS | FAIL ✗ |
| llm_decision | KEEP | PAUSE |
| must-fail rules | (none) | 10-49:former_bytedance_employee |
| augmentation injected | yes | no |

## 2. Assertions

- ❌ **decision == expected (PASS)** — got=FAIL expected=PASS
- ❌ **llm_decision compatible (KEEP)**
- ✅ **must-pass rule applicable+PASS: 10-25** — applicable=true result=PASS
- ✅ **must-pass rule applicable+PASS: 10-26** — applicable=true result=PASS
- ❌ **matchResume called** — matchResume 没被调
- ❌ **Robohire body.resume starts with augmentation header** — body.resume 头部不是 "## Rule Check Annotations" — first 60 chars: 
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (22)** — wrote=22 expected=22
- ❌ **evidence verifiable rate ≥ 0.8 (got 36%)** — verified=8 / total=22

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 36%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 学历：本科（浙江大学）；技能：React, TypeScript；语言：CET-6 580；性别：男；年龄：30岁（1996-05-12） | 本科, React, CET-6 580 | 本科, React | 30岁, 学历 | ✓ |
| 10-6 | 命中加分项：Next.js | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资 35k-50k，岗位上限 50k | 期望薪资, 岗位上限, 35k-50k | 35k-50k | 期望薪资, 岗位上限 | ✓ |
| 10-8 | 外包接受度：接受 | 接受, 外包接受度 | 接受 | 外包接受度 | ✓ |
| 10-9 | 2018-07至今工作连续，无超过3个月空窗期 | 至今工作连续, 无超过, 个月空窗期 | 2018-07 | 至今工作连续, 无超过 | ✓ |
| 10-10 | 平均每段工作时长约3年，稳定性良好 | 平均每段工作时长约, 稳定性良好 | — | 平均每段工作时长约, 稳定性良好 | ✗ |
| 10-12 | 1996年出生，2018年本科毕业，毕业年龄22岁，符合常规教育周期 | 年出生, 年本科毕业, 毕业年龄 | — | 年出生, 年本科毕业 | ✗ |
| 10-14 | CET-6 580，高于JD要求的480分 | 高于, 要求的, CET-6 | CET-6, CET | 高于, 要求的 | ✓ |
| 10-16 | 无华腾或中软国际历史工作经历 | 无华腾或中软国际历史工作经历 | — | 无华腾或中软国际历史工作经历 | ✗ |
| 10-17 | 无华腾或中软国际历史工作经历 | 无华腾或中软国际历史工作经历 | — | 无华腾或中软国际历史工作经历 | ✗ |
| 10-18 | 无华腾或中软国际历史工作经历 | 无华腾或中软国际历史工作经历 | — | 无华腾或中软国际历史工作经历 | ✗ |
| 10-24 | 已关联至 jr_w66 | 已关联至 | — | 已关联至 | ✗ |
| 10-25 | 工作经历不包含华为、荣耀 | 工作经历不包含华为, 荣耀 | — | 工作经历不包含华为, 荣耀 | ✗ |
| 10-26 | 工作经历不包含OPPO、小米 | 工作经历不包含, 小米, OPPO | — | 工作经历不包含, 小米 | ✗ |
| 10-1 | 新需求下发扫描 | 新需求下发扫描 | — | 新需求下发扫描 | ✗ |
| 10-2 | 新需求下发扫描 | 新需求下发扫描 | — | 新需求下发扫描 | ✗ |
| 10-11 | 偏好正编，与岗位招聘类型一致 | 偏好正编, 与岗位招聘类型一致 | — | 偏好正编, 与岗位招聘类型一致 | ✗ |
| 10-21 | 候选人30岁，在22-32岁范围内 | 候选人, 岁范围内, 22-32 | — | 候选人, 岁范围内 | ✗ |
| 10-32 | 无历史推荐记录 | 无历史推荐记录 | — | 无历史推荐记录 | ✗ |
| 10-33 | 无历史退场记录 | 无历史退场记录 | — | 无历史退场记录 | ✗ |
| 10-34 | 2018-07至2021-02在字节跳动任职，离职已超过6个月 | 在字节跳动任职, 离职已超过, 个月 | 2018-07, 2021-02 | 在字节跳动任职, 离职已超过 | ✓ |
| 10-49 | 工作经历包含“字节跳动”，需核实是否为正编并上传凭证 | 工作经历包含, 字节跳动, 需核实是否为正编并上传凭证 | 字节跳动 | 工作经历包含, 需核实是否为正编并上传凭证 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_438c54",
  "job_requisition_id": "jr_w66",
  "client_id": "CLI_BYTEDANCE",
  "overall_decision": "PAUSE",
  "drop_reasons": [],
  "pause_reasons": [
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
      "evidence": "学历：本科（浙江大学）；技能：React, TypeScript；语言：CET-6 580；性别：男；年龄：30岁（1996-05-12）",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项：Next.js",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "期望薪资 35k-50k，岗位上限 50k",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "外包接受度：接受",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "2018-07至今工作连续，无超过3个月空窗期",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长约3年，稳定性良好",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1996年出生，2018年本科毕业，毕业年龄22岁，符合常规教育周期",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "CET-6 580，高于JD要求的480分",
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
      "evidence": "无华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "无华腾或中软国际历史工作经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "无华腾或中软国际历史工作经历",
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
      "evidence": "工作经历不包含华为、荣耀",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "工作经历不包含OPPO、小米",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历未提供 former_csi_employment 信息",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求中无负向要求",
      "next_action": "continue"
    },
    {
      "rule_id": "10-1",
      "rule_name": "字节新需求下发滞留简历优先转推",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "新需求下发扫描",
      "next_action": "continue"
    },
    {
      "rule_id": "10-2",
      "rule_name": "字节新需求下发HC冻结候选人召回",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "新需求下发扫描",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "偏好正编，与岗位招聘类型一致",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人30岁，在22-32岁范围内",
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
      "applicable": true,
      "result": "PASS",
      "evidence": "无历史推荐记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-33",
      "rule_name": "字节客户退场回流约束规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
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
      "evidence": "2018-07至2021-02在字节跳动任职，离职已超过6个月",
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
      "result": "REVIEW",
      "evidence": "工作经历包含“字节跳动”，需核实是否为正编并上传凭证",
      "next_action": "pause"
    },
    {
      "rule_id": "10-51",
      "rule_name": "字节正编回流客户BP确认放行",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "尚未通过合规凭证校验",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 简历预筛分析\n- **加分项命中**: 候选人具备 `Next.js` 技能。\n- **语言能力**: CET-6 580分，符合海外业务要求。\n- **风险提示**: 候选人曾有字节跳动工作经历，需确认是否为正编回流并补充合规凭证。",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-49",
      "message": "候选人张三存在字节跳动任职经历，请核实是否为正编员工并上传合规凭证。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T02-36-07-829Z_15f9dd_s06-clean-bytedance-keep`
  - run_id: `run_2026-05-12T02-36-07-829Z_15f9dd`
  - decision: FAIL / PAUSE
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=15257 ms tokens=8888/3132
  - rules_evaluated: 28 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, labor_form_preference, former_csi_employment, marital_status]`

- **RuleCheckFlag** × 22 (applicable=true 的全部):
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
  - `10-1` [flag_only] result=PASS next=continue
  - `10-2` [flag_only] result=PASS next=continue
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=PASS next=continue
  - `10-32` [flag_only] result=PASS next=continue
  - `10-33` [flag_only] result=PASS next=continue
  - `10-34` [terminal] result=PASS next=continue
  - `10-49` [needs_human] result=REVIEW next=pause

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 1 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 15.26 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 67 ms |
| **total** | **15.33 s** |
