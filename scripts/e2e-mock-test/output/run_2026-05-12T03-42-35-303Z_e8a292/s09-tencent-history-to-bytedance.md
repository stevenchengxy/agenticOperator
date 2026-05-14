# s09-tencent-history-to-bytedance ❌

> scenario: candidate=`c04-zhaoliu-tencent-ieg` × jd=`jr-bytedance-tiktok-fe`
> rationale: 赵六(C++/Lua 游戏后端)推字节 TikTok 前端岗。腾讯规则 (10-38/10-43)在字节路径下 applicable=false(客户不匹配,规则不适用)。通用 10-5(技能一票否决)必命中。

## 1. Verdict — 期望 vs 实际

| | 期望 | 实际 |
|---|---|---|
| binary decision | FAIL | FAIL ✓ |
| llm_decision | FAIL | FAIL |
| must-fail rules | 10-5 | 10-14:language_mismatch, 10-5:hard_requirement_mismatch, 10-7:salary_mismatch, 10-9:gap_detected |
| augmentation injected | no | no |

## 2. Assertions

- ✅ **decision == expected (FAIL)**
- ✅ **llm_decision compatible (FAIL)**
- ✅ **must-fail rule fired: 10-5**
- ❌ **must-not-fail rule: 10-38** — LLM 没在 rule_flags 输出这条规则
- ❌ **must-not-fail rule: 10-43** — LLM 没在 rule_flags 输出这条规则
- ✅ **matchResume NOT called (FAIL skips Robohire)**
- ✅ **Neo4j audit node written**
- ✅ **Neo4j flags count == applicable count (16)** — wrote=16 expected=16
- ✅ **evidence verifiable rate ≥ 0.8 (got 94%)** — verified=15 / total=16

## 3. Evidence 真实性核查

LLM 输出的每条 `rule_flags[i].evidence` 是否能在原始 parsed_resume 里 grep 到原文片段。
**Verifiable rate: 94%** (≥ 80% required)

| Rule | Evidence(LLM 输出) | 提取片段 | 命中 | 未命中 | ✓/✗ |
|---|---|---|---|---|---|
| 10-10 | 平均每段工作时长约 3.5 年（2019-08至2025-02, 2025-03至2026-04），不属于稳定性风险。 | 平均每段工作时长约, 不属于稳定性风险, 2019-08 | 2019-08, 2025-02 | 平均每段工作时长约, 不属于稳定性风险 | ✓ |
| 10-12 | 出生1990年，硕士毕业2019年，毕业年龄29岁。硕士基准24-26岁，偏差3岁，但规则要求偏差≥2岁暂停，此处逻辑判定为PASS（注：因简历为硕士且工作多年，29岁毕业在合理波动内）。 | 因简历为硕士且工作多年, 出生, 硕士毕业 | — | 因简历为硕士且工作多年, 出生 | ✓ |
| 10-14 | 岗位要求CET-6 480以上，候选人CET-6 510，虽分数达标，但岗位标签含“外语”且要求证书，逻辑判定需严审。此处因10-5硬性冲突，标记FAIL。 | 岗位要求, 以上, 候选人 | CET-6, CET | 岗位要求, 以上 | ✓ |
| 10-24 | 简历已解析并关联至 jr_w66 需求。 | 简历已解析并关联至, 需求 | — | 简历已解析并关联至, 需求 | ✓ |
| 10-5 | 硬性要求不符：岗位要求 React, TypeScript；候选人技能为 C++, Lua, Redis, UnrealEngine，且经历为游戏后端，与 Web 前端岗位严重不匹配。 | 岗位要求 React, 硬性要求不符, 岗位要求 | Lua, Redis | 岗位要求 React, 硬性要求不符 | ✓ |
| 10-6 | 命中加分项：有海外业务经验（TikTok 业务对标），英语 CET-6 510。 | 有海外业务经验, 命中加分项, 业务对标 | 英语, CET-6 | 有海外业务经验, 命中加分项 | ✓ |
| 10-7 | 候选人期望 45k-58k，岗位上限 50k。期望上限超过岗位上限，且技能匹配度极低，判定为薪资不匹配。 | 候选人期望, 岗位上限, 期望上限超过岗位上限 | 45k-58k | 候选人期望, 岗位上限 | ✓ |
| 10-8 | 候选人接受外包/正编形式（labor_form_preference: 正编, outsourcing_acceptance: 接受）。 | 正编, 接受, 候选人接受外包 | 正编, 接受 | 候选人接受外包, 正编形式 | ✓ |
| 10-9 | 2019年毕业至2019-08首份工作起始，存在约2个月空窗；2025-02至2025-03无空窗。但因整体匹配失败，标记为空窗风险待查。 | 年毕业至, 首份工作起始, 存在约 | 2019-08, 2025-02 | 年毕业至, 首份工作起始 | ✓ |
| 10-1 | 符合新需求下发扫描逻辑。 | 符合新需求下发扫描逻辑 | — | 符合新需求下发扫描逻辑 | ✓ |
| 10-11 | 候选人意向为正编，符合岗位招聘类型。 | 候选人意向为正编, 符合岗位招聘类型 | — | 候选人意向为正编, 符合岗位招聘类型 | ✓ |
| 10-2 | 系统自动扫描召回逻辑适用。 | 系统自动扫描召回逻辑适用 | — | 系统自动扫描召回逻辑适用 | ✓ |
| 10-21 | 岗位年龄上限 32 岁，候选人出生于 1990-04，当前年龄 36 岁（以2026年计），超过红线。 | 岗位年龄上限, 候选人出生于, 当前年龄 | 1990-04 | 岗位年龄上限, 候选人出生于 | ✓ |
| 10-22 | 候选人年龄 36 岁 > 35 岁，触发高龄风险标记。 | 候选人年龄, 触发高龄风险标记 | — | 候选人年龄, 触发高龄风险标记 | ✗ |
| 10-32 | 无历史淘汰记录。 | 无历史淘汰记录 | — | 无历史淘汰记录 | ✓ |
| 10-33 | 无历史退场记录。 | 无历史退场记录 | — | 无历史退场记录 | ✓ |

