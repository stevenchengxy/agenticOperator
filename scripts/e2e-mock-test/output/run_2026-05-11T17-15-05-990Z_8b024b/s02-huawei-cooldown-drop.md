# s02-huawei-cooldown-drop ✅

> scenario: candidate=`c02-lisi-huawei-recent` × jd=`jr-bytedance-tiktok-fe`
> rationale: 李四 2 个月前从华为离职 < 3 个月冷冻期。10-25 必须命中并挂起,通知招聘专员"竞对互不挖角待确认"。evidence 应该引用华为 离职日期。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | PAUSE | PAUSE |
| must-fail rules | 10-25 | 10-25:stub_review |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (PAUSE)**
- ✅ **must-fail rule fired: 10-25**
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (28)** — wrote=28 expected=28
- ✅ **evidence verifiable rate ≥ 0.8 (got 100%)** — verified=28 / total=28

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 100%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-1 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-2 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-5 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-6 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-7 | expected_salary_range: 40k-50k vs jr.salary_range | 40k-50k vs, 40k-50k | 40k-50k | 40k-50k vs | ✓ |
| 10-8 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-9 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-10 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-11 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-12 | birth_date: 1992-08-20,按教育/年龄逻辑校验 | 1992-08-20, 按教育, 年龄逻辑校验 | 1992-08-20, 1992-08 | 按教育, 年龄逻辑校验 | ✓ |
| 10-14 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-15 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-16 | 简历未提供 former_csi_employment,标 NOT_APPLICABLE | 简历未提供, NOT | — | 简历未提供, NOT | ✓ |
| 10-17 | 简历未提供 former_csi_employment,标 NOT_APPLICABLE | 简历未提供, NOT | — | 简历未提供, NOT | ✓ |
| 10-18 | 简历未提供 former_csi_employment,标 NOT_APPLICABLE | 简历未提供, NOT | — | 简历未提供, NOT | ✓ |
| 10-21 | birth_date: 1992-08-20,按教育/年龄逻辑校验 | 1992-08-20, 按教育, 年龄逻辑校验 | 1992-08-20, 1992-08 | 按教育, 年龄逻辑校验 | ✓ |
| 10-22 | birth_date: 1992-08-20,按教育/年龄逻辑校验 | 1992-08-20, 按教育, 年龄逻辑校验 | 1992-08-20, 1992-08 | 按教育, 年龄逻辑校验 | ✓ |
| 10-24 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-25 | experience[0]: 华为, 离职 2026-03, 距今 < 阈值,命中 | 华为, 离职, 距今 | 华为, 2026-03 | 离职, 距今 | ✓ |
| 10-26 | experience[0]: 华为, 不是华为/OPPO/小米,result=PASS | 华为, 不是华为, 小米 | 华为, experience | 不是华为, 小米 | ✓ |
| 10-29 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-32 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-33 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-34 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-36 | gender=男, birth_date=1992-08-20, marital=已婚已育 | 已婚已育, 1992-08, gender | 已婚已育, 1992-08 | — | ✓ |
| 10-49 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-51 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |
| 10-54 | experience[0]: 华为 (2026-03) | 华为, 2026-03, experience | 华为, 2026-03 | — | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "李四",
  "job_requisition_id": "jr_w66",
  "client_id": "字节",
  "overall_decision": "PAUSE",
  "drop_reasons": [],
  "pause_reasons": [
    "10-25:stub_review"
  ],
  "rule_flags": [
    {
      "rule_id": "10-1",
      "rule_name": "字节新需求下发滞留简历优先转推",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-2",
      "rule_name": "字节新需求下发HC冻结候选人召回",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "expected_salary_range: 40k-50k vs jr.salary_range",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "birth_date: 1992-08-20,按教育/年龄逻辑校验",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-16",
      "rule_name": "通用黑名单检验规则-被动释放人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历未提供 former_csi_employment,标 NOT_APPLICABLE",
      "next_action": "continue"
    },
    {
      "rule_id": "10-17",
      "rule_name": "通用黑名单检验规则-高风险回流人员",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历未提供 former_csi_employment,标 NOT_APPLICABLE",
      "next_action": "continue"
    },
    {
      "rule_id": "10-18",
      "rule_name": "通用黑名单检验规则-EHS风险回流人员。",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历未提供 former_csi_employment,标 NOT_APPLICABLE",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "birth_date: 1992-08-20,按教育/年龄逻辑校验",
      "next_action": "continue"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "birth_date: 1992-08-20,按教育/年龄逻辑校验",
      "next_action": "continue"
    },
    {
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "REVIEW",
      "evidence": "experience[0]: 华为, 离职 2026-03, 距今 < 阈值,命中",
      "next_action": "pause"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为, 不是华为/OPPO/小米,result=PASS",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-32",
      "rule_name": "岗位冷冻期规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-33",
      "rule_name": "字节客户退场回流约束规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-34",
      "rule_name": "字节跳动友商非BPO外包经历回流冷冻期拦截",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-36",
      "rule_name": "字节婚育风险审视与推荐要点",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "gender=男, birth_date=1992-08-20, marital=已婚已育",
      "next_action": "continue"
    },
    {
      "rule_id": "10-49",
      "rule_name": "字节正编员工回流标记与凭证校验",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-51",
      "rule_name": "字节正编回流客户BP确认放行",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 华为 (2026-03)",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-1 ⓘ] 字节新需求下发滞留简历优先转推 — experience[0]: 华为 (2026-03)\n- [10-2 ⓘ] 字节新需求下发HC冻结候选人召回 — experience[0]: 华为 (2026-03)\n- [10-5 ✓] 简历匹配硬性要求一票否决 — experience[0]: 华为 (2026-03)\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — experience[0]: 华为 (2026-03)\n- [10-7 ✓] 候选人期望薪资校验 — expected_salary_range: 40k-50k vs jr.salary_range\n- [10-8 ⓘ] 候选人意愿度校验 — experience[0]: 华为 (2026-03)\n- [10-9 ✓] 简历履历空窗期检测与标记 — experience[0]: 华为 (2026-03)\n- [10-10 ✓] 简历履历空窗期与职业稳定性风险判定 — experience[0]: 华为 (2026-03)\n- [10-11 ⓘ] 求职意向劳务形式校验 — experience[0]: 华为 (2026-03)\n- [10-12 ✓] 学历年龄逻辑校验与风险预警 — birth_date: 1992-08-20,按教育/年龄逻辑校验\n- [10-14 ✓] 语言能力硬性门槛判断 — experience[0]: 华为 (2026-03)\n- [10-15 ✓] 特殊工时与出差意愿匹配 — experience[0]: 华为 (2026-03)\n- [10-16 ✓] 通用黑名单检验规则-被动释放人员 — 简历未提供 former_csi_employment,标 NOT_APPLICABLE\n- [10-17 ✓] 通用黑名单检验规则-高风险回流人员 — 简历未提供 former_csi_employment,标 NOT_APPLICABLE\n- [10-18 ✓] 通用黑名单检验规则-EHS风险回流人员。 — 简历未提供 former_csi_employment,标 NOT_APPLICABLE\n- [10-21 ✓] 岗位年龄红线与隐形门槛判定 — birth_date: 1992-08-20,按教育/年龄逻辑校验\n- [10-22 ✓] 岗位年龄隐形门槛判定 — birth_date: 1992-08-20,按教育/年龄逻辑校验\n- [10-24 ⓘ] 简历与客户原始需求的关联 — experience[0]: 华为 (2026-03)\n- [10-25 ⚠] 华为荣耀竞对与客户互不挖角红线 — experience[0]: 华为, 离职 2026-03, 距今 < 阈值,命中\n- [10-26 ✓] OPPO小米竞对与客户互不挖角红线 — experience[0]: 华为, 不是华为/OPPO/小米,result=PASS\n- [10-29 ✓] 通用二次入职推荐提醒规则 — experience[0]: 华为 (2026-03)\n- [10-32 ⓘ] 岗位冷冻期规则 — experience[0]: 华为 (2026-03)\n- [10-33 ⓘ] 字节客户退场回流约束规则 — experience[0]: 华为 (2026-03)\n- [10-34 ✓] 字节跳动友商非BPO外包经历回流冷冻期拦截 — experience[0]: 华为 (2026-03)\n- [10-36 ✓] 字节婚育风险审视与推荐要点 — gender=男, birth_date=1992-08-20, marital=已婚已育\n- [10-49 ✓] 字节正编员工回流标记与凭证校验 — experience[0]: 华为 (2026-03)\n- [10-51 ⓘ] 字节正编回流客户BP确认放行 — experience[0]: 华为 (2026-03)\n- [10-54 ✓] 对标公司/行业画像库匹配与定向猎挖规则 — experience[0]: 华为 (2026-03)",
  "notifications": []
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-11T17-15-05-990Z_8b024b_s02-huawei-cooldown-drop`
  - run_id: `run_2026-05-11T17-15-05-990Z_8b024b`
  - decision: FAIL / PAUSE
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`stub:deterministic` duration=10 ms tokens=5005/2177
  - rules_evaluated: 28 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, labor_form_preference, former_csi_employment, marital_status]`

- **RuleCheckFlag** × 28 (applicable=true 的全部):
  - `10-1` [flag_only] result=PASS next=continue
  - `10-2` [flag_only] result=PASS next=continue
  - `10-5` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-11` [flag_only] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=PASS next=continue
  - `10-15` [terminal] result=PASS next=continue
  - `10-16` [terminal] result=PASS next=continue
  - `10-17` [terminal] result=PASS next=continue
  - `10-18` [needs_human] result=PASS next=continue
  - `10-21` [terminal] result=PASS next=continue
  - `10-22` [terminal] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=REVIEW next=pause
  - `10-26` [needs_human] result=PASS next=continue
  - `10-29` [terminal] result=PASS next=continue
  - `10-32` [flag_only] result=PASS next=continue
  - `10-33` [flag_only] result=PASS next=continue
  - `10-34` [terminal] result=PASS next=continue
  - `10-36` [needs_human] result=PASS next=continue
  - `10-49` [needs_human] result=PASS next=continue
  - `10-51` [flag_only] result=PASS next=continue
  - `10-54` [terminal] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 0 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 0 ms |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 23 ms |
| **total** | **24 ms** |
