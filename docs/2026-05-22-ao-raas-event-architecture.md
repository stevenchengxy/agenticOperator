# Agentic Operator ↔ RaaS 事件流程架构(2026-05-22 single-Inngest 模型)

**日期**: 2026-05-22
**状态**: 当前架构(commit `f191ae9` 之后)
**目标读者**: AO 维护者、RaaS 集成方
**关联文档**:
- [agent-event-flow.md](./agent-event-flow.md) — 2026-05-19 4 agent 接线细节(已被本文 §3 覆盖并扩展)
- [requirements_from_RAAS/2026-05-22-raas-rematch-events-ao-adaptation-design.md](./requirements_from_RAAS/2026-05-22-raas-rematch-events-ao-adaptation-design.md) — RaaS 端两功能设计
- [requirements_from_RAAS/2026-05-23-raas-rematch-events-ao-adaptation.md](./requirements_from_RAAS/2026-05-23-raas-rematch-events-ao-adaptation.md) — RaaS 端实现 plan
- [deployment-guide.md](./deployment-guide.md) §3 — Inngest URL 配置

---

## 0. 文档目的

近期 RaaS 同事交付了两份关于"更换关联岗位 / 匹配同序列岗位"两个新功能的适配文档,但它们基于**双 Inngest + raas-bridge 拉桥**的旧架构假设。本文档:

1. 把 AO 当前真实跑的 **single shared Inngest 架构**画清楚;
2. 穷尽 AO 现有的事件流(JD 生成 / 简历处理主链路 / 行为监控 / Stub);
3. 解释 RaaS 那两个新功能在当前架构下走哪条路;
4. 给出对齐方案。

---

## 1. 顶层架构

### 1.1 单一 Inngest 总线

AO 与 RaaS 是 shared Inngest 上两个平等的 SDK app:

```
  ╔════════════════════════════════════════════════════════════════════╗
  ║              Shared Inngest 服务器(Docker / native CLI)            ║
  ║                  http://localhost:8288                             ║
  ║                                                                    ║
  ║   ┌──────────────────────────────────────────────────────────┐    ║
  ║   │  /v1/events  → 全部事件历史(/events 页 firehose 拉这个)  │    ║
  ║   │  /v1/apps    → 注册的 SDK app 列表(/monitor 页拉)        │    ║
  ║   │  /fn/register → SDK 注册入口(npm run register 调)        │    ║
  ║   └──────────────────────────────────────────────────────────┘    ║
  ║                                                                    ║
  ║   App 注册表                                                       ║
  ║   ┌─────────────────────────┐    ┌──────────────────────────┐     ║
  ║   │ "agentic-operator-main" │    │ <raas backend app id>    │     ║
  ║   │ (AO,本 repo)            │    │ (RaaS 那台)              │     ║
  ║   │ callback URL:           │    │ callback URL:            │     ║
  ║   │ host.docker.internal    │    │ <raas-host>:<port>       │     ║
  ║   │   :3002/api/inngest     │    │   /api/inngest 或类似    │     ║
  ║   └──────────┬──────────────┘    └──────────┬───────────────┘     ║
  ║              │                              │                     ║
  ║              │ Inngest dispatch             │                     ║
  ║              │ (按 trigger event name 路由) │                     ║
  ╚══════════════│══════════════════════════════│═════════════════════╝
                 │                              │
        ↓ ② 反向 callback         ↓ ② 反向 callback
                 │                              │
   ┌─────────────▼─────────────┐    ┌───────────▼──────────────┐
   │  AO Next.js :3002         │    │  RaaS Backend            │
   │  (Mac 宿主)                │    │  (partner 那台)           │
   │                           │    │                          │
   │  /api/inngest             │    │  Inngest serve endpoint  │
   │   ↓                       │    │   ↓                      │
   │  4 real agents 注册:      │    │  N 个 RaaS subscriber:   │
   │   • createJdAgent         │    │   • raas-backend.jd-     │
   │   • resumeParserAgent     │    │     generated-sync       │
   │   • ruleCheckAgent        │    │   • raas-backend.match-  │
   │   • matchResumeAgent      │    │     result-ingest-*      │
   │                           │    │   • raas-backend.resume- │
   │  + ~19 stub agents        │    │     processed-ingest     │
   │  + 2 behavior (env gated) │    │   • OutboxDispatcher     │
   │                           │    │     (RaaS → Inngest)     │
   └──────┬────────────────────┘    └────────┬─────────────────┘
          │ ① POST event                     │ ① POST event
          │ INNGEST_BASE_URL                 │ INNGEST_BASE_URL
          └─────────────►  shared Inngest ◄──┘
                          /e/<event_key>
```

