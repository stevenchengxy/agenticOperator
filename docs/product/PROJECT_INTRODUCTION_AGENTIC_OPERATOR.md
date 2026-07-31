# Agentic Operator · 项目总览

> **智能体操作中枢** — 面向 AI 招聘智能体舰队的运营控制台 + 端到端事件驱动后端。

本文档面向第一次接触本仓库的工程师、产品经理与运营人员，提供：

1. 项目整体功能与产品定位
2. 顶层架构（前端 / 后端 / 数据 / 外部依赖）
3. 仓库内每一个目录与关键组件的职责说明
4. 端到端的招聘业务流程在代码中的落点

文档基于仓库当前实际代码 + [`README.md`](../../README.md) + [`CLAUDE.md`](../../CLAUDE.md) 综合整理。当代码与文档冲突时，**以代码为准**。

---

## 1. 项目是什么？

**Agentic Operator（智能体操作中枢）** 是一个面向企业级招聘流程外包（RPO）场景的"AI 智能体调度中心"。它把一次完整的招聘流程视为一条 **事件驱动工作流（Inngest 风格）**：

```
REQUIREMENT_SYNCED → ANALYSIS_COMPLETED → JD_GENERATED → CHANNEL_PUBLISHED
       → RESUME_DOWNLOADED → RESUME_PROCESSED → MATCH_PASSED_NEED_INTERVIEW
       → AI_INTERVIEW_COMPLETED → EVALUATION_PASSED → PACKAGE_APPROVED
       → APPLICATION_SUBMITTED
```

每一次状态推进都对应一个 **事件（Event）**，每个事件都带有：发布者 / 订阅者 / Schema / 重试策略 / SLA / 审计痕迹。Agentic Operator 让这张"业务大图"对运营团队 **一屏可见**：正在跑什么、卡在哪、钱花在哪、下一步需要人审批什么。

### 1.1 它解决什么问题

RPO 团队用 AI 跑招聘流水线，会遇到通用观测工具解决不了的四类问题，Agentic Operator 一并回答：

| 问题 | 现象 | 本系统的答案 |
|---|---|---|
| **异构** | 一次入职跨 ATS / 4 个招聘渠道 / 2 个 LLM 厂商 / 向量库 / 日程 / 客户门户 | 以事件为通用底座，6 个视图围绕事件做透视 |
| **人机混合** | JD 审批、推荐包审核、信息澄清都需要人工介入 | `/inbox` 人工任务队列 + `/workflow` 上的 HITL 节点 |
| **成本控制** | Token / API / 渠道费用快速累积 | 每个 agent 的 Episode 表记录 token、duration，可按客户 / 岗位 / agent 切片 |
| **合规 & 审计** | EEO / PII / 客户 NDA 不可让步 | `AuditLog` + `EventInstance` + `RaasMessage` 全链路留痕，`/audit` 页面可查 |

### 1.2 它由什么人使用

- **HSM / 交付经理**：通过 `/fleet` 看舰队全局、`/inbox` 处理需要人工介入的卡点
- **Recruiter / 招聘顾问**：通过 `/live` 看单条候选人推进的具体细节
- **平台工程师**：通过 `/workflow` 编排流程、`/events` 看事件契约、`/datasources` 维护连接器
- **审计 / 合规**：通过 `/audit`、`/correlations`、`/entities/:type/:id` 做溯源

### 1.3 当前完成度

仓库已经从最初的"纯前端 mock"演进到 **前后端 + 数据库 + 真实 LLM 调用** 的完整骨架：

- ✅ 前端 6 大方向视图 + 5 个辅助视图全部接入真实 API（无 mock 数据）
- ✅ 3 个 Inngest agent（`createJD` / `resumeParser` / `matchResume`）已可端到端跑通
- ✅ EM（Event Manager）库：发布、Schema 校验、降级、Neo4j 同步、DLQ
- ✅ RaaS 集成：通过 `lib/raas-api-client.ts` 调外部 RAAS Server
- ✅ 简历预筛规则引擎：`lib/rule-check/` 跑 LLM + 本体图遍历做硬性规则检查
- ✅ Prisma + SQLite 持久化（24 张表，覆盖工作流 / 人工任务 / 事件审计 / Episode / 招聘数据）
- 🚧 Workflow 编辑器（目前是静态 SVG，未来切 React Flow）
- 🚧 告警引擎（规则定义 + 飞书 / 企微 fan-out）
- 🚧 多租户 / Auth

