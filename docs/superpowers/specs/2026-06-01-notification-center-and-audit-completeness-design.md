# 消息通知中心 + 审计日志全可查 + 告警 AI 管理 — 设计文档

> 作者: Claude(代 Steven)
> 日期: 2026-06-01
> 状态: 待 user review(写完直接走 user gate,不派 reviewer per user preference)
>
> **覆盖范围**: rule-check 基础设施报错处理修复 · 统一错误/日志捕获(审计全可查)· 统一"消息+预警"通知模型 · 告警 AI 管理器 + 算法 fallback · 消息通知中心 UI。

---

## 0. 一句话目标

把 AO 里**一切运行中的信号**——业务消息(事件发布、agent run 起止、候选人处理、HITL)和报错预警(后端 / LLM / agent / 基础设施 / 任何抛出的 error)——统一捕获进**可追踪的审计日志(LogEvent)**,再把其中**值得用户看的**精选进**一张 `Notification` 表**,在**消息通知中心**里按"消息 / 预警 × 分类 × 严重度"分类筛选展示、每条可跳转到对应 run/事件的单条过程;预警由 **AI 管理器**做中文总结+聚类+重要性判定,**AI 失效时回落到算法兜底,只推重要通知**。

---

## 1. 背景与触发

### 1.1 生产事故(直接触发)

2026-06-01,生产环境 rule-check **全部报错** `401 无效的令牌`。根因:LLM 网关那把 `AI_API_KEY` 失效(同网关 + 本地有效 key 实测 200)。代码侧放大了伤害——[server/inngest/agents/rule-check-agent.ts:532-578](../../../server/inngest/agents/rule-check-agent.ts) 把 `failSafe('llm-call-error')` 的 `decision:'FAIL'` 跟"真实规则违反"在下游**完全同构**:无条件写 `match_status='未通过'`(空 reason)到合作方主表 + emit `MATCH_RULE_CHECK_FAILED`。结果:故障期间**每个候选人都被误判"未通过"并污染合作方生产库**。最近 40 条 audit 全是 `FAIL` + `llm_model:"unknown"`,确认系统性。

### 1.2 三条诉求(对应用户 prompt)

| 诉求 | 现状缺口 |
|---|---|
| rule-check LLM 报错不要默认 FAIL 阻断 | infra 错误被吞成候选人 FAIL,见 §1.1 |
| 一切报错(后端/LLM/agent/基础设施)都以消息发到告警页 | 错误源分散 5 处(AgentActivity / BehaviorAlert / EmSystemStatus / EventInstance / WS SLA);**抛出的异常、LLM body、API call、infra 故障今天根本不落库**(见 2026-05-22 spec §6.B) |
| 业务消息(事件、agent 运行)也要纳入,与预警分类筛选,不堆一起 | 无统一"消息"概念;`/alerts` 是 mock 的 P1-P4 告警页 |
| AI 管理/总结/发通知,AI 失效用算法兜底只发重要 | `/api/alerts` 无 AI;无 fallback 分级;无通知态 |
| 完善审计日志,所有数据 log 追踪全可查 | 见 [2026-05-22 统一日志与可追踪审计设计](./2026-05-22-unified-logging-audit-design.md):`LogEvent` 已设计但 **0% 实现** |

### 1.3 与既有设计的关系

- **审计全可查 = 落地已批准的 [2026-05-22 LogEvent 统一日志 spec](./2026-05-22-unified-logging-audit-design.md)。** 本 spec **不重新设计 LogEvent**,只:(a) 把它列为 P1 前置并执行其写入主干 + 查询 API;(b) 在 LogEvent 写入时**内联派生** `Notification`。
- **AI 管理器抄 [server/run-summary/synthesize.ts](../../../server/run-summary/synthesize.ts) + `RunAiSummary` 的模式**:plain server 模块 → `chatComplete` → Postgres 缓存 → 网关不可用走确定性 fallback。**不上 Inngest**(沿用既定:观测/合成类不进 Inngest)。
- **自动处理动作(auto_restart/throttle/scale)属 Manage 轴**,本期只**展示** `已自动处理` 状态(读 `BehaviorAlert.managerActionTaken`),不新建自动干预。

---

## 2. 设计原则