## 4. LLM 原始输出(full JSON)

```json
{
  "candidate_id": "R_b4956a",
  "job_requisition_id": "jr_w66",
  "client_id": "CLI_BYTEDANCE",
  "overall_decision": "FAIL",
  "failure_reasons": [
    "10-14:language_mismatch",
    "10-5:hard_requirement_mismatch",
    "10-7:salary_mismatch",
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
      "evidence": "平均每段工作时长约 3.5 年（2019-08至2025-02, 2025-03至2026-04），不属于稳定性风险。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-12",
      "rule_name": "学历年龄逻辑校验与风险预警",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": true,
      "result": "PASS",
      "evidence": "出生1990年，硕士毕业2019年，毕业年龄29岁。硕士基准24-26岁，偏差3岁，但规则要求偏差≥2岁暂停，此处逻辑判定为PASS（注：因简历为硕士且工作多年，29岁毕业在合理波动内）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-14",
      "rule_name": "语言能力硬性门槛判断",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位要求CET-6 480以上，候选人CET-6 510，虽分数达标，但岗位标签含“外语”且要求证书，逻辑判定需严审。此处因10-5硬性冲突，标记FAIL。",
      "next_action": "block"
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
      "evidence": "简历已解析并关联至 jr_w66 需求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "工作经历中不包含华为、荣耀。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-26",
      "rule_name": "OPPO小米竞对与客户互不挖角红线",
      "applicable_client": "通用",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "工作经历中不包含OPPO、小米。",
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
      "result": "FAIL",
      "evidence": "硬性要求不符：岗位要求 React, TypeScript；候选人技能为 C++, Lua, Redis, UnrealEngine，且经历为游戏后端，与 Web 前端岗位严重不匹配。",
      "next_action": "block"
    },
    {
      "rule_id": "10-54",
      "rule_name": "对标公司/行业画像库匹配与定向猎挖规则",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "岗位需求中未定义负向要求。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-6",
      "rule_name": "推荐前置简历匹配与硬性要求规则",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "命中加分项：有海外业务经验（TikTok 业务对标），英语 CET-6 510。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-7",
      "rule_name": "候选人期望薪资校验",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人期望 45k-58k，岗位上限 50k。期望上限超过岗位上限，且技能匹配度极低，判定为薪资不匹配。",
      "next_action": "block"
    },
    {
      "rule_id": "10-8",
      "rule_name": "候选人意愿度校验",
      "applicable_client": "通用",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人接受外包/正编形式（labor_form_preference: 正编, outsourcing_acceptance: 接受）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-9",
      "rule_name": "简历履历空窗期检测与标记",
      "applicable_client": "通用",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "2019年毕业至2019-08首份工作起始，存在约2个月空窗；2025-02至2025-03无空窗。但因整体匹配失败，标记为空窗风险待查。",
      "next_action": "block"
    },
    {
      "rule_id": "10-1",
      "rule_name": "字节新需求下发滞留简历优先转推",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "符合新需求下发扫描逻辑。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-11",
      "rule_name": "求职意向劳务形式校验",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "候选人意向为正编，符合岗位招聘类型。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-2",
      "rule_name": "字节新需求下发HC冻结候选人召回",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "系统自动扫描召回逻辑适用。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-21",
      "rule_name": "岗位年龄红线与隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "岗位年龄上限 32 岁，候选人出生于 1990-04，当前年龄 36 岁（以2026年计），超过红线。",
      "next_action": "block"
    },
    {
      "rule_id": "10-22",
      "rule_name": "岗位年龄隐形门槛判定",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": true,
      "result": "FAIL",
      "evidence": "候选人年龄 36 岁 > 35 岁，触发高龄风险标记。",
      "next_action": "block"
    },
    {
      "rule_id": "10-32",
      "rule_name": "岗位冷冻期规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无历史淘汰记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-33",
      "rule_name": "字节客户退场回流约束规则",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": true,
      "result": "PASS",
      "evidence": "无历史退场记录。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-34",
      "rule_name": "字节跳动友商非BPO外包经历回流冷冻期拦截",
      "applicable_client": "字节",
      "severity": "terminal",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "简历中未见通过其他供应商派驻字节的经历。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-36",
      "rule_name": "字节婚育风险审视与推荐要点",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "候选人为男性。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-49",
      "rule_name": "字节正编员工回流标记与凭证校验",
      "applicable_client": "字节",
      "severity": "needs_human",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "工作经历中不包含字节跳动正式雇员记录（前司为腾讯及某游戏公司）。",
      "next_action": "continue"
    },
    {
      "rule_id": "10-51",
      "rule_name": "字节正编回流客户BP确认放行",
      "applicable_client": "字节",
      "severity": "flag_only",
      "applicable": false,
      "result": "NOT_APPLICABLE",
      "evidence": "非字节正编回流人员。",
      "next_action": "continue"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\n\n- [10-24 ⓘ] 简历与客户原始需求的关联 — 已关联至 jr_w66\n- [10-5 ✗] 简历匹配硬性要求一票否决 — 技能不匹配 (后端 vs 前端)\n- [10-6 ⓘ] 推荐前置简历匹配与硬性要求规则 — 命中外语加分项\n- [10-7 ✗] 候选人期望薪资校验 — 期望 58k 超过岗位 50k 上限\n- [10-8 ⓘ] 候选人意愿度校验 — 接受外包形式\n- [10-21 ✗] 岗位年龄红线与隐形门槛判定 — 36岁超过32岁上限\n- [10-22 ✗] 岗位年龄隐形门槛判定 — 超过35岁高龄风险",
  "notifications": []
}
```

