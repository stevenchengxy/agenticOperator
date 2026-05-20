# Workflow Agents · Inngest Functions 规格总览

> **范围**:AO-main 注册的 4 个生产 Inngest workflow agents 的事件订阅、I/O schema、与 RAAS / RoboHire / Ontology API / Neo4j 的协作方式,以及 AO ↔ RAAS Inngest bus 之间的桥接。
>
> **代码定位**:p4 合并后所有 agent runtime 在 AO-main(`:3002`)。`resume-parser-agent/:3020` 子项目已废弃,代码迁入 [server/inngest/agents/](../server/inngest/agents/)。
>
> **当前实现版本**:`workflow-b@2026-05-19`(PR-1 ~ PR-5 完成后),见 [docs/superpowers/specs/2026-05-19-rule-check-independent-agent-design.md](superpowers/specs/2026-05-19-rule-check-independent-agent-design.md)。
>
> **与上一版的差异**:
> - 新增 4-th agent `ruleCheckAgent`(workflow node 10.5),从 matchResumeAgent step 4.0 抽离
> - `matchResumeAgent` 从单触发改为**双触发**(订阅 `RESUME_PROCESSED` + `MATCH_RULE_CHECK_PASSED`)
> - `parseResume` / `matchResume` 切换为 AO 直连 RoboHire(`lib/robohire-client.ts`),不再走 RAAS API Server 的透传代理
> - `POST /candidates` / `/match-results` / `/jd/sync-generated` 仍走 RAAS API Server(写 RAAS Postgres,partner dual-write 契约)
> - rule data 升级到 v0.1.002,Rule 模型新增 `enforcementLevel` + `failurePolicy` 字段;旧的 `inferSeverity()` 关键词启发式删除
> - `foldDecision` 调整:`insufficient_info → PASS`(不阻断 match);只有 `fail → FAIL`,`pending → REVIEW`

---

## 0. 拓扑一图

```
                            ┌─────────────────────────────────────┐
                            │   RAAS Inngest (10.100.0.70:8288)   │
                            │  ─ "shared bus" — 双方共同订阅       │
                            └─────────────────────────────────────┘
                              ▲           ▲           ▲
              ① RAAS publish  │           │  ⑤ AO forward (回灌)
              REQUIREMENT_*   │           │  JD_GENERATED / RESUME_PROCESSED
              RESUME_DOWN-    │           │  MATCH_*
              LOADED          │           │
                              │           │ pull (raas-bridge: poll /v1/events)
                              │           │
                            ┌─┴───────────┴─────────────────────────┐
                            │  AO-main Inngest (local :8288)        │
                            │  agentic-operator-main app id         │
                            │  em.publish gateway · EventInstance   │
                            └────────────┬──────────────────────────┘
                                         │ fan-out (Inngest serve)
                                         ▼
                            ┌─────────────────────────────────────────┐
                            │  AO-main (Next.js :3002)                │
                            │  app id: agentic-operator-main          │
                            │  /api/inngest serve handler             │
                            │                                         │
                            │   • createJdAgent       (workflow #4)   │
                            │   • resumeParserAgent   (workflow #9)   │
                            │   • matchResumeAgent    (workflow #10)  │
                            │   • ruleCheckAgent      (workflow #10.5)│ ★ NEW (PR-4)
                            └──┬────────────┬───────────┬─────────────┘
                               │            │           │
              ┌────────────────┘            │           └───────────────┐
              │ direct                      │ HTTPS                     │ bolt
              │ HTTPS                       │ (Bearer AGENT_API_KEY)    │
              ▼                             ▼                           ▼
   ┌──────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────┐
   │  RoboHire            │  │  RAAS API Server         │  │  Local Neo4j (:7688) │
   │  (api.robohire.io)   │  │  (raas_v4 backend :3001) │  │  +  Ontology API     │
   │  ─────────           │  │  /api/v1/{...}           │  │  (:3500)             │
   │  • POST /parse-resume│  │  • Persistence:          │  │  • Rule 元数据 (248) │
   │  • POST /match-resume│  │    - POST /candidates    │  │  • Candidate/Resume  │
   │                      │  │    - POST /match-results │  │    /JR/Application/  │
   │  无状态 AI 能力      │  │    - POST /jd/sync-      │  │    Blacklist 实例图  │
   │                      │  │      generated           │  │  • ActionStep 分组    │
   │                      │  │  • Read-only:            │  │                       │
   │                      │  │    - GET /requirements/* │  │  rule-check 用       │
   │                      │  │    - GET /resumes/...    │  │                       │
   │                      │  │  • Legacy proxy(不再用): │  │                       │
   │                      │  │    /parse-resume         │  │                       │
   │                      │  │    /match-resume         │  │                       │
   │                      │  │    /generate-jd ← 还在用 │  │                       │
   └──────────────────────┘  └──────────────────────────┘  └──────────────────────┘
```

### 关键约束

- AO 与 RAAS 各自有独立的 Inngest dev server。AO → RAAS 由 [server/inngest/raas-forward.ts](../server/inngest/raas-forward.ts) 直接 POST 推送;RAAS → AO 由 [server/inngest/raas-bridge.ts](../server/inngest/raas-bridge.ts) 反向 poll。
- **RoboHire 直连**(`lib/robohire-client.ts`)只用于"无状态 AI 加工"调用 — `parse-resume` 和 `match-resume`。
- **RAAS API Server 仍是 source of truth** for Postgres 业务状态(`Candidate / JobPosting / CandidateMatchResult` 等)— 即使切了 RoboHire 直连,持久化端点 (`POST /candidates / /match-results / /jd/sync-generated`) 一定要保留。Partner 已确认这是 dual-write 契约。
- **`generate-jd` 仍走 RAAS 代理**(本版未切) — 留 Phase 2,RoboHire 暴露的 JD 端点文档不完整。
- Agent 不允许直读 RAAS Postgres;不允许直读 partner Neo4j(`RAAS_LINKS_NEO4J_URI`)。本地 Neo4j(`NEO4J_INSTANCE_URI`)是 AO 自己写入 / 读取的"业务实例图",由 `lib/rule-check/neo4j-*-writer.ts` 维护。

---

## 1. Inngest client / Event 表

定义见 [server/inngest/client.ts](../server/inngest/client.ts):

```ts
new Inngest({ id: 'agentic-operator-main', schemas: new EventSchemas().fromRecord<Events>() });
```

**事件名 → 数据 type 映射**:

| Event Name | TS type (data field) | 出/入 | 主要订阅者 |
|---|---|---|---|
| `RESUME_DOWNLOADED` | `ResumeDownloadedData` | in (RAAS → AO) | `resumeParserAgent` |
| `RESUME_PROCESSED` | `ResumeProcessedData` | out (AO → RAAS) + 内部级联 | `matchResumeAgent`(1st seg) + RAAS 自家入库 |
| `RULE_CHECK_REQUESTED` ★ | `RuleCheckRequestedData` | 内部 (AO ↔ AO) | `ruleCheckAgent` |
| `MATCH_RULE_CHECK_PASSED` ★ | `RuleCheckPassedData` | 内部 (AO ↔ AO) | `matchResumeAgent`(2nd seg) |
| `RULE_CHECK_FAILED` ★ | `RuleCheckFailedData` | out (AO → RAAS) | (终态,无后继 agent;RAAS 可订阅做审计) |
| `MATCH_PASSED_NEED_INTERVIEW` | `MatchPassedNeedInterviewData` | out (AO → RAAS) | RAAS `match-result-ingest-need-interview` |
| `MATCH_PASSED_NO_INTERVIEW` | 同上 | out | RAAS ingest fn (no-interview 通道, 当前未发) |
| `MATCH_FAILED` | 同上 | out | RAAS ingest fn (失败通道, 当前未发) |
| `REQUIREMENT_LOGGED` | `RequirementLoggedData` | in | `createJdAgent` |
| `CLARIFICATION_READY` | 同上 | in | `createJdAgent` |
| `JD_REJECTED` | 同上 | in | `createJdAgent` |
| `JD_GENERATED` | `JdGeneratedEnvelope` | out | RAAS `jd-generated-sync`(cascade-only) |

★ = PR-4 新增。`RULE_CHECK_REQUESTED` 和 `MATCH_RULE_CHECK_PASSED` 完全是 AO 内部事件;`RULE_CHECK_FAILED` 是终态,RAAS 可订阅做 audit 但本版不强制。

---

## 2. Function ① — `createJdAgent`(Workflow node 4)

**文件**:[server/inngest/agents/create-jd-agent.ts](../server/inngest/agents/create-jd-agent.ts)

```ts
inngest.createFunction(
  { id: 'create-jd-agent', name: 'Create JD Agent (workflow node 4)', retries: 1 },
  [{ event: 'REQUIREMENT_LOGGED' }, { event: 'CLARIFICATION_READY' }, { event: 'JD_REJECTED' }],
  async ({ event, step, logger }) => { … }
);
```

`retries: 1` — 网络抖动允许一次自动重试。

### 2.1 入参(`REQUIREMENT_LOGGED` / `CLARIFICATION_READY` / `JD_REJECTED`)

```jsonc
{
  "entity_type": "JobRequisition",
  "entity_id": "JR_xxx",                   // ★ Workflow A 标准锚点
  "event_id": "evt_…",
  "payload": {
    "requirement_id": "JR_xxx",
    "client_id": "CLI001",
    "raw_input_data": { "job_requisition_id": "JR_xxx", … }   // legacy 兜底
  },
  "trace": { "trace_id": "…" }
}
```

> **协议变更**:Workflow A 起 RAAS 不再在 payload 里塞 28 字段。Agent 只取 `entity_id`,详情走 `GET /api/v1/requirements/:id`。

### 2.2 内部流程

```
REQUIREMENT_LOGGED / CLARIFICATION_READY / JD_REJECTED
   │
   ├─ pickRequisitionIdFromEnvelope() —— entity_id 优先,回落到 payload.requirement_id
   │
   ├─ step.run("fetch-requirement-<jrid>"):
   │     RAAS GET /api/v1/requirements/:id
   │     ← { requirement, specification, siblings, latest_task, latest_analysis,
   │         analysis_history, clarification_rounds, manual_override_history, … }
   │
   ├─ buildPromptFromRequirement(req, spec) → free-text prompt (4-4000 chars)
   │     拼:客户/岗位标题/招聘类型/期望级别/城市/HC/薪资/年限/学历/语言/面试形式/
   │        优先级/截止/期望到岗/独家委托/必备技能/加分技能/排除条件/原始责任与要求
   │
   ├─ step.run("generate-<jrid>"):
   │     RAAS POST /api/v1/generate-jd  ({ prompt, language: 'zh', companyName, department })
   │     ← { data: RaasGenerateJdData /* RoboHire camelCase 21 字段 */, meta: { stages } }
   │     // RAAS 内部转发 RoboHire,本版 createJdAgent 仍走 RAAS 代理(Phase 2 切直连)
   │
   ├─ step.run("sync-jd-<jrid>"):
   │     RAAS POST /api/v1/jd/sync-generated
   │       body = { job_requisition_id, client_id,
   │                ...generateResult.data,                   // RoboHire camelCase spread
   │                must_have_skills, nice_to_have_skills,
   │                negative_requirement, language_requirements,
   │                expected_level, degree_requirement, education_requirement,
   │                work_years, interview_mode, recruitment_type,
   │                city: pickCityFromBoth() }                // string→array 转换
   │     ← { synced: true, job_posting_id, job_requisition_id }
   │     // 写 RAAS Postgres
   │
   └─ step.sendEvent("emit-jd-generated-<jrid>", { name: 'JD_GENERATED', data })
```

### 2.3 出参(`JD_GENERATED.data` —— `JdGeneratedEnvelope`)

```ts
{
  entity_type: 'JobDescription',
  entity_id: jdId,                              // jd_<8>_<base36 ts>
  event_id: <uuid>,
  payload: {
    ...jdData,                                  // ① RoboHire camelCase 21 字段 spread
    job_requisition_id, client_id,              // ② raas 关联
    posting_title, posting_description,         // ③ partner-canonical snake_case
    city: string[], salary_range,
    interview_mode, degree_requirement, education_requirement, work_years,
    recruitment_type, must_have_skills, nice_to_have_skills,
    negative_requirement, language_requirements, expected_level,
    responsibility, requirement,                // ④ 发布渠道用的 2 段独立字段
    jd_id, claimer_employee_id, hsm_employee_id, client_job_id,   // ⑤ bookkeeping
    search_keywords, quality_score, quality_suggestions,           // ⑥ 诊断
    market_competitiveness, generator_version, generator_model,
    generated_at,
  },
  trace: <upstream trace>
}
```

> **JD_GENERATED 是 cascade-only 事件**:RAAS 端不再依赖订阅它来入库(`syncJdGenerated` 已在 step 3 里写完)。事件本身只用于驱动后续节点(如 sync-to-publish-channel)。

### 2.4 错误处理

| 来源 | 处理 |
|---|---|
| 缺 `entity_id` / `requirement_id` | `NonRetriableError` |
| `RAAS_API_BASE_URL` / `AGENT_API_KEY` 未配置 | `NonRetriableError`(fail-fast) |
| `getRequirementDetail` 4xx | `NonRetriableError` |
| `requirement.client_id` 缺 | `NonRetriableError`(sync-generated 必填) |
| `generateJd` / `syncJdGenerated` 4xx | `NonRetriableError` |
| `generateJd` / `syncJdGenerated` 5xx / 429 | 重抛 → step.run 重试 → function-level retry (1) |

---

## 3. Function ② — `resumeParserAgent`(Workflow node 9)

**文件**:[server/inngest/agents/resume-parser-agent.ts](../server/inngest/agents/resume-parser-agent.ts)

```ts
inngest.createFunction(
  { id: 'resume-parser-agent', name: 'Resume Parser Agent', retries: 0 },
  { event: 'RESUME_DOWNLOADED' },
  async ({ event, step, logger }) => { … }
);
```

