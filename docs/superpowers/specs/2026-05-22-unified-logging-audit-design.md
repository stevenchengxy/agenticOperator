# 统一日志与可追踪审计系统 — 设计文档

> 作者: Claude(代 Steven)
> 日期: 2026-05-22
> 状态: 待 user review(写完直接走 user gate,不派 reviewer per user preference)
>
> **覆盖范围**: AO 仓内所有 agent / event publish / LLM / 外部 HTTP / DB / Manage 干预的日志写入路径与浏览 UI。

---

## 0. 一句话目标

把 AO 现在 **三套并行、互不连通** 的日志系统(`AuditLog` / `AgentActivity` / 文件 JSONL)收敛到 **一张 `LogEvent` 表 + 一个 `logger` 入口 + `/audit/*` 六个极简 sub-page**,让任何 agent、任何事件、任何 LLM/HTTP/DB 调用都能从浏览器里按 `runId × traceId × eventInstanceId × candidate_id` 等 **强相关键** 反向追溯,审计日志真正成为一个 **可追踪 (traceable)** 的运维工具。

---

## 1. 为什么改

### 1.1 现状: 三套日志互不连通

| 系统 | 写入方 | 存储 | 现有 UI |
|---|---|---|---|
| **A. `AuditLog` 表 (EM publish 审计)** | `server/em/persistence.ts::writeAudit()` — 每次 `em.publish` 写一行 | SQLite,`{eventName, traceId, payload, payloadDigest, source, createdAt}` | `/audit` 老页 + `/api/audit` |
| **B. `AuditLog` 表 (Manage 干预审计,同表 `action` 命名空间)** | `lib/manage/audit.ts` — pause/cancel/replay/config 等写一行 | 同上,`action` 字段 `manage.*` | `/monitor/audit` 新页 + `/api/manage/audit` |
| **C. `AgentActivity` 表 (agent narrative)** | `server/agent-logger.ts::createAgentLogger()` | SQLite,`{runId, nodeId, agentName, type, narrative, metadata}` | `/live` Logs tab + `/api/runs/[id]/activity` + `/api/agent-activity` |
| **D. 文件 JSONL `logs/<agent>-<date>.log`** | **另一个同名** `lib/agent-logger.ts::createAgentLogger()` + `currentLogger()` ALS | 磁盘 JSONL,最丰富 (含 anchors + 全量 req/resp) | **完全没有 UI**,只能 `tail -f` |

### 1.2 核心痛点(对应用户 prompt 一一映射)

| 用户诉求 | 现状缺口 |
|---|---|
| "从任何 agent 都能看到 log" | A/B/C 都按 runId 索引 agent,D 文件日志按 agent 名分文件,但 **D 在 UI 不可见**;按 agent 看"该 agent 的所有 LogEvent (跨 run)" 没有页面 |
| "从任何事件都能看到 log" | 没有"按事件维度"的视图。能按 runId 看,但同一个 `MATCH_RULE_CHECK_PASSED` 在不同 run 里发生 N 次,想 "看到这个事件历史上所有调用 + 它的因果链" 现在做不到 |
| "审计页面 UI 展示要能迅速定位问题" | 老 `/audit` 4 列纯表,无 payload 展开、无跨表 join、无跳转;`/monitor/audit` 只看 Manage 域,看不到 EM publish 或 agent 内部细节 |
| "大模型消耗 log 和统计" | `withLlmTelemetry` 写了 tokens 进 AgentActivity,但 **prompt/response 文本不持久化任何地方**;cost 不计算;无聚合页 |
| "审计 UI 极简,不要一个页面过多信息" | 当前 `/monitor` 页是反例: KPI strip + 多 tab + 多 panel + 抽屉混在一起。新 audit 必须避免此风险 |
| "让审计日志真正成为可追踪的日志" | 三套数据无 join 查询能力;trace_id 仅 A 强制,C 软填,D 写但不查 |

### 1.3 命名冲突

`lib/agent-logger.ts` 和 `server/agent-logger.ts` **都** 导出 `createAgentLogger`,语义完全不同(一个写 JSONL,一个写 Prisma)。每个 agent 文件同时绑两份(`fileLogger` + `log`),双写双 schema,语义偏移概率随代码增长。本 spec 不删任一个,但加 shim 让两边都委托到新 logger。

---

## 2. 设计原则

