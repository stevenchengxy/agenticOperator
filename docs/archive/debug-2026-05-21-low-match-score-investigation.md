# 2026-05-21 · MATCH_FAILED score=15 investigation — 陈佩佩

> **TL;DR**: matching score = 15 is **correct**. 候选人是 **采购专员**(2.5y procurement, 大专),
> 但被匹配到了 **文秘行政专员**(本科,会议/公关/档案管理)的 JR — 两个完全不同的职业方向。
> 不是 RoboHire / matcher 算错,是 **workflow 设计问题**:upload event 没绑 JR,
> 系统 fallback 匹配 recruiter 已认领的所有 JR;recruiter 0000023911 当前只有 2 条
> 文秘 JR,所以 采购 简历被强制匹配 文秘 → 低分是正确判定。

## 1. Six runs at a glance

| # | Run ID | Function | Status | Duration | Started |
|---|---|---|---|---|---|
| 1 | `01KS4QRV75ZHWC4JD22Y48MG62` | Resume Parser Agent | ✅ Completed | — | 07:42:31.705Z |
| 2 | `01KS4QSTAXASYTYGZZ9GSRACZG` | Rule Check Agent (10.5) | ✅ Completed | 9.5s | 07:43:03.653Z |
| 3 | `01KS4QT06ZF4NGWGREHZ7ZDT90` | Match Resume Agent — JR R2026040142111 | ✅ Completed (score=15) | ~67s | 07:43:09.656Z |
| 4 | `01KS4QT3WJ5WE1Z0RP32YP49XA` | Match Resume Agent — JR R20260401421 | ✅ Completed (score=15) | ~73s | 07:43:13.403Z |
| 5 | `01KS4QW33A3T7W47W73SM56Q74` | match-completed-candidate-stage (MATCH_FAILED consumer) | ✅ Completed (updated 1) | — | 07:44:18.061Z |
| 6 | `01KS4QWB63E2SQAQNBD04F24Q6` | match-completed-candidate-stage (MATCH_FAILED consumer) | ✅ Completed (skipped: beyond stage) | — | 07:44:26.314Z |

Chain:
```
RESUME_DOWNLOADED
  └→ #1 resumeParser  → emit RESUME_PROCESSED
       └→ #2 ruleCheck (2 JRs → both PASS)
             ├→ emit MATCH_RULE_CHECK_PASSED × 2 → #3 matchResume(JR1) score=15 MATCH_FAILED
             ├                                  → #4 matchResume(JR2) score=15 MATCH_FAILED
             ↓
             #5 / #6 consumer of MATCH_FAILED  (#5 updates state, #6 skips because already past stage)
```

---

## 2. Run #1 — Resume Parser

| Field | Value |
|---|---|
| Run ID | `01KS4QRV75ZHWC4JD22Y48MG62` |
| Function | `Resume Parser Agent` |
| Event | `RESUME_DOWNLOADED` |
| Status | COMPLETED |

**Input (event.payload):**

| Field | Value |
|---|---|
| `upload_id` | `3cac0dfa-c619-ae4d-2c87-98b54fb526df` |
| `filename` | `【采购文员（深圳）_深圳 6-9K】陈佩佩 7年.pdf` |
| `bucket` | `recruit-resume-raw` |
| `object_key` | `2026/05/3cac0dfa-…-【采购文员（深圳）_深圳 6-9K】陈佩佩 7年.pdf` |
| `employee_id` | `0000023911` |
| `client_id` | `cb932a56-6e57-4535-a121-0e36e51d458a` |
| `job_requisition_id` | **`null`** ⚠️ |
| `sourcing_channel_id` | `02001034` |

> ⚠️ **`job_requisition_id = null`** — upload 时没有绑定到任何具体 JR。
> 这是后续 fan-out 错配的根本起点。

**Output (`save-candidate` step):**

```json
{
  "candidate_id":   "2f6e38f1-1012-4f0b-a05b-bc17a34b42df",
  "resume_id":      "64f97384-ea39-4619-93b1-2ad9054b9e4e",
  "application_id": null,
  "candidate_created": true,
  "resume_created":    true
}
```

**Final emit (`emit.resume-processed`):**