1. **确定性主干,AI 是增强层。** "LLM 网关挂了"是最高频告警源——若 AI 总结是通知能否工作的前提,网关一挂告警系统跟着哑火。因此:**捕获 → 分级 → 是否通知 → 站内展示,全程纯算法可独立完成**;AI 只叠在上面(更好的中文总结、聚类降噪、重要性复核)。AI 失效 → 回落算法,**只推重要(critical)**。
2. **LogEvent = 全量,Notification = 精选。** 全部 log/trace 进 LogEvent(可查可追踪);只有"值得用户看的"才派生成 Notification(避免刷屏)。每条 Notification 反向链回 LogEvent / run / 事件。
3. **消息与预警同表不同 `kind`。** 统一一张 `Notification`,`kind ∈ {message, alert}` + `severity` 分类筛选,UI 永不把两类堆在一起。
4. **零侵入捕获。** 错误捕获靠 `wrapInngestHandler` 的 `handler.error` 三件套(2026-05-22 §5.3),agent 不写业务代码即覆盖。
5. **可演进、易回滚。** 每层都有 env 开关(`LOG_EVENT_WRITE` / `NOTIFY_INGEST` / `ALERT_AI`);关掉退回旧 `/alerts`。

---

## 3. 架构:分层管道

```
 所有报错/日志(后端 · LLM · agent · 基础设施 · 抛出的 error)
    │  agent handler.error / em.publish / manage / llmCall / apiCall / dbCall
    ▼
┌─────────────────────────────────────────────────────────────┐
│  LogEvent 表  (单一可信源 · 全量 · 可查可追踪 = 审计日志)        │
│  runId × traceId × eventInstanceId × anchors(candidate/JR/…)  │
└───────────────┬─────────────────────────────────────────────┘
                │  写入时内联派生(NOTIFY_INGEST)
                │   · level∈{error,critical}        → kind=alert
                │   · isMessageWorthy(业务 lifecycle/event/manage/HITL) → kind=message
                │   · 其余(tool/db/api/debug)        → 仅留 LogEvent,不进通知中心
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Notification 表  (精选 · 消息+预警 · 按 dedupeKey 聚合预警)    │
│  确定性主干: severity 分级 · disposition · shouldNotify        │
└───────────────┬─────────────────────────────────────────────┘
                │  AI 增强层(plain route + PG 缓存 · off Inngest)
                │   lazy-on-view + eager-on-critical
                │   网关不可用 → 跳过,标 ai_source='fallback'
                ▼
   summarizeAlert(): 中文业务总结 · 同类聚类降噪 · 重要性复核
                │
                ▼
   消息通知中心 UI(站内权威记录)  +  NotifyChannel 接口(外部渠道 no-op,本期不实装)
                │
                └── 每条 → /monitor/runs/[id] | /correlations/[traceId]
                          | /rule-check/audits/[auditId] | /events?eventInstanceId=
```

---

## 4. 数据模型

### 4.1 `Notification`(新增)

```prisma
model Notification {
  id            String   @id @default(cuid())
  ts            DateTime @default(now())

  // ── 分类(筛选维度)─────────────────────────────────────
  kind          String   // "message" | "alert"
  severity      String   // message→ "info"; alert→ "warning" | "critical"
  category      String   // "system" | "agent" | "event" | "candidate" | "job"
  source        String   // 业务来源标签: agent 短名 | "RAAS API" | "LLM 网关" | "EM" | ...

  // ── 展示内容(确定性渲染)──────────────────────────────
  title         String   // 业务语言标题
  body          String   // 一句话说明(消息: 来自 events-catalog.desc / agent-names;预警: 算法或 AI 填)

  // ── 关联键(下钻 + 跳转)────────────────────────────────
  runId           String?
  traceId         String?
  eventInstanceId String?
  agent           String?  // canonical 短名
  anchorsJson     String?  // {candidate_id, job_requisition_id, upload_id, client_id}
  linkKind        String?  // "run" | "trace" | "rule_check" | "event" | "none" — UI 解析跳转目标
  linkId          String?

  // ── 预警专属(message 时为 null)───────────────────────
  dedupeKey     String?  // 聚合键: "llm_gateway_401" | "agent_error_rate.ruleCheck" | ...
  count         Int      @default(1)
  firstSeenAt   DateTime @default(now())
  lastSeenAt    DateTime @default(now())
  status        String?  // "firing" | "ack" | "resolved" | "auto_handled"
  disposition   String   @default("info_only") // "needs_human" | "auto_handled" | "info_only"
  managerAction String?  // 读自 BehaviorAlert.managerActionTaken(展示用)

  // ── AI 增强缓存(抄 RunAiSummary)──────────────────────
  aiSummary     String?
  aiSeverity    String?  // AI 复核后的严重度(可与算法 severity 不同)
  aiShouldNotify Boolean?
  aiSource      String?  // "llm" | "fallback" | "none"
  llmModel      String?
  aiGeneratedAt DateTime?

  // ── 通知 + 已读态 ──────────────────────────────────────
  shouldNotify  Boolean  @default(false) // 确定性主干算出;AI 在线时可下调噪声
  notifiedAt    DateTime?
  notifyChannel String?  // "in_app"(本期唯一真实)
  readAt        DateTime?

  @@unique([dedupeKey, status])          // 预警去重: 同 key 同 firing 状态只一行
  @@index([ts])
  @@index([kind, ts])
  @@index([severity, ts])
  @@index([category, ts])
  @@index([status])
  @@index([runId])
  @@index([readAt])
}
```