1. **单一可信源 (Single Source of Truth)**: 新增 **一张** 表 `LogEvent`,所有路径写它。老表保留并 **双写**,新页 100% 读 `LogEvent`,旧页不动。
2. **强相关键即一等公民**: 每条 `LogEvent` 必须至少有 `runId | traceId | eventInstanceId` 之一。`anchors`(candidate_id / job_requisition_id / upload_id …)为业务侧关键字,索引并支持下钻。
3. **零侵入覆盖**: 通过 `wrapInngestHandler` 把 logger 绑定到 Inngest 函数入口,任何 agent 不写一行业务代码也保证 `handler.start / handler.end / handler.error` 三件套被写下来。
4. **UI 极简,一页一焦点**: `/audit/*` 拆 6 个 sub-page。每页 **硬约束** 三个交互区上限 (filter bar + 主表/卡片 + 右抽屉);KPI 数字 ≤ 4;不允许嵌套 tab。
5. **可演进、易回滚**: 任何阶段失败,关闭 `LOG_EVENT_WRITE` env,UI 退回老 `/audit`。30 天后若稳定再考虑去掉文件 JSONL 写路径(但 DB 写永远在)。

---

## 3. After 架构

### 3.1 写入路径

```
                                    ┌─────────────────────────┐
   agent handler ──┐                │                         │
   em.publish   ──┤                 │  server/log/logger.ts   │       SQLite
   manage action ─┼────► currentLogger() ALS ─► writer ──────►│ LogEvent table
   LLM gateway  ──┤                 │                         │       (+ index)
   RoboHire     ──┤                 │   - LogEvent.create()   │
   Partner-PG   ──┤                 │   - 文件 JSONL append   │       磁盘
   Allmeta      ──┘                 │   - 终端 ANSI echo      ├─► logs/<agent>-<date>.log
                                    │   - 老 AuditLog 双写    │
                                    │   - 老 AgentActivity 双写│
                                    └────────────┬────────────┘
                                                 │
                                                 ▼
                                          AuditLog (legacy)
                                          AgentActivity (legacy)
```

### 3.2 读取路径

```
   /audit                 ┐
   /audit/stream          │
   /audit/events          ├─► /api/logs (查询)         ┐
   /audit/agents          │   /api/logs/aggregates       ├─► prisma.logEvent
   /audit/agents/[short]  │   /api/logs/[id] (单条详情) │
   /audit/llm             │                              │
   /audit/runs/[id]       ┘                              │
                                                          │
   /live, /monitor, /fleet (老页面,加 🔍 跳转) ──┘
```

---

## 4. 数据模型

### 4.1 `LogEvent` Prisma model(新增)

```prisma
model LogEvent {
  id                   String   @id @default(cuid())
  ts                   DateTime @default(now())
  level                String   // debug | info | notice | warn | error | critical
  category             String   // event_publish | agent_lifecycle | agent_step
                                // | tool_call | llm_call | api_call | db_call
                                // | manage_action | system
  source               String   // ws | em | manage | system | external | raas
  process              String   // next | inngest | raas-bridge | <external-pid>

  // ── Correlation keys (sparse, indexed) ─────────────────────
  // At least one of runId / traceId / eventInstanceId MUST be present
  // for a row to be considered "traceable". The writer warns on stdout
  // when none of the three are set (does not crash).
  agent                String?  // canonical short: "matchResume" | "ReqSync"
  runId                String?
  traceId              String?
  eventInstanceId      String?  // FK → EventInstance.id (no relation, soft FK)
  eventName            String?  // e.g. MATCH_RULE_CHECK_PASSED
  anchorsJson          String?  // JSON: {candidate_id, job_requisition_id, upload_id, …}

  // ── Payload ─────────────────────────────────────────────────
  message              String   // short narrative shown in row (≤ 240 chars)
  payloadJson          String?  // full structured payload; max 256 KB
                                // (truncated with "… +N kb" suffix)
  payloadDigest        String?  // sha256:16 chars — tamper detection + dedup
  durationMs           Int?
  status               String?  // ok | err | warn | pending

  // ── LLM-specific (sparse, only for category=llm_call) ──────
  llmModel             String?
  llmPromptTokens      Int?
  llmCompletionTokens  Int?
  llmTotalTokens       Int?
  llmCostUsd           Float?   // computed at write-time from PRICE_TABLE
  llmFinishReason      String?  // stop | length | tool_calls | content_filter

  @@index([ts])
  @@index([agent, ts])
  @@index([runId, ts])
  @@index([traceId, ts])
  @@index([eventInstanceId])
  @@index([eventName, ts])
  @@index([category, ts])
  @@index([level, ts])
}
```

**Capacity**: 当前 4 个真实 agent ≈ 3 KB/run 文件日志,数千 run/day ≈ 10 MB/day。SQLite 单表 1 GB 无压力(SSD 上索引建立 < 1 min)。**TTL**: 保留 30 天,daily Inngest cron 跑 `prisma.logEvent.deleteMany({ where: { ts: { lt: <30d ago> } } })`。