### 1.2 两条方向 + 两组 URL

| 方向 | URL 来源 | 在 AO 这边的 env | 默认 fallback |
|---|---|---|---|
| ① AO → Inngest(发事件) | `INNGEST_BASE_URL` → `INNGEST_DEV` → `INNGEST_LOCAL_URL` → `INNGEST_ADMIN_URL` | `INNGEST_BASE_URL=http://localhost:8288` | `http://localhost:8288` |
| ② Inngest → AO(反向跑 fn) | `INNGEST_SERVE_HOST` + `INNGEST_SERVE_PATH`(SDK 自动读) | `INNGEST_SERVE_HOST=http://host.docker.internal:3002` `INNGEST_SERVE_PATH=/api/inngest` | — |
| 浏览器端(/monitor 跳 Inngest UI 链接) | `NEXT_PUBLIC_INNGEST_URL` build-time 嵌入 | `NEXT_PUBLIC_INNGEST_URL=http://localhost:8288` | — |
| 鉴权 | `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` | 默认值 `dev` | `dev` |

两个方向的 URL 不同**纯粹是 Docker 网络特殊性**——AO 跑在 Mac 宿主、Inngest 跑在 Docker 容器,从宿主看 Docker 用 `localhost`,从 Docker 看宿主用 `host.docker.internal`。

### 1.3 写死的部分(env 改不了)

