# Agent 事件流（2026-05-19 审计）

AO 当前 production 注册了 **4 个 real agent**（[server/inngest/functions.ts](../server/inngest/functions.ts)
`realFunctions = [resumeParserAgent, createJdAgent, matchResumeAgent, ruleCheckAgent]`），
本文穷尽每个的 trigger / step / RAAS API 调用 / emit 事件，并标出当前
已知的接线问题。

stub agent / behavior agent 默认不注册（`STUB_AGENTS=1` / `BEHAVIOR_AGENTS=1`
才打开），不在本文范围。

---

## 1. 全景图

```
                          ┌──────────────────────────────────┐
REQUIREMENT_LOGGED ──────▶│  createJdAgent                   │──▶ JD_GENERATED
   (RAAS 端 emit)         │  agentic-operator-main-create-…  │       │
                          │  triggers: REQUIREMENT_LOGGED,   │       │
                          │            CLARIFICATION_READY,  │       ▼
                          │            JD_REJECTED           │  (RAAS) jd-generated-sync.function
                          └──────────────────────────────────┘  ├─ patch JobRequisition
                                                                ├─ upsert JobPosting
                                                                ├─ spec.status: pending_publish
                                                                └─ HitlTask{type=jd_review}

                          ┌──────────────────────────────────┐
RESUME_DOWNLOADED ───────▶│  resumeParserAgent               │──▶ RESUME_PROCESSED
   (RAAS 端 emit)         │  resume-parser-agent             │       │
                          │  triggers: RESUME_DOWNLOADED     │       │
                          └──────────────────────────────────┘       │
                                                                     ▼
                          ┌──────────────────────────────────┐
RESUME_PROCESSED ────────▶│  ruleCheckAgent                  │
                          │  rule-check-agent                │
                          │  triggers: RESUME_PROCESSED      │
                          │                                  │
                          │  per JR fan-out:                 │
                          │   ├─ PASS  ──────────────────────┼──▶ MATCH_RULE_CHECK_PASSED ─┐
                          │   ├─ FAIL  ──────────────────────┼──▶ MATCH_RULE_CHECK_FAILED │
                          │   └─ REVIEW ─────────────────────┼──▶ MATCH_RULE_CHECK_FAILED │
                          └──────────────────────────────────┘                              │
                                                                                            │
                          ┌──────────────────────────────────┐                              │
MATCH_RULE_CHECK_PASSED ─▶│  matchResumeAgent                │◀─────────────────────────────┘
                          │  match-resume-agent              │
                          │  triggers: MATCH_RULE_CHECK_PASSED│
                          │                                  │
                          │  decision by score:              │
                          │   score > 90      ───────────────┼──▶ MATCH_PASSED_NO_INTERVIEW
                          │   50 ≤ score ≤ 90 ───────────────┼──▶ MATCH_PASSED_NEED_INTERVIEW ─┐
                          │   score < 50      ───────────────┼──▶ MATCH_FAILED                │
                          │   score = null    ───────────────┼──▶ MATCH_PASSED_NEED_INTERVIEW │
                          │   RoboHire 4xx    ───────────────┼──▶ MATCH_FAILED                │
                          └──────────────────────────────────┘                                │
                                                                                              ▼
                                                            (RAAS) auto-invitation-dispatcher.function
                                                                  trigger: MATCH_PASSED_NEED_INTERVIEW
```

---

## 2. 每个 agent 详细审计

### 2.1 createJdAgent — Workflow node 4 / "Create JD Agent"

**Inngest function**: `agentic-operator-main-create-jd-agent`
**源码**: [server/inngest/agents/create-jd-agent.ts](../server/inngest/agents/create-jd-agent.ts)

| 项 | 值 |
|---|---|
| Triggers | `REQUIREMENT_LOGGED`, `CLARIFICATION_READY`, `JD_REJECTED` |
| Pre-check | `isRaasApiConfigured()` 必须 true；`event.data.entity_id` 必须存在 |
| Step 1 `fetch-requirement-{jrid}` | RAAS GET `/api/v1/requirements/:id` 拉完整需求 |
| Step 2 `generate-{jrid}` | RoboHire POST `/api/v1/jobs/generate-jd`（**直连**，不走 RAAS proxy） |
| Step 3 `sync-jd-{jrid}` | RAAS POST `/api/v1/jd/sync-generated` 把生成的 JD 内容写回 |
| Step 4 `emit-jd-generated-{jrid}` | sendEvent `JD_GENERATED`（payload 同 sync-jd 的 body）|
| Return | `{ ok, jd_id, requisition_id, client_id, title, robohire_request_id }` |
| 上游 RAAS gate | `feature.jd_generation.enabled_employee_ids` 白名单（见 [feature-gating.ts](../raas_v4/backend/apps/api/src/lib/feature-gating.ts)）—— 不在白名单时 RAAS 不 emit REQUIREMENT_LOGGED，本 agent 自然收不到 |