**索引选择理由**:
- `[ts]` — 默认时间序扫
- `[agent, ts]` / `[runId, ts]` / `[traceId, ts]` — 三个最高频下钻路径
- `[eventName, ts]` — `/audit/events` 左栏的"事件频次"查询
- `[category, ts]` / `[level, ts]` — `/audit/stream` 的 filter bar
- 没有 `anchorsJson` 索引: SQLite JSON 索引能力弱,anchors 查询走 app 端 LIKE,数据量小够用

### 4.2 兼容性: 老表不变

`AuditLog`、`AgentActivity`、`WorkflowRun`、`WorkflowStep`、`HumanTask` 字段全部不动。所有现有 API (`/api/audit`、`/api/runs/[id]/activity`、`/api/agent-activity`、`/api/manage/audit`) 继续读老表,响应 schema 不变。

---

## 5. 写入层

### 5.1 新模块 `server/log/logger.ts`

```typescript
export type AgentLoggerCtx = {
  agent?: string;
  nodeId?: string;
  runId?: string | null;
  traceId?: string | null;
  eventInstanceId?: string | null;
  eventName?: string | null;
  anchors?: Record<string, string | null | undefined>;
};

export interface AgentLogger {
  // ── Lifecycle ────────────────────────────────────────────
  event(kind: string, data?: unknown): void;           // 短事件,fire-and-forget
  step<T>(name: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T>;
  error(kind: string, err: unknown, meta?: Record<string, unknown>): void;

  // ── Cross-cutting (called from clients via currentLogger) ─
  apiCall(label: string, info: ApiCallInfo): void;     // category=api_call
  dbCall(label: string, info: DbCallInfo): void;       // category=db_call
  llmCall(info: LlmCallInfo): void;                    // category=llm_call

  // ── Manage action / EM publish (called from those layers) ─
  manageAction(action: string, data: unknown): void;
  emPublish(eventName: string, data: unknown): void;

  // ── Child / context ──────────────────────────────────────
  child(extra: Partial<AgentLoggerCtx>): AgentLogger;
  readonly ctx: Readonly<AgentLoggerCtx>;
}

export function createAgentLogger(ctx: AgentLoggerCtx): AgentLogger;
export function runWithLogger<T>(logger: AgentLogger, fn: () => Promise<T> | T): Promise<T> | T;
export function currentLogger(): AgentLogger | null;
export function createNullLogger(): AgentLogger;
```

**写入语义**:
- 每次方法调用 → 一行 `LogEvent` row(insert)+ 一行 JSONL append + 一行 ANSI 终端 echo
- 三路 sink 独立 try/catch,任一失败 console.warn,不抛错(同 `safeWrite` 现有原则)
- DB insert 是 fire-and-forget(在 `await` 链外 `.catch(console.warn)`),不阻塞 agent
- payloadJson 超 256 KB 截断,加 `"… +Nkb truncated"` 后缀,**digest 仍按全量算**(保证可追踪原始数据 hash)

### 5.2 老 logger 改 shim

`lib/agent-logger.ts` 和 `server/agent-logger.ts` 改为:
```typescript
// shim — delegates to server/log/logger
export { createAgentLogger, runWithLogger, currentLogger, createNullLogger }
  from "@/server/log/logger";
// 保留老 type alias 以兼容 import
```

老调用 `createAgentLogger({ agent, runId, traceId, anchors })` 和 `createAgentLogger({ agent, nodeId, runId })` 都能正常工作,因为新 `AgentLoggerCtx` 是两者超集。

### 5.3 强制覆盖: `wrapInngestHandler`

新 helper `server/inngest/wrap-handler.ts`:

```typescript
export function wrapInngestHandler<TEvent = unknown>(
  meta: { agent: string; nodeId?: string },
  handler: (ctx: InngestCtx<TEvent>, log: AgentLogger) => Promise<unknown>,
) {
  return async (ctx: InngestCtx<TEvent>) => {
    const eventData = (ctx.event.data ?? {}) as Record<string, unknown>;
    const log = createAgentLogger({
      agent: meta.agent,
      nodeId: meta.nodeId,
      runId: extractRunId(ctx),
      traceId: extractTraceId(eventData),
      eventName: ctx.event.name,
      eventInstanceId: typeof eventData._eventInstanceId === "string"
        ? eventData._eventInstanceId : null,
      anchors: {
        candidate_id: eventData.candidate_id as string | undefined,
        job_requisition_id: eventData.job_requisition_id as string | undefined,
        upload_id: eventData.upload_id as string | undefined,
        client_id: eventData.client_id as string | undefined,
      },
    });
    return runWithLogger(log, async () => {
      log.event("handler.start", { event: ctx.event.name, data: eventData });
      try {
        const out = await handler(ctx, log);
        log.event("handler.end", { ok: true });
        return out;
      } catch (e) {
        log.error("handler.error", e);
        throw e;
      }
    });
  };
}
```

