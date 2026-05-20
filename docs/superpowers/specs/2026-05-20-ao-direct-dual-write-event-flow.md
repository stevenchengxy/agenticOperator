# AO Direct Dual-Write — 4 Agent Event Flow

**日期**: 2026-05-20
**状态**: 待执行(配套 plan: `docs/superpowers/plans/2026-05-20-ao-direct-dual-write.md`)
**决策依据**: 2026-05-20 与 partner(zyj)的口头共识 —— AO 完全脱钩 RAAS HTTP API,直写 partner Postgres + Neo4j;partner 通过订阅 AO Inngest 事件来补 side effect

## 0. 顶层架构

- **唯一事件总线**: AO 本机的 Inngest dev server (`:8288`) ,partner 连过来
- **没有 RAAS API 中间层**: AO 直接读写 partner Postgres (`192.168.1.103:5432/raas_db`)
- **Neo4j 写入**: 通过 allmeta ontology API,沿用现有 rule-check 的模式
- **partner side effect**(HitlTask / 通知 / auto-invitation dispatcher): 由 partner 订阅 AO 的 Inngest 事件来触发,**AO 不替代**

## 1. 总览:事件流主图

```
                    ┌────────────────────────────────────────────────┐
                    │  Partner RAAS Frontend / Worker                 │
                    │  (recruiter 录入需求 / Nextcloud 简历同步)         │
                    └──────────┬─────────────────────────────────────┘
                               │ emit
                               ▼
        ┌───────────────────────────────────────────────────┐
        │ AO Inngest dev server  (本机 :8288 · 唯一总线)        │
        │                                                    │
        │  从 partner 来的:                                    │
        │    REQUIREMENT_LOGGED                              │
        │    RESUME_DOWNLOADED                               │
        │                                                    │
        │  AO 自己 cascade 的:                                 │
        │    RESUME_PROCESSED   (thin)                       │
        │    MATCH_RULE_CHECK_PASSED / FAILED                │
        │    JD_GENERATED                                    │
        │    MATCH_PASSED_NEED_INTERVIEW                     │
        │    MATCH_PASSED_NO_INTERVIEW                       │
        │    MATCH_FAILED                                    │
        └─┬─────────────────────────────────────────────┬───┘
          │ subscribe                                    │ subscribe
          ▼                                              ▼
  ┌─────────────────────┐                       ┌──────────────────────────┐
  │   AO 4 个 agent      │                       │ Partner 后端订阅者         │
  │                     │                       │                          │
  │ createJdAgent       │                       │ • JD_GENERATED           │
  │ resumeParserAgent   │      产生              │     → 建 jd_review        │
  │ ruleCheckAgent      │ ──事件──>              │       HitlTask            │
  │ matchResumeAgent    │                       │     → HSM in-app 通知     │
  └──────────┬──────────┘                       │                          │
             │                                  │ • RESUME_PROCESSED        │
             │ Direct read/write                │     → candidate runtime   │
             ▼                                  │       state update        │
  ┌──────────────────────────┐                  │                          │
  │ Partner Postgres         │                  │ • MATCH_PASSED_*          │
  │ 192.168.1.103:5432       │                  │ • MATCH_FAILED            │
  │  job_requisition         │                  │     → auto-invitation     │
  │  job_posting             │                  │       dispatcher          │
  │  candidate / resume      │                  └──────────────────────────┘
  │  application             │
  │  candidate_match_result  │
  └──────────────────────────┘
  ┌──────────────────────────┐
  │ Neo4j (via allmeta API)  │
  │ JobPosting / Candidate /  │
  │ Candidate_Match_Result    │
  │ ontology instances       │
  └──────────────────────────┘
```

每个事件**只在一个地方发起**,所有 agent + partner subscriber 都从 AO Inngest 拉。

---

## 2. Agent 1 · `createJdAgent` · JD 生成

### 2.1 触发事件