**说明**
- 预警按 `(dedupeKey, status)` 去重:同类报错持续发生 → `count++` + 刷新 `lastSeenAt`,不刷屏。`message` 的 `dedupeKey=null`(逐条独立,SQLite 允许多 null + null 组合)。
- `linkKind/linkId` 由入库时 `resolveLink()` 算好,UI 直接拼路由,不在前端做关联推断。
- AI 列全可空:`message` 永不调 AI;`alert` 在线才填,fallback 时 `aiSource='fallback'`、`aiSummary` 用算法模板。

### 4.2 与现有表的关系

- `LogEvent`(2026-05-22 spec 新增):**全量上游**。Notification 是它的精选下游。
- `BehaviorAlert`:**不删**,Monitor Agent 60s cron 的启发式(错误率/积压/HITL stale/run stalled/em degraded)继续写 BehaviorAlert,**并镜像 upsert 一条 `Notification(kind=alert)`**。`managerActionTaken` 透传给 `Notification.managerAction` 以显示"已自动处理"。
- `/api/alerts` 旧端点保留(旧 `/alerts` 回退用);新中心读 `/api/notifications`。

---

## 5. 分类与筛选

| 维度 | 取值 | 来源 |
|---|---|---|
| **kind** | 消息 message / 预警 alert | 入库分类器 |
| **severity** | 信息 info / 提醒 warning / 严重 critical | 算法 `severityOf()`,AI 可复核 |
| **category** | 系统故障 system / 智能体 agent / 事件 event / 候选人 candidate / 岗位 job | 由 LogEvent.category + source + anchors 映射 |
| **disposition** | 需要你处理 needs_human / 已自动处理 auto_handled / 仅通知 info_only | critical→needs_human;BehaviorAlert 有 managerAction→auto_handled;message→info_only |
| **read** | 未读 / 已读 | `readAt` |

**UI 默认筛选**:消息通知中心顶部 `全部 / 消息 / 预警` 段控(kind),下面是 category chips(带计数)+ severity + `只看需要我处理的` 开关。**消息与预警视觉分区,绝不混排同一列表段。**

---

## 6. 入库(Ingestion)

### 6.1 内联派生(主路径,无 poller)

在 `server/log/logger.ts` 写一条 LogEvent 后,fire-and-forget 调 `deriveNotification(logEvent)`(`NOTIFY_INGEST` env 开关):

```
deriveNotification(ev):
  if ev.level in {error, critical}:
      kind = "alert"
      dedupeKey = dedupeKeyOf(ev)         // 见 6.2
      severity  = severityOf(ev)          // error→warning, critical→critical, + 来源加权
      upsert Notification by (dedupeKey, status="firing"):
          on conflict: count++, lastSeenAt=now, title/body 取最新
          on insert  : disposition = severity=="critical" ? needs_human : info_only
                       shouldNotify = (severity=="critical")  // 主干阈值, AI 可调
      // 不在此处调 AI(见 §7),只写确定性行
  elif isMessageWorthy(ev):               // 见 6.3
      kind="message"; severity="info"; insert(每条独立)
  else:
      return                              // 仅 LogEvent, 不进中心
  link = resolveLink(ev)                  // run/trace/rule_check/event
```

`deriveNotification` 三层 try/catch,失败 `console.warn` 不抛——**绝不因通知派生失败影响主流程或 LogEvent 写入**。