---

### 2.2 resumeParserAgent — Workflow node "Resume Parser"

**Inngest function**: `resume-parser-agent`
**源码**: [server/inngest/agents/resume-parser-agent.ts](../server/inngest/agents/resume-parser-agent.ts)

| 项 | 值 |
|---|---|
| Triggers | `RESUME_DOWNLOADED` |
| Retries | **0**（RAAS API 失败不自动重试，避免重复扣配额 / 重写 DB）|
| Pre-check | `upload_id` 必填；`bucket` + `object_key` 必填 |
| Step 1 `download-and-parse-{upload}` | RAAS GET `/api/v1/resumes/uploads/:upload_id/raw` 拉 PDF 字节<br>RoboHire POST `/api/v1/parse-resume`（multipart，**直连**）<br>本地算 MD5 作 etag 兜底 |
| Step 2 `save-candidate` | RAAS POST `/api/v1/candidates`（带 `parsed` 嵌套 + upload anchor）|
| Step 3 `emit-resume-processed` | sendEvent `RESUME_PROCESSED`（payload 含 `parsed.data` + `candidate_id` + `resume_id` + `job_requisition_id` 透传）|
| Return | `{ ok, upload_id, candidate_id, candidate_name, resume_id, is_new_candidate, is_new_resume }` |
| Legacy 路径 | 如果 `event.data.parsed` 已有，跳过 Step 1（partner / 早期联调用） |

---

### 2.3 ruleCheckAgent — Workflow node 10-1 / "Rule Check"

**Inngest function**: `rule-check-agent`
**源码**: [server/inngest/agents/rule-check-agent.ts](../server/inngest/agents/rule-check-agent.ts)
**Spec**: [docs/superpowers/specs/2026-05-19-rule-check-consolidation-design.md](superpowers/specs/2026-05-19-rule-check-consolidation-design.md)

| 项 | 值 |
|---|---|
| Triggers | `RESUME_PROCESSED` |
| Pre-check | `upload_id` 或 `candidate_id` 至少一个；`employee_id` 必填；`isRaasApiConfigured()` |
| Step 1 `list-requirements` | **Path A**（`event.job_requisition_id` 存在）：RAAS GET `/api/v1/requirements/:id` 单条<br>**Path B**（无 job_requisition_id）：RAAS GET `/api/v1/requirements/agent-view?claimer_employee_id=&resume_filename=` 拿候选 JR 列表 |
| Step 2 `fetch-parsed-resume` | 仅当 `event.parsed` 为空时：RAAS GET `/api/v1/candidates/:cid/resumes/:rid/parsed` 回拉 |
| Step 3 per JR `rule-check-{jrid}` | `runRuleCheck()` —— Ontology 维度提取 + Neo4j 图查询 + LLM 决策（[lib/rule-check/runner.ts](../lib/rule-check/runner.ts)）|
| Step 4 per JR `emit-passed-{jrid}` / `emit-failed-{jrid}` | PASS → sendEvent `MATCH_RULE_CHECK_PASSED` (带 jr + parsed + audit)<br>FAIL / REVIEW → sendEvent `MATCH_RULE_CHECK_FAILED` (带 explanations + audit) |
| Bypass | `RULE_CHECK_BYPASS=true` env → 跳过 runRuleCheck，直接 emit MATCH_RULE_CHECK_PASSED（dev 用）|
| Return | `{ ok, upload_id, candidate_id, employee_id, requested_count, passed, failed }` |
| **不写本地 audit** | ⚠️ `writeRuleCheckAuditPrisma()` 函数定义在 [lib/rule-check/prisma-audit-writer.ts](../lib/rule-check/prisma-audit-writer.ts) 但**从未被调用** → AO `/rule-check` 页面读 `ruleCheckAudit` 表恒空 |

---

### 2.4 matchResumeAgent — Workflow node 10-2 / "Match Resume"