`retries: 0` — RAAS / RoboHire 失败不自动重试,避免重复扣 RoboHire 配额或重写 RAAS DB(`resume-parser-agent.ts:37`)。

### 3.1 入参(`RESUME_DOWNLOADED`)

事件支持两种 envelope 形态(agent 用 `unwrapDownloadedEnvelope` 兼容):

**A. RAAS canonical envelope**(生产)

```jsonc
{
  "entity_type": "ResumeUpload",
  "entity_id": "<upload_id>",
  "event_id": "01KQ973ZQB...",
  "payload": {
    "upload_id": "uuid",                    // ★ 必填,反向定位 candidate
    "bucket": "recruit-resume-raw",         // ★ 必填(RAAS MinIO bucket)
    "object_key": "2026/04/<…>.pdf",        // ★ 必填
    "filename": "张三.pdf",
    "etag": null,                           // 手动上传链路可能为 null
    "size": 380866,
    "mime_type": "application/pdf",
    "operator_employee_id": "EMP001",       // 招聘人员
    "operator_id": null,
    "client_id": "CLI001",
    "job_requisition_id": "JR_xxx",
    "received_at": "2026-04-28T12:57:14Z",
    "source_event_name": "ResumeUploaded"
  },
  "trace": { "trace_id": "…", "request_id": "…" }
}
```

**B. Flat(legacy / publish-test)**:直接铺平 payload 字段,可选带 `parsed.data`(已 parse 过的 RoboHire 结果,agent 会跳过 download+parse)。

**必填校验**:`upload_id` + `bucket` + `object_key`,缺任一直接 `NonRetriableError`。

### 3.2 内部流程

```
RESUME_DOWNLOADED
   │
   ├─ unwrap envelope, 抽 anchor (upload_id / bucket / object_key / employee_id / job_requisition_id)
   │
   ├─ pickParsedData() —— 事件里已带 parsed?
   │    ├─ Y → 用事件里的 parsed.data,跳过 download/parse
   │    └─ N → step.run("download-and-parse-<upload_id>"):
   │            ├─ ① RAAS GET  /api/v1/resumes/uploads/:upload_id/raw     → PDF Buffer
   │            ├─ ② ⭐ RoboHire POST /api/v1/parse-resume  (direct,DIRECT!)
   │            │       (lib/robohire-client.ts: parseResumeDirect)
   │            │       multipart form-data: file=Blob
   │            │       Authorization: Bearer ROBOHIRE_API_KEY
   │            │       → { data: RobohireParseResumeData, cached, requestId, savedAs }
   │            └─ ③ MD5(pdfBuffer) → computed_etag (saveCandidate dedup 兜底)
   │
   ├─ step.run("save-candidate"):
   │     RAAS POST /api/v1/candidates   ← Postgres 持久化(保留!partner dual-write 契约)
   │     body = { upload_id, bucket, object_key, etag, mime_type,
   │              operator_employee_id, parsed, robohire_request_id, … }
   │     ← { candidate_id, resume_id, is_new_candidate, is_new_resume, candidate_name, … }
   │
   └─ step.sendEvent("emit-resume-processed", { name: "RESUME_PROCESSED", data })
```

> **⭐ 关键改动 PR-3**:`parse-resume` 调用从 RAAS API Server 透传(`POST /api/v1/parse-resume`)切换为 AO 直连 `https://api.robohire.io/api/v1/parse-resume`。lib 入口 [`lib/robohire-client.ts:parseResumeDirect`](../lib/robohire-client.ts)。RoboHire 是无状态 AI 服务,RAAS 那一层只是 transparent proxy,绕过它去掉一跳网络延迟 + RAAS 单点故障耦合。
>
> **`POST /candidates` 仍走 RAAS** — 因为它写 RAAS Postgres,partner 那边 HSM 前端读这张表。这是 dual-write 契约,不能去。

### 3.3 出参(`RESUME_PROCESSED.data` —— `ResumeProcessedData`)

```ts
{
  // transport(透传)
  bucket, objectKey, filename,
  hrFolder, employeeId, etag, size, sourceEventName, receivedAt,

  // anchor(matcher 必读)
  upload_id, employee_id,

  // parsed.data 透传(matcher 用作 resume-text 来源)
  parsed: { data: RaasParseResumeData },        // shape 与 RobohireParseResumeData 1:1

  // ★ Workflow A 新增 — 下游不必再调 RAAS 反查
  candidate_id, resume_id,
  job_requisition_id?,                          // 单 JR 精准匹配链路才有

  // 4-object nested(已废弃,保留空对象,schema 映射全部由 RAAS 端处理)
  candidate: {}, candidate_expectation: {}, resume: {}, runtime: {},

  parsedAt, parserVersion: "v7-pull-model@2026-05-08",
}
```

### 3.4 错误处理

| 来源 | 处理 |
|---|---|
| RESUME_DOWNLOADED 缺 upload_id / bucket / object_key | `NonRetriableError`(不进入 step.run) |
| RAAS 4xx (除 429) on download | `NonRetriableError` |
| RoboHire 4xx (除 429) on parse | `NonRetriableError`(payload 问题或 PDF 损坏) |
| RoboHire 402 (QUOTA_EXHAUSTED) | `NonRetriableError`(需要充值/告警) |
| RAAS 4xx on saveCandidate | `NonRetriableError` |
| 5xx / 429 / 网络 | 抛原 `RaasApiError` / `RobohireApiError` → Inngest step.run 自带重试 |

---

## 4. Function ③ — `matchResumeAgent`(Workflow node 10,**双触发**)

**文件**:[server/inngest/agents/match-resume-agent.ts](../server/inngest/agents/match-resume-agent.ts)

```ts
inngest.createFunction(
  { id: 'match-resume-agent', name: 'Match Resume Agent (workflow node 10)', retries: 2 },
  [
    { event: 'RESUME_PROCESSED' },     // 1st segment
    { event: 'MATCH_RULE_CHECK_PASSED' },    // 2nd segment ★ NEW (PR-4)
  ],
  async ({ event, step, logger }) => {
    if (event.name === 'RESUME_PROCESSED')  return handleResumeProcessed(...);
    if (event.name === 'MATCH_RULE_CHECK_PASSED') return handleRuleCheckPassed(...);
  }
);
```

`retries: 2` — RoboHire `/match-resume` 网络抖动多,允许两次。

### 4.1 第一段:`handleResumeProcessed`(订阅 `RESUME_PROCESSED`)

**职责**:拉 JR 列表 → 对每条 JR emit `RULE_CHECK_REQUESTED` 给 ruleCheckAgent。

**不调** RoboHire,**不调** `match-results` 写入 — 这些挪到第二段。

