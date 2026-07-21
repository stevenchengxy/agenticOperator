# Monitor 设计 spec

**日期**：2026-05-14
**作者**：Steven · Claude
**范围**：Agentic Operator "Monitor" 轴 —— 全局 workflow 可视化运行监控 + 钻取页面
**Out of scope**：Manage（干预写操作）、Behavior（Monitor Agent / Manager Agent 新 agents）

---

## 0. 三轴框架

Agentic Operator 顶层范围按三轴拆分，**每轴独立 spec、独立 ship**：

| 轴 | 范围 | 性质 |
|---|---|---|
| **Monitor**（本 spec） | 观察：运行历史、queue 状态、失败记录、token 消耗、运行可视化 | read-only UI + 聚合 API |
| **Manage**（后续 spec） | 干预：restart / replay / cancel / pause / force-HITL 等写操作 | UI 按钮 + 写 API + 权限模型 |
| **Behavior**（后续 spec） | 自动化：Monitor Agent（被动观察 + 报警）+ Manager Agent（主动决策介入） | 新 agents + 决策模型 + escalation 路径 |

本 spec 严格限定在 Monitor 轴 —— 任何 UI 按钮都是 **read-only navigation**，没有 restart/cancel/replay。

---

## 1. 现状分析

Agentic Operator 远比 `CLAUDE.md` 描述的 "frontend-only with mock data" 复杂。当前底座（要复用、不重造）：

| 能力 | 已存在 | 缺什么 |
|---|---|---|
| 运行记录 | `WorkflowRun` + `WorkflowStep` + `AgentActivity`，统一 `server/agent-logger.ts` 写入器；`/live` 按 run 展示 timeline | 跨 run 总览面板（要点 `/overview`、`/live`、`/alerts`、`/audit` 四处看） |
| Queue / 失败事件 | `EventInstance`（按 `em.publish()` 一行）+ `DLQEntry` + `HealthIncident` + Inngest dev server dashboard | 没有"Queue & DLQ"视图；DLQ 表完全无页面 |
| 何时介入 | `HumanTask` + `/inbox` + `aiOpinion` + `ChatbotSession` | Monitor 里没有"亟需介入"的 affordance |
| Token 记录 | `AgentEpisode.tokenUsage` (`{prompt, completion, total}`) + `modelUsed` + `durationMs`；`RuleCheckAudit.llm_*_tokens` | 没有按 agent / 按 run / 按时间窗的聚合视图 |
| 运行可视化 | `/workflow` 静态 SVG 图（1620×560，18 节点）；`/live` swimlane 时间轴 | 没有"沿 workflow 图叠加实时状态"的视图 |
| Claude 风格 UI | 现有设计系统是 OKLCH tokens + Tailwind v4 + 自有 atoms，控制台风格 | Monitor 需要单独的暖白+coral+serif token 子集 |

**关键风险（前置工作）**：必须先 audit `createJdAgent` / `matchResumeAgent` / `resumeParserAgent` 是不是都写 `AgentEpisode`。如果跳过，token 视图就是不完整的。把这步作为 Phase 1 task 0。

---

## 2. 噪音问题（设计驱动力）

按现有 3 个 agent + 真实使用场景估算：

| 维度 | 平均 | 峰值 |
|---|---|---|
| 同时活跃 run | ~100 | 500+ |
| 1h 事件总数 | ~3000 | 15000+ |
| 1h 失败/异常 | ~50 | 200+ |
| HITL 等待 | ~5 | 30+ |

把这些直接画到 18 节点的图上 = 视觉灾难。**降噪是 Monitor 设计的核心约束**。

### 2.1 七个降噪机制（缺一不可）

1. **节点上只显示聚合数字** —— 不画每条 run 的线条
2. **顶部多维度过滤器** —— 时间窗、客户、触发事件、状态、搜索；URL state 反映过滤条件
3. **默认时间窗 = 5 分钟** —— 而非 24h；首屏只显示"过去 5 分钟正在发生的事"
4. **用户可 pin 少量 run** —— 最多 5 条；只有 pinned run 在图上画 trail
5. **右侧常驻 Failure / HITL feed** —— 不上图、不上节点，单独栏目
6. **异常优先渲染** —— 红/橙节点自动 z-index 提升 + pulse；健康节点静态半透明
7. **API 聚合 + lazy detail** —— 首屏端点只返回 ~18 行聚合，个体 run 详情按需 fetch

---

## 3. 信息架构

### 3.1 路由