```json
{
  "candidate_id":  "2f6e38f1-1012-4f0b-a05b-bc17a34b42df",
  "candidate_name": "陈佩佩",       // ← 解析正确(不像之前那条"基本信息"翻车)
  "resume_id":     "64f97384-…",
  "application_id": null,
  "job_requisition_id": null
}
```

**解析出的 candidate 全貌:**

| Field | Value |
|---|---|
| name | **陈佩佩** |
| phone | 15218344045 |
| email | 1522467310@qq.com |
| currentCompany | (null, 上游 parser 没在 top-level 显式设) |
| currentTitle | (null,同上) |
| education[0] | 广州广播电视大学 / **大专** / 2020.07 毕业 |
| experience[0] | 2024.11–2025.11 深圳市哈曼达创新科技 / **采购专员** |
| experience[1] | 2022.05–2024.01 深圳泰首智能 / **采购专员** |
| experience[2] | 2020.07–2021.10 广州丝路宝典食品 / **财务** |
| skills.tools | 用友、金税盘、办公软件 |
| skills.soft | 应变能力 / 组织能力 / 沟通能力 / 团队协作 |
| skills.technical | (空) |

**Resume 全文 (rawText,1158 chars,后面 matchResume 用这一段做 `resume` 参数):**

```
PERSONAL RESUME

陈佩佩

求职意向:采购专员    期望薪资:7000+
生日:1999.05.24      手机:15218344045
现居:广东省深圳市     邮箱:1522467310@qq.com

自我评价
• 工作经验:拥有2.5年采购经验,熟悉从需求分析、供应商筛选到订单交付、验收付款的全流程;
• 应变能力:面对紧急采购需求(如生产缺料)或供应商违约时,保持冷静并快速协调资源;
• 工作态度:工作认真负责,具备良好的组织能力及沟通能力,能与生产、研发等团队高效协作。

教育背景
广州广播电视大学    学历:大专    毕业时间:2020.07

社会经验
2024.11-2025.11   深圳市哈曼达创新科技有限公司    采购专员
  - 订单处理 / 沟通维护 / 风险应对 / 项目开发 / 开发筛选 / 谈判签约 / 数据管理
2022.5-2024.1     深圳泰首智能技术有限公司         采购专员
  - 采购任务执行 / 质量审核 / 供应商对账 / 成本优化
2020.7-2021.10    广州丝路宝典食品有限公司         财务
  - 应收应付核对 / 用友金税盘 / 资金规划
```

---

## 3. Run #2 — Rule Check

| Field | Value |
|---|---|
| Run ID | `01KS4QSTAXASYTYGZZ9GSRACZG` |
| Function | `Rule Check Agent (workflow node 10.5)` |
| Event | `RESUME_PROCESSED` |
| Duration | 9.5s |

**Output:**

```json
{
  "ok": true,
  "upload_id":    "3cac0dfa-c619-ae4d-2c87-98b54fb526df",
  "candidate_id": "2f6e38f1-1012-4f0b-a05b-bc17a34b42df",
  "employee_id":  "0000023911",
  "requested_count": 2,
  "passed":          2,
  "failed":          0
}
```

**Per-JR rule check stats (from `step.end` logs):**

| JR | Decision | Rules | Pass | Fail | Pending | Not-Triggered |
|---|---|---|---|---|---|---|
| R2026040142111 | PASS | 7 | 3 | 0 | 0 | 4 |
| R20260401421 | PASS | 7 | 4 | 0 | 0 | 3 |

> rule check 全部通过 — 没有规则拦下来这条候选人。问题不在 rule check。

**关键观察:为什么 fan-out 出 2 个 JR**

upload event 里 `job_requisition_id = null` →
rule-check fallback 走 `requirement_claim` 查 recruiter `0000023911` **当前认领且 in 招聘中**
的所有 JR(per partner spec)。recruiter 当前只有这 2 条 JR(下面 §4 的两条都是 **文秘行政专员**),
所以 采购 简历被强制 fan-out 匹配 文秘 JR。

---

## 4. Run #3 + #4 — Match Resume × 2 (核心问题在这里)

### Run #3: matchResume vs JR R2026040142111