每个 agent 文件 1 行改动:

```typescript
// before
export const matchResumeAgent = inngest.createFunction(
  { id: "match-resume-agent", triggers: [{ event: "MATCH_RULE_CHECK_PASSED" }] },
  async ({ event, step, runId }) => { ... }
);

// after
export const matchResumeAgent = inngest.createFunction(
  { id: "match-resume-agent", triggers: [{ event: "MATCH_RULE_CHECK_PASSED" }] },
  wrapInngestHandler({ agent: "matchResume", nodeId: "10-2" }, async (ctx, log) => {
    // 函数体里的 `runWithLogger(fileLogger, ...)` + `createAgentLogger(...)` 全部删掉,
    // 直接用 `log.*` 或在嵌套调用里 `currentLogger().*`
    ...
  })
);
```

`stub-factory.ts` 同样改一行 — 所有 stub agent 一并继承 `handler.start/end/error` 三件套。

### 5.4 LLM gateway 接入

`server/llm/gateway.ts::chatComplete` 在拿到 completion 之后加:

```typescript
const log = currentLogger();
if (log) {
  log.llmCall({
    model: gateway.model,
    toolName: opts.toolName ?? "chat",
    promptMessages: opts.messages,
    responseText: completion.choices[0]?.message?.content ?? "",
    usage: completion.usage,
    durationMs,
    finishReason: completion.choices[0]?.finish_reason,
    costUsd: computeCost(gateway.model, completion.usage),
  });
}
```

`server/log/price-table.ts`(新增): 5 个模型内置单价 (USD per 1K tokens):

| Model | prompt $/1K | completion $/1K |
|---|---|---|
| google/gemini-3-flash-preview | 0.000075 | 0.00030 |
| openai/gpt-4o-mini | 0.000150 | 0.00060 |
| openai/gpt-4o | 0.00250 | 0.01000 |
| anthropic/claude-opus-4-7 | 0.01500 | 0.07500 |
| anthropic/claude-sonnet-4-6 | 0.00300 | 0.01500 |

未列模型 cost=null,UI 显示 "—"。

**Env 开关 `LOG_LLM_BODIES`**:
- `full` (默认 dev) — prompt + response 全量写 payloadJson
- `heads` (默认 prod) — 各取前 500 char,加 `"… +Nkb truncated"` 标记
- `none` — 只写 metadata,payloadJson 留空

### 5.5 EM publish 双写

`server/em/persistence.ts::writeAudit` 加:

```typescript
await prisma.auditLog.create({ ... });  // 现有
const log = currentLogger();
if (log) {
  log.emPublish(input.eventName, {
    traceId: input.traceId,
    source: input.source,
    payloadDigest: digest,
    payload: input.payload,
  });
}
// 若 currentLogger 为空(从 UI 直接调 em.publish 的边缘场景),
// fallback 用 createAgentLogger({ agent: "em", traceId: input.traceId }) 写一次。
```

### 5.6 Manage 双写

`lib/manage/audit.ts::writeManageAudit` 同模式: 写 AuditLog 后用 `currentLogger()` 或 fallback logger 写一行 LogEvent (`category="manage_action"`)。

### 5.7 已接 ALS 的 cross-cutting 模块

`lib/robohire-client.ts`、`lib/partner-pg/client.ts`、`lib/allmeta-client.ts` 已在用 `currentLogger().apiCall(...)`。新 logger 的 `apiCall(...)` 会落到 `LogEvent (category="api_call")`。**callsite 不改**。

### 5.8 "可追踪" 校验

`server/log/logger.ts` 在每次 write 时检查 ctx 是否至少有一个 `runId/traceId/eventInstanceId` 非空:
- 有 → 写 LogEvent
- 无 → 仍写,但 `level=warn`,message 自动加 `[untraceable]` 前缀,console.warn 一行 `[logger] untraceable write from <agent>/<kind>`(便于 dev 阶段抓漏)

这就是"让审计日志真正成为可追踪的日志"在写入侧的实现 — **被动度量 + 主动告警,但不阻塞写**。

---

## 6. 查询 API

### 6.1 `GET /api/logs` — 通用检索