### 6.2 `dedupeKeyOf` / `severityOf`(确定性)

- **dedupeKey**:优先用结构化信号——LLM 网关 401→`llm_gateway_401`;gateway 不可用→`llm_gateway_unavailable`;agent 抛错→`agent_error.<agent>.<errClass>`;EM degraded→`em_degraded`;rule-check infra park→`rule_check_parked.<reason>`。无结构化信号则 `hash(category+source+message 前 80 字)`。
- **severityOf**:`critical` = 影响面广/阻断业务(网关全挂、EM down、run stalled、rule-check 批量 park);`warning` = 单点可恢复(单次 retry 失败、低置信、单 agent 错误率升高);其余 `info`。来源/事件可加权(catalog `kind==="error"` 的事件直接 warning 起步)。

### 6.3 `isMessageWorthy`(消息白名单)

只放业务有意义的 lifecycle:`handler.start/handler.end`(仅真实业务 agent,排除 stub 噪声)、`em.publish` 的 `domain`/`gate` 类事件(查 events-catalog `kind`)、`manage_action`、HITL 待办创建/完成、候选人处理完成、JD 生成完成。**排除** `tool_call/db_call/api_call/debug`(它们留在 LogEvent 可查,不进中心)。消息 `title/body` 用 [lib/events-catalog.ts](../../../lib/events-catalog.ts) 的 `EventDef.desc` + [lib/agent-names.ts](../../../lib/agent-names.ts) 的双语名渲染——**纯算法、零 LLM、零开发者术语**。

### 6.4 派生告警(聚合,复用 Monitor Agent)

错误率/积压/SLA/DLQ 这类**跨多行聚合**的信号,无法从单条 LogEvent 内联算——继续由现有 Monitor Agent 60s cron 评估(behavior 轴),写 BehaviorAlert 时镜像 upsert Notification。

---

## 7. AI 管理器 + 算法 fallback

### 7.1 形态(off Inngest)

新模块 `server/notifications/summarize.ts`,签名抄 run-summary:

```typescript
async function summarizeAlerts(opts: { trigger: "lazy-on-view" | "eager-on-critical" }): Promise<void>
```

触发:
- **lazy-on-view**:`GET /api/notifications` 命中时,挑出 `kind=alert && aiGeneratedAt=null && status=firing` 的(限 N 条/次),后台补总结(不阻塞响应,响应先返回算法版)。
- **eager-on-critical**:`deriveNotification` 落了一条新的 critical alert 时,**异步**触发一次单条 `summarizeAlert(id)`(fire-and-forget;失败不影响入库)。

### 7.2 AI 在线路径

```
if isGatewayConfigured():
  try:
    out = chatComplete({ system: 告警分诊 prompt, user: <alert + 关联 LogEvent 摘要>,
                         temperature: 0.2, maxTokens: 400 })
    parse → { summary_zh, severity, should_notify, cluster_hint }
    update Notification: aiSummary, aiSeverity, aiShouldNotify, aiSource="llm", llmModel, aiGeneratedAt
    // 聚类降噪: cluster_hint 命中既有 firing alert → 合并(lastSeenAt/count),把本条标 resolved
  catch GatewayUnavailableError | 任意错误:
    → fallbackTriage(alert)        // 见 7.3, 绝不让 AI 失败冒泡
```

**关键**:AI 路径自身的失败/网关挂,**不抛**——直接落到 fallback。这保证"网关挂了"这条 critical 告警一定能被算法分诊并通知,即便 AI 不可用。

### 7.3 算法 fallback(`fallbackTriage`)

纯确定性,无 LLM:
- `aiSummary` = 模板渲染(`"<source> 发生 <severity> · 近 <window> 内 <count> 次 · <category>"` + 关联 run/JR)。
- `aiSeverity` = `severityOf`(已算)。
- **`aiShouldNotify` = 只 critical**(= "fallback 只发送重要通知")。warning/info 在 fallback 模式不主动通知,仅进中心。
- `aiSource = "fallback"`。

UI 上 `aiSource="fallback"` 的卡片标一个 `算法` 小 badge,区别于 AI 总结。

### 7.4 通知决策汇总

| 模式 | critical | warning | info(消息) |
|---|---|---|---|
| AI 在线 | 通知 | 聚类后通知(降噪) | 不通知,仅进中心 |
| AI 失效(fallback) | 通知 | **不通知**,仅进中心 | 不通知 |