| Field | Value |
|---|---|
| Run ID | `01KS4QT06ZF4NGWGREHZ7ZDT90` |
| Function | `Match Resume Agent (workflow node 10)` |
| Event | `MATCH_RULE_CHECK_PASSED` |

**JR 关键字段 (从 event.payload.job_requisition 提取):**

| Field | Value |
|---|---|
| `job_requisition_id` | `JRQ-cb932a56-…-R2026040142111` |
| `client_job_title` | **文秘行政专员** |
| `client_job_type` | 产品/内容类运营 |
| `city` | 深圳 |
| `salary_range` | 8k-9k |
| `degree_requirement` | **本科** |
| `work_years` | (null) |
| `must_have_skills` | (空 — 没填) |
| `job_responsibility` | 1. 外部对接(政府部门、行业协会、事业单位)<br>2. 会议全流程组织与保障<br>3. 商务接待与公关、资源对接、合作维护<br>4. 材料撰写与档案管理<br>5. 日常行政事务统筹 |
| 办公地点 | 前海科兴科学园 |

**送给 RoboHire 的 `match-resume` 调用 (从 `match.input` 日志):**

```json
{
  "resume_chars": 1158,
  "resume_src":   "parsed_content",
  "jd_chars":     786
}
```

`resume` 字段 = 上面 §2 那段 rawText (PDF 纯文本)
`jd` 字段 = `flattenRequirementForMatch(req)` 拼出来的 JR 文本(约 786 字)

**partner-pg 写入结果 (`save-match-…` step):**

```json
{
  "candidate_match_result_id": "2ab51b0c-a99a-444d-aebf-5168b20aecc9",
  "candidate_id":              "2f6e38f1-…",
  "job_requisition_id":        "JRQ-…-R2026040142111",
  "job_posting_id":            "a9d96231-a1eb-44f3-9106-2cfb87c868d5",
  "created": true
}
```

**Match outcome:**

```json
{
  "ok": true,
  "requestId":     "req_1779349390919_ia296qy",
  "eventName":     "MATCH_FAILED",
  "matching_score": 15
}
```

emit 出去的 MATCH_FAILED 事件:

```json
{
  "event_name":   "MATCH_FAILED",
  "candidate_id": "2f6e38f1-…",
  "job_requisition_id": "JRQ-…-R2026040142111",
  "matching_score": 15,
  "candidate_match_result_id": "2ab51b0c-…",
  "overall_status": "不匹配"
}
```

### Run #4: matchResume vs JR R20260401421

跟 Run #3 几乎一模一样 — **JR 字段内容完全相同**(两条 JR 是同岗位的两个版本)。同样得到 `matching_score = 15` → `MATCH_FAILED`。

| Field | Value |
|---|---|
| Run ID | `01KS4QT3WJ5WE1Z0RP32YP49XA` |
| `candidate_match_result_id` | `7e5ee283-92d9-4a0b-a071-4c6bc6532b7c` |
| `job_posting_id` | `c4baa203-4f32-4e2b-b1e7-95397c5ae1b1` |
| `matching_score` | **15** |
| event | `MATCH_FAILED` |

---

## 5. Run #5 + #6 — Downstream consumers (`match-completed-candidate-stage`)

这两条是订阅 `MATCH_FAILED` 的 stage-machine 更新器。一次跑一条 MATCH_FAILED。

### Run #5

