# 完整事件链(含 rule-check 子流程详图)

> 全部链路从 `REQUIREMENT_LOGGED` 到 `APPLICATION_SUBMITTED`。基于 2026-05-14 现状:
> - AO 重构后 control plane 拆分,**agents 跑在 `resume-parser-agent` 子项目(:3020)**
> - rule-check 拆成 5-agent pipeline(在 `scripts/rule-check-poc/`,待集成回 matchResumeAgent)
> - 包含 2 项最新规则改动:① 缺数据不阻塞 ② RuleScopeClassifierAgent 过滤 candidate-matching 类规则

---

## 0. 架构速览

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│  Layer 1 — UI / Dashboard                                                          │
│  RAAS dashboard  (HSM / recruiter / HSM 工作台,只读 Allmeta 显示)                   │
└──────────────────────┬────────────────────────────────────────────────────────────┘
                       │ emit / consume events
                       ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│  Layer 2 — Event bus(Shared Inngest @ 10.100.0.70:8288)                          │
│  跨服务消息总线,所有 ontology 事件经此                                              │
└──────────────────────┬────────────────────────────────────────────────────────────┘
                       │
       ┌───────────────┴───────────────────────────────────────────┐
       ▼                                                            ▼
┌──────────────────────────────────────┐   ┌──────────────────────────────────────┐
│  AO-main (:3002)                     │   │  resume-parser-agent (:3020)         │
│  ─────────────                       │   │  ─────────────────────────           │
│  · UI(/rule-check 审计 drawer)      │   │  · 3 个 Inngest agents:              │
│  · EM gateway                        │   │     - resumeParserAgent              │
│  · RAAS bridge                       │   │     - createJdAgent                  │
│  · 不跑业务 agent(functions = [])    │   │     - matchResumeAgent               │
│                                      │   │  · scripts/rule-check-poc/ pipeline │
└──────────────────────────────────────┘   │    (POC,待集成进 matchResumeAgent)│
                                            └──────────────────────────────────────┘
                       │                                       │
                       └───────────────┬───────────────────────┘
                                       ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│  Layer 3 — 业务网关                                                                 │