```
/monitor                          ← 主页:全局图 + KPI + Failure/HITL feed
/monitor/runs/[id]                ← 单 run 详情(图上高亮路径 + timeline + events + tokens)
/monitor/agents/[name]            ← 单 agent 详情(episodes / token 曲线 / 错误 / config)
/monitor/queue                    ← 事件队列(accepted/pending/rejected/DLQ 4 桶视图)
/monitor/failures/[runId]?step=N  ← 单失败详情(stack trace, retry history, related events)
```

每个都是真路由（不是 drawer），URL 可分享、可贴在 Slack 里。

### 3.2 与现有页面的边界

- `/overview` `/inbox` `/alerts` `/events` `/audit` `/rule-check` **全部不动**
- `/workflow` 保留为"编辑/查看架构"（build 视角）；`/monitor` 是它的 runtime mirror（operate 视角）—— 同拓扑、不同语义、共享坐标
- `/live` 保留 3 个月再 deprecate，不立即重定向（迁移路径不一一对应）；LeftNav 上的 "Runs" 项删掉

### 3.3 LeftNav

`nav_group_operate` 组下：
- 添加 **"Monitor"**（icon `gauge`），位于 `Overview` 之后
- 删 **"Runs"** 项（`/live` 路由暂留，nav 不再露出）
- 其余不动

### 3.4 点击映射

| 点击对象 | 去向 |
|---|---|
| Agent 节点 | `/monitor/agents/[name]` |
| 节点上的 running 数字 | mini-list popover → 点其中一条 → `/monitor/runs/[id]` |
| 节点上的 HITL 数字 | `/inbox?agent=[name]`（走现有 inbox） |
| 节点上的 queue badge | `/monitor/queue?nodeId=[name]` |
| Failure feed 一行 | `/monitor/runs/[id]?focus=step-[n]` |
| HITL feed 一行 | `/inbox/[taskId]` |
| Recent runs 卡片 | `/monitor/runs/[id]` |
| KPI strip 数字 | 自动 apply 对应过滤器 |
| 边上的事件动画 | 浮窗显示事件名 + 1h 计数，**不跳页** |

---

## 4. 数据契约（API）

5 个新端点，全部 `GET /api/monitor/*`。

### 4.1 `/api/monitor/overview` — 首屏唯一 polling 端点

轮询周期 4s。**响应大小目标 < 30KB** 即便峰值 500 活跃 run。

```ts
{
  filter: { since: ISO, client?, triggerEvent?, status? },
  kpi: {
    activeRuns, pendingHitl, failuresInWindow,
    tokensInWindow, queueDepth, queueLagP50Ms, queueLagP95Ms
  },
  nodes: Array<{
    name, running, completedInWindow, failedInWindow, hitlPending,
    successRate1h, queueDepth,
    tokensInWindow: { prompt, completion, total },
    avgDurationMs,
    status: 'healthy'|'degraded'|'failing'|'idle',
    pulse: boolean
  }>,
  edges: Array<{ from, to, eventName, countInWindow, lastEventAt }>,
  failures: Array<{ runId, agent, eventName?, narrative, severity, at, metadata? }>,
  hitl: Array<{ taskId, runId, nodeId, title, createdAt, deadline? }>,
  recentRuns: Array<{ id, triggerEvent, status, startedAt, lastActivityAt, clientLabel? }>
}
```

数据源：`WorkflowRun` + `AgentActivity` + `AgentEpisode` + `EventInstance` + `HumanTask` 聚合查询。所有 list 限 20。

### 4.2 `/api/monitor/runs/[id]` — Run 详情聚合

合并现有 `/api/runs/[id]` + `/trace` + `/summary` + `/steps`，避免多次轮询。

```ts
{
  run: { id, triggerEvent, triggerData, status, startedAt, completedAt?, lastActivityAt },
  trail: Array<{
    nodeId, enteredAt, leftAt?,
    result: 'success'|'failure'|'pending'|'skipped',
    durationMs?, stepCount, tokensUsed, relatedEpisodeId?
  }>,
  events: Array<{ name, ts, source: 'inbound'|'outbound', eventInstanceId? }>,
  activity: Array<{ ts, agent, type, narrative, metadata? }>,
  tokensByAgent: Record<string, { prompt, completion, total, model? }>,
  hitl: Array<{ taskId, status, title, createdAt, completedAt? }>
}
```

### 4.3 `/api/monitor/agents/[name]` — Agent 详情聚合

```ts
{
  name,
  config: AgentConfig,
  recentEpisodes: Array<{
    id, runId, clientId?, durationMs, tokenUsage,
    modelUsed?, judgeScore?, createdAt
  }>,                                             // 最近 50
  tokenSpend: Array<{ bucket: ISO, prompt, completion, total }>,    // 24h hourly
  errorRate:  Array<{ bucket: ISO, total, failed }>,                // 24h hourly
  recentErrors: Array<{ runId, narrative, ts, metadata? }>
}
```