"通知" = 置 `notifiedAt` + `notifyChannel="in_app"`(站内角标/红点);外部渠道见 §8。

---

## 8. 通知与渠道

- **本期唯一真实渠道 = 站内(in_app)**:消息通知中心 + 左导航角标计数(未读 needs_human 数)。
- **可插拔接口**:`server/notifications/channels.ts` 定义 `interface NotifyChannel { send(n: Notification): Promise<void> }`;实现 `InAppChannel`(写 `notifiedAt`)+ `NoopExternalChannel`(飞书/邮件占位,只 log "would send")。env `NOTIFY_CHANNELS=in_app`。未来外部渠道实现接口即可接入,不动调用方。

---

## 9. rule-check 基础设施报错修复(P1 核心)

### 9.1 区分 infra vs 真实 FAIL

[lib/rule-check/runner.ts](../../../lib/rule-check/runner.ts) 的 `failSafe` 已带 `fail_reason`。定义 **infra 类**:`llm-call-error | gateway-unavailable | ontology-graph-unavailable | parse-error | tool-loop-exhausted`。其余(LLM 正常返回了 fail 判定)= **真实规则违反**,逻辑不变。

新增纯函数 `isInfraFailure(reason): boolean`,加单测。

### 9.2 agent 行为改动

[server/inngest/agents/rule-check-agent.ts](../../../server/inngest/agents/rule-check-agent.ts) `decision==='FAIL'` 分支前置判断:

```
if result.decision === 'FAIL' && isInfraFailure(result.audit.fail_reason):
    // 基础设施报错 —— 不是候选人 FAIL
    log.error("rule_check.infra_error", { reason })          // → LogEvent(critical) → Notification(alert)
    throw new Error(`rule-check infra failure: ${reason}`)   // 让 Inngest 重试(指数退避)
    // 重试耗尽后 Inngest 标 run failed;不写 partner、不 emit FAILED;
    // run 停在可重放状态(已有 /api/rule-check-audits/[auditId]/replay)
```

→ **基础设施报错时:不写 `未通过` 到合作方主表、不 emit `MATCH_RULE_CHECK_FAILED`、不落 audit FAIL 行**(或落一行 `decision='ERROR'` 标记,便于重放筛选——见 9.3)。重试全部失败 → 一条 critical 告警 + 事件挂起待重放。网关恢复后批量 replay。

真实规则违反(`!isInfraFailure`)→ 现有 partner 写 + emit FAILED **完全不变**。

### 9.3 audit 标记(可选,便于重放圈选)

infra park 时写 audit 行 `decision='ERROR'`(新增枚举值)而非 `FAIL`,`fail_reason` 保留。这样故障窗的"误判"与"真实未通过"在 audit 上可区分,重放只圈 `decision='ERROR'`。`/api/rule-check-audits` 的 decision filter 加 `ERROR`。

### 9.4 善后(运维,非本 PR 代码)

故障窗(约 2026-06-01 07:45 起)已被写成 `未通过` 的候选人,需用 [/api/rule-check-audits/[auditId]/replay](../../../app/api/rule-check-audits) 批量重放纠正——本 spec 提供圈选 SQL/脚本说明,执行由运维触发。

---

## 10. 深链(每条消息可跳转)

入库时 `resolveLink(ev)` 按优先级选目标,写入 `linkKind/linkId`:

| 条件 | linkKind | UI 路由 |
|---|---|---|
| rule-check 相关(有 audit_id) | rule_check | `/rule-check/audits/[auditId]` |
| 有 runId | run | `/monitor/runs/[runId]` |
| 仅 traceId | trace | `/correlations/[traceId]` |
| 事件类(有 eventInstanceId) | event | `/events?eventInstanceId=[id]` |
| 都没有 | none | 不可跳(灰显) |

卡片整体可点 → 跳目标;目标页就是"该事件 / 该 Agent run 的单条完整过程"。

---

## 11. UI:消息通知中心

### 11.1 路由与命名

- 新路由 `/notifications`(canonical);旧 `/alerts` 改为 `redirect('/notifications')`。
- 左导航 `alerts` 项:label `nav_alerts` 文案 **告警 → 消息通知**(zh)/ "Notifications"(en);icon 保留 `alert`(或换 `bell`);count = 未读 needs_human 数。