**Inngest function**: `agentic-operator-main-match-resume-agent`
**源码**: [server/inngest/agents/match-resume-agent.ts](../server/inngest/agents/match-resume-agent.ts)

| 项 | 值 |
|---|---|
| Triggers | **仅** `MATCH_RULE_CHECK_PASSED`（2026-05-19 consolidation 后；之前订 `RESUME_PROCESSED` 自己跑 rule check） |
| Pre-check | `data.job_requisition` + `data.parsed_resume` 必填（ruleCheck 已透传） |
| Step 1 `match-{jrid}` | RoboHire POST `/api/v1/match-resume`（**直连**，不走 RAAS proxy）|
| Step 2 `save-match-{jrid}` | RAAS POST `/api/v1/match-results` 写匹配分 + 元数据（仅 step 1 成功时执行） |
| Step 3 `emit-match-{jrid}` | 按分数决策 emit：<br> `> 90` → `MATCH_PASSED_NO_INTERVIEW`<br> `50 ≤ score ≤ 90` → `MATCH_PASSED_NEED_INTERVIEW`<br> `< 50` → `MATCH_FAILED`<br> `score = null` → `MATCH_PASSED_NEED_INTERVIEW`（保守）<br> RoboHire 4xx → `MATCH_FAILED`（带 `error_kind: robohire-match-call-failed`，不调 saveMatchResults）|
| Return | `{ ok, job_requisition_id, requestId, eventName, matching_score }` |

---

## 3. 下游 (RAAS 端) 消费者

| AO 发出的事件 | RAAS Inngest function | 行为 |
|---|---|---|
| `JD_GENERATED` | jd-generated-sync.function | patch JobRequisition + upsert JobPosting + 推 spec.status `pending_publish` + 建 `HitlTask{type=jd_review}` + in-app 通知 |
| `MATCH_PASSED_NEED_INTERVIEW` | [auto-invitation-dispatcher.function](../raas_v4/backend/apps/api/src/modules/inngest/functions/auto-invitation-dispatcher.function.ts) | 命中自动邀约规则时自动发面试邀请；其它分支留给 HSM/recruiter 人工触发 |
| `MATCH_PASSED_NO_INTERVIEW` | （暂无 RAAS 消费者） | UI 列表可见；继续走 offer 流程依赖人工 |
| `MATCH_FAILED` | （暂无 RAAS 消费者） | UI 列表可见 |
| `MATCH_RULE_CHECK_FAILED` | （暂无 RAAS 消费者） | 仅 audit 记录用 |

---

## 4. 已知接线问题（按影响降序）