```jsonc
// partner → AO Inngest
{
  "name": "REQUIREMENT_LOGGED",
  "data": {
    "entity_type": "JobRequisition",
    "entity_id": "JR-...",                  // ← 主要标识
    "event_id": "evt-uuid",
    "payload": {
      "requirement_id": "JR-...",            // 兼容字段(可空)
      "client_id": "C-..."
      // 其他字段忽略 — 详细数据靠 entity_id 反查 Postgres
    },
    "trace": { "trace_id": "...", "request_id": "...", ... }
  }
}
```

### 2.2 内部步骤

| # | 动作 | 触点 | 失败处理 |
|---|---|---|---|
| 1 | 从 envelope 取 `entity_id` 作为 `job_requisition_id` | 纯内存 | 缺 → `NonRetriable` |
| 2 | **读 Partner Postgres**: `SELECT FROM job_requisition r LEFT JOIN job_requisition_specification s WHERE r.job_requisition_id = $1` | `partner-pg/requirements.ts::getRequirementDetail` | 返回 null → `NonRetriable`;连不上 → retry |
| 3 | 按 F4 表拼自由文本 prompt(40+ 字段,3 个日期语义校正) | agent 内部 buildPromptFromRequirement | prompt < 4 chars → `NonRetriable` |
| 4 | **调 RoboHire**: `POST https://api.robohire.io/api/v1/jobs/generate-jd` | `lib/robohire-client.ts::generateJdDirect` | 4xx → `NonRetriable`;5xx → retry |
| 5 | **写 Partner Postgres**(单 tx,3 个 SQL): <br/>① `UPDATE job_requisition` 回填 17 字段 <br/>② `INSERT INTO job_posting ... ON CONFLICT DO UPDATE`,`publish_status='pending'` <br/>③ `UPDATE job_requisition_specification SET status='pending_publish' WHERE status='draft'`(compare-and-set) | `partner-pg/job-posting.ts::syncJdToPartnerPg` | 任一 SQL 错 → ROLLBACK → retry |
| 6 | **写 Neo4j**: JobPosting instance via allmeta | `lib/allmeta-client.ts` | log-not-fail |
| 7 | **emit AO Inngest**: `JD_GENERATED` | `step.sendEvent` | 自动 retry |

### 2.3 出站事件

```jsonc
{
  "name": "JD_GENERATED",
  "data": {
    "entity_type": "JobDescription",
    "entity_id": "jd_<8char>_<base36>",
    "event_id": "uuid",
    "payload": {
      "job_requisition_id": "JR-...",
      "job_posting_id": "<from-pg>",         // ← partner 用这个查表
      "client_id": "C-...",
      "jd_id": "jd_...",
      "posting_title": "...",
      "posting_description": "...",
      "city": ["上海"],
      "salary_range": "30k-50k",
      "must_have_skills": [...],
      "search_keywords": [...],
      "quality_score": 0.85,
      // RoboHire data 整段 spread
      "generated_at": "2026-05-20T..."
    },
    "trace": { ...(透传) }
  }
}
```

### 2.4 Partner 订阅

| Partner subscriber | 应该做什么 |
|---|---|
| `inngest:JD_GENERATED → create-jd-review-task.fn` | 建 `hitl_task` row,`task_type='jd_review'`,routing 到 HSM |
| `inngest:JD_GENERATED → notify-hsm.fn` | 写 `notification_record`,severity='important',actionUrl=`/hsm/jd-review/<job_posting_id>` |

---

## 3. Agent 2 · `resumeParserAgent` · 简历解析

### 3.1 触发事件

```jsonc
{
  "name": "RESUME_DOWNLOADED",
  "data": {
    "upload_id": "upload-uuid",              // 必须
    "bucket": "recruit-resume-raw",          // MinIO bucket
    "object_key": "...",                     // MinIO key
    "filename": "【高级Java工程师】张三.pdf",   // 透传给 RESUME_PROCESSED (F2 用)
    "job_requisition_id": "JR-...|null",     // 路径 A 必带,路径 B 为 null
    "claimer_employee_id": "EMP-..."         // 路径 B 必带
  }
}
```