```
RESUME_PROCESSED
   │
   ├─ pickUploadId / pickCandidateId / pickEmployeeId
   │
   ├─ step.run("list-requirements"):
   │     ┌─ A) data.job_requisition_id 有值 (上传时弹框关联了岗位)
   │     │     → RAAS GET /api/v1/requirements/:id
   │     │     → 单 JR 精准匹配
   │     │
   │     └─ B) job_requisition_id 缺
   │           → RAAS GET /api/v1/requirements/agent-view?claimer_employee_id=<emp>
   │           → 客户端兜底过滤 isRecruitingStatus() + hasMatchableContent()
   │
   └─ for (each requirement):
        bypass = process.env.RULE_CHECK_BYPASS === 'true'
        if (bypass):
            // 直接 emit MATCH_RULE_CHECK_PASSED(audit.fail_reason='bypassed')
            // 跳过 ruleCheckAgent,链路直接进 2nd segment
        else:
            step.sendEvent("emit-rule-check-requested-<jrid>", {
              name: 'RULE_CHECK_REQUESTED',
              data: {
                upload_id, candidate_id, resume_id, employee_id,
                job_requisition_id: jrid,
                client_id,
                job_requisition: req,            // ★ 完整 JR 对象(给 ruleCheckAgent 用)
                parsed_resume: parsed.data,      // ★ 完整 parsed resume
                runtime_context: { … },
                trace_id,
              }
            })
```

### 4.2 第二段:`handleRuleCheckPassed`(订阅 `MATCH_RULE_CHECK_PASSED`)

**职责**:接 ruleCheckAgent 的 PASS 决定 → 调 RoboHire match → 持久化到 RAAS Postgres → emit `MATCH_PASSED_NEED_INTERVIEW`。

```
MATCH_RULE_CHECK_PASSED  { ..., job_requisition: <JR full>, parsed_resume: <data> }
   │
   ├─ 校验 payload 含 job_requisition + parsed_resume
   │
   ├─ buildResumeTextFromParsed(parsed_resume) → JSON.stringify
   │  flattenRequirementForMatch(job_requisition) → JD 文本拼接
   │
   ├─ step.run("match-<jrid>"):
   │     ⭐ RoboHire POST /api/v1/match-resume  (direct,DIRECT!)
   │     (lib/robohire-client.ts: matchResumeDirect)
   │     body = { resume, jd }
   │     Authorization: Bearer ROBOHIRE_API_KEY
   │     → { data: RobohireMatchResumeData /* matchScore/recommendation/summary/... */,
   │         requestId, savedAs }
   │     // 4xx 跳过该 JR;5xx/429 抛重试
   │
   ├─ step.run("save-match-<jrid>"):
   │     RAAS POST /api/v1/match-results   ← Postgres 持久化(保留!dual-write 契约)
   │     body = { ...matchResult.data,            // RoboHire camelCase 全字段
   │              source: 'need_interview',
   │              candidate_id, upload_id, job_requisition_id, client_id,
   │              robohire_request_id, savedAs }
   │     ← { upserted, candidate_match_result_id, source: 'need_interview' }
   │
   └─ step.sendEvent("emit-match-<jrid>", {
        name: 'MATCH_PASSED_NEED_INTERVIEW',
        data: { upload_id, job_requisition_id, success: true, data, requestId, savedAs }
      })
```

> **⭐ 关键改动 PR-4**:`matchResume` 调用从 RAAS 透传切换 RoboHire 直连。
>
> **⭐ 关键改动 PR-4**:rule-check 逻辑从 step 4.0 内嵌位置抽到独立 `ruleCheckAgent` 里(见 §5)。`matchResumeAgent` 1st segment 只负责 "拉 JR + 派工",2nd segment 只负责 "match + 落库 + emit"。两段之间通过 `RULE_CHECK_REQUESTED` → `ruleCheckAgent` → `MATCH_RULE_CHECK_PASSED` 串联。
>
> **dual-trigger 设计权衡**:为什么不拆 2 个 function?在 Inngest 监控里仍然显示 2 次独立 run(每段一次),可观测性 OK;不拆 function 减少注册数和文件数。

### 4.3 错误处理

| 来源 | 段 | 处理 |
|---|---|---|
| 缺 upload_id / candidate_id / employee_id | 1st | `NonRetriableError` |
| RAAS 4xx on requirements 拉取 | 1st | `NonRetriableError` |
| MATCH_RULE_CHECK_PASSED payload 缺 job_requisition / parsed_resume | 2nd | return ok:false,跳过该 JR(不抛) |
| RoboHire 4xx on match | 2nd | 跳过该 JR,记 ERROR log,不抛 |
| RoboHire 402 QUOTA_EXHAUSTED | 2nd | 跳过该 JR(可独立告警) |
| RAAS 4xx on saveMatchResults | 2nd | `NonRetriableError` |
| 5xx / 429 / 网络 | 1st+2nd | step.run 重试 → function retries:2 |

---

## 5. Function ④ — `ruleCheckAgent`(Workflow node 10.5)★ NEW

**文件**:[server/inngest/agents/rule-check-agent.ts](../server/inngest/agents/rule-check-agent.ts)
**Lib 核心**:[lib/rule-check/runner.ts](../lib/rule-check/runner.ts) `runRuleCheck()`

```ts
inngest.createFunction(
  { id: 'rule-check-agent', name: 'Rule Check Agent (workflow node 10.5)', retries: 1 },
  { event: 'RULE_CHECK_REQUESTED' },
  async ({ event, step, logger }) => { … }
);
```

`retries: 1` — `runRuleCheck` 内部已 fail-safe in-band(不抛异常),retry 主要为 Inngest step.run 自己的层级异常兜底。

### 5.1 入参(`RULE_CHECK_REQUESTED` —— `RuleCheckRequestedData`)

由 `matchResumeAgent` 1st segment emit。每条 JR 一条事件。

```ts
{
  upload_id: string,
  candidate_id: string,
  resume_id: string,
  employee_id: string,
  job_requisition_id: string,
  client_id?: string,
  // ★ 完整 JR + parsed resume — 给 runRuleCheck 用,避免再回拉 RAAS
  job_requisition: Record<string, unknown>,
  parsed_resume: Record<string, unknown> | null,
  runtime_context: { upload_id, candidate_id, resume_id, employee_id,
                     filename?, received_at?, trace_id?: string | null },
  trace_id?: string | null
}
```

### 5.2 内部流程

