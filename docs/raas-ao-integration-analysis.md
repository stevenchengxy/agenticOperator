# RAAS v4 ↔ Agentic Operator 完整对接分析

> 拉取版本:raas_v4 main @ `393efab`(2026-05-12 拉)
> AO 版本:Steven @ HEAD
> 目的:把 RAAS 平台业务逻辑摸清楚,标出 AO 对接点和 gap

---

## 0. 实际链路全景图(从两个仓库交叉读出来)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  USER (HSM / 招聘专员) 在 raas web console 点"上传简历"                       │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ raas_v4 backend (apps/api, port 3001)                                       │
│ POST /api/v1/candidates/upload-resume                                       │
│ - candidatesMain.hono.ts                                                    │
│   1. 写 MinIO bucket=recruit-resume-raw (PDF 字节)                          │
│   2. 写 Postgres ResumeUploadRuntime (upload_id 为 anchor)                  │
│   3. outboxService.enqueueInternalCommand({                                 │
│        topic: "raas.events",                                                │
│        eventName: "RESUME_DOWNLOADED",                                      │
│        entityType: "Candidate",                                             │
│        payload: { upload_id, bucket, object_key, filename, etag, size,     │
│                   hr_folder, employee_id, operator, ip_address, ... }       │
│      })                                                                     │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ raas_v4 worker (apps/worker)                                                │
│ OutboxDispatcher → InngestEventPublisher.publish()                          │
│ Inngest event (envelope shape):                                             │
│   name: "RESUME_DOWNLOADED"                                                 │
│   data: {                                                                   │
│     entity_type: "Candidate",                                               │
│     entity_id: null,                                                        │
│     source_action: null,                                                    │
│     event_id: "<uuid>",                                                     │
│     payload: { ... },                                                       │
│     trace: { trace_id, request_id, workflow_id, parent_trace_id }           │
│   }                                                                         │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Inngest dev/cloud (10.100.0.70:/opt/inngest-shared, :8288 内网)              │
│ Fan-out 给所有订阅 RESUME_DOWNLOADED 的 SDK                                  │
└────────┬────────────────────────────────────────────────────────┬──────────┘
         │                                                         │
         ▼                                                         ▼
┌─────────────────────────┐                       ┌────────────────────────────┐
│ AO resumeParserAgent     │ (订阅 RESUME_DOWNLOADED)│ raas backend 内自己也订阅(❓)│
│ (server/inngest/agents/) │                       │  目前没看到 raas 自己处理      │
│                          │                       │  RESUME_DOWNLOADED 的 fn,    │
│ 1. unwrapEnvelope:tolerate│                      │  外部 agent (AO) 是唯一        │
│   { data: {payload, ...} }│                      │  consumer。                  │
│   或 flat                 │                       └────────────────────────────┘
│ 2. GET /api/v1/resumes/   │
│    uploads/:id/raw         │
│    (从 raas 拉 PDF 字节)   │
│ 3. POST /api/v1/parse-    │
│    resume (raas 透传 RH)   │
│ 4. POST /api/v1/candidates│
│    (raas DB:Candidate +   │
│    Resume + Application)  │
│ 5. emit RESUME_PROCESSED   │
└─────────┬────────────────┘
          ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Inngest "RESUME_PROCESSED"  ← AO emit                                        │
└────────┬──────────────────────────────────────────────────────┬────────────┘
         │                                                       │
         ▼                                                       ▼