```
查询参数(全部 optional,无参 → 最近 200 条按 ts 倒序):
  &agent=<canonical>            — 精确匹配
  &runId=<id>
  &traceId=<id>
  &eventInstanceId=<id>
  &eventName=<NAME>
  &category=event_publish|agent_lifecycle|agent_step|tool_call|llm_call|api_call|db_call|manage_action|system
  &level=debug|info|notice|warn|error|critical (可逗号多选)
  &since=<ISO>&until=<ISO>      — 时间窗
  &anchor.candidate_id=<id>     — 嵌套 anchor 过滤(走 LIKE on anchorsJson)
  &anchor.job_requisition_id=<id>
  &q=<text>                     — 全文 LIKE 'message + payloadJson'
  &cursor=<opaque>              — 分页(基于 ts + id)
  &limit=<N>                    — 默认 200, max 500

响应:
  {
    rows: Array<{
      id, ts, level, category, source, process,
      agent, runId, traceId, eventInstanceId, eventName,
      anchors: object,                         // 解析后
      message, durationMs, status,
      payloadPreview: string | null,           // 首 200 char,避免列表传巨大 payload
      hasFullPayload: boolean,
      llmModel?, llmTotalTokens?, llmCostUsd?,
    }>,
    nextCursor: string | null,
    total: number,
    fetchedAt: ISO,
  }
```

### 6.2 `GET /api/logs/aggregates` — 聚合统计

```
查询参数:
  &since=<ISO>&until=<ISO>      — 必填
  &groupBy=model|agent|event|hour|category|level
  &metric=count|tokens|cost|avg_latency|p95_latency|err_rate
  &filter.agent=&filter.category=&filter.level= (optional pre-filters)

响应:
  {
    groups: Array<{ key: string, value: number, n: number }>,
    total: { count: number, tokens?: number, cost?: number },
    meta: { since, until, generatedAt },
  }
```

### 6.3 `GET /api/logs/[id]` — 单条详情

返回单条 LogEvent 全量(含 payloadJson 256 KB),用于右抽屉的 "查看完整 payload"。**列表 API 不返回 payloadJson**,避免传输负担。

### 6.4 端点测试

每个端点 vitest,golden-file 风格:
- happy path: 插入 N 条 fixture,断言 filter / pagination / aggregation 输出 shape
- 边界: 空表 → `{rows:[], total:0}`;cursor 越界 → `nextCursor=null`;limit > 500 → clamp
- 错误: 缺参 (`aggregates` 不带 `groupBy`) → 400

---

## 7. UI 设计

### 7.1 路由结构

```
/audit                    layout(左侧栏,6 项) + 概览页内容
├─ /audit                 概览  (Overview)
├─ /audit/stream          实时流 (Stream)
├─ /audit/events          按事件 (By Event)
├─ /audit/agents          按 agent (By Agent)
│  └─ /audit/agents/[short]  单 agent 详情
├─ /audit/llm             LLM 调用 (LLM Calls)
└─ /audit/runs/[id]       单 run 全量
```

### 7.2 Layout (`app/audit/layout.tsx`)

```
┌─ Shell (AppBar + LeftNav) ─────────────────────────────────┐
│ AppBar: 面包屑 "治理 / 审计日志 / <sub-page name>"          │
├──────────┬─────────────────────────────────────────────────┤
│ Sub-nav  │  Sub-page content                                │
│ (160px)  │  (1 fr — 最多 3 个交互区,见 §7.4 硬约束)         │
│          │                                                  │
│ 概览     │                                                  │
│ 实时流   │                                                  │
│ 按事件   │                                                  │
│ 按 agent │                                                  │
│ LLM 调用 │                                                  │
│ 单 run   │                                                  │
└──────────┴─────────────────────────────────────────────────┘
```

Sub-nav 是简单的 `<aside>` + 6 个 `<Link>`,active 态 `bg-accent-bg text-accent`。无折叠、无搜索、无图标 — 极简。

### 7.3 每页职责与交互区

| 路由 | 职责(一句话) | 交互区 1 | 交互区 2 | 交互区 3 |
|---|---|---|---|---|
| `/audit` | 24h 总览 | 4 张 KPI 卡(总条数 / 错误数 / LLM tokens / LLM cost) | 一条 sparkline(过去 24h 每 5 min 桶,按 level 堆叠) | 无 |
| `/audit/stream` | tail -f 风格 LogStream | Filter bar (level / category / agent / 时间窗 / q 搜索) | 主表(虚拟滚动,新行从顶部流入) | 右抽屉:点行展开 payloadJson + 跨表 join 跳转 |
| `/audit/events` | 按事件名维度 | 左:事件列表(按 24h 频次排,搜索) | 中:选中事件的最近 N 个实例 | 右抽屉:点实例 → 因果链 (publish → consumer agent → emit 出的下游 event)(走 `/api/runs/[id]/trace` 复用) |
| `/audit/agents` | 卡片矩阵 | 网格 N×3,每卡: agent 名 + 24h 调用次数 + 错误率 sparkline | 无 | 无(点卡 → `/audit/agents/[short]`) |
| `/audit/agents/[short]` | 单 agent 详情 | 顶部: 该 agent 的 4 KPI(24h calls / errors / avg latency / total tokens) | 主表: 该 agent 全部 LogEvent(filter bar 同 stream) | 右抽屉(点行) |
| `/audit/llm` | LLM 调用专属 | 顶部双折线: tokens / cost 24h 时序 | 主表: 每条 llm_call(model / agent / tokens / cost / duration) | 右抽屉(点行): model / prompt 全量 / response 全量 / usage / cost / finish reason |
| `/audit/runs/[id]` | 单 run 完整 | 顶部: run header(triggerEvent / status / span / agents involved) | 主表 / 时间轴: 该 run 全部 LogEvent(可切换 list / timeline 两种 viz,但不是 tab,是按钮切换) | 右抽屉(点行) |