```
RULE_CHECK_REQUESTED
   │
   ├─ step.run("rule-check-<jrid>"):
   │     runRuleCheck(input):
   │       ① extractDims(job_requisition) → { client_id, business_group, studio }
   │
   │       ② fetchRulesForMatchResume()
   │            ┌─ ONTOLOGY_API_BASE/TOKEN 已配 → 调 Ontology API
   │            │    GET /api/v1/ontology/actions/matchResume/rules?domain=RAAS-v1
   │            │    → { actionSteps: [{ id, name, order, rules: [...] }] }
   │            │    + lib/rule-check/rules.json 拼 metadata
   │            └─ API 未配/失败 → JSON fallback(只有 rules,无 step grouping)
   │
   │       ③ applyClientFilter(rules, dims):
   │            keep if executor === 'Agent'
   │              && (applicableClient === '通用' || applicableClient === client_id)
   │              && matchesDepartment(applicableDepartment, business_group)
   │            // 客户级过滤 100% 代码逻辑,不是 LLM
   │
   │       ④ buildGraphContext({ candidate_id, job_requisition_id }):
   │            并发拉 6 个 slot 从 NEO4J_INSTANCE(本地 Neo4j :7688):
   │              candidate / resume / job_requisition / applications /
   │              blacklist_hits / employment_links
   │            缓存到 Map 给后续 LLM tool-use 复用
   │
   │       ⑤ composeMatchResumePrompt({ input, graph, steps }):
   │            §1 Role + 约束
   │            §2 Inputs (runtime_context + JR + JR spec + hsm_feedback)
   │            §3 Graph context (6 slot 原 JSON)
   │            §4 Rules — 按 Set 顺序,Set 内顺序;每条 rule 头部带
   │                 [applicableClient=…, enforcement=mandatory|optional, onFail=block|warn]
   │            §5 决策结算逻辑
   │            §6 Output schema(compact: rule_id + status + reason?)
   │            §7 自检
   │
   │       ⑥ chatComplete({ system, user, tools, maxTokens: 16000 }):
   │            POST <AI_BASE_URL>/chat/completions
   │            model: AI_MODEL (默认 google/gemini-3-flash-preview)
   │            tools: get_instance / list_instances / list_links(命中 cache 不回源)
   │
   │       ⑦ parseLlmJson + coerceRuleResults(parsed, filteredSteps):
   │            严格校验 6 态 status,LLM 漏 rule → parse-error fail-safe
   │
   │       ⑧ statsFromResults + deriveExplanations + foldDecision:
   │            ★ foldDecision (PR-4 + 2026-05-19 修正):
   │              if (stats.fail > 0)     return 'FAIL'       // 真实违反 → 终止
   │              if (stats.pending > 0)  return 'REVIEW'     // 需 HSM 介入
   │              return 'PASS'                                // 含 insufficient_info → PASS
   │
   │       ⑨ ruleCheckLog.info('runRuleCheck.done', ...)
   │            写 lib/rule-check/logs/YYYY-MM-DD.log
   │
   │       return MatchResumeCheckResult {
   │         decision, stats, rule_results, explanations,
   │         graph_context, audit: { rules_evaluated, graph_calls, llm_*, … }
   │       }
   │
   ├─ extractDims(job_requisition) → 拼 RuleCheckAuditMeta
   │
   ├─ if (result.decision === 'PASS'):
   │     step.sendEvent("emit-passed-<jrid>", {
   │       name: 'MATCH_RULE_CHECK_PASSED',
   │       data: {
   │         upload_id, candidate_id, resume_id, job_requisition_id, client_id,
   │         audit: RuleCheckAuditMeta,
   │         job_requisition, parsed_resume, runtime_context, employee_id,
   │           // ★ 透传给 matchResumeAgent 第二段,避免 2nd 段回拉 RAAS
   │       }
   │     })
   │
   └─ if (result.decision === 'FAIL' || 'REVIEW'):
        step.sendEvent("emit-failed-<jrid>", {
          name: 'RULE_CHECK_FAILED',
          data: { upload_id, candidate_id, resume_id, job_requisition_id, client_id,
                  decision, failed_rules: [{ rule_id, rule_name, step_id, status, reason }],
                  audit: RuleCheckAuditMeta }
        })
        // 终态,链路终止,不再调 match
```

### 5.3 RuleStatus 六态 + foldDecision

| status | 含义 | foldDecision 贡献 |
|---|---|---|
| `pass` | 规则触发且通过 | → PASS |
| `fail` | 规则触发且违反 | → **FAIL**(终止 match) |
| `pending` | 规则触发,需 HSM 介入(rule 文本明确要求人工确认) | → **REVIEW**(等同 FAIL,终止 match) |
| `insufficient_info` | 数据不足以判定(例:缺出生日期无法验证年龄) | → **PASS**(★ PR-4 修正:不再阻断 match) |
| `not_triggered` | 进入条件不满足,本条 rule 跳过 | → PASS |
| `not_executed` | 前序 rule 已 fail,本条短路 | → PASS(但通常已是 FAIL 链路) |

**为什么 `insufficient_info → PASS`?** Partner 契约要求:**数据缺失不应该惩罚候选人**。LLM 不能因为图节点缺失就把候选人挡掉。只有 LLM 看到完整数据并确认违反规则才阻断。

### 5.4 Rule 数据(`lib/rule-check/rules.json` v0.1.002)

248 条规则,其中 ~51 条 id 以 "10-" 开头(matchResume 相关)。每条 rule 字段:

```jsonc
{
  "id": "10-25",
  "specificScenarioStage": "简历匹配",
  "businessLogicRuleName": "华为荣耀竞对与客户互不挖角红线",
  "applicableClient": "通用",                    // "通用" / "字节" / "腾讯"
  "applicableDepartment": "N/A",                  // BG/Studio 维度
  "submissionCriteria": "…",
  "standardizedLogicRule": "…",
  "relatedEntities": [...],
  "businessBackgroundReason": "…",
  "ruleSource": "内部流程",
  "executor": "Agent",                            // "Agent" 才被 ruleCheckAgent 评估
  "enforcementLevel": "optional",                 // ★ NEW: mandatory / optional
  "failurePolicy": "warn"                         // ★ NEW: block / warn
}
```

`enforcementLevel + failurePolicy` 取代了旧的 `inferSeverity()` 关键词启发式(已删除)。映射规则:
- `mandatory + block` → 旧 `terminal`
- `optional + warn` → 旧 `flag_only`
- 其他组合 → `needs_human`(deriveLegacySeverity)

**数据同时存在 Neo4j 本地**(248 条 `:Rule` 节点 in `NEO4J_INSTANCE_URI`,通过 [scripts/migrate-rules-v0-1-002.ts](../scripts/migrate-rules-v0-1-002.ts) 灌入)。

### 5.5 错误处理

`runRuleCheck` 内部**永不抛错**,所有异常分支返回 `decision='FAIL'` + `audit.fail_reason`(in-band fail-safe):

| fail_reason | 触发条件 |
|---|---|
| `parse-error` | LLM 输出无法 parse,或 rule_results 长度不匹配 |
| `ontology-graph-unavailable` | Neo4j 拉 graph_context 失败(401/连接) |
| `llm-call-error` | chatComplete 抛错(gateway 不通) |
| `tool-use-loop-exceeded` | LLM 工具调用超过 maxIterations=5 |

ruleCheckAgent 拿到 `FAIL + fail_reason` 后,仍然 emit `RULE_CHECK_FAILED`(decision='FAIL',audit.fail_reason 透传),不抛异常给 Inngest。matchResumeAgent 不会接到 PASSED,链路终止。

### 5.6 RULE_CHECK_BYPASS(PR-5 可选)