### 4.1 ruleCheckAgent 不写本地 `ruleCheckAudit` 表
**症状**：AO [/rule-check](http://localhost:3002/rule-check) 页面长期为空，明明 ruleCheck 跑过几十次。
**根因**：[writeRuleCheckAuditPrisma()](../lib/rule-check/prisma-audit-writer.ts#L38) 定义了但 [rule-check-agent.ts](../server/inngest/agents/rule-check-agent.ts) 没调用。
**修法**：在 step 3 `rule-check-{jrid}` 之后插一行 `await writeRuleCheckAuditPrisma(result, ctx)`。需要构造 `WritePrismaAuditContext`（candidate_id / resume_id / jrid / employee_id / trace_id 都已有）。

### 4.2 RAAS `/requirements/agent-view` legacy stub 抢路由
**症状**：HSM 实际只 claim 1 个 JR（RAAS UI 显示一致），但 AO ruleCheckAgent 一份简历会 fan-out 到 N 条历史 JR（典型 ~50），跑 N 次 ruleCheck + N 次 matchResume。
**根因**：[legacy-proxies.hono.ts](../raas_v4/backend/apps/api/src/modules/legacy-proxies/legacy-proxies.hono.ts) stub 没按 claimer 过滤、强行把所有 JR 的 status 改成 `recruiting`；它注册在 `app.route("/", legacyRouter)` 抢在真处理器 [requirements-agent-view.hono.ts:86](../raas_v4/backend/apps/api/src/modules/requirements/requirements-agent-view.hono.ts#L86) 前面。
**修法**：删 stub 让真处理器接管（之前提过用户暂时回退）。

### 4.3 RAAS `/jd/sync-generated` legacy stub 抢路由
**症状**：createJdAgent 把生成的 JD POST 给 RAAS，RAAS UI 看不到 JD 内容；spec.status 卡在 draft 不推到 pending_publish；HitlTask 不建。
**根因**：[legacy-proxies.hono.ts](../raas_v4/backend/apps/api/src/modules/legacy-proxies/legacy-proxies.hono.ts) stub 只写 `jobPostingListProjection` title 壳子，抢在 [jd.hono.ts:114](../raas_v4/backend/apps/api/src/modules/jd/jd.hono.ts#L114) `syncJdGenerated()` 真处理器前面。
**修法**：同 4.2。

### 4.4 RAAS `POST /candidates` legacy stub 抢路由
**症状**：resumeParserAgent 调 saveCandidate 时报 `RAAS API 500 DB_ERROR: Invalid prisma.candidate.upsert() invocation`。
**根因**：stub 读 `data.name` / `data.mobile`（顶层），但 RoboHire 返回是 `parsed.data.name`（嵌套）；找不到就 fallback `name: "Unknown"`，所有字段进 null，Prisma NOT NULL / FK 约束炸。真处理器 [candidates-main.hono.ts:218](../raas_v4/backend/apps/api/src/modules/candidates/candidates-main.hono.ts#L218) 支持嵌套 form B + 走 `resumePipelineService.processResumeUpload` 写多张表。
**修法**：同 4.2。

### 4.5 matchResumeAgent 分数始终为 null
**症状**：log 里所有 `[matchResume] RoboHire match OK · score=undefined rec=undefined`，全部走 MATCH_PASSED_NEED_INTERVIEW 保守分支。
**根因**：`extractMatchingScore(matchResult.data)` 找不到分数字段。需要核实 RoboHire `/match-resume` 返回的分数 JSON path（可能嵌在 `data.score` / `data.match.score` / `data.overall_score` 之类，但当前 extractor 路径对不上）。
**修法**：抓一次 RoboHire 真实响应，确认 score 字段的 JSON path，把 [match-resume-agent.ts extractMatchingScore](../server/inngest/agents/match-resume-agent.ts) 改成对应路径。

---

## 5. 事件 schema 来源

| 文件 | 作用 |
|---|---|
| [server/inngest/client.ts](../server/inngest/client.ts) | AO 自定义事件 TypeScript shape：`ResumeProcessedData`、`MatchEventData`、`MatchRuleCheckPassedData`、`RuleCheckAuditMeta` 等 |
| [neo4j_data/actions_v0_1_002.json](../neo4j_data/actions_v0_1_002.json) | Ontology action 定义（事件名权威源）|
| [docs/superpowers/specs/2026-05-19-rule-check-consolidation-design.md](superpowers/specs/2026-05-19-rule-check-consolidation-design.md) | 10-1 / 10-2 拆分设计 |

---

## 6. 触发链路示例（实测一份简历，对 1 个 claimed JR）

```
T+0   RAAS UI 用户上传简历 PDF
T+0.1 RAAS /candidates/upload-resume → MinIO putObject → resume_upload_runtime row → outbox emit RESUME_DOWNLOADED
T+0.2 RESUME_DOWNLOADED → resumeParserAgent
       ├─ download-and-parse-XX  RAAS GET /resumes/uploads/XX/raw + RoboHire /parse-resume   ~9s
       ├─ save-candidate         RAAS POST /candidates                                       ~0.2s
       └─ emit-resume-processed  sendEvent RESUME_PROCESSED                                   ~3ms
T+10  RESUME_PROCESSED → ruleCheckAgent
       ├─ list-requirements      RAAS GET /requirements/<jrid>  (path A)                     ~0.05s
       ├─ rule-check-<jrid>      runRuleCheck (ontology+neo4j+LLM)                            ~2.8s
       └─ emit-passed-<jrid>     sendEvent MATCH_RULE_CHECK_PASSED                            ~3ms
T+13  MATCH_RULE_CHECK_PASSED → matchResumeAgent
       ├─ match-<jrid>           RoboHire POST /match-resume                                  ~2s
       ├─ save-match-<jrid>      RAAS POST /match-results                                     ~0.2s
       └─ emit-match-<jrid>      sendEvent MATCH_PASSED_NEED_INTERVIEW                        ~3ms
T+15  MATCH_PASSED_NEED_INTERVIEW → RAAS auto-invitation-dispatcher  (规则命中则触发面试邀请)
```

如果 step 1 走 path B（用户上传时未选岗位），N 个 claimed JR → fan-out 后中段会有 N×(ruleCheck + matchResume) 并发跑。

---

_最近一次审计：2026-05-19_