### 3.2 内部步骤

| # | 动作 | 触点 | 失败处理 |
|---|---|---|---|
| 1 | 校验 envelope: `upload_id` + `bucket` + `object_key` | 内存 | 缺 → `NonRetriable` |
| 2 | **MinIO 下载 PDF 字节** | `lib/minio-client.ts` | 5xx retry;404 `NonRetriable` |
| 3 | 计算 MD5 etag(去重锚点) | crypto | — |
| 4 | **调 RoboHire**: `POST /api/v1/resumes/parse-resume`(multipart) | `lib/robohire-client.ts::parseResumeDirect` | 4xx `NonRetriable`;5xx retry |
| 5 | **写 Partner Postgres**(单 tx): <br/>① `INSERT INTO candidate ... ON CONFLICT (phone, email) DO UPDATE`(去重) <br/>② `INSERT INTO resume (candidate_id, parsed_data, source_etag, ...) ON CONFLICT (candidate_id, source_etag) DO NOTHING` <br/>③ `INSERT INTO application (candidate_id, job_requisition_id, sourcing_channel_id, ...)` <br/>④ `INSERT INTO candidate_runtime_state (resume_parse_status='completed', ...)` | `partner-pg/candidates.ts::saveCandidateToPartnerPg` | 任一错 ROLLBACK → retry |
| 6 | **写 Neo4j**: Candidate instance + Resume instance | `lib/allmeta-client.ts` | log-not-fail |
| 7 | **emit AO Inngest**: `RESUME_PROCESSED`(thin — 不带 parsed body) | `step.sendEvent` | 自动 retry |

### 3.3 出站事件(thin shape per F1 doc)

```jsonc
{
  "name": "RESUME_PROCESSED",
  "data": {
    "candidate_id": "cand-...",
    "resume_id": "res-...",
    "upload_id": "upload-uuid",
    "employee_id": "EMP-...",                // = claimer,路径 B 用
    "filename": "【高级Java工程师】张三.pdf",   // F2 用(透传)
    "job_requisition_id": "JR-...|null",
    "parsed": {
      "data": null                            // thin event 留空
    }
  }
}
```

### 3.4 Partner 订阅

| Partner subscriber | 应该做什么 |
|---|---|
| `inngest:RESUME_PROCESSED → candidate-stage-tick.fn` | 更新 `candidate_runtime_state.pipeline_stage='parsed'`(如还需要) |

---

## 4. Agent 3 · `ruleCheckAgent` · 规则预筛 (LLM gate)

### 4.1 触发事件

`RESUME_PROCESSED`(上一步 AO 自己 emit 的;或 partner 直接发的 thin 事件)。**Payload shape 同上**。

### 4.2 内部步骤

| # | 动作 | 触点 | 路径 |
|---|---|---|---|
| 1 | 从 envelope 取 `candidate_id` / `resume_id` / `job_requisition_id` / `employee_id` / `filename` | 内存 | 公共 |
| 2 | **F1 thin 回拉**: `payload.parsed.data` 空 → `SELECT parsed_data FROM resume WHERE candidate_id=$1 AND resume_id=$2` | `partner-pg/parsed-resume.ts::getParsedResume` | 公共 |
| 3a | **路径 A**(`job_requisition_id` 非空): 跳到 5 | — | A |
| 3b | **路径 B**(空): **F2 路径 B** — 拉 claimer 在招岗位列表 + 文件名收敛 | `partner-pg/agent-view.ts::getRequirementsAgentView` | B |
| 4 | 对收敛后每个 JR(A=1,B=N) | 循环 | 公共 |
| 5 | **读 Partner Postgres**: `getRequirementDetail(jrId)` 拿规则字段 | `partner-pg/requirements.ts` | 公共 |
| 6 | **读 Ontology API**: rules / actions / events definitions | `lib/rule-check/ontology-source.ts` | 公共 |
| 7 | **跑 LLM gate**: Resume × Rules → PASS or FAIL + 理由 | `lib/rule-check/runner.ts` | 公共 |
| 8 | **写 Neo4j**: `Candidate_Match_Result` instance(已在 commit `bef8ae8` 实现,无变化) | `lib/rule-check/neo4j-match-result-writer.ts` | 公共 |
| 9 | **emit AO Inngest**: 每 JR 一个 `MATCH_RULE_CHECK_PASSED` 或 `MATCH_RULE_CHECK_FAILED` | `step.sendEvent` | 公共 |