┌──────────────────────────────────┐         ┌──────────────────────────────────┐
│ raas backend 订阅 (function 1)    │         │ AO matchResumeAgent 订阅           │
│ resume-processed.function.ts      │         │ (server/inngest/agents/)          │
│ - resumePipelineService.process() │         │                                   │
│   写 Candidate / Resume / Expect  │         │ 1. list-requirements              │
│   to Postgres (dedup via 4-key)   │         │    (单 jr_id 或 claimer agent-view)│
│ - emit ontology RESUME_PROCESSED  │         │ 2. [optional] rule-check gate     │
│   outbox 事件(给 audit 用)        │         │    - 调 LLM,binary PASS/FAIL      │
│ - 写 audit log "解析完成"         │         │    - emit RULE_CHECK_PASSED/FAILED│
│                                   │         │    - 写 Neo4j RuleCheckAudit/Flag │
│ raas backend 订阅 (function 2)    │         │ 3. POST /api/v1/match-resume      │
│ job-matching.function.ts          │         │    (raas → Robohire 透传打分)     │
│ - matchResumeToRequirements()     │         │ 4. POST /api/v1/match-results     │
│ - emit MATCH_* events             │         │ 5. emit MATCH_PASSED_NEED_INTERVIEW│
└─────────┬────────────────────────┘         └─────────┬────────────────────────┘
          │                                            │
          │      (两条路径都可能产出 MATCH_* 事件 — 见 §4 Gap)
          ▼                                            ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Inngest "MATCH_PASSED_NEED_INTERVIEW" / "MATCH_PASSED_NO_INTERVIEW"          │
└────────┬───────────────────────────────────────────────────────────────────┘
         ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ raas backend 订阅 (match-result-ingest.function.ts)                          │
│ - 把外部 match 结果 upsert 到 candidate_match_result_runtime_state           │
│ - MatchPool UI 读这个表展示                                                  │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. RAAS 平台业务模块清单(`backend/apps/api/src/modules/`)

| 模块 | 角色 |
|---|---|
| `candidates` | 简历上传入口(hono route) + Candidate / Resume / Application Postgres 写入 |
| `resume-ingest` | 上传公共 helper:operator block / event payload shape / deterministic resume_id |
| `inngest/functions/resume-processed.function.ts` | **RESUME_PROCESSED** 消费者 — 写 Postgres + audit log |
| `inngest/functions/job-matching.function.ts` | **RESUME_PROCESSED** 也订阅,但走 raas 内部 job matching |
| `inngest/functions/match-result-ingest.function.ts` | **MATCH_PASSED_NEED_INTERVIEW** / **NO_INTERVIEW** 消费者 — 落 candidate_match_result |
| `inngest/functions/jd-distribution.function.ts` | JD 分发 |
| `inngest/functions/jd-generated-sync.function.ts` | **JD_GENERATED** 消费者 |
| `inngest/functions/requirement-analysis.function.ts` | 需求分析 |
| `inngest/functions/hitl-task-creator.function.ts` | HITL 任务生成 |
| `inngest/functions/evaluation-report.function.ts` | 面试评估报告 |
| `inngest/functions/interview-invitation.function.ts` | 面试邀请 |
| `inngest/functions/notification-dispatcher.function.ts` | 通知派发 |
| `outbox` | 事件 outbox 模式实现 |
| `hitl` | Human-in-the-loop 任务系统 |
| `dashboard` / `observability` | 监控、event timeline、运行可见性 |

**关键洞察**:RAAS 自己有 `job-matching.function.ts` 也订阅 `RESUME_PROCESSED`,跟我们 AO `matchResumeAgent` **同时跑**。这是个潜在冲突点(见 §4)。

---

## 2. AO 这边的对接点

| AO 文件 | 对接 RAAS 哪个东西 |
|---|---|
| `server/inngest/agents/resume-parser-agent.ts` | 订阅 `RESUME_DOWNLOADED` (raas emit) |
| `server/inngest/agents/match-resume-agent.ts` | 订阅 `RESUME_PROCESSED` (自己或 raas emit) |
| `server/inngest/agents/create-jd-agent.ts` | 订阅 `REQUIREMENT_LOGGED` / `CLARIFICATION_READY` / `JD_REJECTED` (raas emit) |
| `lib/raas-api-client.ts` | 调用 raas API:`/parse-resume` / `/candidates` / `/match-resume` / `/match-results` / `/generate-jd` / `/jd/sync-generated` / `/requirements/:id` / `/requirements/agent-view` / `/resumes/uploads/:id/raw` |
| `server/inngest/raas-bridge.ts` | RAAS 内网 Inngest event 转发到 AO 本地 Inngest(单向 pull) |
| `server/inngest/raas-forward.ts` | 反向:AO 内 event 转发到 RAAS Inngest |
| `lib/rule-check/neo4j-instance-writer.ts` | (新加)写 `RuleCheckAudit` / `RuleCheckFlag` 进 Neo4j |
| `app/api/inngest/route.ts` | Inngest serve handler 端点 |