│                                                                                     │
│  RAAS API Server (:3001)              Allmeta Ontology API (:3500)                │
│  ─────────────────────                ─────────────────────────                   │
│  · /parse-resume   ←  RoboHire 透传    · /instances/{label}  ← 实例数据 CRUD       │
│  · /match-resume   ←  RoboHire 透传    · /actions/matchResume/rules  ← 拉规则     │
│  · /generate-jd    ←  RoboHire 透传    · /actions/matchResume/results ← 写 Match │
│  · /requirements/* ←  RAAS DB         · /links               ← 关系             │
│  · /candidates / /jd/sync-generated / /match-results  ← RAAS 本地持久化           │
│  · /events/ingest   ← partner 事件 ingest(信号 + HITL 触发)                       │
└──────────────────────┬────────────────────────────────────────────────────────────┘
                       │ writes
                       ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│  Layer 4 — 存储                                                                     │
│                                                                                     │
│  Neo4j (bolt://localhost:7688)        AO Prisma SQLite              MinIO          │
│  ─────────────────────────            ──────────────                ──────          │
│  · 实例图(Allmeta 写入唯一入口)        · RuleCheckAudit + Flag      · 简历 PDF      │
│  · Ontology schema(:DataObject /      · (AO 私有,不进 Neo4j)                       │
│    :Rule / :Action / :Event)                                                       │
│  · 经 Allmeta API 读 / 写                                                          │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. 阶段 1 — 需求登记 + JD 生成

```
HSM 在 RAAS dashboard 录入需求
       │
       ▼  RAAS dashboard emit
   REQUIREMENT_LOGGED  /  REQUIREMENT_SYNCED
   payload: { job_requisition_id, client_id, employee_id, ... }
       │
       ▼  Shared Inngest @ :8288
   ┌──────────────────────────────────────────────────────────────────┐
   │  resume-parser-agent (:3020)  →  createJdAgent                   │
   │  订阅:REQUIREMENT_LOGGED / CLARIFICATION_READY / JD_REJECTED      │
   │                                                                   │
   │  Step A. fetch raw requirement                                    │
   │    [RAAS]  GET /api/v1/requirements/{job_requisition_id}          │
   │            → { requirement: {...64 字段...}, spec, siblings }     │
   │                                                                   │
   │  Step B. RoboHire 生成 JD                                          │
   │    [RAAS]  POST /api/v1/generate-jd                               │
   │            body: { job_requisition_id, must_have_skills, ... }    │
   │            → { data: { title, description, requirements, ...} }   │
   │                                                                   │
   │  Step C. 持久化(双写)                                             │
   │    [RAAS]    POST /api/v1/jd/sync-generated   ← RAAS DB           │
   │    [Allmeta] POST /api/v1/ontology/instances/Job_Posting          │
   │              POST /api/v1/ontology/instances/Job_Requisition      │
   │              POST /api/v1/ontology/links { type: REALIZES_REQ }   │
   │                                                                   │
   │  Step D. emit                                                     │
   │    ANALYSIS_COMPLETED / CLARIFICATION_INCOMPLETE ★HITL /          │
   │    JD_GENERATED ★HITL                                             │
   └──────────────────────────────────────────────────────────────────┘
       │
       ▼  ★ HITL 分支
   CLARIFICATION_INCOMPLETE → partner HSM 工作台(澄清需求)
   JD_GENERATED              → partner HSM 工作台(审 JD)
                              ↓ HSM 审通过
                              emit JD_APPROVED → 阶段 2
```

---

## 2. 阶段 2 — JD 发布到渠道(partner 主导)

```
   JD_APPROVED
       │
       ▼  partner channel publisher
   partner 调拉勾 / BOSS / 内推 API
       │
       ├─ 成功 → emit CHANNEL_PUBLISHED
       ├─ 手发 → emit CHANNEL_PUBLISHED_MANUAL
       └─ 失败 → emit CHANNEL_PUBLISHED_FAILED ★HITL (recruiter 手动)

   [Allmeta]  PATCH /instances/Job_Posting/{id}
              body: { channel_status: 'published', channel_published_at }
```

**AO 不参与本阶段**。

---

## 3. 阶段 3 — 简历采集 + 解析

```
候选人投递简历 / recruiter 手工上传
       │
       ▼  文件存 MinIO (10.100.0.70:9000)
       │
       ▼  RAAS dashboard emit
   RESUME_DOWNLOADED
   payload: { upload_id, bucket, object_key, candidate_hint, employee_id }
       │
       ▼  Shared Inngest
   ┌──────────────────────────────────────────────────────────────────┐
   │  resume-parser-agent (:3020)  →  resumeParserAgent               │
   │  订阅:RESUME_DOWNLOADED                                            │
   │                                                                   │
   │  Step A. download PDF                                             │
   │    [RAAS]  GET /api/v1/resumes/uploads/{upload_id}/raw            │
   │            → Buffer (PDF 字节)                                     │
   │                                                                   │
   │  Step B. RoboHire 解析                                             │
   │    [RAAS]  POST /api/v1/parse-resume    (multipart)               │
   │            → { data: { name, gender, marital_status,              │
   │                        education[], experience[], skills{},       │
   │                        expected_salary_range, ...29 字段 } }       │
   │                                                                   │
   │  Step C. 持久化(双写)                                             │
   │    [RAAS]    POST /api/v1/candidates    ← RAAS DB                 │
   │    [Allmeta] POST /api/v1/ontology/instances/Candidate            │
   │              POST /api/v1/ontology/instances/Resume               │
   │              POST /api/v1/ontology/instances/Candidate_Expectation│
   │              POST /api/v1/ontology/links (HAS_RESUME / HAS_EXP)   │
   │                                                                   │
   │  Step D. emit                                                     │
   │    RESUME_PROCESSED                                               │
   │    或 RESUME_PARSE_ERROR ★HITL(解析失败)                          │
   │    或 RESUME_LOCKED_CONFLICT ★HITL(候选人锁定冲突)                 │
   └──────────────────────────────────────────────────────────────────┘
       │
       ▼
   RESUME_PROCESSED  ──► 阶段 4
   payload: { candidate_id, resume_id, parsed: { data: {...} } }
```

---

## 4. 阶段 4 ★ 核心 — 简历匹配(rule-check + Robohire)

```
   RESUME_PROCESSED
       │
       ▼  Shared Inngest
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  resume-parser-agent (:3020)  →  matchResumeAgent                        │
   │  订阅:RESUME_PROCESSED                                                     │
   │                                                                           │
   │  Step 1-3. 准备数据                                                       │
   │    [RAAS]  GET /api/v1/requirements/agent-view?claimer_employee_id=X     │
   │            → 拉候选人名下所有可匹配 JR(可能多条,循环)                    │
   │                                                                           │
   │  ┌──────────────────────────────────────────────────────────────────┐    │
   │  │ Step 4 ★★★ rule-check 子流程(7 个 sub-step,详见下方 §4.x)★★★  │    │
   │  └──────────────────────────────────────────────────────────────────┘    │
   │                                                                           │
   │  Step 5 (rule-check 决策 = KEEP 时进). 调 RAAS matchResume                │
   │    [RAAS]  POST /api/v1/match-resume     ← RAAS proxy 到 Robohire        │
   │            → { matchScore, recommendation, breakdown }                    │
   │                                                                           │
   │    [RAAS]   POST /api/v1/match-results    ← 持久化 RAAS DB               │
   │    [Allmeta] POST /actions/matchResume/results   ← 写 :Candidate_Match_  │
   │             PATCH /instances/Candidate_Match_Result(补 rule-check 字段)   │
   │                                                                           │
   │  Step 6. emit 最终决策                                                    │
   │    matchScore ≥ 阈值 + 需面试 → MATCH_PASSED_NEED_INTERVIEW              │
   │    matchScore ≥ 阈值 + 免面试 → MATCH_PASSED_NO_INTERVIEW                │
   │    matchScore < 阈值          → MATCH_FAILED                              │
   │                                  (match_failed_source='robohire_threshold')│
   └──────────────────────────────────────────────────────────────────────────┘
```

### 4.1 sub-step ① OntologyQueryAgent — 拉 rules + filter

```
   ┌───────────────────────────────────────────────────────────────────┐
   │  [Allmeta]  GET /api/v1/ontology/actions/matchResume/rules?       │
   │             domain=RAAS-v1                                         │
   │                                                                    │
   │  → 51 条 ontology rules                                            │
   │                                                                    │
   │  [现有 filter](applicableClient × applicableDepartment × executor)│
   │    ─ executor=Human 的规则 → 跳(人工处理)                          │
   │    ─ 不匹配本 JR client/dept 的客户专属规则 → 跳                    │
   │                                                                    │
   │  ⬇ ~27 条剩余                                                       │
   └───────────────────────────────────────────────────────────────────┘
```

### 4.2 sub-step ② SeverityInferenceAgent — 从文本推断 severity

```
   ┌───────────────────────────────────────────────────────────────────┐
   │  扫 rule.standardizedLogicRule 文本,关键词分类:                    │
   │                                                                    │
   │   terminal      含 "立即终止 / 立即拦截 / 一票否决 / 不予录用"      │
   │   needs_human   含 "挂起 / 暂停 / 待 HSM / 审核提醒"                │
   │   flag_only     兜底 — 仅标记,不阻断                               │
   │                                                                    │
   │  (中期方案,陈洋的活:ontology Rule 加 gating_severity 字段)        │
   └───────────────────────────────────────────────────────────────────┘
```

### 4.3 sub-step ③ ★NEW★ RuleScopeClassifierAgent — LLM 三分类

```
   ┌───────────────────────────────────────────────────────────────────┐
   │  ★ 关键 sub-agent — 把"不该 rule-check 的"过滤掉                   │
   │                                                                    │
   │  ── 路径 A:applicableClient ≠ '通用' 或 dept 限定 → 直接标         │
   │             customer_specific(不问 LLM,~5 条)                    │
   │                                                                    │
   │  ── 路径 B:剩余'通用'规则 → 批量丢给 LLM 判定                       │
   │     [LLM 输入] N 条 rule.standardizedLogicRule + relatedEntities  │
   │     [LLM 输出] { rule_id, scope, reason }                          │
   │                                                                    │
   │  三种 scope:                                                       │
   │                                                                    │
   │  ╔═════════════════════╦══════════════════════════════════════════╗│
   │  ║ scope               ║ 含义 + 例子                                ║│
   │  ╠═════════════════════╬══════════════════════════════════════════╣│
   │  ║ truly_universal     ║ 规则只读候选人属性,跟具体 JR 无关。      ║│
   │  ║ (✅ 留进 LLM)        ║ 例:10-9 履历空窗、10-10 职业稳定性、    ║│
   │  ║                     ║      10-27 利益冲突声明、10-16/17/18    ║│
   │  ║                     ║      CSI 历史从业、10-38/39/40 腾讯历史 ║│
   │  ╠═════════════════════╬══════════════════════════════════════════╣│
   │  ║ customer_specific   ║ 客户/部门绑定。例:10-1 字节专属、       ║│
   │  ║ (✅ 留进 LLM)        ║       10-47 腾讯婚育、10-3 IEG          ║│
   │  ╠═════════════════════╬══════════════════════════════════════════╣│
   │  ║ candidate_matching  ║ 候选人 vs JR 字段比对(Robohire 已覆盖)。 ║│
   │  ║ (❌ 过滤掉)          ║ 例:10-5 一票否决学历对 JR、10-7 期望薪资║│
   │  ║                     ║      超岗位框架、10-14 外语对 JR 要求    ║│
   │  ╚═════════════════════╩══════════════════════════════════════════╝│
   │                                                                    │
   │  ⬇ 27 → ~15 条(去掉 ~12 条 candidate_matching)                    │
   └───────────────────────────────────────────────────────────────────┘
```

### 4.4 sub-step ④ RuleClassifierAgent — 按 severity 分桶

```
   ┌───────────────────────────────────────────────────────────────────┐
   │  把 ~15 条 rules 重组成多视图:                                      │
   │    - by client      :  general / client_level / department_level   │
   │    - by severity    :  terminal / needs_human / flag_only          │
   │                                                                    │
   │  (给下一 step 的 prompt 渲染做分段标题用)                            │
   └───────────────────────────────────────────────────────────────────┘
```

### 4.5 sub-step ⑤ PromptComposerAgent — 渲染 prompt

```
   ┌───────────────────────────────────────────────────────────────────┐
   │  渲染最终 user prompt,7 段:                                        │
   │    header / role / inputs / rules / decision_logic /                │
   │    output_schema / self_check                                       │
   │                                                                    │
   │  ★ 关键 prompt 约束(本次改动):                                     │
   │                                                                    │
   │  ① result 分类铁律:                                                │
   │     - 真违反 → result="FAIL" + fail_reason_type="rule_violation"   │
   │     - 缺数据 → result="NOT_APPLICABLE"(★ 不阻塞,即使 terminal)   │
   │     - 真通过 → result="PASS"                                        │
   │                                                                    │
   │  ② evidence 三段式:候选人字段值 + 阈值 + 推断理由                 │
   │                                                                    │
   │  ③ 禁箭头 / 符号 / 模糊措辞 / 缺数据当未提供                       │
   │                                                                    │
   │  ④ 决策结算:                                                       │
   │     - 任一 result=FAIL && fail_reason_type=rule_violation → DROP   │
   │     - 全 PASS / NOT_APPLICABLE → KEEP(包括 terminal 缺数据)        │
   └───────────────────────────────────────────────────────────────────┘
```

### 4.6 sub-step ⑥ LLMRunnerAgent — 调 Gemini 评估

```
   ┌───────────────────────────────────────────────────────────────────┐
   │  [LLM]  POST {AI_BASE_URL}/v1/chat/completions                    │
   │         model: google/gemini-3-flash-preview                       │
   │                                                                    │
   │  输出 rule_flags[] (~15 条 applicable rules):                       │
   │  {                                                                 │
   │    rule_id: "10-9",                                                │
   │    rule_name: "简历履历空窗期检测与标记",                            │
   │    applicable: true,                                               │
   │    result: "PASS" | "FAIL" | "NOT_APPLICABLE",                    │
   │    fail_reason_type: "rule_violation" | "missing_data" | null,    │
   │    severity: "needs_human",                                        │
   │    evidence: "候选人 work_experience 含连续 4 段经历...",            │
   │    next_action: "continue"                                         │
   │  }                                                                 │
   │                                                                    │
   │  + overall_decision: "KEEP" | "DROP"                                │
   │  + drop_reasons: ["10-X:VIOLATION_CODE"]                            │
   └───────────────────────────────────────────────────────────────────┘
```

### 4.7 sub-step ⑦ ★ 决策折算 (Decision Folding) — 关键三分支 ★

```
   扫 rule_flags[],分类统计:
       has_real_violation = ∃ flag: result=FAIL && fail_reason_type='rule_violation'
       missing_fields[]   = 从 result=NOT_APPLICABLE 且 evidence 含"未提供"的 flag 抠出来

   ┌─────────────────────────────────────────────────────────────────────────┐
   │                                                                          │
   │   ┌──────────────────────┐  ┌──────────────────────────┐  ┌────────────┐│
   │   │  分支 A:真违反        │  │  分支 B:无真违反 + 缺数据  │  │ 分支 C:全过 ││
   │   │  has_real_violation  │  │  !has_real_violation     │  │ 全 PASS    ││
   │   │  = true              │  │  && missing_fields.len>0 │  │            ││
   │   └──────────┬───────────┘  └────────────┬─────────────┘  └─────┬──────┘│
   │              │                            │                       │      │
   │              ▼                            ▼                       ▼      │
   │   ━━━━━━━━━━━━━━━━━━━━━     ━━━━━━━━━━━━━━━━━━━━━━━━━━     ━━━━━━━━━━   │
   │   ★ rule-check FAIL ★      ★ 继续 + 信号通知 RAAS ★         ★ 直接过 ★   │
   │   ━━━━━━━━━━━━━━━━━━━━━     ━━━━━━━━━━━━━━━━━━━━━━━━━━     ━━━━━━━━━━   │
   │                                                                          │
   │   emit MATCH_FAILED        ① emit RESUME_INFO_MISSING        (无事件)   │
   │     {                        {                                           │
   │       candidate_id,            candidate_id,                             │
   │       job_req_id,              resume_id,                                │
   │       match_failed_            job_req_id,                               │
   │         source:                missing_fields[],                         │
   │         'rule_check_           audit_id                                  │
   │         terminal',           }                                            │
   │       failure_reason_                                                    │
   │         codes: [               ─► partner 自己处理:                     │
   │         "10-X:VIOLATION"]          建 HITL 任务给 recruiter 补;          │
   │     }                              补完后 partner 自己重发              │
   │                                    RESUME_PROCESSED(新一轮)            │
   │                                    AO 不订阅 / 不等 / 不阻塞            │
   │                                                                          │
   │   ─► partner 关任务         ② 流程**不停**,继续 Step 5                 │
   │      (matching 终止)                                                     │
   │                                                                          │
   │   ━━━━━━━━━━━━━━━━━━━━━     ━━━━━━━━━━━━━━━━━━━━━━━━━━     ━━━━━━━━━━   │
   └─────────────────────────────────────────────────────────────────────────┘
              │                            │                           │
              │ (流程终止)                  ▼                           ▼
              │                       ┌────────────────────────────────────┐
              │                       │  Step 5  调 RAAS matchResume       │
              │                       │  (调 Robohire 评分,见 §4 上面)    │
              │                       └────────────────────────────────────┘
              │                                          │
              ▼                                          ▼
        partner consumer              emit MATCH_PASSED_NEED_INTERVIEW
        关 candidate-on-jr            或 MATCH_PASSED_NO_INTERVIEW
        matching task                 或 MATCH_FAILED (robohire_threshold)
```

### ★ 三分支事件互斥规则(给 partner 看)

| 分支 | rule-check 状态 | AO emit 事件 | partner 应做 | 流程是否继续 |
|---|---|---|---|---|
| **A. 真违反** | 客户/通用规则真违反 | `MATCH_FAILED` + `match_failed_source='rule_check_terminal'` + `failure_reason_codes[]` | 关 matching task,通知 HSM | ❌ 终止 |
| **B. 缺数据** | 只 NOT_APPLICABLE,无真违反 | `RESUME_INFO_MISSING` + `missing_fields[]`(信号,**AO 不等**)| 自己建 HITL 任务让 recruiter 补,补完后**自己重发** `RESUME_PROCESSED`(走全新链路) | ✅ 继续 → Step 5 |
| **C. 全过** | 全 PASS 或 NA(非缺数据)| (无 rule-check 事件) | — | ✅ 继续 → Step 5 |

**关键变化(跟之前设计相比)**:
- AO 不再有 `infoFilledHandler` 中间 handler
- AO **不订阅** RESUME_INFO_MISSING 的回复事件
- partner 拿到 RESUME_INFO_MISSING 后**自己处理补全**,补完后**自己重发 RESUME_PROCESSED** 走全新链路 — 简化全套 AO 逻辑

---

## 5. 阶段 5 — 面试 / 评估(MATCH_PASSED_NEED_INTERVIEW 后)

```
   MATCH_PASSED_NEED_INTERVIEW
       │
       ▼  partner interview-scheduler(待 partner 实现)
   [RAAS]  POST /api/v1/invite-interview   ← 当前 HTTP 501
       │
       ▼ emit INTERVIEW_INVITATION_SENT
   [Allmeta] POST /instances/Interview_Record
             POST /links { Application -[:HAS_INTERVIEW]-> }
       │
       ▼  候选人完成 AI 面试
       ▼ partner emit AI_INTERVIEW_COMPLETED
   [Allmeta] PATCH /instances/Interview_Record/{id}
             body: { transcript_url, score, completed_at }
       │
       ▼  AO evaluationAgent(★ 待建,订阅 AI_INTERVIEW_COMPLETED)
   AO 跑 evaluation LLM(综合面试转写 + JD spec + rule-check 历史)
       │
       ▼ [Allmeta] POST /instances/Evaluation_Report
       │ [Allmeta] POST /links { Application -[:HAS_EVALUATION]-> }
       │
       ▼ emit
   EVALUATION_PASSED  →  阶段 6
   EVALUATION_FAILED ★HITL(HSM 复核)
```

`MATCH_PASSED_NO_INTERVIEW`:跳过本阶段,直接进阶段 6。

---

## 6. 阶段 6 — 推荐包生成 + 客户提交

```
   EVALUATION_PASSED  /  MATCH_PASSED_NO_INTERVIEW
       │
       ▼  AO packageAgent(★ 待建)
   生成推荐包(优化简历 + 评估摘要 + 卖点)
       │
       ▼ [Allmeta] POST /instances/Recommendation_Material
       │ [Allmeta] POST /links { Application -[:HAS_PACKAGE]-> }
       │
       ▼ emit
   PACKAGE_GENERATED ★HITL   →  HSM 审推荐包
   PACKAGE_MISSING_INFO ★HITL →  recruiter 补料(补完 partner 重发 PACKAGE_GENERATED)
       │
       ▼  HSM 审通过
       ▼ emit PACKAGE_APPROVED
       │
       ▼  partner client-submission worker
   调客户 RMS API 提交推荐包
       │
       ├─ 成功 → emit APPLICATION_SUBMITTED
       │         [Allmeta] PATCH /instances/Application/{id}
       │                   body: { status: 'submitted_to_client' }
       │         🎉 终态
       │
       └─ 失败 → emit SUBMISSION_FAILED ★HITL
                 (recruiter 手提)
```

---

## 7. 阶段 7 — 客户面试 / Offer(超出 AO 范围)

```
APPLICATION_SUBMITTED → 客户 RMS 通知 → 客户面试
                     → 客户决策
                     → partner emit OFFER_GENERATED
                     → [Allmeta] POST /instances/Job_Offer
                     → 候选人签 / 拒
                     → [Allmeta] POST /instances/Assignment(外包派驻成立)
```

---

## 8. 总事件清单

| 阶段 | 事件 | 方向 | HITL? | 写哪个 Allmeta 实例 |
|---|---|---|---|---|
| 1 | `REQUIREMENT_LOGGED` / `_SYNCED` | RAAS → AO | ❌ | (createJdAgent 触发) |
| 1 | `ANALYSIS_COMPLETED` | AO → 下游 | ❌ | Job_Requisition |
| 1 | `CLARIFICATION_INCOMPLETE` / `_READY` / `_RETRY` | 来回 | ★ (incomplete) | — |
| 1 | `ANALYSIS_BLOCKED` | AO → ops | ★ | — |
| 2 | `JD_GENERATED` | AO → partner | ★ HSM 审 | Job_Posting |
| 2 | `JD_APPROVED` / `JD_REJECTED` | RAAS → AO | ❌ | Job_Posting (PATCH) |
| 3 | `CHANNEL_PUBLISHED` / `_MANUAL` / `_FAILED` | partner | ★ (failed) | Job_Posting (PATCH) |
| 4 | `RESUME_DOWNLOADED` | RAAS → AO | ❌ | (resumeParserAgent 触发) |
| 4 | `RESUME_PROCESSED` | AO → AO matcher | ❌ | Candidate + Resume |
| 4 | `RESUME_PARSE_ERROR` / `_LOCKED_CONFLICT` | AO → partner | ★ | — |
| 5 | **`RESUME_INFO_MISSING`** | **AO → RAAS(信号)** | ★ recruiter | — |
| 5 | **`MATCH_FAILED`** | **AO → partner** | (关任务) | Candidate_Match_Result (PASS-only writes Match_Result;FAIL 不写)|
| 5 | `MATCH_PASSED_NEED_INTERVIEW` / `_NO_INTERVIEW` | AO → partner | ❌ | Candidate_Match_Result + Application |
| 6 | `INTERVIEW_INVITATION_SENT` | partner → AO | ❌ | Interview_Record |
| 6 | `AI_INTERVIEW_COMPLETED` | partner → AO | ❌ | Interview_Record (PATCH) |
| 6 | `EVALUATION_PASSED` / `_FAILED` | AO → 下游/partner | ★ (failed) | Evaluation_Report |
| 7 | `PACKAGE_GENERATED` / `_MISSING_INFO` | AO → partner | ★ | Recommendation_Material |
| 7 | `PACKAGE_APPROVED` | RAAS → 下游 | ❌ | (PATCH) |
| 7 | `APPLICATION_SUBMITTED` | partner / AO | ❌ | Application (PATCH) |
| 7 | `SUBMISSION_FAILED` | partner → partner | ★ | — |

★ 共 12 个 HITL 事件触发 partner 工作台任务。

---

## 9. RAAS API 端点速查

| Method | Path | 用途 | AO 调用方 |
|---|---|---|---|
| GET | `/api/v1/requirements/agent-view?claimer_employee_id=X` | 列某 recruiter 名下所有可匹配 JR | matchResumeAgent |
| GET | `/api/v1/requirements/{job_requisition_id}` | 单 JR 完整详情 | createJdAgent / matchResumeAgent |
| POST | `/api/v1/generate-jd` | RoboHire JD 生成透传 | createJdAgent |
| POST | `/api/v1/jd/sync-generated` | 持久化 JD 到 RAAS DB | createJdAgent |
| GET | `/api/v1/resumes/uploads/{upload_id}/raw` | 拉简历 PDF | resumeParserAgent |
| POST | `/api/v1/parse-resume` (multipart) | RoboHire 解析透传 | resumeParserAgent |
| POST | `/api/v1/candidates` | 持久化候选人到 RAAS DB | resumeParserAgent |
| POST | `/api/v1/match-resume` | RoboHire 评分透传 | matchResumeAgent |
| POST | `/api/v1/match-results` | 持久化匹配结果到 RAAS DB | matchResumeAgent |
| POST | `/api/v1/invite-interview` | 发面试邀约(currently 501) | partner 实现 |
| POST | `/api/v1/events/ingest` | 通用事件 ingest(信号 / HITL 触发) | AO emit `RESUME_INFO_MISSING / MATCH_FAILED / ANALYSIS_BLOCKED` 等 |

---

## 10. Allmeta API 端点速查

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/v1/ontology/actions/matchResume/rules?domain=RAAS-v1` | 拉 51 条 matchResume 规则 |
| POST | `/api/v1/ontology/instances/{label}?domain=RAAS-v1` | 创建/upsert 实例(MERGE)|
| GET | `/api/v1/ontology/instances/{label}/{pk}?domain=RAAS-v1` | 读单个实例 |
| PATCH | `/api/v1/ontology/instances/{label}/{pk}` | 部分更新 |
| POST | `/api/v1/ontology/links` | 建实例间关系 |
| **POST** | **`/api/v1/ontology/actions/matchResume/results`** | **特化端点:写 :Candidate_Match_Result + 自动 MERGE Candidate/JR + 自动建关系** |

---

## 11. 共享 Neo4j 实例图(经 Allmeta 写)

```
(Client)
   │
   └─ owns ─► (Job_Requisition) ─ has ─► (Job_Posting) ─ via ─► (Sourcing_Channel)
                    │
                    │ evaluated for
                    ▼
                (Candidate) ─ has ─► (Resume) ─ has ─► (Candidate_Expectation)
                    │
                    ├─ has_match_result ─► (Candidate_Match_Result)
                    │
                    ├─ has_application ─► (Application)
                    │                         │
                    │                         ├─ has_interview ─► (Interview_Record)
                    │                         ├─ has_evaluation ─► (Evaluation_Report)
                    │                         └─ has_package ─► (Recommendation_Material)
                    │
                    └─ has_offer ─► (Job_Offer) ─ leads to ─► (Assignment)
```

---

## 12. AO 当前实施状态

| 阶段 | 责任 agent | 已实现? | Allmeta 路径? |
|---|---|---|---|
| 1+2 | createJdAgent(resume-parser-agent :3020) | ✅ 实现 | ❌ 还在用 RAAS DB,Allmeta 写入待加 |
| 3 | partner channel publisher | partner 实现 | — |
| 4 | resumeParserAgent(:3020) | ✅ 实现 | ❌ 待加 Allmeta 写 Candidate/Resume |
| 5 | matchResumeAgent(:3020) | ✅ 基础实现 | ❌ 待集成 rule-check-poc + Allmeta 写 Match_Result |
| 5.rule-check | rule-check-poc 5-agent pipeline + scope classifier | ✅ POC | ❌ 未集成回 matchResumeAgent |
| 6 | evaluationAgent | ❌ 待建 | — |
| 6 | packageAgent | ❌ 待建 | — |
| 7 | partner client-submission | partner 实现 | — |

---

## 13. 本次 2 项规则改动(★ 重点)

### ① 缺数据不阻塞(改 prompt-composer-agent.ts)

**老逻辑**:任何 terminal/needs_human 规则 result=FAIL → overall=DROP(包括缺数据 FAIL)
**新逻辑**:
- LLM 输出加 `fail_reason_type` 字段(`rule_violation` / `missing_data` / null)
- 折算时:只有 `result=FAIL && fail_reason_type='rule_violation'` 才 DROP
- 缺数据 → 强制改成 `NOT_APPLICABLE`,流程继续

### ② RuleScopeClassifierAgent(新 sub-agent)

新建 [scripts/rule-check-poc/agents/rule-scope-classifier-agent.ts](../../scripts/rule-check-poc/agents/rule-scope-classifier-agent.ts)

- 用 LLM 判定每条规则的 `scope`:`truly_universal` / `customer_specific` / `candidate_matching`
- 过滤掉 `candidate_matching`(Robohire 已覆盖必备技能 / 期望薪资 / 学历对 JR 等比对类规则)
- rule-check LLM 只跑 `truly_universal` + `customer_specific`(~15 条,从 27 缩到 15)

---

## 14. 文档关系

| 文档 | 作用 |
|---|---|
| **本文** [docs/full-event-chain-with-rule-check-detail.md](./full-event-chain-with-rule-check-detail.md) | ★ 全链路 + rule-check 子流程详细 |
| [docs/full-event-chain-end-to-end.md](../full-event-chain-end-to-end.md) | 老版全链路(重构前)|
| [docs/raas-partner-integration-spec-for-claude-code.md](../raas-partner-integration-spec-for-claude-code.md) | partner 实施手册 |
| [docs/architecture-corrected-event-chain.md](../architecture-corrected-event-chain.md) | 三层架构(AO + RAAS dashboard + Allmeta) |
| [docs/ao-runtime-vs-allmeta-dataobject-gap.md](../ao-runtime-vs-allmeta-dataobject-gap.md) | DataObject schema 对齐分析 |
| Allmeta API doc | `~/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md` |
