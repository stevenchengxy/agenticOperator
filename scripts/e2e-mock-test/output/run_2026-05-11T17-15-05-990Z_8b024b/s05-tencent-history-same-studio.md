# s05-tencent-history-same-studio ✅

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-tencent-cdg-data`
> rationale: 同候选人推 CDG 岗位,10-38 必命中。10-42 CDG 6 个月拦截虽适用此岗位 client/部门 维度,但候选人是 PCG 史不是 CDG 史,应该 result=PASS。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | PAUSE | PAUSE |
| must-fail rules | 10-38 | 10-38:stub_review |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (PAUSE)**
- ✅ **must-fail rule fired: 10-38**
- ✅ **must-pass rule applicable+PASS: 10-42** — applicable=true result=PASS
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (27)** — wrote=27 expected=27
- ✅ **evidence verifiable rate ≥ 0.8 (got 96%)** — verified=26 / total=27

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 96%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-5 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-6 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-7 | expected_salary_range: 45k-58k vs jr.salary_range | 45k-58k vs, 45k-58k | 45k-58k | 45k-58k vs | ✓ |
| 10-8 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-9 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-10 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-12 | birth_date: 1990-04-15,按教育/年龄逻辑校验 | 1990-04-15, 按教育, 年龄逻辑校验 | 1990-04-15, 1990-04 | 按教育, 年龄逻辑校验 | ✓ |
| 10-14 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-15 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-16 | 简历未提供 former_csi_employment,标 NOT_APPLICABLE | 简历未提供, NOT | — | 简历未提供, NOT | ✓ |
| 10-17 | 简历未提供 former_csi_employment,标 NOT_APPLICABLE | 简历未提供, NOT | — | 简历未提供, NOT | ✓ |
| 10-18 | 简历未提供 former_csi_employment,标 NOT_APPLICABLE | 简历未提供, NOT | — | 简历未提供, NOT | ✓ |
| 10-24 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-25 | experience[0]: 某游戏公司, 不是华为/OPPO/小米,result=PASS | 某游戏公司, 不是华为, 小米 | 某游戏公司, experience | 不是华为, 小米 | ✓ |
| 10-26 | experience[0]: 某游戏公司, 不是华为/OPPO/小米,result=PASS | 某游戏公司, 不是华为, 小米 | 某游戏公司, experience | 不是华为, 小米 | ✓ |
| 10-27 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-28 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-29 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-35 | nationality=中国 → 通道限制判定 | 中国, 通道限制判定, nationality | 中国, nationality | 通道限制判定 | ✓ |
| 10-38 | former_tencent_employment: IEG/天美, leave_type=主动离场,命中 | IEG/天美, 天美, 主动离场 | 天美, 主动离场 | IEG/天美, 命中 | ✓ |
| 10-39 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-42 | former_tencent_employment / CDG 6 个月拦截不适用(候选人非 CDG 史),result=PASS | 个月拦截不适用, 候选人非, CDG | — | 个月拦截不适用, 候选人非 | ✗ |
| 10-45 | 简历未提供 former_tencent_employment(或非腾讯历史),result=PASS | 简历未提供, 或非腾讯历史, PASS | — | 简历未提供, 或非腾讯历史 | ✓ |
| 10-46 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-47 | gender=男, birth_date=1990-04-15, marital=已婚已育 | 已婚已育, 1990-04, gender | 已婚已育, 1990-04 | — | ✓ |
| 10-53 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |
| 10-54 | experience[0]: 某游戏公司 (2026-04) | 某游戏公司, 2026-04, experience | 某游戏公司, 2026-04 | — | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "赵六",
  "job_requisition_id": "jr_y88",
  "client_id": "腾讯",
  "overall_decision": "PAUSE",
  "drop_reasons": [],
  "pause_reasons": [
    "10-38:stub_review"
  ],
  "rule_flags": [
    {
      "rule_id": "10-5",
      "rule_name": "简历匹配硬性要求一票否决",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "expected_salary_range: 45k-58k vs jr.salary_range",
      "next_action": "continue"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-10",
      "rule_name": "简历履历空窗期与职业稳定性风险判定",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "birth_date: 1990-04-15,按教育/年龄逻辑校验",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-15",
      "rule_name": "特殊工时与出差意愿匹配",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
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
      "rule_id": "10-24",
      "rule_name": "简历与客户原始需求的关联",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司, 不是华为/OPPO/小米,result=PASS",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司, 不是华为/OPPO/小米,result=PASS",
      "next_action": "continue"
    },
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-28",
      "rule_name": "腾讯亲属关系回避处理规则",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-29",
      "rule_name": "通用二次入职推荐提醒规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-35",
      "rule_name": "腾讯外籍候选人实名与通道限制规范",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "nationality=中国 → 通道限制判定",
      "next_action": "continue"
    },
    {
      "rule_id": "10-38",
      "rule_name": "腾讯历史从业经历识别与核实触发",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "REVIEW",
      "evidence": "former_tencent_employment: IEG/天美, leave_type=主动离场,命中",
      "next_action": "pause"
    },
    {
      "rule_id": "10-39",
      "rule_name": "腾讯历史从业经历核实结果处理",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-42",
      "rule_name": "CDG事业群6个月回流冷冻期绝对拦截",
      "applicable_client": "腾讯",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "former_tencent_employment / CDG 6 个月拦截不适用(候选人非 CDG 史),result=PASS",
      "next_action": "continue"
    },
    {
      "rule_id": "10-45",
      "rule_name": "腾讯正编转外包回流标记",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "简历未提供 former_tencent_employment(或非腾讯历史),result=PASS",
      "next_action": "continue"
    },
    {
      "rule_id": "10-46",
      "rule_name": "腾讯正编转外包回流凭证校验",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-47",
      "rule_name": "腾讯婚育风险审视与推荐要点",
      "applicable_client": "腾讯",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "gender=男, birth_date=1990-04-15, marital=已婚已育",
      "next_action": "continue"
    },
    {
      "rule_id": "10-53",
      "rule_name": "非IEG事业群跳过内部技术面试",
      "applicable_client": "腾讯",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "PASS",
      "evidence": "experience[0]: 某游戏公司 (2026-04)",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-5 ✓] 简历匹配硬性要求一票否决 — experience[0]: 某游戏公司 (2026-04)\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — experience[0]: 某游戏公司 (2026-04)\n- [10-7 ✓] 候选人期望薪资校验 — expected_salary_range: 45k-58k vs jr.salary_range\n- [10-8 ⓘ] 候选人意愿度校验 — experience[0]: 某游戏公司 (2026-04)\n- [10-9 ✓] 简历履历空窗期检测与标记 — experience[0]: 某游戏公司 (2026-04)\n- [10-10 ✓] 简历履历空窗期与职业稳定性风险判定 — experience[0]: 某游戏公司 (2026-04)\n- [10-12 ✓] 学历年龄逻辑校验与风险预警 — birth_date: 1990-04-15,按教育/年龄逻辑校验\n- [10-14 ✓] 语言能力硬性门槛判断 — experience[0]: 某游戏公司 (2026-04)\n- [10-15 ✓] 特殊工时与出差意愿匹配 — experience[0]: 某游戏公司 (2026-04)\n- [10-16 ✓] 通用黑名单检验规则-被动释放人员 — 简历未提供 former_csi_employment,标 NOT_APPLICABLE\n- [10-17 ✓] 通用黑名单检验规则-高风险回流人员 — 简历未提供 former_csi_employment,标 NOT_APPLICABLE\n- [10-18 ✓] 通用黑名单检验规则-EHS风险回流人员。 — 简历未提供 former_csi_employment,标 NOT_APPLICABLE\n- [10-24 ⓘ] 简历与客户原始需求的关联 — experience[0]: 某游戏公司 (2026-04)\n- [10-25 ✓] 华为荣耀竞对与客户互不挖角红线 — experience[0]: 某游戏公司, 不是华为/OPPO/小米,result=PASS\n- [10-26 ✓] OPPO小米竞对与客户互不挖角红线 — experience[0]: 某游戏公司, 不是华为/OPPO/小米,result=PASS\n- [10-27 ✓] 腾讯亲属关系回避规则 — experience[0]: 某游戏公司 (2026-04)\n- [10-28 ✓] 腾讯亲属关系回避处理规则 — experience[0]: 某游戏公司 (2026-04)\n- [10-29 ✓] 通用二次入职推荐提醒规则 — experience[0]: 某游戏公司 (2026-04)\n- [10-35 ✓] 腾讯外籍候选人实名与通道限制规范 — nationality=中国 → 通道限制判定\n- [10-38 ⚠] 腾讯历史从业经历识别与核实触发 — former_tencent_employment: IEG/天美, leave_type=主动离场,命中\n- [10-39 ✓] 腾讯历史从业经历核实结果处理 — experience[0]: 某游戏公司 (2026-04)\n- [10-42 ✓] CDG事业群6个月回流冷冻期绝对拦截 — former_tencent_employment / CDG 6 个月拦截不适用(候选人非 CDG 史),result=PASS\n- [10-45 ⓘ] 腾讯正编转外包回流标记 — 简历未提供 former_tencent_employment(或非腾讯历史),result=PASS\n- [10-46 ✓] 腾讯正编转外包回流凭证校验 — experience[0]: 某游戏公司 (2026-04)\n- [10-47 ✓] 腾讯婚育风险审视与推荐要点 — gender=男, birth_date=1990-04-15, marital=已婚已育\n- [10-53 ⓘ] 非IEG事业群跳过内部技术面试 — experience[0]: 某游戏公司 (2026-04)\n- [10-54 ✓] 对标公司/行业画像库匹配与定向猎挖规则 — experience[0]: 某游戏公司 (2026-04)",
  "notifications": []
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-11T17-15-05-990Z_8b024b_s05-tencent-history-same-studio`
  - run_id: `run_2026-05-11T17-15-05-990Z_8b024b`
  - decision: FAIL / PAUSE
  - dims: client=`腾讯` BG=`CDG`
  - LLM: model=`stub:deterministic` duration=10 ms tokens=5044/2180
  - rules_evaluated: 27 / 51
  - rule_source: `json-fallback`
  - partial_resume_fields: `[name, education, skills, languages, gender, birth_date, experience, expected_salary_range, outsourcing_acceptance, gap_periods, former_csi_employment, conflict_of_interest, nationality, former_tencent_employment, marital_status]`