### 7.4 极简硬约束(实现 review checklist)

每个 sub-page 提 PR 时必须自检:

- [ ] 主区块数 ≤ 3 (filter bar / 主表 / 右抽屉)
- [ ] KPI 数字 ≤ 4
- [ ] 没有任何 `<Tabs>` 组件嵌套
- [ ] 没有 KPI strip + 多 panel + 多 tab 同时出现(`/monitor` 的反面教材)
- [ ] 右抽屉是 overlay 不是 split-pane (点空白处关闭)
- [ ] 所有 correlation key (runId / traceId / eventInstanceId / candidate_id / job_requisition_id) 在 UI 上都是 **可点击链接** → 跳到对应维度的过滤视图

### 7.5 右抽屉的"可追踪"细节

任意一行打开右抽屉,顶部固定 5 个跳转按钮:

```
┌─ Drawer header ──────────────────────────────────────────┐
│ matchResume · 2026-05-22 14:32:11 · tool_call · 1840ms   │
│                                                          │
│  [ 该 run 全部 ]  [ 同 trace ]  [ 同事件实例 ]            │
│  [ 同 candidate ] [ 同 JR ]                              │
│                                                          │
├─ Payload ────────────────────────────────────────────────┤
│ { ... JSON pretty-print ... }                            │
└──────────────────────────────────────────────────────────┘
```

每个按钮 disabled 当对应 key 在该行不存在(灰显)。点击 → `/audit/stream?runId=...` 等,带 query 参数。

### 7.6 跨页跳转入口(layer 5)

在以下页面加一个 `🔍` icon 按钮(从 `Ic.search` 调):
- Live `RealRunDetail` 顶部 header → `/audit/runs/<id>`
- Monitor `RunDetailContent`、`FailureDetailContent` → `/audit/runs/<id>`
- Fleet `AgentDetailPanel` → `/audit/agents/<short>`
- Events `EventInstancesTab` 每个实例行 → `/audit/events?eventInstanceId=<id>`

**不**重写这些老页面,只加一个按钮。

---

## 8. i18n

新增 ~30 个 key 到 `lib/i18n.tsx`,zh + en 各一份。命名空间 `audit_`:

| Key | zh | en |
|---|---|---|
| `audit_nav_overview` | 概览 | Overview |
| `audit_nav_stream` | 实时流 | Stream |
| `audit_nav_events` | 按事件 | By Event |
| `audit_nav_agents` | 按 Agent | By Agent |
| `audit_nav_llm` | 大模型调用 | LLM Calls |
| `audit_nav_run` | 单 Run | Run |
| `audit_kpi_total` | 总日志数 | Total Logs |
| `audit_kpi_errors` | 错误数 | Errors |
| `audit_kpi_llm_tokens` | LLM tokens | LLM Tokens |
| `audit_kpi_llm_cost` | LLM 花费 | LLM Cost |
| `audit_drawer_jump_run` | 该 run 全部 | Same run |
| `audit_drawer_jump_trace` | 同 trace | Same trace |
| `audit_drawer_jump_event` | 同事件实例 | Same event instance |
| `audit_drawer_jump_candidate` | 同 candidate | Same candidate |
| `audit_drawer_jump_jr` | 同 JR | Same JR |
| `audit_filter_level` | 级别 | Level |
| `audit_filter_category` | 类别 | Category |
| `audit_filter_agent` | Agent | Agent |
| `audit_filter_time` | 时间窗 | Time window |
| `audit_filter_search` | 搜索 | Search |
| `audit_llm_model` | 模型 | Model |
| `audit_llm_prompt` | Prompt | Prompt |
| `audit_llm_response` | 响应 | Response |
| `audit_llm_finish_reason` | 终止原因 | Finish reason |
| `audit_untraceable` | 不可追踪 | Untraceable |
| ... | ... | ... |