### 4.4 `/api/monitor/queue` — 队列 4 桶

```ts
{
  accepted: { total, sample: EventInstance[] },
  pending:  { total, sample: EventInstance[] },
  rejected: { total, sample: EventInstance[] },
  dlq:      { total, sample: DLQEntry[] }
}
```

每桶 sample 限 50；分页 `?bucket=accepted&offset=50`。

### 4.5 `/api/monitor/failures/[runId]` — 单失败详情

失败步骤 + retry history + related events。复用 `WorkflowStep` + `AgentActivity`，无需新表。

---

## 5. /monitor 主页布局

```
┌────────────────────────────────────────────────────────────────────────┐
│ Monitor                                                       ⚙ Help   │
├────────────────────────────────────────────────────────────────────────┤
│ [Time 5min ▼] [Client ▼] [Trigger ▼] [Status ▼] [🔍 Search] [Pin: 2]   │
├────────────────────────────────────────────────────────────────────────┤
│ Active 124 │ HITL 8 │ Failures 3 │ Tokens 1.2M │ Queue p95 240ms       │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│       workflow graph (1620×560, reuse /workflow geometry)              │
│       节点 = 聚合 badges + 状态色;边 = 动画密度条                          │
│       ~640px tall                                                       │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│ ┌─ Recent runs ────┐ ┌─ Failures feed ──┐ ┌─ HITL pending ─┐           │
│ │ horizontal cards │ │ vertical list 20 │ │ vertical 20    │           │
│ └──────────────────┘ └──────────────────┘ └────────────────┘           │
└────────────────────────────────────────────────────────────────────────┘
```

### 5.1 节点组件 `<MonitorNode>`

```tsx
<MonitorNode>
  <Header>{name}</Header>
  <RunningBadge count={12} onClick={openMiniList} />
  <HitlBadge count={3} hidden={count===0} />
  <QueueBadge depth={queueDepth} hidden={depth===0} />
  <SuccessIndicator rate={0.98} />
  <Color status={'healthy'|'degraded'|'failing'} />
  <PulseRing visible={pulse} />
  <PinButton hover />
</MonitorNode>
```

- 状态色由 `max(running 堵塞, 错误率 1h, queue depth)` 决定
- 橙/红节点自动 z-index 提升 + 轻 scale + pulse ring
- 健康节点静态、opacity 0.85

### 5.2 边动画

`countInWindow > 0` 时显示沿边滚动的小点；速度按数量分桶（10/100/1000）。**CSS animation**（非 JS）—— CPU 友好。

### 5.3 KPI strip 可点

- 每个 KPI 数字 click → 应用对应过滤器（"3 failures" → `?status=failed`）
- 视觉提示：cursor pointer + hover bg

### 5.4 Pin 机制

- Pin 按钮在节点 hover 时浮出
- 最多 5 条 pinned run
- Pinned run 在图上叠加 trail（彩色高亮 + 边粗化），未 pin 的不画
- pinned IDs 持久化到 `localStorage` key `ao:monitor:pinned-runs`

---

## 6. /monitor/runs/[id] —— Run 详情页 + 实时执行图