### 4.3 出站事件

```jsonc
// PASS
{
  "name": "MATCH_RULE_CHECK_PASSED",
  "data": {
    "candidate_id": "cand-...",
    "resume_id": "res-...",
    "job_requisition_id": "JR-...",          // 已收敛到具体岗位
    "upload_id": "upload-...",
    "rule_check_summary": "...(LLM markdown)",
    "parsed_data_ref": { "candidate_id", "resume_id" }
  }
}

// FAIL
{
  "name": "MATCH_RULE_CHECK_FAILED",
  "data": {
    "candidate_id": "cand-...",
    "resume_id": "res-...",
    "job_requisition_id": "JR-...",
    "upload_id": "upload-...",
    "matching_score": null,
    "failure_reason": "...",
    "data": { ...(rule-check 输出) }
  }
}
```

### 4.4 Partner 订阅

| Partner subscriber | 应该做什么 |
|---|---|
| `inngest:MATCH_RULE_CHECK_FAILED` | 视 partner 业务,可能只 log,也可能更新候选人状态 |
| `MATCH_RULE_CHECK_PASSED` | partner 不需要,纯 AO 内部 cascade |

---

## 5. Agent 4 · `matchResumeAgent` · 精准匹配(打分)

### 5.1 触发事件

`MATCH_RULE_CHECK_PASSED`(AO Inngest cascade)。

### 5.2 内部步骤

| # | 动作 | 触点 | 失败处理 |
|---|---|---|---|
| 1 | 从 envelope 取 `candidate_id` / `resume_id` / `job_requisition_id` | 内存 | 公共 |
| 2 | **回拉 parsed body**(F1): `getParsedResume(candidate_id, resume_id)` | `partner-pg/parsed-resume.ts` | — |
| 3 | **读 JR 详情**: `getRequirementDetail(jrId)` | `partner-pg/requirements.ts` | — |
| 4 | (可选)将 ruleCheck `rule_check_summary` markdown 注入到 RoboHire resume 顶部 | 内存拼装 | — |
| 5 | **调 RoboHire**: `POST /api/v1/match-resume` → 分数 + reasoning | `lib/robohire-client.ts::matchResumeDirect` | 4xx `NonRetriable`;5xx retry |
| 6 | **写 Partner Postgres**: `INSERT INTO candidate_match_result + UPSERT runtime_state` | `partner-pg/match-results.ts::saveMatchResultsToPartnerPg` | tx retry |
| 7 | **写 Neo4j**: 更新 `Candidate_Match_Result` instance(刷分数 + reasoning) | `lib/rule-check/neo4j-match-result-writer.ts`(复用) | log-not-fail |
| 8 | **emit AO Inngest**: 根据分数 + 阈值 + 是否需要面试,emit 三选一: `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED` | `step.sendEvent` | 自动 retry |

### 5.3 出站事件 (F3 平铺契约 — 关键!)

```jsonc
// 三个事件名共享 payload shape
{
  "name": "MATCH_PASSED_NEED_INTERVIEW",       // 或 _NO_INTERVIEW / MATCH_FAILED
  "data": {
    // ── 顶层平铺(F3 强制 — partner dispatcher 直读)──
    "job_requisition_id": "JR-...",            // 必带 string
    "candidate_id": "cand-...",                // 必带 string | null
    "matching_score": 0.87,                    // 必带 number | null(不省略)
    "upload_id": "upload-...",                 // 必带 string | null(不用 "")
    "job_posting_id": "<from-pg>",             // 可选 string | null
    "success": true,                           // RoboHire envelope
    "data": { ...(RoboHire match data 原样) }, // 整段保留
    "requestId": "rh-req-...",
    "savedAs": null
  }
}
```