### 11.2 布局(参考用户提供的设计图)

```
消息通知 · NOTIFICATIONS
副标题: 系统、智能体、事件、候选人与岗位的状态提醒集中在这里。智能体能自动处理的会自动处理,需要你的会标出来。
                                                          [全部已读] [通知设置]

[ 通知 N ]  [ 人工待办 M ]  [ 值班 & 自治 ]          ← 顶 tab(沿用图)

— "通知" tab 内 —
段控:  [全部] [消息] [预警]                          ← kind 分类(核心:不堆一起)
chips: [全部] [系统故障] [智能体] [事件] [候选人] [岗位]   计数      [开关] 只看需要我处理的
X 条需要你处理 ·  Y 条已自动处理

卡片列表(消息段 / 预警段视觉分区):
┌────────────────────────────────────────────────────────────┐
│ [icon] 标题            [严重|提醒|信息]        12m 前   [v]   │
│        一句话 body(AI 总结 或 算法模板/events-catalog.desc) │
│        [分类 badge] source(mono)   [算法?]   [需要你处理|已自动处理] │
└────────────────────────────────────────────────────────────┘
  整卡可点 → 跳 linkKind 对应路由
```

- **人工待办 tab**:读 HumanTask(HITL)——复用现有 `/inbox` 数据,这里只做入口聚合。
- **值班 & 自治 tab**:值班表 + "哪些预警允许 agent 自动处理"的自治开关展示(自治动作属 Manage 轴,本期只读展示 + 占位)。

### 11.3 数据获取

`GET /api/notifications?kind=&category=&severity=&needsHuman=&unread=&cursor=&limit=` → 读 `Notification`,按 ts 倒序,游标分页。命中时后台触发 lazy AI 总结(§7.1)。`POST /api/notifications/read`(单条/全部已读)、`POST /api/notifications/[id]/ack`。

---

## 12. i18n / 命名

新增 `ntf_*` 命名空间(zh+en 各一份):`ntf_title`(消息通知)、`ntf_sub`、`ntf_tab_all/messages/alerts`、`ntf_kind_message/alert`、`ntf_sev_info/warning/critical`(信息/提醒/严重)、`ntf_cat_system/agent/event/candidate/job`、`ntf_disp_needs_human/auto_handled`、`ntf_mark_all_read`、`ntf_settings`、`ntf_ai_fallback_badge`(算法)等。改 `nav_alerts` 文案为"消息通知"。审计相关 `audit_*` key 见 2026-05-22 spec。

---

## 13. 分阶段 + 文件清单

### P1 — 捕获全部 + 修 rule-check(止血优先)

**rule-check 修复(最急,独立)**
- 改 `lib/rule-check/runner.ts`:`isInfraFailure()` + export;`server/inngest/agents/rule-check-agent.ts` infra 分支 throw-to-retry,不写 partner / 不 emit FAILED。
- audit `decision='ERROR'` 枚举 + `/api/rule-check-audits` filter。
- 测试:`runner.test.ts` 加 "infra 错误不产生候选人 FAIL";agent 测试加 "infra 错误不写 partner、不 emit FAILED、抛错触发重试"。

**LogEvent 写入主干(审计全可查)** — 执行 [2026-05-22 spec](./2026-05-22-unified-logging-audit-design.md) P0+P1+P2:
- `prisma/schema.prisma` +`LogEvent`、+`Notification`。
- `server/log/logger.ts`(3 路 sink)+ `price-table.ts` + `cost.ts`;旧 logger 改 shim。
- `server/inngest/wrap-handler.ts`(`handler.error` 兜底捕获)+ 5 个 agent + stub-factory 各 1 行接入。
- LLM gateway / EM publish / Manage 双写 LogEvent。
- `app/api/logs`(+aggregates +[id])查询端点 + vitest。

### P2 — 消息通知层

- `prisma`:`Notification`(已在 P1 加表)。
- `server/notifications/derive.ts`(`deriveNotification` + `dedupeKeyOf` + `severityOf` + `isMessageWorthy` + `resolveLink`)+ vitest。
- `server/log/logger.ts`:写后 fire-and-forget 调 `deriveNotification`(`NOTIFY_INGEST` 开关)。
- `server/notifications/summarize.ts`(AI 管理器)+ `fallbackTriage` + 告警分诊 prompt + vitest(含"网关挂 → fallback only critical")。
- `server/notifications/channels.ts`(`NotifyChannel` + InApp + NoopExternal)。
- Monitor Agent 写 BehaviorAlert 时镜像 upsert Notification。
- `app/api/notifications`(list + read + ack)+ vitest。