---

## 3. Event envelope shape — 务必对齐!

**raas 发的所有事件都走 outbox + envelope wrapper**(`apps/worker/.../inngest-event.publisher.ts`):

```ts
{
  name: "<EVENT_NAME>",
  data: {
    entity_type: string,        // "Candidate" / "JobRequisition" / ...
    entity_id: string | null,
    source_action: string | null,
    event_id: string,           // UUID, raas 端做幂等
    payload: { ... },           // 实际业务数据
    trace: {                    // 跨服务关联 ID
      trace_id: string | null,
      request_id: string | null,
      workflow_id: string | null,
      parent_trace_id: string | null
    }
  }
}
```

**AO 端的 unwrap 行为**:
- `resumeParserAgent` 有 `unwrapDownloadedEnvelope()` 兼容 envelope vs flat
- `matchResumeAgent` 有 `unwrapResumeProcessedEvent()` 同上
- `createJdAgent` 直接读 `event.data.payload`

✅ AO 兼容 raas envelope 是 OK 的。但有 2 个 gap:

### Gap A:AO 自己 emit 的事件没有 envelope wrapper

看 `matchResumeAgent` emit:
```ts
await step.sendEvent('emit-match-...', {
  name: 'MATCH_PASSED_NEED_INTERVIEW',
  data: payload,  // ← 这是 flat,没 envelope wrap
});
```

raas 端 `match-result-ingest.function.ts` 有 `resolveMatchPayload(raw)` 兼容三种 shape(A/B/C),所以暂时不挂,但 **trace_id 丢了**(envelope.trace 字段在 flat shape 里不存在)。

### Gap B:RAAS API 响应 envelope

raas API 返回 `{ data: {...}, requestId, _traceId }`,但 AO 这边 mock RAAS server 写的是 flat 响应。**这是我前面在 e2e test 里发现的 bug — 我的 mock RAAS server 让 saveCandidate 返回 flat,导致 `candidate_id` 落到 Neo4j 时是 null**。

修法:mock RAAS server 全部响应 wrap 成 `{ data: actual }`。

---

## 4. 关键 Gap 清单

### Gap 1:**`RESUME_PROCESSED` 双订阅潜在冲突**(P0)
- raas `job-matching.function.ts` 订阅 RESUME_PROCESSED → 跑 raas 内部 matching
- AO `matchResumeAgent` 订阅 RESUME_PROCESSED → 跑 Robohire 深度匹配
- 两个都 emit `MATCH_PASSED_NEED_INTERVIEW`!
- raas 端 `match-result-ingest.function.ts` 消费 MATCH_* — **不知道哪个是真正的"权威"打分**

**建议**:
- AO 这边 emit 的 MATCH_* 加 `source: "ao-agent"` 字段
- raas job-matching 输出加 `source: "raas-internal"` 字段
- raas match-result-ingest 用 source 做 dedup / 哪条覆盖哪条

或者更彻底:**raas 关掉自己的 job-matching.function.ts**,只让 AO 处理(因为 AO 调 Robohire,raas 内部应该没必要再独立 match)。

### Gap 2:**trace_id 在 AO emit 时丢失**(P1)
- raas 发 RESUME_DOWNLOADED 时 envelope.trace 有 trace_id
- AO resumeParserAgent 拿到 trace_id 传给 raas-api-client (X-Trace-Id header) ✓
- AO matchResumeAgent 拿到 traceId 也传给 raas-api-client ✓
- 但 AO emit RESUME_PROCESSED / MATCH_* / RULE_CHECK_* 时,**event.data 顶层没把 trace 传下去**