`RULE_CHECK_BYPASS=true` 时,`matchResumeAgent` 1st segment 直接 emit `MATCH_RULE_CHECK_PASSED`(`audit.fail_reason='bypassed'`),**完全跳过 ruleCheckAgent**。链路直接进入 2nd segment。

用途:本地 dev 想跳过 LLM 调用快速验证 RoboHire match + RAAS 持久化路径;或 LLM gateway 故障时临时绕过。生产默认关闭。

---

## 6. 外部依赖清单 — 谁调谁

### 6.1 RoboHire(`api.robohire.io`)— 直连

通过 [lib/robohire-client.ts](../lib/robohire-client.ts) 调用。

| Path | Method | Caller | 入参 | 出参 |
|---|---|---|---|---|
| `/api/v1/parse-resume` | POST (multipart) | `resumeParserAgent` | `file=<pdf Blob>` | `{ success, data: RobohireParseResumeData, cached, requestId, savedAs }` |
| `/api/v1/match-resume` | POST (json) | `matchResumeAgent` 2nd seg | `{ resume, jd, candidatePreferences?, jobMetadata? }` | `{ success, data: RobohireMatchResumeData, requestId, savedAs }` |

**错误码 → `RobohireApiError.code`**:
- 4xx (除 429) → `CLIENT`(`isClientError=true` → caller NonRetriable)
- 402 → `QUOTA_EXHAUSTED`(单独 audit/告警)
- 429 → `RATE_LIMITED`(可重试)
- 5xx / 网络 → `SERVER` / `NETWORK`(可重试)

### 6.2 RAAS API Server(`192.168.1.105:3001`)— RAAS Postgres 持久化 + RAAS-internal 读

通过 [lib/raas-api-client.ts](../lib/raas-api-client.ts) 调用。

| Path | Method | Caller | 用途 |
|---|---|---|---|
| `/api/v1/resumes/uploads/:upload_id/raw` | GET | `resumeParserAgent` | 拉原始 PDF(RAAS MinIO 存储) |
| `/api/v1/requirements/:id` | GET | `createJdAgent` + `matchResumeAgent`(1st seg, 单 JR 路径) | 拉单条 JR 详情 |
| `/api/v1/requirements/agent-view` | GET | `matchResumeAgent`(1st seg, 多 JR 路径) | 拉招聘人员名下 recruiting JR 列表 |
| `/api/v1/candidates` | POST | `resumeParserAgent` | **写 Postgres**:Candidate + Resume(dual-write 契约) |
| `/api/v1/jd/sync-generated` | POST | `createJdAgent` | **写 Postgres**:JobPosting + JR 状态推进 |
| `/api/v1/match-results` | POST | `matchResumeAgent` 2nd seg | **写 Postgres**:CandidateMatchResult |
| `/api/v1/generate-jd` | POST | `createJdAgent` | RoboHire 透传(未切直连) |
| ~~`/api/v1/parse-resume`~~ | ~~POST~~ | ~~`resumeParserAgent`~~ | **已废弃**:切换为 RoboHire 直连 |
| ~~`/api/v1/match-resume`~~ | ~~POST~~ | ~~`matchResumeAgent`~~ | **已废弃**:切换为 RoboHire 直连 |

**关键原则**:RAAS API Server 上**写 Postgres** 的端点必须保留(`/candidates / /match-results / /jd/sync-generated` — partner HSM 前端读这些数据)。仅 RoboHire 的 transparent proxy 端点(`/parse-resume / /match-resume`)可以切直连。

### 6.3 Ontology API(`localhost:3500`)— 拉规则元数据

通过 [lib/ontology-gen/fetch.ts](../lib/ontology-gen/fetch.ts) 调用。

| Path | Method | Caller | 用途 |
|---|---|---|---|
| `/api/v1/ontology/actions/matchResume/rules?domain=RAAS-v1` | GET | `ruleCheckAgent` → `runRuleCheck` → `fetchRulesForMatchResume` | 拉 Action + 248 条 rule + step 分组 |

未配 / 失败 → fallback 到本地 `lib/rule-check/rules.json`。**fallback 模式没有 step grouping**(`ontology-source.ts` 限制),需要 Allmeta Studio 注册 `matchResume` action 才能跑完整 rule-check。

### 6.4 Local Neo4j(`bolt://localhost:7688`)— 业务实例图

直接通过 `neo4j-driver` 调用,见 [lib/rule-check/neo4j-instance-writer.ts](../lib/rule-check/neo4j-instance-writer.ts) + [lib/rule-check/graph-context.ts](../lib/rule-check/graph-context.ts)。

| 节点 / 关系 | 写入方 | 读取方 |
|---|---|---|
| `:Candidate` / `:Resume` / `:JobRequisition` 实例锚节点 | `matchResumeAgent` 2nd seg (writeInstanceAnchorsOnly) | `ruleCheckAgent` → buildGraphContext |
| `(:Candidate)-[:HAS_RESUME]->(:Resume)` | 同上 | 同上 |
| `(:Candidate)-[:EVALUATED_FOR]->(:JobRequisition)` | 同上 | 同上 |
| `:Match_Result` 节点 | `matchResumeAgent` 2nd seg (neo4j-match-result-writer) | UI / 监控 |
| `:Rule` 元数据(248) | scripts/migrate-rules-v0-1-002.ts(一次性) | `ruleCheckAgent`(可选,目前走 JSON+API) |

### 6.5 LLM Gateway(`10.100.0.70:3010` partner 内网)

通过 [server/llm/gateway.ts](../server/llm/gateway.ts) 调用,OpenAI 协议。

只有 `ruleCheckAgent → runRuleCheck → chatComplete` 用。env:`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`(默认 `google/gemini-3-flash-preview`)。

---

## 7. 端到端事件链(happy path · 当前实现)