### P3 — 消息通知中心 UI

- `app/notifications/page.tsx` + `components/notifications/NotificationsContent.tsx`(三 tab + kind 段控 + category chips + 分区卡片 + 跳转)。
- `app/alerts/page.tsx` → redirect。
- `components/shared/LeftNav.tsx` 文案改;count 接未读。
- `lib/i18n.tsx` +`ntf_*`(zh+en)。

### 文件清单(本 spec 新增/改动汇总)

| 类型 | 路径 |
|---|---|
| 新增 | `server/notifications/derive.ts` · `summarize.ts` · `channels.ts` · `prompt.ts`(+ 各 `.test.ts`) |
| 新增 | `app/api/notifications/route.ts` · `[id]/ack/route.ts` · `read/route.ts`(+ test) |
| 新增 | `app/notifications/page.tsx` · `components/notifications/NotificationsContent.tsx` |
| 新增(P1,LogEvent) | 见 2026-05-22 spec §11 文件清单 |
| 改动 | `prisma/schema.prisma`(+LogEvent +Notification)· `lib/rule-check/runner.ts` · `server/inngest/agents/rule-check-agent.ts` · `server/log/logger.ts`(派生钩子)· `server/inngest/agents/monitor-agent.ts`(镜像)· `components/shared/LeftNav.tsx` · `lib/i18n.tsx` · `app/alerts/page.tsx` · `app/api/rule-check-audits`(ERROR filter) |

---

## 14. 测试 / Definition of Done

1. **rule-check 止血**:infra 错误(网关 401/unavailable/超时/parse-error)→ 不写 `未通过` 到 partner、不 emit `MATCH_RULE_CHECK_FAILED`、抛错触发 Inngest 重试;真实规则违反路径不变。单测覆盖两条路径。
2. **审计全可查**:任意 agent run 的 lifecycle / step / tool_call / llm_call / api_call / `handler.error` 都能在 `/api/logs` 按 `runId/traceId/agent/candidate_id` 查到(含今天会丢的抛错)。
3. **消息纳入**:事件发布 / agent run 起止 / 候选人处理完 出现在通知中心 `消息` 段,业务语言、可跳转到该 run。
4. **预警 + AI**:rule-check infra 报错 → 通知中心 `预警` 段一条 critical,有 AI 中文总结;**关掉网关(模拟 AI 失效)→ 仍出现该 critical 预警(算法 fallback,标 `算法` badge)且被通知**;warning 在 fallback 模式不通知。
5. **分类不堆一起**:`全部/消息/预警` 段控 + category chips 生效,两类视觉分区。
6. **跳转**:每条卡片点击跳到 `/monitor/runs/[id]` | `/correlations/[traceId]` | `/rule-check/audits/[auditId]` | `/events?eventInstanceId=`。
7. **零回归**:旧 `/api/alerts`、`/api/audit`、rule-check 真实 FAIL 路径、partner dual-write 契约不变;vitest 全绿;`npm run build` 通过。
8. **可回滚**:`NOTIFY_INGEST=0` → 不派生通知,LogEvent 照写;`ALERT_AI=0` → 全走 fallback。

---

## 15. 不做的事(YAGNI)

- ❌ 不做真实外部渠道(飞书/邮件/短信)——只留接口 + no-op。
- ❌ 不新建自动干预动作(auto_restart/throttle/scale)——属 Manage 轴,本期只**展示** `已自动处理`。
- ❌ 不上 Inngest 跑 AI 总结——plain route + PG 缓存。
- ❌ 不做 RBAC / 通知订阅偏好持久化——`通知设置` 本期占位。
- ❌ 不做 ES/FTS——SQLite/PG LIKE 够用(沿用 2026-05-22 决策)。
- ❌ 不重写 `/monitor/audit`——与新审计互补。

---

## 16. Open questions

无——用户已确认:rule-check 重试后挂起+告警 / 仅站内渠道 / 一份分阶段 spec / 审计全可查 / 消息+预警统一但分类筛选 / 每条可跳转。实现细节(列表分页 vs 游标、卡片虚拟滚动、AI 分诊 prompt 具体措辞)在 writing-plans 阶段细化。