**建议**:AO 这边所有 emit 都包成 envelope:
```ts
await step.sendEvent('emit-rule-check-passed', {
  name: 'RULE_CHECK_PASSED',
  data: {
    entity_type: 'Candidate',
    entity_id: candidateId,
    event_id: randomUUID(),
    payload: passedPayload,
    trace: { trace_id: traceId, ... }  // ← 从上游 RESUME_PROCESSED 透传
  }
});
```

### Gap 3:**端到端日志可见性**(P1)
- raas 端日志在 raas-backend container 的 stdout
- AO 端日志在 AO Next.js process 的 stdout
- Inngest dev server 自己的日志在 docker container
- **没有任何工具能 by trace_id 把这 3 个地方的日志串起来**

**建议建一个**:
- AO 加 `lib/observability/trace-logger.ts`:每次 `logger.info(...)` 自动 append trace_id + 写本地 SQLite `agent_activity` 表
- 提供 API `/api/observability/trace/:trace_id` 返回所有日志
- AO 已经有 `server/agent-logger.ts` 雏形,扩成 cross-trace 即可

### Gap 4:**RAAS API 响应 envelope 不一致**(P1)
- raas API 返回 `{ data: {}, requestId, _traceId }`,但有些 endpoint 直接返回 flat
- AO `raas-api-client.ts` 大多数函数 `body.data` 取,少数直接 `body`
- 这导致 mock server 编写时不知道哪个 endpoint 要 wrap

**建议**:逐个 endpoint 跑一遍真实 raas backend,记下响应 shape,固化成 contract 文档

### Gap 5:**没有"模拟 raas 平台"的统一脚本**(P2)
- 当前 AO e2e mock 模拟的是 RAAS API HTTP 响应,但**没模拟 raas emit Inngest event 的链路**
- 真实生产链路:user 上传简历 → raas API 写 outbox → worker dispatch → Inngest → AO agent
- 我们 e2e 跳过了 outbox 这层

**建议**:写一个 `scripts/e2e-mock-test/raas-emitter.ts`,模拟 raas outbox publish:
```ts
await inngest.send({
  name: 'RESUME_DOWNLOADED',
  data: {
    entity_type: 'Candidate',
    entity_id: null,
    event_id: 'uuid',
    payload: { upload_id, bucket, object_key, filename, ... },
    trace: { trace_id: 'trace_e2e_xxx', request_id: '...' }
  }
});
```

然后 AO Inngest function 会自动接到。e2e test 端到端验证从 envelope 入站到 RULE_CHECK_* emit 出站的全链路。

### Gap 6:**AO 端不写 Postgres,但 raas 端写**(P3)
- AO matchResumeAgent 走 raas API,raas 写 Postgres
- AO 自己只写 Neo4j(rule check audit)
- 没问题,但**业务实体真相在 raas Postgres**,AO 端的 audit / event 都是补充审计
- 如果 raas Postgres 跟 AO Neo4j drift,需要约定 cross-reference 策略(目前 audit 用 candidate_id 做引用即可)

---

## 5. RAAS Postgres 关键表(给 AO 视角理解)

| 表 | 含义 | AO 读/写? |
|---|---|---|
| `Candidate` | 候选人主表 | AO 通过 POST /candidates 间接写 |
| `Resume` | 简历记录(blob 在 MinIO) | 同上 |
| `Application` | 候选人 × JD 投递记录 | AO POST /match-results 间接写 |
| `JobRequisition` | 客户原始招聘需求 | AO GET /requirements/:id 读 |
| `JobRequisitionSpecification` | JD 规约 | 同上 |
| `JobPosting` | 生成的 JD | AO 通过 syncJdGenerated 写 |
| `ResumeUploadRuntime` | 上传 session 跟踪 | AO 不动 |
| `CandidateMatchResult` | match 结果(Robohire 透传) | AO POST /match-results 间接写 |
| `CandidateMatchResultRuntimeState` | match 运行态 | raas 内部 |
| `HitlTask` | 人工任务 | raas 内部(可能未来订阅 RULE_CHECK_FAILED 来 spawn) |
| `AuditLog` | 操作审计 | raas 内部 |

