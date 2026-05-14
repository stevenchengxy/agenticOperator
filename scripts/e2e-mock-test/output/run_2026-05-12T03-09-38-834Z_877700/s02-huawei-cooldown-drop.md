# s02-huawei-cooldown-drop ❌

> scenario: candidate=`c02-lisi-huawei-recent` × jd=`jr-bytedance-tiktok-fe`
> rationale: 李四 2 个月前从华为离职 < 3 个月冷冻期。10-25 必须命中并挂起,通知招聘专员"竞对互不挖角待确认"。evidence 应该引用华为 离职日期。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-25 | 10-25:competitor_cooldown_huawei |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-25**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (23)** — wrote=23 expected=23
- ❌ **evidence verifiable rate ≥ 0.8 (got 43%)** — verified=10 / total=23

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 43%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | 学历:本科(JD:本科); 技能:React, TypeScript(JD:React, TypeScript); 年龄:33岁(JD:22-32岁, 规则10-21处理); 语言:CET-6 520… | 本科, React, 33岁 | 本科, React | 33岁, 22-32岁 | ✓ |
| 10-6 | 命中加分项: Next.js (nice_to_have_skills) | Next.js, 命中加分项, Next | Next.js, Next | 命中加分项 | ✓ |
| 10-7 | 期望薪资 40k-50k 在岗位薪资范围 30k-50k 内 | 期望薪资, 在岗位薪资范围, 40k-50k | 40k-50k | 期望薪资, 在岗位薪资范围 | ✓ |
| 10-8 | 外包接受度: 接受 | 接受, 外包接受度 | 接受 | 外包接受度 | ✓ |
| 10-9 | 毕业2017-06, 首份工作2017-07; 换挡期2019-05至2019-06; 均小于3个月 | 毕业, 首份工作, 换挡期 | 2017-07, 2019-05 | 毕业, 首份工作 | ✓ |
| 10-10 | 平均每段工作时长: 京东(22个月), 华为(81个月), 稳定性良好 | 京东, 平均每段工作时长, 个月 | 京东, 华为 | 平均每段工作时长, 个月 | ✓ |
| 10-12 | 1992年出生, 2017年本科毕业, 毕业年龄25岁, 偏差2岁(基准23岁), 逻辑正常 | 年出生, 年本科毕业, 毕业年龄 | — | 年出生, 年本科毕业 | ✗ |
| 10-14 | 持有 CET-6 520分, 满足 JD 要求 480分 | 持有, 满足, 要求 | CET-6, CET | 持有, 满足 | ✓ |
| 10-16 | 无华腾或中软国际历史工作经历 | 无华腾或中软国际历史工作经历 | — | 无华腾或中软国际历史工作经历 | ✗ |
| 10-17 | 无华腾或中软国际历史工作经历 | 无华腾或中软国际历史工作经历 | — | 无华腾或中软国际历史工作经历 | ✗ |
| 10-18 | 无华腾或中软国际历史工作经历 | 无华腾或中软国际历史工作经历 | — | 无华腾或中软国际历史工作经历 | ✗ |
| 10-24 | 已关联至原始需求 jr_w66 | 已关联至原始需求 | — | 已关联至原始需求 | ✗ |
| 10-25 | 候选人最近一份工作在华为, 离职日期 2026-03, 当前日期 2026-05-12, 间隔不足3个月 | 候选人最近一份工作在华为, 离职日期, 当前日期 | 2026-03 | 候选人最近一份工作在华为, 离职日期 | ✓ |
| 10-26 | 简历中不包含 OPPO 或小米任职记录 | 简历中不包含, 或小米任职记录, OPPO | — | 简历中不包含, 或小米任职记录 | ✗ |
| 10-29 | 非我司(CSI)曾任职员工 | 非我司, 曾任职员工, CSI | — | 非我司, 曾任职员工 | ✗ |
| 10-54 | 未命中岗位负向要求 | 未命中岗位负向要求 | — | 未命中岗位负向要求 | ✗ |
| 10-11 | 意向劳务形式: 正编, 匹配岗位招聘类型: 正编 | 正编, 意向劳务形式, 匹配岗位招聘类型 | 正编 | 意向劳务形式, 匹配岗位招聘类型 | ✓ |
| 10-21 | 候选人出生于 1992-08, 当前 33 岁, 超过岗位上限 32 岁 | 候选人出生于, 当前, 超过岗位上限 | 1992-08 | 候选人出生于, 当前 | ✓ |
| 10-32 | 无近3个月内字节岗位淘汰记录 | 无近, 个月内字节岗位淘汰记录 | — | 无近, 个月内字节岗位淘汰记录 | ✗ |
| 10-33 | 无字节历史退场记录 | 无字节历史退场记录 | — | 无字节历史退场记录 | ✗ |
| 10-34 | 简历中未发现通过友商派驻字节的经历 | 简历中未发现通过友商派驻字节的经历 | — | 简历中未发现通过友商派驻字节的经历 | ✗ |
| 10-36 | 候选人婚育状态为已婚已育, 不触发风险判定 | 候选人婚育状态为已婚已育, 不触发风险判定 | — | 候选人婚育状态为已婚已育, 不触发风险判定 | ✗ |
| 10-49 | 简历中不包含字节跳动正式雇员经历 | 简历中不包含字节跳动正式雇员经历 | — | 简历中不包含字节跳动正式雇员经历 | ✗ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_a5c40a",
  "job_requisition_id": "jr_w66",
  "client_id": "CLI_BYTEDANCE",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-25:competitor_cooldown_huawei"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "学历:本科(JD:本科); 技能:React, TypeScript(JD:React, TypeScript); 年龄:33岁(JD:22-32岁, 规则10-21处理); 语言:CET-6 520(JD:CET-6 480)",
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
      "evidence": "期望薪资 40k-50k 在岗位薪资范围 30k-50k 内",
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
      "evidence": "毕业2017-06, 首份工作2017-07; 换挡期2019-05至2019-06; 均小于3个月",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "平均每段工作时长: 京东(22个月), 华为(81个月), 稳定性良好",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "1992年出生, 2017年本科毕业, 毕业年龄25岁, 偏差2岁(基准23岁), 逻辑正常",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "持有 CET-6 520分, 满足 JD 要求 480分",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位未标记轮班/出差等特殊工时标签",
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
      "evidence": "已关联至原始需求 jr_w66",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人最近一份工作在华为, 离职日期 2026-03, 当前日期 2026-05-12, 间隔不足3个月",
      "next_action": "notify_recruiter"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中不包含 OPPO 或小米任职记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "非我司(CSI)曾任职员工",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "未命中岗位负向要求",
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
      "evidence": "非 HC 冻结召回候选人",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "意向劳务形式: 正编, 匹配岗位招聘类型: 正编",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人出生于 1992-08, 当前 33 岁, 超过岗位上限 32 岁",
      "next_action": "block"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位已设定明确年龄上限, 适用 10-21",
      "next_action": "continue"
    },
    {
      "rule_id": "10-32",
      "rule_name": "岗位冷冻期规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无近3个月内字节岗位淘汰记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-33",
      "rule_name": "字节客户退场回流约束规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无字节历史退场记录",
      "next_action": "continue"
    },
    {
      "rule_id": "10-34",
      "rule_name": "字节跳动友商非BPO外包经历回流冷冻期拦截",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中未发现通过友商派驻字节的经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-36",
      "rule_name": "字节婚育风险审视与推荐要点",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人婚育状态为已婚已育, 不触发风险判定",
      "next_action": "continue"
    },
    {
      "rule_id": "10-49",
      "rule_name": "字节正编员工回流标记与凭证校验",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历中不包含字节跳动正式雇员经历",
      "next_action": "continue"
    },
    {
      "rule_id": "10-51",
      "rule_name": "字节正编回流客户BP确认放行",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非字节正编回流人员",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "### 预筛风险提示\n- **竞对红线**: 候选人来自华为且离职不足3个月，触发互不挖角红线(10-25)。\n- **年龄超标**: 候选人33岁，超过岗位设定的32岁上限(10-21)。\n- **加分项**: 命中 `Next.js` 技能加分。",
  "notifications": [
    {
      "recipient": "招聘专员",
      "channel": "InApp",
      "rule_id": "10-25",
      "message": "候选人李四来自华为，离职日期2026-03距今不足3个月，请核实竞对互不挖角风险。"
    }
  ]
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-09-38-834Z_877700_s02-huawei-cooldown-drop`
  - run_id: `run_2026-05-12T03-09-38-834Z_877700`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=16832 ms tokens=9661/3307
  - rules_evaluated: 28 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, labor_form_preference, former_csi_employment, marital_status]`

- **RuleCheckFlag** × 23 (applicable=true 的全部):
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
  - `10-25` [needs_human] result=FAIL next=notify_recruiter
  - `10-26` [needs_human] result=PASS next=continue
  - `10-29` [terminal] result=PASS next=continue
  - `10-54` [terminal] result=PASS next=continue
  - `10-11` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=FAIL next=block
  - `10-32` [flag_only] result=PASS next=continue
  - `10-33` [flag_only] result=PASS next=continue
  - `10-34` [terminal] result=PASS next=continue
  - `10-36` [needs_human] result=PASS next=continue
  - `10-49` [needs_human] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 4 ms |
| fetch requirement | 2 ms |
| rule check (LLM) | 16.83 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 53 ms |
| **total** | **16.89 s** |