```
1)  HR 在 RAAS Dashboard 提交需求
       └─ RAAS publish REQUIREMENT_LOGGED  (entity_type=JobRequisition, entity_id=JR_xxx)
                ↓ (raas-bridge poll → em.publish → AO Inngest send)

2)  createJdAgent  (AO-main :3002, workflow #4)
       ├─ RAAS  GET  /api/v1/requirements/:id           (拉详情 + spec)
       ├─ RAAS  POST /api/v1/generate-jd                (RAAS 代理 RoboHire 生成 JD)
       ├─ RAAS  POST /api/v1/jd/sync-generated          (写 RAAS Postgres + 推 spec.status)
       └─ step.sendEvent JD_GENERATED                    (cascade)

3)  RAAS 自家流程: JobPosting 发布到 BOSS / 智联 / ……
       └─ HR 收到候选简历 → RAAS Web Console 上传 PDF → RAAS MinIO
       └─ RAAS publish RESUME_DOWNLOADED  (entity_id=upload_id)
                ↓ (raas-bridge → em.publish → AO Inngest)

4)  resumeParserAgent  (workflow #9)
       ├─ RAAS     GET  /api/v1/resumes/uploads/:upload_id/raw   (拉 PDF 字节)
       ├─ ⭐ RoboHire POST /api/v1/parse-resume  (DIRECT,不走 RAAS proxy)
       ├─ RAAS     POST /api/v1/candidates                       (写 Postgres)
       └─ step.sendEvent RESUME_PROCESSED                         (cascade)

5)  matchResumeAgent (1st segment)  (workflow #10)
       ├─ RAAS GET /api/v1/requirements/agent-view (or /:id)
       └─ for each requirement:
             step.sendEvent RULE_CHECK_REQUESTED
                  { upload_id, candidate_id, job_requisition_id,
                    job_requisition: <full JR>,
                    parsed_resume: <parsed data>,
                    runtime_context, ... }

6)  ruleCheckAgent  (workflow #10.5) ★ NEW
       ├─ runRuleCheck(input):
       │    ├─ Ontology API: 拉 matchResume action + step 分组 + 248 rules
       │    ├─ applyClientFilter: 按 client_id / business_group 过滤
       │    ├─ Local Neo4j: 拉 candidate/resume/jr/applications/blacklist/employment 6-slot
       │    ├─ composeMatchResumePrompt + chatComplete(LLM):
       │    │     Gemini-3-flash-preview(或其他 AI_MODEL)逐 rule 评估
       │    └─ foldDecision: fail > pending > else
       │
       ├─ if decision === 'PASS':
       │     step.sendEvent MATCH_RULE_CHECK_PASSED
       │        { ...原 payload + audit, job_requisition, parsed_resume }
       │
       └─ if decision === 'FAIL' / 'REVIEW':
             step.sendEvent RULE_CHECK_FAILED
                { decision, failed_rules: [{rule_id, rule_name, status, reason}], audit }
             # 终态,链路终止

7)  matchResumeAgent (2nd segment)  (订阅 MATCH_RULE_CHECK_PASSED)
       ├─ buildResumeTextFromParsed + flattenRequirementForMatch
       ├─ ⭐ RoboHire POST /api/v1/match-resume  (DIRECT)
       ├─ RAAS     POST /api/v1/match-results   (写 Postgres, source='need_interview')
       └─ step.sendEvent MATCH_PASSED_NEED_INTERVIEW   (1 条/JD)

8)  RAAS 收到 MATCH_PASSED_NEED_INTERVIEW
       └─ 用 upload_id → resume_upload → candidate_id → 写 candidate_match_result_runtime_state
```

**事件计数**(假设候选人上传 + 招聘人员名下有 N 条可匹配 JR):

| 事件 | 数量 |
|---|---|
| `RESUME_DOWNLOADED` | 1 |
| `RESUME_PROCESSED` | 1 |
| `RULE_CHECK_REQUESTED` | N(每条 JR) |
| `MATCH_RULE_CHECK_PASSED` | M(M ≤ N,PASS 的 JR) |
| `RULE_CHECK_FAILED` | N - M |
| `MATCH_PASSED_NEED_INTERVIEW` | M(每条 PASS 的 JR) |

---

## 8. 事件路由:AO ↔ RAAS Inngest 桥接

### 8.1 RAAS → AO(pull):[server/inngest/raas-bridge.ts](../server/inngest/raas-bridge.ts)

- 启用条件:`RAAS_BRIDGE_ENABLED=1`(默认关闭)。
- 周期 poll `${RAAS_INNGEST_URL}/v1/events?limit=20`(默认 5s),过滤 `RAAS_BRIDGE_EVENTS`(默认 `RESUME_DOWNLOADED`)。
- 命中后调 `em.publish(name, data, { source: 'raas-bridge', externalEventId: shared.id })`,让 AO 走 schema validate → dedup → Inngest send。
- `externalEventId = shared.id` 同时作为 `inngest.send().id`,所以 RAAS 重发同一个 id 在两层都被去重。

### 8.2 AO → RAAS(push):[server/inngest/raas-forward.ts](../server/inngest/raas-forward.ts)

- 启用条件:`RAAS_FORWARD_ENABLED=1` + `RAAS_INNGEST_URL` 已配置。
- `POST ${RAAS_INNGEST_URL}/e/${INNGEST_EVENT_KEY}`,timeout 15s。
- 用于补救 `step.sendEvent()` 只写本地 Inngest 的局限 — `JD_GENERATED` / `RESUME_PROCESSED` / `MATCH_*` 等 customer-facing 事件需要推到 partner bus 让 RAAS 订阅。
- 当前 4 个 agent **没有显式调 `forwardToRaas`** — 依赖 partner 端从 AO 拉取或 partner Inngest 订阅本地总线。

### 8.3 EM 网关:[server/em/publish.ts](../server/em/publish.ts)

`em.publish` 是 AO 的 publish 入口(raas-bridge 必走;agent 直 `step.sendEvent` 不经过它)。流程:degraded 自检 → filter → schema validate → dedup → persist → inngest.send → 失败 emit `EVENT_REJECTED`。

### 8.4 内置 schema:[server/em/schemas/builtin.ts](../server/em/schemas/builtin.ts)

zod v1.0 兜底 8+ 个核心事件。新增的 `RULE_CHECK_REQUESTED` / `MATCH_RULE_CHECK_PASSED` / `RULE_CHECK_FAILED` 还未注册到 builtin schemas — agent 间 emit 走 `step.sendEvent`(不过 em.publish),所以 schema validation 不阻断。若要把这 3 个事件加进 RAAS bus(让 RAAS 也能看),需要在 builtin.ts 加 schema。

---

## 9. 环境变量速查

### 9.1 RoboHire 直连(PR-2 新增)

| Env | 作用 | 默认 |
|---|---|---|
| `ROBOHIRE_API_BASE_URL` | `https://api.robohire.io` | 必填 |
| `ROBOHIRE_API_KEY` | `rh_*` API key,`write` scope | 必填 |
| `ROBOHIRE_TIMEOUT_MS` | HTTP timeout(per RoboHire 文档建议) | `120000` |

### 9.2 RAAS API Server

| Env | 作用 | 默认 |
|---|---|---|
| `RAAS_API_BASE_URL` | RAAS API Server URL | 必填 |
| `AGENT_API_KEY` | Bearer token | 必填 |
| `RAAS_DEFAULT_EMPLOYEE_ID` | matchResume 兜底 | 可选 |

### 9.3 Inngest

| Env | 作用 | 默认 |
|---|---|---|
| `INNGEST_DEV` / `INNGEST_BASE_URL` | 本地 / 共享 dev server URL | `1`(local) |
| `INNGEST_EVENT_KEY` | partner forward 的 event key | `dev` |

### 9.4 Rule check / Ontology / Neo4j / LLM

| Env | 作用 | 默认 |
|---|---|---|
| `ONTOLOGY_API_BASE` | `http://localhost:3500` | — |
| `ONTOLOGY_API_TOKEN` | Allmeta Studio dev token | — |
| `ONTOLOGY_API_DOMAIN` | `RAAS-v1` | — |
| `NEO4J_INSTANCE_URI` | 本地 Neo4j Bolt | `bolt://localhost:7688` |
| `NEO4J_INSTANCE_USER` / `_PASSWORD` / `_DATABASE` | 同上 | — |
| `RAAS_LINKS_NEO4J_URI` | partner Neo4j(只读 fallback) | `neo4j://10.100.0.70:7687` |
| `AI_BASE_URL` | LLM gateway(OpenAI 协议) | — |
| `AI_API_KEY` | LLM gateway token | — |
| `AI_MODEL` | 默认模型 | `google/gemini-3-flash-preview` |
| `RULE_CHECK_BYPASS` | `true` 跳过 ruleCheckAgent(PR-5) | 关 |