### 5.4 Partner 订阅(**最关键**)

| Partner subscriber | 应该做什么 |
|---|---|
| `inngest:MATCH_PASSED_NEED_INTERVIEW → auto-invitation-dispatcher.fn` | 读顶层 `candidate_id` / `job_requisition_id` / `matching_score`,创建 `auto_invitation_attempt`,发面试邀约 |
| `inngest:MATCH_PASSED_NO_INTERVIEW` | 推荐到客户邮箱 / candidate pool(视 partner 业务) |
| `inngest:MATCH_FAILED` | 通常只 log;也可能更新 `candidate.last_match_result` |

---

## 6. 端到端链式 demo: partner 上传 1 份简历

```
T+0s   partner 上传【高级Java工程师】张三.pdf 到 Nextcloud
T+0.1s partner 后端写 resume_upload runtime row + emit RESUME_DOWNLOADED to AO Inngest
        │
        ├── 触发 AO::resumeParserAgent
        │     ├ MinIO 下载 PDF (1s)
        │     ├ RoboHire parse-resume (3-30s)
        │     ├ partner Postgres tx 写 candidate + resume + application (50ms)
        │     ├ Neo4j 写 Candidate instance (200ms)
        │     └ emit RESUME_PROCESSED (thin) to AO Inngest
        │
        └── 触发 AO::ruleCheckAgent
              ├ partner Postgres 回拉 parsed body (F1) (20ms)
              ├ 路径判定: filename 含【高级Java工程师】+ claimer_employee_id 有
              ├ 路径 B → partner Postgres F2 收敛 (50ms) → 命中 1 个 JR
              ├ partner Postgres getRequirementDetail (20ms)
              ├ ontology API 拉规则 (100ms)
              ├ LLM gate → PASS (5-15s)
              ├ Neo4j 写 Candidate_Match_Result (rule-check stage) (200ms)
              └ emit MATCH_RULE_CHECK_PASSED to AO Inngest
                    │
                    └── 触发 AO::matchResumeAgent
                          ├ partner Postgres F1 回拉 parsed (20ms)
                          ├ partner Postgres getRequirementDetail (20ms)
                          ├ RoboHire match-resume (30-90s)
                          ├ partner Postgres 写 candidate_match_result (50ms)
                          ├ Neo4j 更新 Candidate_Match_Result (200ms)
                          └ emit MATCH_PASSED_NEED_INTERVIEW to AO Inngest
                                │
                                └── partner subscriber: auto-invitation-dispatcher
                                      └ partner Postgres 写 auto_invitation_attempt
                                      └ partner 发面试邀约邮件/短信

总耗时 ~ 40-150s(主要被 RoboHire 两次调用占用)
```

---

## 7. 给 partner 的契约 deliverable

partner(zyj)需要订阅 **5 个事件** 来补 side effect:

| Partner 要订阅的事件 | 来源 | 替代了什么旧逻辑 |
|---|---|---|
| `JD_GENERATED` | AO::createJdAgent | 旧 `sync-generated` 的 HSM 通知 + jd_review HitlTask |
| `RESUME_PROCESSED` | AO::resumeParserAgent | 旧 `POST /candidates` 的 outbox event |
| `MATCH_PASSED_NEED_INTERVIEW` | AO::matchResumeAgent | 旧 `POST /match-results` 的 auto-invitation trigger |
| `MATCH_PASSED_NO_INTERVIEW` | AO::matchResumeAgent | 同上 |
| `MATCH_FAILED` | AO::matchResumeAgent | dispatcher 也消费失败事件 |

partner 这 5 个 subscriber 在他自己的后端写 Inngest function,函数体里调 partner 已有的 service(create-hitl-task、send-notification、auto-invitation-dispatcher)。**partner 之前在 RAAS API handler 里 inline 做的事,现在挪到 Inngest function 里做。**