---

## 2. 顶层架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (Next.js App Router · React 19 · Tailwind v4 OKLCH)        │
│  ┌─────────────┬──────────┬──────────┬──────────┬─────────────┐    │
│  │ /fleet      │ /workflow│ /live    │ /events  │ /alerts ...│    │
│  └─────┬───────┴────┬─────┴────┬─────┴────┬─────┴──────┬──────┘    │
└────────┼────────────┼──────────┼──────────┼────────────┼───────────┘
         │ fetchJson  │          │ SSE      │            │
         ▼            ▼          ▼          ▼            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Next.js API Routes  (app/api/**)                                   │
│   /agents · /runs · /events · /em/* · /human-tasks · /inngest ...   │
└────────┬────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Server-side modules  (server/**)                                   │
│  ┌──────┬─────────┬───────────┬─────────┬─────────┬──────────────┐  │
│  │  em  │ inngest │ llm       │ raas    │ db      │ normalize    │  │
│  │      │ +agents │ gateway   │ client  │ Prisma  │ envelope     │  │
│  └──────┴─────────┴───────────┴─────────┴─────────┴──────────────┘  │
└────────┬────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  External systems                                                   │
│  Inngest dev gateway · Neo4j · MinIO · OpenAI · RAAS API Server     │
│  RoboHire (legacy) · SQLite (data/ao.db)                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Next.js 16.2（App Router · Turbopack） |
| Runtime | React 19.2 · Node ≥ 22 |
| 语言 | TypeScript 5 strict |
| 样式 | Tailwind CSS 4.2，CSS-first 通过 `@theme inline` 绑定 OKLCH 变量 |
| 数据 | Prisma 7 · `better-sqlite3`（dev：`data/ao.db`） |
| 事件总线 | Inngest 4.x（dev 网关 + Inngest CLI） |
| 图数据库 | Neo4j 6（本体 / 事件契约 / 规则） |
| 对象存储 | MinIO（简历 PDF） |
| LLM | OpenAI SDK 6（默认 Gemini-3-flash via gateway） |
| 校验 | Zod 4 + JSON Schema → Zod 转换器 |
| 测试 | Vitest 4 + happy-dom |
| i18n | 自研 flat-dictionary `t()` hook，中 / 英双语 |

### 2.2 启动方式

```bash
npm install
npm run dev            # 端口 3002（不是 3000，写死在 package.json）
npm run inngest:up     # 起本地 Inngest dev gateway（可选）
npm run inngest:dev    # 起 Inngest CLI dev server（agent 触发用）
npm run db:push        # 同步 schema 到 data/ao.db
npm run db:studio      # Prisma Studio 浏览 DB
npm run test           # Vitest（CLAUDE.md 里说没有测试 — 已过时，现在有了）
```

> **注意**：`CLAUDE.md` 中"No tests, no API routes"已严重过时。仓库现在有 50+ 个 API route 和大量 vitest 测试。新人应以本文档和实际代码为准。

---

## 3. 目录结构详解

### 3.1 `app/` — 路由与 API（Next.js App Router）

#### 3.1.1 页面路由（每个都是 `"use client"` 的薄壳，渲染 `<Shell>` + `*Content`）

| 路径 | 方向 | 受众 | 作用 |
|---|---|---|---|
| `/` | redirect | — | 重定向到 `/fleet` |
| `/fleet` | A · 舰队指挥 | 所有 Ops | 主仪表盘：KPI 条 + 全量 agent 表 + 告警 rail + 活动流 + 合规分卡 + 漏斗 |
| `/workflow` | B · 工作流画布 | 平台工程师 | 1620×560 SVG 节点图，触发 → agent → 分支 → 护栏 → HITL → 终结。点击节点弹出 inspector + Agent Chatbot |
| `/live` | C · 实时运行 | 值班 Recruiter | 单条 Run 的实时追踪：泳道时间线 + 决策流 + 完整 trace + 异常面板 |
| `/events` | D · 事件管理 | 工程师 / 审计 | Inngest 风格事件总线：注册表 + 6 标签详情（Overview / Schema / Subscribers / Runs / History / Logs）+ 实时事件流 |
| `/events/[name]/instances/[id]` | — | 工程师 | 单条 EventInstance 追踪页（trace_id 维度） |
| `/alerts` | — | 值班 | 告警三联视图：KPI + 列表 + 4 标签详情（Timeline / Related / Rule / Runbook） |
| `/datasources` | — | 平台 / 合规 | 24 个外部连接器：健康、吞吐、字段映射、凭据、webhook、审计 |
| `/inbox` | — | HSM / 招聘 | 人工任务收件箱（HumanTask 表），HITL 队列总入口 |
| `/triggers` | — | 平台工程师 | 触发器总览（Cron / Webhook） |
| `/correlations` | — | 审计 | 因果链：按 trace_id 串起事件因果图 |
| `/correlations/[traceId]` | — | 审计 | 单 trace 详情 |
| `/entities/[type]/[id]` | — | 审计 | 实体生命旅程（候选人 / 需求 / JD 的全生命周期事件流） |
| `/overview` | — | 总览 | 系统总览（KPI 高度浓缩） |
| `/audit` | — | 审计 | `AuditLog` 表浏览，按 eventName / traceId / source 过滤 |
| `/agent-demo` | — | Demo | 单个 Agent 的演示 / 调试页面 |
| `/dev/generate-prompt` | — | 工程师 | 本体 → Prompt 生成器调试页 |

#### 3.1.2 API 路由（`app/api/**/route.ts`，共 ~50 个）

| 分组 | 主要 endpoint | 职责 |
|---|---|---|
| Agents | `/api/agents`, `/api/agents/health`, `/api/agents/[short]/{activity,chat,explain,recent-entities}` | Agent 列表、健康检查、chatbot、解释器、最近实体 |
| Runs | `/api/runs`, `/api/runs/[id]/{activity,chat,steps,summary,trace}` | 工作流 Run + 步骤 + trace |
| Events | `/api/events`, `/api/events/[name]/stream` | 事件注册表（Neo4j 兜底到 hardcoded 目录）+ SSE 实时流 |
| EM (Event Manager) | `/api/em/{publish,health,sync-now,event-instances,event-stats,webhook/neo4j-changed}` | 发布事件、健康、Neo4j → SQLite 同步、EventInstance 浏览 |
| Inngest | `/api/inngest` (注册 endpoint), `/api/inngest-events`, `/api/inngest-events/[id]/runs` | Inngest SDK serve、事件流转 |
| Human tasks | `/api/human-tasks`, `/api/human-tasks/[id]`, `/api/human-tasks/[id]/messages` | HITL 队列 / 消息子线程 |
| Audit / Correlations / Entities | `/api/audit`, `/api/correlations/[traceId]`, `/api/entities/[type]/[id]{,/journey}` | 审计、因果链、实体旅程 |
| Activity feed | `/api/activity/recent`, `/api/agent-activity` | 主页活动流 |
| Datasources | `/api/datasources`, `/api/raas-bridge/status` | 数据源 + RaaS bridge 状态 |
| Trace | `/api/trace/[id]` | LLM trace 详情 |
| Alerts | `/api/alerts` | 告警列表 |
| Triggers | `/api/triggers` | 触发器列表 |
| Stream | `/api/stream` | 通用 SSE 实时流 |
| Workflow | `/api/workflow/active` | 当前工作流定义 |
| RaaS | `/api/raas/requirements` | 透传 RAAS 需求接口 |
| Agentic | `/api/agentic` | 顶层"是否启用 Agent 模式"开关 |
| Test 触发 | `/api/test/{trigger-match-requested,trigger-requirement,trigger-resume-uploaded}` | 开发期事件触发器，绕过 RaaS 直接造事件 |

### 3.2 `components/` — UI 组件

每个路由配一个目录，所有真正的 markup 都在这里；`app/<route>/page.tsx` 只是 `<Shell>` 的薄壳。

| 子目录 | 关键文件 | 说明 |
|---|---|---|
| `shared/` | `Shell.tsx` | 全局 chrome：AppBar + LeftNav + CommandPalette + direction tag |
|  | `AppBar.tsx` | 顶栏：logo、面包屑、⌘K 搜索、Realtime 灯、EM 健康 pill、语言切换、主题切换、告警铃、头像 |
|  | `LeftNav.tsx` | 左侧导航，分 **运营 / 构建 / 治理** 三组；inbox count 通过 `/api/human-tasks` 每 10s 轮询 |
|  | `CommandPalette.tsx` | ⌘K 全局命令面板 |
|  | `atoms.tsx` | 原子组件：`StatusDot` / `Spark` / `Metric` / `Badge` / `Btn` / `Card` / `CardHead` / `EmptyState` |
|  | `Ic.tsx` | 扁平 SVG 图标库（~30 个，键为 `IcName` union） |
|  | `LogStream.tsx` | 通用日志流组件（SSE 拉取） |
|  | `Markdown.tsx` | Markdown 渲染（Agent 回复、JD 等） |
|  | `AgenticToggle.tsx` | "Agent 模式" 开关 |
| `fleet/` | `FleetContent.tsx` | 主仪表盘；通过 `/api/agents` 拉真实 agent 列表 |
| `workflow/` | `WorkflowContent.tsx` | 节点图本体 |
|  | `NeighborhoodPanel.tsx` / `RecentEntitiesPanel.tsx` / `AgentChatbot.tsx` | 选中 agent 节点后的 inspector |
| `live/` | `LiveContent.tsx` | Run 选择 + 状态分组；URL state 为单一真理源 |
|  | `RealRunDetail.tsx` / `RunSummaryModal.tsx` | 单 Run 详情中 / 右栏 |
| `events/` | `EventsContent.tsx` | 6 个顶层 tab：registry / stream / dlq / rejected / instances / causality |
|  | `EventInstancesTab.tsx` / `EventLogModal.tsx` / `InstanceTrailContent.tsx` | 实例 + 日志详情 |
| `alerts/` | `AlertsContent.tsx` | 告警 KPI + 列表 + 详情 4 tab |
| `inbox/` | `InboxContent.tsx` | 人工任务三联视图（list + detail + messages） |
| `triggers/` | `TriggersContent.tsx` | Cron / Webhook 触发器 |
| `audit/` | `AuditContent.tsx` | AuditLog 浏览器，URL 即过滤器 |
| `correlation/` | `CorrelationContent.tsx` | 因果链可视化 |
| `entity/` | `EntityJourneyContent.tsx` | 实体生命旅程时间线 |
| `datasources/` | `DataSourcesContent.tsx` | 24 连接器网格 + 详情 6 tab |
| `overview/` | `OverviewContent.tsx` | 系统总览 |
| `agent-demo/` | `AgentDemoContent.tsx` | 单 agent 演示 |

### 3.3 `lib/` — 客户端 / 通用库

| 子目录 / 文件 | 职责 |
|---|---|
| `i18n.tsx` | `AppProvider` + 中英双语字典 + `useApp()` hook，`localStorage` 持久化 `ao:lang` / `ao:theme` |
| `events-catalog.ts` | 28 事件 Inngest 风格目录（hardcoded 兜底；首选 Neo4j 同步） |
| `agent-functions.ts` / `agent-mapping.ts` / `agent-graph.ts` | Agent 名 ↔ 节点 ↔ 工作流 的映射与拓扑 |
| `workflow-meta.ts` | 当前活跃工作流的元信息 |
| `event-lifecycle.ts` | 事件状态分类（成功 / 拒绝 / DLQ 等） |
| `entity-types.ts` / `entity-extractor.ts` | 实体类型枚举与从事件 payload 抽取实体 |
| `datasources-static.ts` / `triggers-static.ts` | 静态 fixture（接入 API 前的兜底） |
| `minio.ts` | MinIO 客户端 |
| `robohire.ts` / `raas-internal.ts` / `raas-api-client.ts` | 三套外部 API 客户端（RoboHire 已退役，新链路走 raas-api-client） |
| `api/` | 前端 `fetchJson` 封装、SSE 解析器、类型定义（`types.ts`）、各种 hook（`agents-health.ts` / `em-health.ts` / `event-stats.ts` / `inngest-events.ts` / `activity-types.ts`） |
| `inference/jd-from-filename.ts` | 从文件名推断 JD 信息（demo 用） |
| `mappers/flatten-resume.ts` / `robohire-to-raas.ts` | 数据映射器 |
| `prompts/match-resume.ts` | matchResume agent 的 prompt 模板与测试 |
| **`rule-check/`** | 简历预筛规则引擎（详见 §3.5） |
| **`ontology-gen/`** | 本体 → Prompt 代码生成（详见 §3.6） |

### 3.4 `server/` — 服务端模块（仅供 API 路由 + Inngest agents 使用）

#### 3.4.1 `server/em/` — Event Manager 库

事件总线的核心。所有外发的事件都必须通过 `em.publish()`：会做 Schema 校验、降级判断、DLQ 落库、Inngest 转发。

| 文件 | 职责 |
|---|---|
| `index.ts` | 公共 barrel：导出 `em.publish` / `em.validate` / `em.registry` / `em.health` |
| `publish.ts` | 主发布逻辑：Schema 校验 → 降级判断 → Inngest 发送 → EventInstance 落库 |
| `validate.ts` | Zod 校验入口 |
| `registry/` | 事件契约缓存（Neo4j 优先，hardcoded 兜底），含 JSON Schema → Zod 的转换器 |
| `schemas/` | 内置 Zod schema |
| `sync/event-definition-sync.ts` | Neo4j → SQLite 的事件契约同步 worker |
| `clients/neo4j.ts` | Neo4j driver 封装 |
| `degraded-mode.ts` | 降级模式状态机（Neo4j 不可达时让发布仍能跑） |
| `rejection.ts` | 拒绝事件（EVENT_REJECTED）发射器 |
| `persistence.ts` | EventInstance 写库 |

#### 3.4.2 `server/inngest/` — Inngest 客户端与 Agent

| 文件 | 职责 |
|---|---|
| `client.ts` | Inngest 实例 + 全量事件 TypeScript 类型（`ResumeDownloadedData` / `ResumeProcessedData` / `MatchPassedNeedInterviewData` / `RuleCheckPassedData` / `JdGeneratedEnvelope` 等） |
| `functions.ts` | Function 注册表（导出 3 个 agent，给 `/api/inngest` 注册） |
| `agents/create-jd-agent.ts` | **createJD agent**：订阅 `REQUIREMENT_LOGGED` → 调 RaaS `/generate-jd` → 持久化 → 发 `JD_GENERATED` |
| `agents/resume-parser-agent.ts` | **resumeParser agent**：订阅 `RESUME_DOWNLOADED` → MinIO 取 PDF → RaaS `/parse-resume` → 落库 → 发 `RESUME_PROCESSED` |
| `agents/match-resume-agent.ts` | **matchResume agent**：订阅 `RESUME_PROCESSED` → 拉需求列表 → 可选 rule-check 预筛（gate by `RULE_CHECK_ENABLED`）→ 调 RaaS `/match-resume` → 落库 → 发 `MATCH_PASSED_NEED_INTERVIEW` |
| `logged-step.ts` | Inngest step 的 wrapper，自动记 `AgentActivity` / `AgentEpisode` |
| `raas-bridge.ts` / `raas-forward.ts` | RaaS 桥接（外部 Kafka 消息 → Inngest 事件） |

#### 3.4.3 其余 server 模块

| 模块 | 职责 |
|---|---|
| `llm/gateway.ts` | LLM 网关：默认走 Gemini-3-flash via OpenAI 兼容协议；含 prompt cache 与 tool-call 支持 |
| `llm/jd-generator.ts` | （legacy）直接 LLM 生成 JD 的实现，已被 RaaS `/generate-jd` 替代 |
| `llm/robohire.ts` / `llm/robohire-shape.ts` | RoboHire 调用与字段映射（legacy） |
| `llm/instrumented.ts` | LLM 调用的 instrumented 包装（埋点） |
| `llm/minio-client.ts` | LLM 用到的 MinIO 客户端 |
| `raas/internal-client.ts` | RaaS 内部 API 客户端（legacy 内部路径） |
| `clients/em.ts` / `clients/ws.ts` | EM / WS 服务的客户端（拆库后预留） |
| `db/index.ts` | Prisma client 单例 + connection helper |
| `normalize/envelope.ts` | 事件 envelope 规整：从各种 shape（RaaS canonical / flat / legacy）抽出统一字段 |
| `normalize/agents.ts` / `normalize/status.ts` | Agent / Run 状态规整 |
| `http/instrumented.ts` | HTTP 调用埋点 |
| `agent-logger.ts` | Agent 行为日志（写 `AgentActivity`） |
| `agentic-state.ts` | "Agent 模式"全局开关的服务端状态 |
| `init.ts` | 服务端初始化（在第一个请求时自动启动 Neo4j sync worker 等） |

### 3.5 `lib/rule-check/` — 简历预筛规则引擎

`matchResume` agent 在调 RAAS `/match-resume` **之前**跑的 LLM + 本体图遍历预筛。决策为 `PASS` / `FAIL` / `REVIEW`，对应发 `MATCH_RULE_CHECK_PASSED` 或 `RULE_CHECK_FAILED` 事件。

| 文件 | 职责 |
|---|---|
| `index.ts` | barrel：`buildRuleCheckInput` + `runRuleCheck` |
| `runner.ts` | 主编排：抽 dims → 拉规则 → 过滤 → 构建图上下文 → 拼 prompt → LLM(with tools) → 折叠结果 |
| `ontology.ts` / `ontology-source.ts` | 从本体 API 拉 matchResume 相关规则；按 client 过滤 |
| `graph-context.ts` | 构建 Neo4j 图上下文（agent 可用 tools：`get_instance` / `list_instances` / `list_links`） |
| `prompt.ts` | 合成 system prompt + user prompt（5 块输入结构） |
| `instance-client.ts` | 本体实例查询客户端 |
| `resume-projection.ts` | 把 parsed resume 投影到本体期望的 shape |
| `types.ts` | `RuleCheckInput` / `RuleResult` / `MatchResumeCheckResult` 等公共类型 |
| `rules.json` | 兜底规则（当本体 API 不可达） |

### 3.6 `lib/ontology-gen/` — 本体 → Prompt 代码生成

把客户在 Ontology 平台上配置的"Action"对象（含 step / input / output / rule / notification 等）抽下来，生成可直接用于 Agent 的 prompt 模板。

| 文件 | 职责 |
|---|---|
| `index.ts` | 公共 surface（slim build）：导出 `fetchAction` / `parseAction` + 类型 + 错误层级 |
| `client.ts` / `fetch.ts` | Ontology API HTTP 客户端，含 auth |
| `errors.ts` | 错误层级（`OntologyAuthError` / `OntologyNotFoundError` / `OntologyUpstreamError` / ...） |
| `validate.ts` | Action JSON 结构校验 |
| `types.public.ts` / `types.internal.ts` | 类型定义 |
| `compile/` | 把 Action 模型编译成可执行的 prompt 中间表示 |
| `v4/` | v4 代次的 prompt 生成入口 `generatePrompt` + `fillRuntimeInput` |

### 3.7 `prisma/` — 数据持久层

SQLite 文件位于 `data/ao.db`。**24 张表**，按域分组：

| 域 | 表 | 用途 |
|---|---|---|
| **WS 工作流运行时** | `WorkflowRun` / `WorkflowStep` / `AgentActivity` / `HumanTask` / `ChatbotSession` | Run 与 Step 状态、Agent 行为日志、HITL 队列、HITL 对话 |
| **Living KB** | `CandidateLock` / `Blacklist` / `AgentEpisode` / `AgentConfig` / `AgentConfigHistory` | 候选人锁、黑名单、Agent 单次执行 Episode（用于 fine-tune 与 cost 切片）、Agent 运行时配置覆盖 |
| **EM 审计与 DLQ** | `AuditLog` / `DLQEntry` / `DedupCache` | 事件审计、死信、去重缓存 |
| **EM 运行时** | `EventDefinition` / `EventInstance` / `EmSystemStatus` / `GatewayFilterRule` / `OutboundEvent` / `RaasMessage` / `RejectedMessage` / `IngestionConfig` / `HealthIncident` / `ExecutionTrace` | 事件契约、实例追踪、健康快照、网关过滤、Outbound（终端 agent 推送外部）、Inbound RaaS 审计 |
| **招聘业务** | `JobRequisition` / `JobDescription` | 需求与 JD（Workflow node 1-2 → 4） |

`prisma/seed-from-sidecars.ts` 用 `npm run db:seed` 从 sidecar 文件灌入种子数据。

### 3.8 `scripts/` — 运维与开发脚本

| 脚本 | 用途 |
|---|---|
| `dev-bootstrap.mjs` | `npm run dev` 启动前置：检查端口、清缓存等 |
| `register-with-inngest.ts` | 把 AO 作为 SDK 注册到团队共享 Inngest dev gateway |
| `publish-test-event.ts` | 手动发布事件做端到端验证 |
| `list-minio-resumes.ts` / `pick-test-resume.ts` | MinIO 简历桶浏览 / 挑测试简历 |
| `e2e-real-pdf.ts` | 端到端：上传真实 PDF → 触发完整链路 |
| `probe-robohire.ts` | RoboHire 联通性探测（legacy） |
| `replay-screenshot-event.ts` | 重放某个事件做 UI 截图 |
| `gen-v4-snapshot.ts` | 生成 ontology-gen v4 快照 |
| `dump-match-inputs.ts` | 把 matchResume 的实际输入 dump 出来调 prompt |
| `export-action-ontology.ts` | 导出本体 Action 子图为 cypher |
| `run-match-resume-prompt.ts` / `run-match-resume-rule-check.ts` | 单独跑 matchResume prompt / rule-check |
| `run-rule-check-test-suite.ts` / `seed-rule-check-fixtures.ts` | rule-check 测试套件 |
| `rule-check-poc/` / `rule-check-test-suite/` | rule-check 工程化 fixture 与 POC |

### 3.9 `docs/` — 设计与运维文档

按主题组织的设计文档与流程说明，常用入口：

| 文档 | 内容 |
|---|---|
| `end-to-end-pipeline-walkthrough.md` | 端到端流水线代码走读 |
| `event-flow-deep-dive.md` | 事件流转细节 |
| `event-manager-and-tracking-design.md` | EM 库与事件追踪设计 |
| `workflow-event-chain.md` / `.pdf` | 工作流事件链 |
| `deployment.md` | **唯一维护的部署指南**(Docker Compose 跨机部署与运维) |
| `inngest-docker-deployment.md` | ⚠️ 历史快照(旧开发机自带 Inngest),已被 `deployment.md` 取代 |
| `resume-agent-engineering-spec.md` | 简历解析 agent 设计规范 |
| `match-resume-api-user-guide.md` | matchResume API 使用指南 |
| `rule-check-*.md` | rule-check 全栈：用户指南 / 设计 / pipeline / 端到端 |
| `neo4j-instance-storage-plan.md` | Neo4j 实例存储方案 |
| `raas-*.md` / `yeyang-*.md` | RaaS 联调与字段对齐 |
| `action_object_prompt/` | Action 对象 prompt 模板与示例 |
| `superpowers/` | superpowers 工作流相关 spec |

### 3.10 `design_handoff_agentic_operator/` — 原始设计稿

包含 README spec + `styles.css`（OKLCH token 源头）+ 4 个方向（A/B/C/D）的 Babel-in-browser JSX 原型。**只读参考**，不要 `import`。

### 3.11 其它根目录文件

| 文件 / 目录 | 作用 |
|---|---|
| `.env.example` | 后端 / LLM gateway 环境变量模板 |
| `docker-compose.inngest.yml` | 本地 Inngest dev gateway 容器编排 |
| `next.config.js` | Next.js 配置（极简） |
| `postcss.config.js` | PostCSS 入口指向 `@tailwindcss/postcss` |
| `vitest.config.ts` | Vitest 配置（happy-dom env） |
| `prisma.config.ts` | Prisma CLI 配置 |
| `app/globals.css` | **OKLCH 设计 token + Tailwind v4 `@theme inline`**（设计系统的源头） |
| `generated/` | Prisma generated client 输出目录 |
| `__tests__/` | 顶层 vitest 用例（目前只有 sanity） |
| `data/` | SQLite 数据库 + 简历样本 + 本体 cypher 导出 + rule-check 测试报告 |

---

## 4. 端到端业务流程（代码 ⇄ 业务）

以 **一份简历从上传到被推荐给客户** 为例：

| # | 业务步骤 | 事件 | 触发组件 | 主要表 |
|---|---|---|---|---|
| 1 | HR 在 RaaS 前端上传简历，RaaS 把 PDF 落到 MinIO，发 `RESUME_DOWNLOADED` | `RESUME_DOWNLOADED` | RaaS（外部）→ `server/em/publish.ts` 入口 | `RaasMessage` / `EventInstance` |
| 2 | `resumeParserAgent` 订阅 → 从 MinIO 拉 PDF → 调 RaaS `/parse-resume` → 调 RaaS `/candidates` 持久化 | `RESUME_PROCESSED` | `server/inngest/agents/resume-parser-agent.ts` | `EventInstance` / `AgentEpisode` |
| 3 | `matchResumeAgent` 订阅 → 拉该 HR 名下需求列表 → 对每个需求：**（可选）跑 rule-check 预筛** → 调 RaaS `/match-resume` → 调 RaaS `/match-results` 持久化 | `MATCH_RULE_CHECK_PASSED` / `RULE_CHECK_FAILED` / `MATCH_PASSED_NEED_INTERVIEW` | `server/inngest/agents/match-resume-agent.ts` + `lib/rule-check/runner.ts` | `EventInstance` / `AgentEpisode` |
| 4 | rule-check 若判 `REVIEW` → 落 `HumanTask` → `/inbox` 出现待审 | — | `lib/rule-check/runner.ts` → `server/em/publish.ts` 链式 | `HumanTask` |
| 5 | 前端各页面通过 `/api/runs`, `/api/agents`, `/api/events`, `/api/em/event-instances` 等查询事件 / Run / Episode 数据 | — | `app/api/**` + `lib/api/**` | 全部 |

需求 → JD 子流程类似：`REQUIREMENT_LOGGED` → `createJdAgent` → RaaS `/generate-jd` + `/jd/sync-generated` → `JD_GENERATED`。

---

## 5. 设计系统关键约定

> 完整约定见 [`CLAUDE.md`](../../CLAUDE.md) §"Design system"，这里给最小要点。

1. **颜色 token 是 OKLCH 变量**：定义在 `app/globals.css` 的 `:root` 与 `[data-theme="dark"]`，通过 `@theme inline` 与 Tailwind 工具类（`bg-surface` / `text-ink-1` / `bg-accent-bg` / `text-ok` 等）绑定。**永远不要硬编码 `#hex` / `rgb()`**。
2. **没有 `tailwind.config.ts`**：Tailwind v4 的配置全在 CSS 里。
3. **暗色主题**靠 `<html data-theme="dark">`，所有变量被重定义一次，组件自动响应。
4. **i18n**：UI chrome 通过 `t()`；mock 业务字符串（如 "字节跳动" / "ReqSync"）保持中文硬编码。
5. **图标**：`Ic.search` / `Ic.bolt` 这种平面 key，类型是 `IcName`。
6. **原子组件**：`components/shared/atoms.tsx` 里的 `StatusDot` / `Spark` / `Metric` / `Badge` / `Btn` / `Card` 覆盖 ~90% 重复场景，先用它们再考虑自造 div。

---

## 6. 给新人的最少行动清单

1. **跑起来**：`npm install && npm run dev`，打开 <http://localhost:3002>，左导航点一遍 13 个页面熟悉 IA。
2. **看一次 Run**：起 `npm run inngest:up` + `npm run inngest:dev`，跑 `npm run publish:test`，回到 `/live` 看到这条 Run 的全链路。
3. **读三个 agent**：`server/inngest/agents/*.ts`，掌握"订阅 → 调外部 → emit"的固定骨架。
4. **读 EM**：`server/em/index.ts` → `publish.ts` → `validate.ts`，理解一次 `em.publish` 内部发生了什么。
5. **读一遍 `app/globals.css` + `components/shared/atoms.tsx`**，再去碰任何样式。
6. **想改业务**：先去 [`docs/`](../) 找对应主题的设计文档，再下手。

---

## 7. 维护建议

- 本文档（`PROJECT_INTRODUCTION_AGENTIC_OPERATOR.md`）应在出现以下变化时同步更新：
  - 新增 / 删除一个顶层路由（`app/<route>/`）
  - 新增 / 删除一张 Prisma 表
  - 新增 / 删除一个 Inngest agent 或一个 `server/em/`、`lib/rule-check/`、`lib/ontology-gen/` 子模块
  - 端到端业务流程发生不向后兼容的变化
- 单个组件级别的迭代 **不需要** 改本文，依赖 `CLAUDE.md` + 代码注释即可。
- 当本文与 `README.md` / `CLAUDE.md` 出现冲突时：**代码 > 本文 > CLAUDE.md > README.md**（按可信度降序）。