(完整列表在实现 PR 中补齐)

---

## 9. 迁移 + 回滚

### 9.1 阶段

| Phase | 动作 | 兼容性 | Rollback |
|---|---|---|---|
| **P0** Schema + Writer | 加 `LogEvent` 表 + `server/log/logger.ts` + `price-table.ts`;old loggers 改 shim;Inngest wrap helper;EM/Manage/LLM 双写 | 老 API/UI 全部继续工作 | `LOG_EVENT_WRITE=0` env 关闭新写路径 |
| **P1** Coverage | 5 个 agent 文件 + stub-factory.ts 各 1 行换 `wrapInngestHandler`;LLM gateway 加 `currentLogger().llmCall(...)` | 0 行业务逻辑变 | 单文件 git revert |
| **P2** Query API | `/api/logs`、`/api/logs/aggregates`、`/api/logs/[id]` 三个端点 + vitest | 新增,不影响老 API | 不部署 |
| **P3** UI | `/audit/layout.tsx` + 7 个 sub-page + 跨页 `🔍` 入口 | 老 `/audit` URL 仍可达(变为新概览页);旧 `components/audit/AuditContent.tsx` 删除 | 路由 git revert |
| **P4** (30 天后,可选) | 若 LogEvent 稳定,移除 `lib/agent-logger.ts` 文件 JSONL 写路径;`logs/` 目录可删 | `tail -f` 工作流改为 `/audit/stream` | 留个 issue 跟踪 |

### 9.2 P0 双写测试

vitest fixture:
- 调 `em.publish('FOO', {...}, { traceId: 't1' })` → 断言 `AuditLog` 写了 1 行 **且** `LogEvent (category=event_publish, traceId=t1)` 写了 1 行,payloadDigest 相同
- 调 `manage.runPause(runId, opts)` → 断言 `AuditLog (action=manage.run.pause)` 写了 1 行 **且** `LogEvent (category=manage_action)` 写了 1 行
- 调 `withLlmTelemetry(...)` → 断言 `AgentActivity (type=tool)` 写了 1 行 **且** `LogEvent (category=llm_call, llmModel=<m>, llmTotalTokens=<n>)` 写了 1 行
- `LOG_EVENT_WRITE=0` env → 断言 LogEvent 0 行写入,老表照常写

### 9.3 数据迁移

不做。新表从 P0 部署后开始累积。老 AuditLog / AgentActivity 历史数据不导入(过期数据 debug 价值低,且 schema 差异大,导入收益 < 复杂度)。

---

## 10. 不做的事 (YAGNI)

- ❌ 不接入 Postgres FTS / Elasticsearch — SQLite `LIKE` 在 10 MB/day 上够用,要扩了再说
- ❌ 不做日志告警 / 订阅 — 那是 alerts / behavior 的职责
- ❌ 不做日志导出 / 下载 — debug 工具不是合规存档
- ❌ 不做 RBAC(`AO_ROLE` 全员 admin 假设保持)
- ❌ 不做动态 LLM 价格 fetch — 内置 5 个模型够用,其它 cost=null
- ❌ 不重写 `/monitor/audit` — 它服务 governance/ops 受众,与新 audit 互补
- ❌ 不做 RAAS 远端日志 federation — RAAS 自己的日志由 RAAS 控制;AO 这边只记录"向 RAAS 调了什么"(已经在 `lib/raas-internal.ts` 的 apiCall 里覆盖)
- ❌ 不做 anomaly detection / smart insights / NL 查询 — 极简优先,留给未来 Manage / Behavior pillar

---

## 11. 文件清单(总览)

### 新增