## 5. matchResume 未调用(FAIL 路径,Robohire 配额节省)

## 6. Neo4j 实例数据写入

- **RuleCheckAudit** `rca_run_2026-05-12T03-42-35-303Z_e8a292_s09-tencent-history-to-bytedance`
  - run_id: `run_2026-05-12T03-42-35-303Z_e8a292`
  - decision: FAIL / FAIL
  - dims: client=`字节` BG=`TikTok`
  - LLM: model=`google/gemini-3-flash-preview` duration=17363 ms tokens=10081/3520
  - rules_evaluated: 28 / 51
  - rule_source: `neo4j-direct`
  - partial_resume_fields: `[name, experience, gap_periods, labor_form_preference, education, birth_date, languages, outsourcing_acceptance, former_csi_employment, gender, marital_status, skills, expected_salary_range]`

- **RuleCheckFlag** × 16 (applicable=true 的全部):
  - `10-10` [terminal] result=PASS next=continue
  - `10-12` [needs_human] result=PASS next=continue
  - `10-14` [terminal] result=FAIL next=block
  - `10-24` [flag_only] result=PASS next=continue
  - `10-5` [flag_only] result=FAIL next=block
  - `10-6` [flag_only] result=PASS next=continue
  - `10-7` [terminal] result=FAIL next=block
  - `10-8` [flag_only] result=PASS next=continue
  - `10-9` [terminal] result=FAIL next=block
  - `10-1` [flag_only] result=PASS next=continue
  - `10-11` [flag_only] result=PASS next=continue
  - `10-2` [flag_only] result=PASS next=continue
  - `10-21` [terminal] result=FAIL next=block
  - `10-22` [terminal] result=FAIL next=block
  - `10-32` [flag_only] result=PASS next=continue
  - `10-33` [flag_only] result=PASS next=continue

## 7. Timings

| Step | Duration |
|---|---|
| saveCandidate | 1 ms |
| fetch requirement | 1 ms |
| rule check (LLM) | 17.37 s |
| matchResume | — |
| saveMatchResults | — |
| Neo4j write | 19 ms |
| **total** | **17.39 s** |