**约定**:
- AO 不直连 RAAS Postgres
- AO 不操心 raas 表 schema 演进
- 所有 raas-side 业务真相 → raas API 走 HTTP

---

## 6. 行动建议(按优先级)

| # | 行动 | 优先级 | 工期 | 依赖 |
|---|---|---|---|---|
| 1 | 修 mock RAAS server response wrap(`{data:...}` envelope)| P0 | 30 min | 仅本仓 |
| 2 | AO emit RESUME_PROCESSED / RULE_CHECK_* / MATCH_* 时也包 envelope + 透传 trace | P1 | 1 小时 | 仅本仓 |
| 3 | 写 e2e mock raas event emitter — 用 envelope shape 发 RESUME_DOWNLOADED | P1 | 30 min | 仅本仓 |
| 4 | 跟 raas 团队确认 `RESUME_PROCESSED` 双订阅 — 关掉 raas 自己的 job-matching 或两边都加 source 字段 | P0 | 半天 | 需要 raas 团队配合 |
| 5 | 建端到端 trace 日志可见性(SQLite agent_activity + API) | P1 | 2 小时 | 仅本仓 |
| 6 | 写 RAAS API response shape contract 文档(逐个 endpoint) | P2 | 1 小时 | 需要跑一次真实 raas backend 拿响应 |

---

## 7. 文件索引

| 路径 | 用途 |
|---|---|
| `raas_v4/backend/apps/api/src/modules/candidates/candidates-main.hono.ts` | RAAS 端简历上传入口 |
| `raas_v4/backend/apps/api/src/modules/inngest/functions/resume-processed.function.ts` | RAAS 端 RESUME_PROCESSED 消费 |
| `raas_v4/backend/apps/api/src/modules/inngest/functions/job-matching.function.ts` | RAAS 端 RESUME_PROCESSED 消费(冲突点) |
| `raas_v4/backend/apps/api/src/modules/inngest/functions/match-result-ingest.function.ts` | RAAS 端 MATCH_* 消费 |
| `raas_v4/backend/apps/worker/src/modules/events/inngest-event.publisher.ts` | RAAS 端 outbox → Inngest publisher (envelope 构造点) |
| `raas_v4/backend/packages/events/src/names.ts` | RAAS 端事件名 freeze |
| `raas_v4/backend/apps/api/src/modules/resume-ingest/resume-ingest-helpers.ts` | RAAS 端 payload shape 定义 |
| `server/inngest/agents/resume-parser-agent.ts` | AO 端 RESUME_DOWNLOADED 消费 + emit RESUME_PROCESSED |
| `server/inngest/agents/match-resume-agent.ts` | AO 端 RESUME_PROCESSED 消费 + emit MATCH_* + RULE_CHECK_* |
| `lib/raas-api-client.ts` | AO 调 RAAS API HTTP client |
| `docs/raas-partner-rule-check-integration.md` | 给 raas 团队的 RULE_CHECK_* 对接文档 |
| `docs/workflow-event-chain.md` | AO 端事件链总图(本文是 raas 视角补充) |

---

## 8. 关键决策点(给用户)

请决定:
- **(a)** Gap 1 — RESUME_PROCESSED 双订阅是 keep both / drop raas / drop AO?(影响哪边是 match 权威)
- **(b)** Gap 2 + 3 trace_id + envelope — 我现在就改 AO 代码做正确包装?(production 影响,不能纯 mock 跑)
- **(c)** Gap 5 raas event emitter mock — 加进 e2e test?(纯本仓改动)
- **(d)** Gap 4 raas API response shape — 让我跑一次真实 raas backend 拿响应?(需要 raas backend 在本机起得来)

我建议先把 **(a)** 跟 raas 团队对一句,同时我把 **(c)** + 我已发现的 mock server `data` wrapper bug 一并修了。**(b)** 影响 production 代码,要你点头才动。