| 路径 | 用途 |
|---|---|
| `prisma/schema.prisma` (+1 model) | `LogEvent` 表 |
| `server/log/logger.ts` | 统一 logger 工厂 + 3 路 sink |
| `server/log/price-table.ts` | LLM 单价 |
| `server/log/cost.ts` | `computeCost(model, usage)` |
| `server/log/logger.test.ts` | vitest |
| `server/inngest/wrap-handler.ts` | Inngest 入口装饰器 |
| `server/inngest/wrap-handler.test.ts` | vitest |
| `app/api/logs/route.ts` | 通用检索 |
| `app/api/logs/route.test.ts` | vitest |
| `app/api/logs/aggregates/route.ts` | 聚合 |
| `app/api/logs/aggregates/route.test.ts` | vitest |
| `app/api/logs/[id]/route.ts` | 单条详情 |
| `app/audit/layout.tsx` | 左侧栏 layout |
| `app/audit/page.tsx` | 概览(重写) |
| `app/audit/stream/page.tsx` | 实时流 |
| `app/audit/events/page.tsx` | 按事件 |
| `app/audit/agents/page.tsx` | 按 agent 卡片 |
| `app/audit/agents/[short]/page.tsx` | 单 agent 详情 |
| `app/audit/llm/page.tsx` | LLM 调用 |
| `app/audit/runs/[id]/page.tsx` | 单 run 全量 |
| `components/audit/OverviewContent.tsx` | |
| `components/audit/StreamContent.tsx` | 含 filter bar、虚拟滚动、抽屉 |
| `components/audit/EventsContent.tsx` | 左中右三栏 |
| `components/audit/AgentsContent.tsx` | 卡片矩阵 |
| `components/audit/AgentDetailContent.tsx` | |
| `components/audit/LlmContent.tsx` | 折线 + 主表 |
| `components/audit/RunContent.tsx` | |
| `components/audit/LogRowDrawer.tsx` | 共用右抽屉(5 跳转按钮 + payload) |
| `components/audit/AuditNav.tsx` | 左侧栏 |
| `components/audit/JumpButton.tsx` | 跨页 🔍 入口,在 Live/Monitor/Fleet/Events 引用 |

### 改动

| 路径 | 改动 |
|---|---|
| `lib/agent-logger.ts` | 改为 re-export shim |
| `server/agent-logger.ts` | 改为 re-export shim |
| `server/em/persistence.ts` | `writeAudit` 加 LogEvent 双写 |
| `lib/manage/audit.ts` | 加 LogEvent 双写 |
| `server/llm/gateway.ts` | `chatComplete` 加 `currentLogger().llmCall(...)` |
| `server/inngest/agents/create-jd-agent.ts` | 1 行换 `wrapInngestHandler` |
| `server/inngest/agents/match-resume-agent.ts` | 同 |
| `server/inngest/agents/rule-check-agent.ts` | 同 |
| `server/inngest/agents/resume-parser-agent.ts` | 同 |
| `server/inngest/agents/stub-factory.ts` | 同(顶层一次,所有 stub 受益) |
| `lib/i18n.tsx` | +30 个 `audit_*` key (zh + en) |
| `components/shared/LeftNav.tsx` | `/audit` 项改成可展开,显示 6 个 sub-link(或简化为单 link,点开后看到内部左栏 — 待 UI 实现时定) |
| `components/live/RealRunDetail.tsx` | header 加 `<JumpButton href={/audit/runs/${runId}} />` |
| `components/monitor/RunDetailContent.tsx` | 同 |
| `components/monitor/FailureDetailContent.tsx` | 同 |
| `components/fleet/AgentDetailPanel.tsx` | header 加 `<JumpButton href={/audit/agents/${short}} />` |
| `components/events/EventInstancesTab.tsx` | 每行加 `<JumpButton href={/audit/events?eventInstanceId=${id}} />` |

### 删除

| 路径 | 理由 |
|---|---|
| `components/audit/AuditContent.tsx` | 老 `/audit` 全量重写,移除 |

---

## 12. 实现完成定义 (Definition of Done)

P0~P3 全部上线后,以下 acceptance 必须通过:

1. **任意 agent**: 从 `/audit/agents/<short>` 能看到该 agent 过去 24h 全部 LogEvent,含 lifecycle / step / tool_call / llm_call / api_call。
2. **任意事件**: 从 `/audit/events` 找到任意 eventName,点开一个实例,能看到完整因果链(publish → consumer → emit)。
3. **任意 LLM 调用**: `/audit/llm` 主表能找到任意一次 LLM 调用,点开抽屉看到 model + prompt 全量 + response 全量 + usage + cost + finish reason。
4. **可追踪 cross-link**: 在 `/audit/stream` 看到任意一行,点 "同 trace" → 跳到该 traceId 下全部行;点 "同 candidate" → 跳到该 candidate_id 的全部行。
5. **极简 UI 校验**: 6 个 sub-page 任意一个,**人工 review 通过 §7.4 checklist**(主区 ≤ 3 / KPI ≤ 4 / 无嵌套 tab)。
6. **零回归**: 老 `/monitor/audit`、`/live`、`/api/audit`、`/api/runs/[id]/activity`、`/api/agent-activity` 响应 shape 不变,vitest 通过。
7. **TTL**: 部署 ≥ 31 天后,LogEvent 表行数稳定在 30 天滚动窗(daily cron 跑通)。

---

## 13. Open questions

无 — 用户已确认 "全部实现 + LLM logs + 极简多页 + 真正可追踪"。

实施细节(列表虚拟滚动库选型 / sparkline 用哪个 atom / LogStream 怎么 poll vs SSE)在 writing-plans 阶段细化。