| Field | Value |
|---|---|
| Run ID | `01KS4QW33A3T7W47W73SM56Q74` |
| Event | `MATCH_FAILED` (from Run #3) |

**Output:**

```json
{ "updated": 1, "total": 1, "skipped": [], "eventName": "MATCH_FAILED" }
```

→ 把 candidate 的 stage 更新成 `match_failed` 状态(数据库写成功)。

### Run #6

| Field | Value |
|---|---|
| Run ID | `01KS4QWB63E2SQAQNBD04F24Q6` |
| Event | `MATCH_FAILED` (from Run #4) |

**Output:**

```json
{
  "updated": 0,
  "total":   1,
  "skipped": [{
    "candidate_id":  "2f6e38f1-…",
    "reason":        "candidate_beyond_job_matching",
    "current_state": "job_matching"
  }],
  "eventName": "MATCH_FAILED"
}
```

→ 这条 skip 了 — 因为 Run #5 已经把候选人状态推到了 `match_failed`,这次再来一条 MATCH_FAILED
时候选人 state 已经 beyond `job_matching` → 不动。**这是状态机正确的去重行为**,不是 bug。

---

## 6. 为什么 score 这么低 — 分析

**用户期待:** 高分匹配
**实际:** score=15 → MATCH_FAILED

### 字段级 side-by-side 对比

| 维度 | 候选人 陈佩佩 (resume) | JR 文秘行政专员 |
|---|---|---|
| **求职意向 / 岗位** | 采购专员 | 文秘行政专员 |
| **行业** | 采购 (procurement) | 行政/秘书 (admin/secretarial) |
| **工作内容** | 订单处理、供应商管理、成本谈判、BOM 单 | 政府对接、会议组织、商务接待、公关、档案 |
| **核心技能** | 用友 / 金税盘 / 供应商评估 / 谈判 | (JR 没填 must_have_skills,但 JD 文本意指公关接待、文书) |
| **学历** | **大专** | **本科** (要求) ❌ |
| **经验** | 2.5y 采购 + 1y 财务 (无行政经验) | 文秘/行政经验 |
| **薪资意向** | 7000+ | 8k-9k (OK) |
| **城市** | 深圳 | 深圳 ✓ |

### 维度命中:

- ✅ 城市 / 薪资带 — 命中
- ❌ 岗位 — 完全不一致(采购 vs 文秘)
- ❌ 行业 — 不一致
- ❌ 学历 — 不达标(大专 vs 要求本科)
- ❌ 技能 — 完全不重合
- ❌ 经验 — 0 年文秘经验

**RoboHire 给 15 分是合理的。** 真正 fit 一条文秘 JR 的候选人应该是:
- 本科及以上
- 有过秘书/行政/文书/公关经验
- 熟悉会议组织、商务接待、档案管理

陈佩佩 没有任何一条对得上。

### 根本不是 matcher 出错,是 workflow 出错

**真正的问题在 fan-out 阶段:** 这条采购简历**根本不应该被匹配到文秘 JR**。

| 链路点 | 问题 |
|---|---|
| Upload 事件 | `job_requisition_id = null` — 上传时没绑岗位 |
| ruleCheck fan-out | 因为 jr_id 缺,fallback 取 recruiter 当前所有 in-flight JR |
| recruiter `0000023911` 的 JR 池 | 当前只有 2 条 文秘 JR,**没有任何 采购 JR** |
| 结果 | 采购简历被强制跟文秘 JR 算分,必然低 |

---

## 7. 修复建议(按 ROI 排序)

### A. 短期 — Workflow 层(必做)
1. **upload 阶段强制选 JR**:UI 上传简历必须先选目标 JR;不允许 `job_requisition_id = null` 的 upload 进入主链路。如果 partner UI 不能很快改,在 AO 这边 ruleCheck 检测到 `job_requisition_id=null` 时,**不要做 fan-out,直接 emit `MATCH_FAILED.reason=no_explicit_jr`** 或者跳过整个 match 阶段。
2. **从文件名反推 JR 意向**:文件名里有 `【采购文员(深圳)_深圳 6-9K】陈佩佩 7年.pdf`,采购 + 深圳 + 6-9K + 7y 全在里面。可以加一个简单的 fuzzy match (filename ↔ recruiter 的 JR title),如果命中再 fan-out,不命中就明确报错"无匹配 JR"。

### B. 中期 — 数据层
3. **recruiter JR 池可视化**:在 AO UI 显示"recruiter 当前认领的 JR 列表",让上传者一眼能看到"我这个简历会被匹配到哪些 JR",防止业务侧错配。
4. **学历预筛**:已经有 rule check 了,可以在 rule-check 阶段加一条"degree_requirement vs candidate.highest_acquired_degree" hard rule,差太多就直接 `MATCH_RULE_CHECK_FAILED`,不进 matchResume 浪费 token。

### C. 长期 — UX
5. **resume → JR 推荐反向召回**:不只是 recruiter 把 JR 推给候选人,反过来 — 候选人简历进来后,根据 ontology 内全部 published JR 做相似度召回,推荐 top-N 给 recruiter 选择"推送到哪条 JR"。这才是真正用 AI 做 reverse-match 的产品形态。

### D. 不需要做的(用户可能误以为是 bug 但不是)
- ❌ **不要降低 MATCH_FAILED 的 score 阈值** — 15 分是真的不匹配,降阈值只是把垃圾混进面试池
- ❌ **不要怀疑 parsed_content 切换** — 这次跑用的就是 parsed_content(`resume_src=parsed_content`,1158 字符),走的是新链路;低分跟字段选择无关,跟 resume vs JR 本质不匹配相关

---

## 8. 完整日志事件清单 (附录)

只列 candidate_id `2f6e38f1-…` / upload_id `3cac0dfa-…` 关联的所有日志事件:

```
07:43:03.049 resumeParser  save-candidate.ok    candidate_id=2f6e38f1-…  resume_id=64f97384-…
07:43:03.320 resumeParser  emit.resume-processed
07:43:03.326 resumeParser  handler.done

07:43:03.658 ruleCheck     handler.start
07:43:04.056 ruleCheck     step.start            rule-check-…R2026040142111
07:43:04.071 ruleCheck     api.lookup-client.get-instance
07:43:04.084 ruleCheck     api.lookup-client.cypher
07:43:04.092 ruleCheck     api.lookup-client.partner-pg
07:43:04.092 ruleCheck     rule-fetch.client-resolution
07:43:04.134 ruleCheck     api.fetch-action-rules
07:43:04.134 ruleCheck     rule-fetch.result
07:43:04.134 ruleCheck     runRuleCheck.start
07:43:09.274 ruleCheck     step.end              decision=PASS  pass=3 fail=0
07:43:09.376 ruleCheck     step.start            rule-check-…R20260401421
07:43:09.381–.534 ruleCheck (同上链路)
07:43:13.148 ruleCheck     step.end              decision=PASS  pass=4 fail=0
07:43:13.195 ruleCheck     handler.done          passed=2 failed=0

07:43:09.669 matchResume   handler.start (R2026040142111)
07:43:09.670 matchResume   match.input           resume_chars=1158 resume_src=parsed_content jd_chars=786
07:43:13.410 matchResume   handler.start (R20260401421)
07:43:13.411 matchResume   match.input           resume_chars=1158 resume_src=parsed_content jd_chars=786

(matchResume 中间步骤约 60+s — RoboHire /match-resume LLM 调用)

07:44:17.470 matchResume   handler.start (R2026040142111 replay)
07:44:17.775 matchResume   handler.start (R2026040142111 replay 2)
07:44:17.892 matchResume   emit.match-event      MATCH_FAILED score=15 cmr=2ab51b0c-…
07:44:17.901 matchResume   handler.done

07:44:26.025 matchResume   handler.start (R20260401421 replay)
07:44:26.171 matchResume   handler.start (R20260401421 replay 2)
07:44:26.188 matchResume   emit.match-event      MATCH_FAILED score=15 cmr=7e5ee283-…
07:44:26.194 matchResume   handler.done
```

(handler.start 多次出现是 Inngest 的 step memoization replay,每次进入 handler body 都会 log 一次,但实际只有一次完整执行 — 这是 Inngest 执行模型的正常表现,不是异常)

---

## 9. 关于 partner-pg 数据是否落库

为这次 run 写入 partner Postgres 的:

| 表 | 行数 | 关键字段 |
|---|---|---|
| `candidate` | 1 | `candidate_id=2f6e38f1-…` `name="陈佩佩"` `mobile_normalized=15218344045` |
| `resume` | 1 | `resume_id=64f97384-…` parsed_content=1158 字符 |
| `candidate_match_result` × 2 | 2 | `2ab51b0c-…` (R2026040142111, score=15) + `7e5ee283-…` (R20260401421, score=15) |
| `candidate_match_result_runtime_state` × 2 | 2 | 同上对应行,带 dimension scores + AI summary + raw_llm_response |
| `application` | 0 | (RAAS 自己创建,AO 已停写;upload 时 jr_id 为 null 也走不到这里) |

→ **数据都落了**。RAAS 看不见的话还是 §6 那条:Application 没建 → HSM 视角空 / status,state 为 NULL → recruiter chip 默认过滤掉。要修可见性需要补 status/state 默认值并重新加 Application 创建路径。