### 9.5 AO ↔ RAAS bridge

| Env | 作用 | 默认 |
|---|---|---|
| `RAAS_BRIDGE_ENABLED` | 启用 RAAS → AO 反向 poll | 关 |
| `RAAS_INNGEST_URL` | 共享 bus URL | `http://10.100.0.70:8288` |
| `RAAS_FORWARD_ENABLED` | 启用 AO → RAAS push | 关 |
| `EM_STRICT_SCHEMA` | 未注册事件 reject | `false` |

---

## 10. Function 注册

[server/inngest/functions.ts](../server/inngest/functions.ts):

```ts
const realFunctions = [
  resumeParserAgent,     // workflow #9
  createJdAgent,         // workflow #4
  matchResumeAgent,      // workflow #10 (dual-trigger)
  ruleCheckAgent,        // workflow #10.5 ★ NEW
];

// 加上(可选)stub agents(STUB_AGENTS=1)和 behavior agents(BEHAVIOR_AGENTS=1)
export const allFunctions = [...realFunctions, ...stubFunctions, ...behaviorFunctions];
```

serve handler 在 [app/api/inngest/route.ts](../app/api/inngest/route.ts)。AO-main 启动时由 docker-compose.inngest.yml 配置的 Inngest dev server 主动 PUT register 到 `:3002/api/inngest`,见 `docker-compose.inngest.yml:33`(`-u http://host.docker.internal:3002/api/inngest`)。

---

## 11. 关键参考代码索引

| 关注点 | 文件 |
|---|---|
| Inngest client + event TS types | [server/inngest/client.ts](../server/inngest/client.ts) |
| Function 注册(4 个 real + stub + behavior) | [server/inngest/functions.ts](../server/inngest/functions.ts) |
| serve handler | [app/api/inngest/route.ts](../app/api/inngest/route.ts) |
| Function ① createJdAgent | [server/inngest/agents/create-jd-agent.ts](../server/inngest/agents/create-jd-agent.ts) |
| Function ② resumeParserAgent | [server/inngest/agents/resume-parser-agent.ts](../server/inngest/agents/resume-parser-agent.ts) |
| Function ③ matchResumeAgent(双触发) | [server/inngest/agents/match-resume-agent.ts](../server/inngest/agents/match-resume-agent.ts) |
| Function ④ ruleCheckAgent ★ | [server/inngest/agents/rule-check-agent.ts](../server/inngest/agents/rule-check-agent.ts) |
| Rule check 核心 | [lib/rule-check/runner.ts](../lib/rule-check/runner.ts) |
| Rule data + ontology | [lib/rule-check/rules.json](../lib/rule-check/rules.json) · [lib/rule-check/ontology.ts](../lib/rule-check/ontology.ts) |
| Migration script | [scripts/migrate-rules-v0-1-002.ts](../scripts/migrate-rules-v0-1-002.ts) |
| RoboHire 直连 client ★ | [lib/robohire-client.ts](../lib/robohire-client.ts) |
| RAAS API client | [lib/raas-api-client.ts](../lib/raas-api-client.ts) |
| Ontology API client | [lib/ontology-gen/fetch.ts](../lib/ontology-gen/fetch.ts) |
| Neo4j instance writer | [lib/rule-check/neo4j-instance-writer.ts](../lib/rule-check/neo4j-instance-writer.ts) |
| LLM gateway | [server/llm/gateway.ts](../server/llm/gateway.ts) |
| em.publish 网关 | [server/em/publish.ts](../server/em/publish.ts) |
| RAAS → AO bridge | [server/inngest/raas-bridge.ts](../server/inngest/raas-bridge.ts) |
| AO → RAAS forward | [server/inngest/raas-forward.ts](../server/inngest/raas-forward.ts) |
| 内置 zod schemas | [server/em/schemas/builtin.ts](../server/em/schemas/builtin.ts) |
| Smoke 脚本 — RoboHire | [scripts/smoke-test-robohire.ts](../scripts/smoke-test-robohire.ts) |
| Smoke 脚本 — rule check 单独触发 | [scripts/test-rule-check-only.ts](../scripts/test-rule-check-only.ts) |
| Spec(本架构设计) | [docs/superpowers/specs/2026-05-19-rule-check-independent-agent-design.md](superpowers/specs/2026-05-19-rule-check-independent-agent-design.md) |
| 实施 Plan | [docs/superpowers/plans/2026-05-19-rule-check-independent-agent.md](superpowers/plans/2026-05-19-rule-check-independent-agent.md) |
| 历史相关 docs | [docs/raas-event-flow-upload-id-correlation.md](raas-event-flow-upload-id-correlation.md) · [docs/RULE_CHECK_DESIGN_DOC_chenyang.md](RULE_CHECK_DESIGN_DOC_chenyang.md) |

---

## 12. 与上一版差异摘要(v0.1.x → workflow-b@2026-05-19)

| 维度 | 旧 | 新 |
|---|---|---|
| Agent 数量 | 3 | **4**(新增 ruleCheckAgent) |
| Agent runtime 位置 | `resume-parser-agent/:3020` 子项目 | **AO-main :3002**(p4 合并已完成) |
| matchResumeAgent 触发器 | 单触发(`RESUME_PROCESSED`) | **双触发**(`RESUME_PROCESSED` + `MATCH_RULE_CHECK_PASSED`) |
| Rule check 位置 | 内嵌在 matchResumeAgent step 4.0(env gate `RULE_CHECK_ENABLED`) | **独立 ruleCheckAgent**(env gate 改 `RULE_CHECK_BYPASS=true` 反语义) |
| parse-resume | RAAS API Server 透传 RoboHire | **AO 直连 `api.robohire.io`** |
| match-resume | RAAS API Server 透传 RoboHire | **AO 直连 `api.robohire.io`** |
| Rule data version | v0.1 | **v0.1.002**(+ `enforcementLevel` + `failurePolicy` 两字段) |
| Severity 推断 | `inferSeverity()` 33 关键词启发式 | **直接读 `enforcementLevel + failurePolicy`**;legacy `severity` 派生兜底 |
| foldDecision `insufficient_info` | `→ REVIEW`(阻断 match) | **`→ PASS`**(数据缺失不阻断;只有真实 `fail` 阻断) |
| POST /candidates | 保留 | 保留(partner dual-write 契约) |
| POST /match-results | 保留 | 保留(同上) |
| POST /jd/sync-generated | 保留 | 保留(同上) |
| POST /generate-jd | 走 RAAS 代理 | 仍走 RAAS 代理(Phase 2 切直连) |