```
┌────────────────────────────────────────────────────────────────────────┐
│ Run abc123 · REQUIREMENT_LOGGED · 4m12s · 字节跳动 / jd-xyz · running   │
├────────────────────────────────────────────────────────────────────────┤
│ Agents touched 5 │ Tokens 23k │ Failures 0 │ HITL waited 0             │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   同一张 workflow graph (复用 /monitor 主页坐标),trail 着色:              │
│     - 走过的节点 = 彩色(绿/橙/红 按 trail[i].result)                       │
│     - 没走过的节点 = 灰色 opacity 0.3                                     │
│     - 走过的边 = 粗线 + 时间戳标签                                         │
│     - 当前节点 = orange + pulse                                          │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│ Tabs: [Timeline] [Events] [Tokens] [HITL]                              │
│ Timeline(默认):复用 components/live/LogStream + RunTraceTimeline        │
└────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Trail 着色规则

| 状态 | 颜色 |
|---|---|
| `result === 'success'` | 绿 fill (`--c-claude-ok`) |
| `result === 'failure'` | 红 ring + 红 text (`--c-claude-err`) |
| `result === 'pending'` && current | 橙 + pulse |
| `result === 'skipped'` | 浅灰 |
| 从未进入 | 深灰 opacity 0.3 |

### 6.2 `?focus=step-N` URL 参数

- 自动滚动 timeline 到该 step
- 高亮对应边/节点
- 用于 Failures feed 跳转的深链接

### 6.3 v2 推迟项

- "Play" 模式（重放 trail 动画）—— scope 控住，v1 只做静态 trail
- 跟其他 run 对比视图 —— v1 单 run 显示

### 6.4 坐标共享原则

`/monitor` 主页、`/monitor/runs/[id]`、未来 Manage / Behavior 页 **都用同一份 18-node 坐标 + 同一个 `<WorkflowGraph>` 基础组件**。

实现方式：从 `/workflow` 的节点+边 array 抽出到 `lib/workflow-graph-meta.ts`，所有用图的页面从此 import。保证视觉一致性 + 维护只改一处。

---

## 7. /monitor/agents/[name] —— Agent 详情页

```
┌─────────────────────────────────────────────────────────────────────┐
│ JDGenerator (createJD)        healthy · Active 12 · 1h success 98%  │
├─────────────────────────────────────────────────────────────────────┤
│ Tabs: [Episodes] [Tokens] [Errors] [Config]                         │
│                                                                     │
│ Episodes(默认): table of last 50 from AgentEpisode                   │
│   cols: runId · client · duration · tokens · score · model · time  │
│   row click → /monitor/runs/[runId]                                 │
│                                                                     │
│ Tokens:                                                             │
│   24h hourly line chart (prompt vs completion)                      │
│   per-model bar chart                                               │
│   total / avg-per-episode                                           │
│                                                                     │
│ Errors: list with run links                                         │
│                                                                     │
│ Config(read-only AgentConfig view):                                 │
│   temperature, maxRetries, tier, maxOutputTokens, promptAppend     │
│   "Edit in /workflow" link (Monitor read-only,编辑属于 Manage)        │
└─────────────────────────────────────────────────────────────────────┘
```

图表实现：手写 `<TokenChart>` / `<ErrorRateChart>`，~80 行 SVG，**不引 Recharts**（避免新依赖、bundle size 友好）。可基于现有 `<Spark>` atom 升级。

---

## 8. /monitor/queue —— 队列 4 桶

4 个 tab：Accepted / Pending / Rejected / DLQ。每个 tab 一个 list：

- 列：`eventName · source · status · ts · payloadDigest`
- 行 click：展开 inline detail（包含 schema errors、tried versions、payload summary）
- 顶部 search + filter (eventName, source, time range)

数据源：`EventInstance` (前 3 桶) + `DLQEntry` (DLQ)。

---

## 9. /monitor/failures/[runId] —— 单失败详情

简单页：

- 失败步骤的 stack trace（来自 `WorkflowStep.error` 字段）
- 该步骤的 retry attempts 列表（按 `AgentActivity.type === 'step.retrying'` 过滤）
- Related events（按 `EventInstance.causedByEventId` 反查）
- Back to run link → `/monitor/runs/[runId]?focus=step-[n]`

---

## 10. Claude 风格 token 子集

### 10.1 新增 OKLCH 变量（`app/globals.css`）

```css
:root {
  --c-claude-bg:        oklch(0.985 0.005 80);
  --c-claude-surface:   oklch(0.995 0.003 80);
  --c-claude-panel:     oklch(0.96 0.008 80);
  --c-claude-line:      oklch(0.88 0.008 75);
  --c-claude-ink-1:     oklch(0.22 0.01 80);
  --c-claude-ink-2:     oklch(0.4 0.01 80);
  --c-claude-ink-3:     oklch(0.55 0.01 80);
  --c-claude-ink-4:     oklch(0.7 0.01 80);
  --c-claude-accent:    oklch(0.67 0.14 35);
  --c-claude-accent-bg: oklch(0.94 0.05 35);
  --c-claude-ok:        oklch(0.7 0.13 145);
  --c-claude-warn:      oklch(0.78 0.12 80);
  --c-claude-err:       oklch(0.6 0.18 25);
}

[data-theme="dark"] {
  --c-claude-bg:        oklch(0.18 0.005 80);
  --c-claude-surface:   oklch(0.22 0.005 80);
  --c-claude-panel:     oklch(0.25 0.005 80);
  --c-claude-line:      oklch(0.32 0.005 80);
  --c-claude-ink-1:     oklch(0.92 0.005 80);
  --c-claude-ink-2:     oklch(0.75 0.005 80);
  --c-claude-ink-3:     oklch(0.6 0.005 80);
  --c-claude-ink-4:     oklch(0.45 0.005 80);
  --c-claude-accent:    oklch(0.72 0.15 35);
  --c-claude-accent-bg: oklch(0.3 0.08 35);
  --c-claude-ok:        oklch(0.7 0.13 145);
  --c-claude-warn:      oklch(0.75 0.12 80);
  --c-claude-err:       oklch(0.65 0.18 25);
}
```

### 10.2 Scope 机制

`app/monitor/layout.tsx` 包一层 `<div data-style="claude">`。CSS 用属性选择器作用域：

```css
[data-style="claude"] {
  background: var(--c-claude-bg);
  color: var(--c-claude-ink-1);
  font-family: ui-sans-serif, "SF Pro Text", Inter, system-ui, sans-serif;
}