- **RuleCheckFlag** × 27 (applicable=true 的全部):
  - `10-5` [terminal] result=PASS next=continue
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=PASS next=continue
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=PASS next=continue
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=PASS next=continue
  - `10-15` [terminal] result=PASS next=continue
  - `10-16` [terminal] result=PASS next=continue
  - `10-17` [terminal] result=PASS next=continue
  - `10-18` [needs_human] result=PASS next=continue
  - `10-24` [flag_only] result=PASS next=continue
  - `10-25` [needs_human] result=PASS next=continue
  - `10-26` [needs_human] result=PASS next=continue
  - `10-27` [needs_human] result=PASS next=continue
  - `10-28` [terminal] result=PASS next=continue
  - `10-29` [terminal] result=PASS next=continue
  - `10-35` [needs_human] result=PASS next=continue
  - `10-38` [terminal] result=REVIEW next=pause
  - `10-39` [terminal] result=PASS next=continue
  - `10-42` [terminal] result=PASS next=continue
  - `10-45` [flag_only] result=PASS next=continue
  - `10-46` [needs_human] result=PASS next=continue
  - `10-47` [needs_human] result=PASS next=continue
  - `10-53` [flag_only] result=PASS next=continue
  - `10-54` [terminal] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 1 ms |
| fetch requirement | 0 ms |
| rule check (LLM) | 0 ms |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 26 ms |
| **total** | **27 ms** |