| 项 | 位置 | 写死值 |
|---|---|---|
| Inngest app id | [server/inngest/client.ts:327](../server/inngest/client.ts#L327) | `"agentic-operator-main"` |
| Real agent 列表 | [server/inngest/functions.ts:81](../server/inngest/functions.ts#L81) | `[resumeParserAgent, createJdAgent, matchResumeAgent, ruleCheckAgent]` |
| 每个 agent 的 trigger event 名 | 各 agent 文件 `inngest.createFunction({...triggers:[{event:'...'}]})` | 见 §2 |

### 1.4 raas-bridge / raas-forward 的现状

| 模块 | 文件 | 当前运行状态 |
|---|---|---|
| `raas-bridge`(拉桥:RaaS Inngest → AO Inngest) | [server/inngest/raas-bridge.ts](../server/inngest/raas-bridge.ts) | **休眠**。代码与启动调用都在([server/init.ts:21](../server/init.ts#L21)),但门控 `if (process.env.RAAS_BRIDGE_ENABLED !== "1") return` 直接返回。`.env.example:330` 标记"架构遗留,新部署不需要"。 |
| `raas-forward`(推送:AO 事件 → RaaS Inngest) | [server/inngest/raas-forward.ts](../server/inngest/raas-forward.ts) | **休眠**。门控 `RAAS_FORWARD_ENABLED=1`,未设。 |

shared Inngest 模型下,两个机制都不必要——RaaS 端 `inngest.send()` 直接命中 shared Inngest,AO 订阅者直接被触发,事件**双向流通免转发**。

---

## 2. 事件目录(10 个 + 2 个辅助)

来源:[server/em/schemas/builtin.ts:129-206](../server/em/schemas/builtin.ts#L129-L206)

| Event Name | Publishers | Subscribers | 方向 |
|---|---|---|---|
| `REQUIREMENT_LOGGED` | `raas-dashboard`、`raas-bridge` | `createJdAgent` | RaaS → AO |
| `JD_GENERATED` | `createJdAgent` | `raas-backend.jd-generated-sync` | AO → RaaS |
| `JD_REJECTED` | `createJdAgent` | `raas-backend` + `createJdAgent`(自循环) | AO 内/出 RaaS |
| `CLARIFICATION_READY` | HITL flow | `createJdAgent` | HITL → AO |
| `RESUME_DOWNLOADED` | `raas-bridge`(历史)、RaaS 直发 | `resumeParserAgent` | RaaS → AO |
| `RESUME_PROCESSED` | `rpa.resumeParserAgent`、`raas.reassign-republisher` | `ao.ruleCheckAgent`、`raas-backend.resume-processed-ingest` | **双向** |
| `MATCH_RULE_CHECK_PASSED` | `ao.ruleCheckAgent` | `ao.matchResumeAgent` | AO 内部 |
| `MATCH_RULE_CHECK_FAILED` | `ao.ruleCheckAgent` | (无,仅审计) | AO 内部 |
| `MATCH_PASSED_NEED_INTERVIEW` | `rpa.matchResumeAgent` | `raas-backend.match-result-ingest-need-interview` | AO → RaaS |
| `MATCH_FAILED` | `rpa.matchResumeAgent` | `raas-backend.match-result-ingest-failed` | AO → RaaS |
| `MATCH_PASSED_NO_INTERVIEW` | (legacy) | `raas-backend.match-result-ingest-no-interview` | 已下线 |
| `MONITOR_ALERT` | `monitorAgent` | `managerAgent` | AO 内部 |

---

## 3. 三大主链路

### 3.1 流程 ① — JD 生成(需求 → JD)

```
   RaaS Web Console: 招聘者提交一条新需求
         │
         │ RaaS outbox + OutboxDispatcher
         ▼
   inngest.send("REQUIREMENT_LOGGED", { payload: { requirement_id, ... } })
         │
         ▼
   ╔═══════════════ Shared Inngest ═══════════════╗
   ║  dispatch by event name → 找订阅者            ║
   ║  REQUIREMENT_LOGGED  →  createJdAgent         ║
   ╚════════════════════│══════════════════════════╝
                        │ Inngest 反向 POST AO callback
                        │  http://host.docker.internal:3002/api/inngest
                        ▼
   ┌──── AO Next.js: createJdAgent run ────────────────────────┐
   │  1. partner-pg 拉 requirement 详情                          │
   │  2. LLM 生成 JD 文本(走 AI_BASE_URL 网关)                   │
   │  3. 写 partner-pg job_posting / Allmeta → Neo4j JD_*       │
   │  4. step.sendEvent("JD_GENERATED", { jd_id, title, ... })  │
   │     [create-jd-agent.ts:325]                               │
   └────────────────────│───────────────────────────────────────┘
                        │
                        ▼
   ╔═══════════════ Shared Inngest ═══════════════╗
   ║  JD_GENERATED  →  raas-backend.jd-generated-sync ║
   ╚════════════════════│══════════════════════════╝
                        │ Inngest 反向 POST RaaS callback
                        ▼
   RaaS Backend: 把 JD 入库 / 展示在 RaaS UI
```

**Trigger 分支**([create-jd-agent.ts:103-107](../server/inngest/agents/create-jd-agent.ts#L103-L107)):
- `REQUIREMENT_LOGGED` — 首次提交
- `CLARIFICATION_READY` — HITL 澄清后重跑
- `JD_REJECTED` — 业务拒绝后重生成(createJdAgent 自循环)

### 3.2 流程 ② — 简历主链路(上传 → 解析 → 规则 → 匹配 → 回写)

**最常跑的链路**——一次简历上传走完 4 跳,中间 4 个 agent 各跑一次 Inngest function run。

```
   Partner Nextcloud webhook → MinIO 落新简历 PDF
         │
         │ RaaS backend 检测到 MinIO 写入,发事件
         ▼
   inngest.send("RESUME_DOWNLOADED", { bucket, objectKey, candidate_id, ... })
         │
         ▼
   ╔═══════════════ Shared Inngest ═══════════════╗
   ║  RESUME_DOWNLOADED  →  resumeParserAgent      ║
   ╚════════════════════│══════════════════════════╝
                        ▼
   ┌──── AO: resumeParserAgent run ─────────────────────────────┐
   │  [resume-parser-agent.ts]                                  │
   │  1. minio 拉 PDF binary                                    │
   │  2. POST RoboHire /parse-resume → 拿结构化 4 对象          │
   │  3. partner-pg 写 candidate / resume(dual-write)           │
   │  4. Allmeta → Neo4j 写 Candidate / Resume / Education      │
   │  5. step.sendEvent("RESUME_PROCESSED", {                   │
   │       upload_id, candidate_id, resume_id,                  │
   │       parsed: { data: {...} }  ← fat event(含解析)         │
   │     })                          [resume-parser-agent:373]  │
   └────────────────────│───────────────────────────────────────┘
                        │
                        ▼ (跳点 1 → 2)
   ╔═══════════════ Shared Inngest ═══════════════╗
   ║  RESUME_PROCESSED  →  ruleCheckAgent          ║
   ║  RESUME_PROCESSED  →  raas-backend.resume-    ║
   ║                       processed-ingest        ║
   ║  (两个订阅者并行触发)                          ║
   ╚════════════════════│══════════════════════════╝
                        ▼
   ┌──── AO: ruleCheckAgent run ────────────────────────────────┐
   │  [rule-check-agent.ts]                                     │
   │  ① unwrap envelope → 拿 payload [560-567]                  │
   │  ② pickUploadId / pickCandidateId / pickEmployeeId         │
   │  ③ linkedJrId 判定:                                        │
   │     • 有 job_requisition_id → 路径 A:partner-pg 查单条 JR  │
   │     • 没有 → 路径 B:查 recruiter 名下所有 published JR     │
   │  ④ parsed 缺失时(thin event)→ partner-pg back-pull        │
   │     getParsedResume(candidate_id, resume_id) [192-228]     │
   │  ⑤ for each JR:                                            │
   │     - Allmeta 写 Job_Requisition 实例(实时镜像)           │
   │     - runRuleCheck(...) ← Allmeta 查规则 + LLM 评估        │
   │     - 写 Prisma RuleCheckAudit(/rule-check UI 数据源)     │
   │     - Allmeta 写 Candidate_Match_Result(cmr_<c>_<jr>)     │
   │     - decision === FAIL → emit MATCH_RULE_CHECK_FAILED     │
   │     - else                → emit MATCH_RULE_CHECK_PASSED   │
   └────────────────────│───────────────────────────────────────┘
                        │
                        ▼ (跳点 2 → 3,N 条 fan-out)
   ╔═══════════════ Shared Inngest ═══════════════╗
   ║  MATCH_RULE_CHECK_PASSED  →  matchResumeAgent ║
   ║  MATCH_RULE_CHECK_FAILED  →  (无订阅,只入审计) ║
   ╚════════════════════│══════════════════════════╝
                        ▼
   ┌──── AO: matchResumeAgent run ──────────────────────────────┐
   │  [match-resume-agent.ts]                                   │
   │  1. 用 parsed_resume + job_requisition 调 RoboHire         │
   │     POST /match-resume → 拿 matching_score + 维度细分      │
   │  2. partner-pg 写 candidate_match_result(_runtime_state)   │
   │     [lib/partner-pg/match-results.ts]                      │
   │     PK = cmr_<candidate>_<jr>                              │
   │  3. decideMatchEvent(score):                               │
   │       score < 40   → MATCH_FAILED                          │
   │       其它(含 null) → MATCH_PASSED_NEED_INTERVIEW          │
   │  4. step.sendEvent(<eventName>, payload)  [line 239]       │
   └────────────────────│───────────────────────────────────────┘
                        │
                        ▼ (跳点 3 → 4,最终回 RaaS)
   ╔═══════════════ Shared Inngest ═══════════════╗
   ║  MATCH_PASSED_NEED_INTERVIEW  →              ║
   ║    raas-backend.match-result-ingest-need-... ║
   ║  MATCH_FAILED  →                             ║
   ║    raas-backend.match-result-ingest-failed   ║
   ╚════════════════════│══════════════════════════╝
                        ▼
   RaaS Backend: 把匹配结果入库 → 推到 RaaS Web UI(MatchPool / 人才详情)
```

**Fan-out 关键点**:
- 路径 B(recruiter 名下多 JR)时,ruleCheckAgent 在**同一个 run 里 sequential** 跑 N 次 rule-check,每个 JR 单独 emit 一条 `MATCH_RULE_CHECK_PASSED` → matchResumeAgent 被触发 **N 次 run**(并发)
- 路径 A(单 JR)只跑一次

### 3.3 流程 ③ — RaaS 重派 / 同序列(本次适配主题)

RaaS Web Console 的两个新功能:
- **功能 A — 更换关联岗位**(`POST /api/v1/candidates/:id/reassign-job`)
- **功能 B — 匹配同序列岗位**(`POST /api/v1/candidates/:id/match-same-sequence`)

两者都**跳过 `RESUME_DOWNLOADED → resumeParserAgent`**,直接发 thin event `RESUME_PROCESSED`(无 `parsed`,无 `upload_id`,带新 `job_requisition_id` + 触发标志):

```
   功能 A:RaaS Web Console "更换关联岗位"
   功能 B:RaaS Web Console "匹配同序列岗位"
         │
         │ RaaS reassignCandidateJob() / triggerMatch()
         │ → outbox → OutboxDispatcher
         ▼
   inngest.send("RESUME_PROCESSED", {
     payload: {
       candidate_id, resume_id, job_requisition_id,  ← 新 JR
       reassign_trigger: true,         (功能 A)
       same_sequence_trigger: true,    (功能 B)
       operator_id, client_id, ...
       // 注意:NO parsed,NO upload_id  ← thin event
     }
   })
         │
         ▼
   ╔═══════════════ Shared Inngest ═══════════════╗
   ║  RESUME_PROCESSED  →  ruleCheckAgent          ║
   ║  RESUME_PROCESSED  →  raas-backend.resume-    ║
   ║                       processed-ingest        ║
   ╚════════════════════│══════════════════════════╝
                        ▼
   ┌──── AO: ruleCheckAgent run ────────────────────────────────┐
   │  跟流程 ② 一模一样的链路:                                  │
   │   - thin event → back-pull parsed_content                  │
   │   - 有 job_requisition_id → 路径 A                         │
   │   - 同序列功能:RaaS 端发 N 条,这里就跑 N 次 run            │
   │     (各自独立的 Inngest run id)                            │
   │   - 末端 emit MATCH_RULE_CHECK_PASSED → matchResumeAgent   │
   │     → MATCH_PASSED_NEED_INTERVIEW → 回 RaaS                │
   └────────────────────────────────────────────────────────────┘
```

**核心洞察**:**功能 A/B 在 Inngest 视角下就是流程 ② 的"短路版"——只是少了前两跳。** ruleCheckAgent 自己不读 `reassign_trigger` / `same_sequence_trigger`(它们是 passthrough 信息字段),thin event 通过 back-pull 补齐 parsed 数据后,链路完全一样。

[rule-check-agent.ts:14-17](../server/inngest/agents/rule-check-agent.ts#L14-L17) 自己写了这句:

> 重派场景:partner 直接重发 `RESUME_PROCESSED`(带新 `job_requisition_id`),**本函数走路径 A,无任何额外订阅或代码改动。**

——在 2026-05-19 consolidation 时已经预想到了这两个功能。

#### 3.3.1 ruleCheckAgent 接 RaaS thin event 的逐行追迹

| 行 | 代码 | RaaS payload 处理 |
|---|---|---|
| [67](../server/inngest/agents/rule-check-agent.ts#L67) | `unwrapResumeProcessedEvent(event.data)` | 信封/扁平两种形态都吃 |
| [69](../server/inngest/agents/rule-check-agent.ts#L69) | `pickUploadId(data)` → null | RaaS 不发 upload_id,用 candidate_id 兜底 |
| [70](../server/inngest/agents/rule-check-agent.ts#L70) | `pickCandidateId(data)` | RaaS payload.candidate_id |
| [71](../server/inngest/agents/rule-check-agent.ts#L71) | `pickEmployeeId(data)` | 走 `operator_id`(兜底链 `claimer_employee_id → employee_id → employeeId → operator_id → env`) |
| [94-96](../server/inngest/agents/rule-check-agent.ts#L94-L96) | `if (!uploadId && !candidateId) throw` | 有 candidate_id → 通过 |
| [97-99](../server/inngest/agents/rule-check-agent.ts#L97-L99) | `if (!employeeId) throw` | 有 operator_id → 通过 |
| [100-102](../server/inngest/agents/rule-check-agent.ts#L100-L102) | `if (!isPartnerPgConfigured()) throw` | 依赖 `RAAS_POSTGRES_URL` |
| [109-112](../server/inngest/agents/rule-check-agent.ts#L109-L112) | `linkedJrId = "jr-new-999"` | 进路径 A |
| [116-135](../server/inngest/agents/rule-check-agent.ts#L116-L135) | `getRequirementDetail(linkedJrId)` | 依赖 partner Postgres 有该 JR |
| [192-228](../server/inngest/agents/rule-check-agent.ts#L192-L228) | `getParsedResume(candidate_id, resume_id)` | 依赖 partner Postgres 有该 parsed 简历 |
| [302-451](../server/inngest/agents/rule-check-agent.ts#L302-L451) | runRuleCheck → 写 audit + CMR | 跟流程 ② 完全相同 |
| [457-525](../server/inngest/agents/rule-check-agent.ts#L457-L525) | emit MATCH_RULE_CHECK_PASSED/FAILED | 同流程 ② |

---

## 4. 辅助流程

### 4.1 Behavior 轴(env-gated `BEHAVIOR_AGENTS=1`,默认关)

```
   ┌─────────────────────────────────────────────────────────┐
   │ monitorAgent (cron: */1 * * * *)  [monitor-agent.ts:173]│
   │  每分钟扫 BehaviorAlert / RunStatistic                  │
   │  发现异常 → step.sendEvent("MONITOR_ALERT", {...})      │
   └────────────────────────────│────────────────────────────┘
                                ▼
   ╔═══ Shared Inngest ═══════════════════════════════════╗
   ║  MONITOR_ALERT  →  managerAgent                       ║
   ╚════════════════════════│══════════════════════════════╝
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ managerAgent  [manager-agent.ts:183]                    │
   │  LLM 判断响应(pause / human task / notify)             │
   │  → 写 Prisma HumanTask / 切 AgentConfig.enabled         │
   └─────────────────────────────────────────────────────────┘
```

### 4.2 Stub agents(env-gated `STUB_AGENTS=1`,默认开)

`AGENT_MAP` 里 ~19 个非 real agent 各自注册一个空函数(`createStubAgent`)。Inngest dispatch 时它们订阅各种事件、写一条 `AgentActivity` 然后 sleep 后 emit 一个固定下游事件——**纯演示**,给 `/fleet`、`/monitor`、`/workflow` 三个 UI 页凑齐"整个 agent fleet 都部署了"的画面。生产部署要清干净时设 `STUB_AGENTS=0`。

### 4.3 HITL 暂停(/api/inngest-admin/functions/[slug]/toggle)

`AgentConfig.enabled=false` 时,[app/api/inngest/route.ts:42-52](../app/api/inngest/route.ts#L42-L52) 在 serve adapter 注册前**过滤掉**被暂停的函数。事件来到 shared Inngest 时:
- 函数已下线 → Inngest 把事件 queue 在自己侧
- 函数恢复(toggle 回 `enabled=true`)→ `invalidateHandlerCache()` 重建 serve handler → 下次 dispatch 命中
- handler 里还有第二道防线 `assertNotPaused()`,即便 race 也短路返回

---

## 5. 端到端跨系统 Trace 时间线

一个简历从上传到匹配结果回到 RaaS UI 的典型耗时:

```
T+0   ms │ RaaS Nextcloud webhook 触发,文件到 MinIO
T+50  ms │ RaaS 写 outbox 行 + 发 RESUME_DOWNLOADED 到 Inngest
T+60  ms │ Inngest dispatch → POST AO /api/inngest
T+200 ms │ AO resumeParserAgent run 开始
         │  ├─ MinIO 拉 PDF (~100ms)
         │  ├─ RoboHire /parse-resume (~3-8s,LLM 调用)
         │  └─ partner-pg + Allmeta 双写 (~300ms)
T+8s     │ AO emit RESUME_PROCESSED (fat event)
T+8s     │ Inngest dispatch → 两个订阅者并发
         │  ├─ AO ruleCheckAgent run
         │  └─ RaaS raas-backend.resume-processed-ingest run
T+8s+    │ AO ruleCheckAgent:
         │  ├─ partner-pg 查 JR / 查 parsed_resume (~200ms)
         │  ├─ Allmeta 写 Job_Requisition 镜像 (~150ms)
         │  ├─ Allmeta 查规则 + LLM 评估 (~3-10s)
         │  ├─ Prisma 写 RuleCheckAudit
         │  ├─ Allmeta 写 Candidate_Match_Result
         │  └─ emit MATCH_RULE_CHECK_PASSED
T+18s    │ AO matchResumeAgent run 开始
         │  ├─ RoboHire /match-resume (~5-15s,LLM)
         │  └─ partner-pg 写 candidate_match_result(_runtime_state)
T+33s    │ AO emit MATCH_PASSED_NEED_INTERVIEW
T+33s+   │ RaaS raas-backend.match-result-ingest-need-interview run
         │   把匹配结果 push 到 RaaS UI
T+33s+ε  │ 招聘者在 RaaS Web Console 看到新匹配
```

跨系统聚合查询走 [/api/runs/[id]/trace](../app/api/runs/[id]/trace),底层是 shared Inngest 的 `/v1/runs`,自然跨 AO + RaaS 两边的 run。

---

## 6. 总览图(双方订阅/发布)

```
                          ╔═══════════════════════════════╗
                          ║                               ║
                          ║   SHARED INNGEST (单一实例)   ║
                          ║   /v1/events 全宇宙事件总线   ║
                          ║                               ║
                          ╚═══════════════════════════════╝
                                  ▲  ▲  ▲   ▲  ▲  ▲  ▲
                send │             │  │  │   │  │  │  │   ← dispatch
                     │             │  │  │   │  │  │  │
   ┌─────────────────┴─────────────┴──┴──┴───┴──┴──┴──┴────────────────────────┐
   │                                                                          │
   │  ┌─────────────────────────────┐         ┌─────────────────────────────┐ │
   │  │   AO (this repo)            │         │   RaaS Backend (partner)    │ │
   │  │                             │         │                             │ │
   │  │  publishes:                 │         │  publishes:                 │ │
   │  │   • RESUME_PROCESSED        │  ◄────► │   • REQUIREMENT_LOGGED      │ │
   │  │   • MATCH_RULE_CHECK_*      │         │   • CLARIFICATION_READY     │ │
   │  │   • JD_GENERATED            │         │   • RESUME_DOWNLOADED       │ │
   │  │   • JD_REJECTED             │         │   • RESUME_PROCESSED        │ │
   │  │   • MATCH_PASSED_NEED_*     │         │     (重派/同序列功能)        │ │
   │  │   • MATCH_FAILED            │         │                             │ │
   │  │                             │         │  subscribes:                │ │
   │  │  subscribes:                │         │   • JD_GENERATED            │ │
   │  │   • REQUIREMENT_LOGGED      │         │   • JD_REJECTED             │ │
   │  │   • CLARIFICATION_READY     │         │   • RESUME_PROCESSED        │ │
   │  │   • JD_REJECTED (自循环)    │         │   • MATCH_PASSED_*          │ │
   │  │   • RESUME_DOWNLOADED       │         │   • MATCH_FAILED            │ │
   │  │   • RESUME_PROCESSED        │         │                             │ │
   │  │   • MATCH_RULE_CHECK_PASSED │         │                             │ │
   │  │   • MONITOR_ALERT           │         │                             │ │
   │  │                             │         │                             │ │
   │  └──────┬──────────────────────┘         └─────────────┬───────────────┘ │
   │         │                                              │                 │
   │         │   partner-pg dual-write(非事件,直连 SQL)    │                 │
   │         ├──────────────────────────────────────────────┤                 │
   │         │   candidate / resume / job_posting /         │                 │
   │         │   candidate_match_result(_runtime_state) ... │                 │
   │         │                                              │                 │
   │         │   Allmeta Ontology(:3500) → Neo4j            │                 │
   │         │   AO 这边写 entity 实例,Studio 维护 schema   │                 │
   │                                                                          │
   └──────────────────────────────────────────────────────────────────────────┘
```

---

## 7. RaaS 重派/同序列功能适配清单

回到本次的核心问题:**给定 single Inngest 架构,要让 RaaS 那两个功能跑通,AO 这边需要改什么?**

### 7.1 RaaS 设计文档主张的 3 个改动 — 重新评估

RaaS 端 [2026-05-22 设计](./requirements_from_RAAS/2026-05-22-raas-rematch-events-ao-adaptation-design.md) 列了 3 个改动,这里在 single-Inngest 架构下重新评估:

| # | 改动 | 在 single-Inngest 下评估 |
|---|---|---|
| 1 | `RAAS_BRIDGE_EVENTS` 加入 `RESUME_PROCESSED` | **无效** — bridge 默认关,即使设了 env 也跟架构方向相悖 |
| 2 | `tick()` 按 `reassign_trigger`/`same_sequence_trigger` 内容过滤 | **无效** — bridge 不跑,无环可防 |
| 3 | `RESUME_PROCESSED_v1` 的 `upload_id` 改为 optional | **无效但无害** — schema 只在 `em.publish` 路径上校验,RaaS 直 send 不过这条路径。**1 行 0 风险,建议仍做**(修 schema ↔ agent 契约不一致,为将来防御) |

**所有 3 项改动都只在"走 bridge"路径上才有功效。** shared Inngest 模型下,RaaS 直发即可,无需任何代码改动。

### 7.2 实际需要做的事(精简版)

#### A. 代码改动 — 1 行(可选,但建议)

| 文件 | 改动 | 理由 |
|---|---|---|
| [server/em/schemas/builtin.ts:64](../server/em/schemas/builtin.ts#L64) | `upload_id: z.string().min(1)` → `z.string().min(1).optional()` | 修 schema ↔ agent 契约不一致,1 行 0 副作用 |

可选附带:把 [components/events/EventInstancesTab.tsx:185](../components/events/EventInstancesTab.tsx#L185) 那句过时提示"raas-bridge 上 VPN 后会自动产生流量"改成 single-Inngest 语义。

#### B. 配置 — 你 `.env.local` 已经齐了

| 项 | 状态 |
|---|---|
| `RAAS_POSTGRES_URL` | ✓ 已配(`192.168.1.103:5432/raas_db`) |
| `RAAS_DEFAULT_EMPLOYEE_ID` | ✓ 已配(`0000199059`) |
| `INNGEST_BASE_URL` | ✓ `http://localhost:8288` |
| `INNGEST_SERVE_HOST` | ✓ `http://host.docker.internal:3002` |
| `RAAS_BRIDGE_ENABLED` | (未设,正确 — 不要开) |
| `RAAS_FORWARD_ENABLED` | (未设,正确 — 不要开) |

#### C. 跟 RaaS partner 对齐 — 必须确认

| # | 内容 | 风险 |
|---|---|---|
| 1 | RaaS 端 `inngestClient` 指向**同一台** shared Inngest | 不对就事件到不了 AO |
| 2 | 该 shared Inngest 上 `agentic-operator-main` 已注册 + 4 个 real agents 全部 visible | 没注册 → 事件来了但不触发 |
| 3 | RaaS payload `operator_id` 是真实的 recruiter ID | 否则即便 ruleCheckAgent 跑了也 NonRetriableError |
| 4 | RaaS 端发 `RESUME_PROCESSED` 是信封形态 `{ payload: { ... } }` | agent unwrap 两种都吃,有最好 |
| 5 | partner Postgres 里那条简历的 `parsed_content` 非空 | RaaS 端"无解析则不发"已内置保护 |

#### D. 本地无 RaaS 时的验证 workaround

未连 RaaS 时,可以写一个 `/api/test/trigger-raas-rematch` 路由,模仿 RaaS thin-event payload 直接 `inngest.send('RESUME_PROCESSED', ...)`,绕过 RaaS 验 agent 链。模式跟 [/api/rule-check-audits/[auditId]/replay](../app/api/rule-check-audits/[auditId]/replay/route.ts) 一致。

### 7.3 端到端验证清单(代码 + 配置改完后)

1. AO 这边 `INNGEST_BASE_URL` 跟 RaaS 端**指向同一台**;
2. `npm run register` 把 AO 注册到 shared Inngest;
3. 让 RaaS 同事在 Web Console 触发一次"更换关联岗位";
4. AO `/events` firehose 出现 `RESUME_PROCESSED` 行;
5. Inngest dashboard 看到 `agentic-operator-main-rule-check-agent` 新 run;
6. `RuleCheckAudit` 表 / `candidate_match_result_runtime_state` 表新增对应行;
7. RaaS 端 UI 显示新匹配结果。

走通 → 整个适配只用了 1 行 schema + 一个真 employee ID。

---

## 8. 总结一句话

> **当前 AO 跑的是 single shared Inngest 架构,RaaS 的两个新功能(更换关联岗位 / 匹配同序列岗位)在这套架构下 = 流程 ② 的"短路版":RaaS 直接发 thin event `RESUME_PROCESSED` 到 shared Inngest,AO `ruleCheckAgent` 直接被触发,走路径 A 单 JR 跑完规则审计 + 匹配评分 + 双写回 partner-pg / RaaS UI。代码改动 = 0(必要)/ 1 行 schema(建议防御),其他都是配置确认。**