[data-style="claude"] h1,
[data-style="claude"] h2 {
  font-family: ui-serif, Charter, "Iowan Old Style", Palatino, serif;
  letter-spacing: -0.01em;
}
```

### 10.3 新 atom 变体

不改现有 `<Card>` / `<Metric>` —— 新增 `<ClaudeCard>` / `<ClaudeMetric>` / `<ClaudeBadge>` 在 `components/monitor/atoms.tsx`。**只在 `/monitor` 子树用**，其他页面继续用原 atoms。

### 10.4 视觉规则

- Card padding 24px（vs 现有 16px）
- Card border-radius 12px（vs 8px）
- Border-weight 1px solid `--c-claude-line`，**不加 shadow**
- Hover 状态：bg shift 到 `--c-claude-panel`，**不 scale、不 elevate**
- 间距尺度：所有 gap +50%（4→6, 8→12, 16→24）
- 数字字体：`font-variant-numeric: tabular-nums` + heavier weight

---

## 11. 实施顺序（建议给后续 writing-plans）

| 阶段 | 任务 | Blocking |
|---|---|---|
| 0 | Audit 三个 agent 是否都写 `AgentEpisode` —— 修补缺失的 episode write | **是**(否则 token 视图不完整) |
| 1 | 抽 `lib/workflow-graph-meta.ts`(从 `/workflow` 抽出共享坐标) | 是 |
| 2 | 新增 Claude token + atoms(`components/monitor/atoms.tsx`) | 否 |
| 3 | `/api/monitor/overview` 后端 + 单测 | 是 |
| 4 | `/monitor` 主页(图 + KPI + filters) | 依赖 1,2,3 |
| 5 | `/api/monitor/runs/[id]` + `/monitor/runs/[id]` 页面 | 依赖 1,2 |
| 6 | `/api/monitor/agents/[name]` + `/monitor/agents/[name]` 页面 | 依赖 0,2 |
| 7 | `/api/monitor/queue` + `/monitor/queue` 页面 | 否 |
| 8 | `/api/monitor/failures/[runId]` + `/monitor/failures/[runId]` 页面 | 否 |
| 9 | LeftNav 调整(加 Monitor、删 Runs);`/live` 保留 | 依赖 4 |

总评估：~8-12 个 PR，按 phase 分批 merge。

---

## 12. Non-goals（明确不做）

- ❌ Restart / Cancel / Replay 按钮（属于 Manage 轴）
- ❌ Monitor Agent / Manager Agent 的 agent 实现（属于 Behavior 轴）
- ❌ 编辑 AgentConfig（属于 Manage 轴；本 spec 只读展示）
- ❌ Play 模式（trail 重放动画）—— v2 再加
- ❌ 跨 run 对比视图 —— v2 再加
- ❌ 取代 `/workflow`（保留，build vs operate 双视角）
- ❌ 立即重定向 `/live`（保留 3 个月再 deprecate）

---

## 13. 风险 & 已知未解

1. **AgentEpisode 覆盖率未知**（§1）—— phase 0 audit 才能确认
2. **`AGENT_MAP` ↔ workflow node id 对应关系**（参见 `lib/agent-mapping.ts`）—— 已有 byWsId/byShort 映射器，新 `lib/workflow-graph-meta.ts` 要复用、不重造
3. **峰值场景的 polling 压力** —— 4s 轮询 × 50 用户 = 12 req/s on `/api/monitor/overview`。SQLite 单表查询应当能扛，但要做端点级缓存（10s TTL）以防意外
4. **filter cardinality 过大** —— Client 列表如果几百个，dropdown 不友好。v1 用 search input，不 dropdown
5. **暗色模式 Claude 风格的协调** —— Claude 官方界面主要是亮色，暗色模式我们自己设计；§10.1 给了初稿但需要 review

---

## 14. 后续

- Spec approve 后 → 走 `writing-plans` skill 拆 implementation plan
- Manage spec、Behavior spec 各自独立 brainstorm + 独立 ship
- Phase 0 (AgentEpisode audit) 可以**并行启动**，不必等 plan
