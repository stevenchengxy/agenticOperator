# 多 Agent 监控架构(Multi-Agent Monitor)— 技术架构设计文档

> 状态:设计稿(尚未实现 · 未动代码) · 日期 2026-06-04 · 已过一轮对抗式 review(AO 引用核实 / 可行性 / 外部事实 / 完整性)
> 关联:本文是在 [`2026-06-01-notification-center-and-audit-completeness-design.md`] 之上的监控层设计;承接其"通知中心"为统一出口,并补齐它遗留的 candidate/job/event 通知接线。

---

## 0. 一句话目标

在**已有 Inngest 运行时 + Postgres 遥测黑板**之上,补一套**先进的 multi-agent 监控层**:**确定性监视器**(健康 / SLA / 成本 / 错误率)做承重骨干,**LLM 判官**(事实审查 / 漂移)只在**抽样**与**争议点**介入;全程 **off-Inngest、AI 可选、按业务域隔离**,产出统一汇入消息通知中心。其中 candidate/job/event 三类通知由**带业务锚点的事实审查命中**(rule-check FAIL,§9.4)与 event 发布填充 —— **注意**:纯基础设施型监视器(health/error-rate)天然归类 `system`/`agent`,不会自动填 candidate/job(见 §6.7 的 categoryOf 约束)。

**不接入 OpenClaw**(理由见 §1.4 ADR)。

---

## 1. 背景与现状

### 1.1 触发(用户三问)

1. 需要哪些 AI Agent 进行监控?
2. 怎么搭一套先进的 Multi-Agents Monitor 架构?
3. 是否需要接入 OpenClaw?

本文给出三问的工程化回答:监视器清单(§4)、总体架构(§3)、OpenClaw 决策(§1.4)。

### 1.2 现状盘点(均已核实到代码)

**已有 · 承重(不重造,直接复用):**

| 能力 | 现状 | 代码锚点 |
|---|---|---|
| Agent 运行时(确定性 step 骨干 + 持久 HITL) | ✅ Inngest 跑各域业务 agent;LLM 调用在隔离 `step.run` + try/catch;人审 `step.waitForEvent` | `server/inngest/**` · `server/inngest/domains/energy/make-agent.ts` |
| 遥测黑板(runs/events/step-traces 镜像) | ✅ polling archiver 镜像进 Postgres;读 Postgres-first + live fallback | `scripts/inngest-archiver.ts` · `lib/inngest-archive/**` · `lib/inngest-source.ts` · `reader.ts`(`listRecentRuns`/`getRunHistory`/`getRunStepOutputs`/`listRunsWithEvents`) |
| 事实审查(rule-check) | ✅ 真实业务产出 ↔ 本体规则逐条判定;**招聘**主判官 LLM-assisted、**能源/费控**主判官是确定性规则引擎;两者皆有**第二个独立 LLM 交叉复核**(verify route,primary_model 招聘=LLM、能源=`确定性规则引擎`) | `server/inngest/agents/rule-check-agent.ts` · `lib/rule-check/{runner,engine}.ts` · `app/api/rule-check-audits/[auditId]/verify/route.ts` |
| 通知中心(确定性 capture→classify→notify + AI 增强) | ✅ 域隔离;`recordNotification` 派生入库;`summarizeAlert` 仅增强、网关挂回落 fallback | `server/notifications/{derive,ingest,summarize,channels}.ts` · `app/api/notifications/route.ts` |
| AI 增强缓存范式(off-Inngest + PG 缓存 + 确定性 fallback) | ✅ run-summary / alert summary 两处同范式 | `server/run-summary/synthesize.ts` · `server/notifications/summarize.ts` · `server/llm/gateway.ts`(`chatComplete`/`isGatewayConfigured`) |

**缺失 · 本设计补:**

| 缺口 | 现状证据 |
|---|---|
| **确定性监视器层完全缺位** | `BehaviorAlert` 模型尚在(`prisma/schema.prisma:595`)但**零调用**(Behavior 轴已删);无活跃 monitor 进程;`cron.sla-sweeper`/`cron.cost-rollup` 仅是 `lib/triggers-static.ts:26-27` 的**展示目录条目**,无对应 handler(`SLA_BREACH_DETECTED`/`COST_ROLLUP_READY` 零订阅者) |
| **rule-check 仍逐条触发,非持续抽样监控** | 仅在 match 流程内同步跑;无对生产流量的采样重评 |
| **漂移检测 + 人工校准回路缺** | 无 judge-vs-human 一致率/混淆矩阵;判官 60–90 天会漂移无人复核 |
| **分诊/根因仅单条总结** | `summarizeAlert` 一次只框一条告警,无跨告警聚类根因 |
| **通知 candidate/job 死分支 + 域标签漏标** | 承通知 spec 未竟项:`categoryOf` 的 candidate/job 分支无真实生产者(唯一带锚点的 `rule-check-agent.ts:360` 硬编 `category:'system'` 被短路);除 energy/费控 工厂外采集端不传 `domain`(`AgentLogContext` 无 domain/anchors 字段) |
| **告警无自动 resolve** | `Notification.status` 支持 `resolved`,但唯一写者是手动 ack(`app/api/notifications/route.ts:144`);条件消失后 firing 行永久挂着 |

**可复用积木(本设计的拼装件):**

- 黑板读:`lib/inngest-archive/reader.ts`(`getRunHistory` 返回每 step `durationMs`,backing SLA 监视器)
- 成本:`lib/monitor/run-token-usage.ts` —— **签名 `getRunTokenUsage(runIds: string[]): Promise<Record<string, RunTokenUsage>>`**(取 run-id 数组,返回 per-run 映射;token 数据**无 domain 维度**,按 run_id 键)
- 健康读:`lib/api/agents-health.ts`(`useAgentsHealth`)、`lib/api/em-health.ts`(`useEmHealth`)—— 客户端 hook,读端点
- 出口:`server/notifications/ingest.ts`(`recordNotification(CaptureInput)`;`CaptureInput` 已含 `domain`/`anchors`/`auditId`/`dedupeHint`)
- 判官:`lib/rule-check/{runner,engine,verify-prompt}.ts` + verify route
- AI fallback 范式:`server/run-summary/synthesize.ts`、`server/notifications/summarize.ts`、`server/inngest/domains/energy/make-agent.ts`(`safeLlm` 超时降级)
- 后台常驻范式:`scripts/inngest-archiver.ts`(standalone tsx 长轮询 + `dev-bootstrap` 用 `pgrep -f` 去重单实例)

### 1.3 与既有设计的关系 + 现有 /monitor 表面集成

- **承接**:`2026-06-01-notification-center`(通知中心 = 本监控层统一出口)、`2026-05-28-local-postgres-inngest-archive`(黑板)、`2026-05-22-unified-logging-audit`(LogEvent 全量上游)、`2026-05-19/28` rule-check + verify 系列(事实判官)、`2026-06-02-energy-hitl-rulecheck-companion`(HITL 三闸口)。
- **集成现有监控表面**:`/api/monitor/*` 命名空间已被占用(`overview/runs/failures/agents/queue/system-status/instances/...`),`/monitor/*` 页面已存在。本设计的新端点用 `/api/monitor/sweep|eval|findings|calibration`(**确认不与现有 handler 撞名**);新 finding 的渲染走**现有通知中心 + `/monitor` 新增 tab**,不另起 UI。须遵守 `2026-05-24-dynamic-monitor-infrastructure` 的"从 live 源派生、无硬编码集合"铁律 —— `enabledMonitors` 来自 `MonitorConfig`(§9.3),不写死 Set。
- **清理**:孤儿 `BehaviorAlert` 表(零调用)独立 PR 删除,knip + build 兜底([[reference_ao_dead_code_knip]]);本设计不复活它。

### 1.4 OpenClaw 决策(Architecture Decision Record)

**决策:不接入 OpenClaw。**

- **它是 agent 运行时,不是监控工具** —— 与 AO 的 Inngest 同类(竞品),不是可叠加的监控层。"接入"实际等于把 agents 从 Inngest 迁到 OpenClaw = 倒退迁移(丢持久 step/事件引擎/重试 + 已有 Postgres trace 归档)。
- **安全风险** —— arxiv 2603.27517 核实:470 条公告,含从 LLM 工具调用到宿主机的**完整未授权 RCE 链**。对多业务域生产控制平面是错误威胁模型。
- **它的可观测性恰好验证 AO 已做对** —— OpenClaw 的监控故事 = "发 OTel span + 几个导出插件";AO 已有更强等价物(Postgres 镜像 trace + 带第二 LLM 复核的 rule-check + 域隔离通知)。
- **唯一可借鉴**:OTel GenAI 语义约定(`gen_ai.*`)——但来自 OTel 标准、非 OpenClaw,且 **Inngest 自身已 ship `extendedTracesMiddleware()` + `InngestSpanProcessor`**,要走 OTel 用 Inngest 中间件即可。见 §5.3。

> 流行度引用口径:OpenClaw 是 GitHub 上**最受欢迎的真实软件项目之一**(~375k stars,仅 awesome-list/教程/课程类聚合仓在其上),**不是**"史上最星"(那是 SEO 夸大)。具体全球排名随时间漂移,不写死名次。SEO 软文集群(clawbot.blog / vyomcloud.com / dextralabs.com / clawhosters.com)不可引为事实源。

---

## 2. 设计原则

1. **确定性优先,AI 是增强层。** "LLM 网关挂了"是最高频告警源;监控若依赖 LLM,网关一挂监控跟着哑。因此 capture→classify→threshold→alert 全程纯算法独立可完成;LLM 判官只叠在上面做事实审查/聚类,失效即回落确定性。(外部权威一致背书:Anthropic 确定性 tracing、AWS logs+metrics+alarms、OTel 把 LLM 遥测当"数据"而非"监控器"。)
2. **监控的检测/合成 off-Inngest。** 所有监视器 = plain Next API route / standalone 进程 + Postgres 缓存,读黑板、写 finding/通知。**不把 observability/synthesis 放上 Inngest**([[feedback_ao_observability_not_inngest]])。*限定语*:HITL **续跑**本身是被观测业务 agent 的事,仍走既有 Inngest `waitForEvent` —— 监控只负责检测与发起人审,边界清晰不破。
3. **Blackboard,不是单一 super-monitor。** Postgres(镜像 runs/events/traces + rule-check findings)是黑板;各监视器是**独立、可各自失败**的反应式 agent,轮询黑板、写回结果。避免单个 LLM 大监控器(Anthropic 实测 multi-agent ~15× token)。
4. **控制面 / 数据面分离;Postgres 唯一持久。** 数据面 = Inngest 跑 agent;控制面 = `AgentVersion`/`AgentConfig`/`MonitorConfig` + Neo4j 本体;archiver = reconcile/listener 回路。*例外*:`MonitorEval`(§9.2)是**持久观测缓存**(与 `RunAiSummary` 同性质),显式豁免"临时态不进持久层",并自带保留期(§9.2)。
5. **"扛得住 LLM 宕机"必须被测试。** 见 §13 runbook。这是全设计的承重保证,P1 硬验收。
6. **按域隔离 + OTel 命名前向兼容。** 每条 finding 带 `domain`;遥测列名向 OTel GenAI `gen_ai.*` 别名映射(非硬改),便于将来导出任意 OTel 后端。
7. **可演进、易回滚。** 每个监视器一个 env 开关;新监视器先 **read-only / observe**,按实测准确率逐步放权到 notify→act。

---

## 3. 总体架构

```
┌─ 数据面 DATA PLANE(agent 运行处 · 非确定性)──────────────────────┐
│  Inngest :8288   每域业务 agent(招聘 / 能源 / 费控)                 │
│  每个 LLM/网关调用 = 隔离 step.run + try/catch 降级                   │
│  人审 = step.waitForEvent(持久挂起,不占机器)                       │
└───────────────────────────────┬───────────────────────────────────┘
            发 runs/events/step-traces │  (archiver ~30s 间隔镜像)
                                       ▼
┌─ 遥测黑板 TELEMETRY BACKBONE(确定性 · 扛得住 LLM 宕机)─────────────┐
│  scripts/inngest-archiver.ts 镜像 → Postgres   读 = Postgres-first   │   ← BLACKBOARD
│  InngestRunArchive / InngestStepArchive / event 镜像                 │
│  reader.ts: listRecentRuns / getRunHistory / getRunStepOutputs / …   │
└───────────────────────────────┬───────────────────────────────────┘
        各监视器轮询黑板、写回 findings/通知 │
                                       ▼
┌─ 监控面 MONITOR PLANE(standalone sweeper + plain route · 不上 Inngest)┐
│                                                                      │
│  ① 确定性监视器(承重 · 无 LLM) ── scripts/monitor-sweeper.ts (60s)   │
│     health · sla · cost(含 runaway) · error-rate                    │
│        └─ 越阈值 → recordNotification(→ system/agent 类 · 带 domain)  │
│        └─ 条件消失 → status:resolved(§6.6)                           │
│                                                                      │
│  ② LLM 事实审查持续监控(抽样 · 争议升级) ── /api/monitor/eval        │
│     rule-check 抽样 groundedness → 争议升 3 模型陪审团(跨家族)        │
│        └─ 分数趋势 → MonitorEval ;命中 → recordNotification(candidate)│
│                                                                      │
│  ③ 漂移 + 校准回路 ── /api/monitor/calibration(定时重评 + 人工标注)   │
│  ④ 分诊 / 根因合成 ── 聚类 firing 告警 → 一句话根因(AI 增强 · fallback)│
│  ⑤ 护栏(可选 · 仅高风险域 · 同步硬拦截)                              │
└───────────────────────────────┬───────────────────────────────────┘
   ▲ 控制面 CONTROL PLANE        │ 统一出口
   │  MonitorConfig(域键)        │
   │  (每域:启用项 / 采样% /     ▼
   │   judge 家族 / 阈值 / 自治级)  ┌──────────────────────────────────┐
   │  Neo4j 本体(judge 评判依据)   │  消息通知中心(域隔离 · 统一权威)  │
   ▼                              │  candidate/job ← rule-check FAIL    │
   人面 HUMAN PLANE ◀─────────────┤  needs_human → 人工待办            │
   通知 + companion → 人决策发事件 → Inngest waitForEvent 续跑(无路径分叉)
```

**数据流(端到端见附录 C):** 业务 agent 在 Inngest 跑 → archiver 镜像进 Postgres(滞后 ≤ 一个 archiver 间隔)→ sweeper 每 60s 读黑板算指标、与 `MonitorConfig` 阈值比对,越线 `recordNotification`(确定性侧靠 `(dedupeKey,status)` upsert 去重)、条件消失则 resolve →(同 sweep 或 `/api/monitor/eval`)对最近窗口业务产出抽样跑判官,分数落 `MonitorEval`,命中且非误报 → `recordNotification(candidate/job, auditId)` → `needs_human` 进人工待办,人决策经事件回灌 Inngest `waitForEvent` 续跑。

---

## 4. 监视器清单(Roster)

> "需要哪些监控 agent" 的正面回答。多数是**确定性监视器**,LLM 判官只占少数关键点。注意 **出口分类** 列:health/error 天然 `system`/`agent`,candidate/job 由②的事实审查命中填(§6.7)。

| # | 监视器 | 类型 | 读什么(黑板) | 算什么 → 发什么 | 出口分类 | 触发 | AO 现状 |
|---|---|---|---|---|---|---|---|
| ① | **health / liveness** | 确定性 | `InngestStepArchive` 每 run 最新 step 时间(心跳) | 最新 step 距今 > 阈值 → run stalled,critical | `system` | sweep 60s | ❌ 新建 |
| ② | **sla / latency** | 确定性 | `getRunHistory` step `durationMs` | p95 step/run 时长 > 域阈值 → warning | `agent` | sweep 60s | ❌ 新建 |
| ③ | **cost / token(含 runaway)** | 确定性(+LLM 轨迹可选) | `getRunTokenUsage(runIds[])`;tool-step 计数 | 越域预算 / 工具调用突破 toolLoop → 告警 | `system` | sweep 60s | ❌ 新建(复用 `getRunTokenUsage`) |
| ④ | **error-rate** | 确定性 | 窗口内失败 step/run + `handler.error` LogEvent | errors/总数 滑窗率(带 min-volume 守卫)越阈值 → 告警 | `agent`/`system` | sweep 60s | 🟡 单条 agent_error 已进通知;缺**率**聚合 |
| ⑤ | **事实审查 fact-monitor** | LLM 判官 | 抽样业务产出 + 本体规则 + 候选/岗位锚点 | Ragas 式 faithfulness 0–1 / PASS-FAIL | **`candidate`/`job`** | sweep 抽样 | ✅ rule-check 已有逐条;缺**持续抽样** |
| ⑥ | **二次复核 → 陪审团** | LLM | 判官判定 | 分歧时 3 模型多数表决 | (写 MonitorEval) | 仅争议样本 | ✅ 有第二 LLM;缺 panel |
| ⑦ | **drift 漂移** | 定时 LLM 重评 | 历史已判样本(同 prompt 版本) | 重判 vs 原判一致率漂移 → 重校准提醒 | `system` | 定时(日/周) | ❌ 新建 |
| ⑧ | **triage / root-cause** | LLM(可选 · fallback) | 同窗 firing 告警簇 | 聚类 → 一句话业务根因 | (写 aiSummary) | lazy-on-view | 🟡 `summarizeAlert` 仅单条 |
| ⑨ | **escalation / 值班** | 确定性 + 人 | `disposition=needs_human` | → 人工待办 → companion → 续跑 | (复用) | 即时 | ✅ 复用 energy 三闸口 |
| ⑩ | **guardrail(可选)** | 廉价 LLM / 确定性 | 高风险域热路径输出 | tripwire 同步硬拦截 | (拦在 agent step 内) | 同步 | ❌ 默认不做 |

**编排说明:** `monitor-sweeper` / `/api/monitor/sweep` 只是**确定性 fan-out**(顺序/并发跑①–④ + 调度⑤抽样),**不是 LLM**,不在告警关键路径 —— blackboard 而非 supervisor 编排,避免单 super-monitor 的 ~15× token 与单点失败。

---

## 5. 遥测黑板(Telemetry Backbone)

### 5.1 现状即黑板

archiver(`scripts/inngest-archiver.ts`,默认 `ARCHIVE_INTERVAL_MS=30000`)把 Inngest runs/events/step-traces 镜像进 Postgres(`InngestRunArchive`/`InngestStepArchive`);`lib/inngest-source.ts` 做 Postgres-first + live fallback(`MONITOR_READ_SOURCE=auto`);`reader.ts` 暴露读 API。**监视器一律读 `reader.ts`/archive,不直连 Inngest**(survive Inngest 抖动)。

### 5.2 统一读端口 `MonitorReadPort`(新增薄封装 `lib/monitor/read-port.ts`)

```ts
export interface MonitorReadPort {
  // health: 心跳 = InngestStepArchive 每 running run 的最新 step 时间(NOT WorkflowRun.lastActivityAt)
  inflightRuns(domain: string | null): Promise<{ runId: string; lastStepAt: Date; functionSlug: string }[]>;
  runDurations(domain: string | null, sinceMs: number): Promise<RunTiming[]>;         // sla(getRunHistory)
  tokenUsageByRun(runIds: string[]): Promise<Record<string, RunTokenUsage>>;          // cost(复用 getRunTokenUsage)
  toolStepCounts(runIds: string[]): Promise<Record<string, number>>;                  // runaway(InngestStepArchive tool steps)
  errorWindow(domain: string | null, windowMs: number): Promise<{ errors: number; total: number }>; // error-rate(带分母)
  recentBusinessOutputs(domain: string | null, sampleRate: number): Promise<AgentOutput[]>;          // fact-monitor 抽样
}
```

**run → domain 映射**:token/step 数据无 domain 维度、按 run_id 键 → 端口内用 `InngestRunArchive.functionSlug`(/Inngest app id)前缀映射到域。**health 心跳源更正**:`WorkflowRun.lastActivityAt` 仅 energy/费控 维护(`make-agent.ts` 在状态转移时更新),招聘 Inngest agent 不写 `WorkflowRun` → 健康心跳统一取 `InngestStepArchive` 最新 step,domain-agnostic 且对所有域可用。

### 5.3 OTel GenAI 命名对齐(前向兼容,**非硬改**)

`lib/monitor/otel-map.ts` 提供 `toOtel(finding)`,仅导出时调用,内部表结构不动:`agent→gen_ai.agent.name`、`model→gen_ai.request.model`、`tokens→gen_ai.usage.{input,output}_tokens`、`traceId→gen_ai.conversation.id`、`op→gen_ai.operation.name`。spec 仍 Development,别名而非硬耦合。若将来要现成 trace UI(Langfuse/Phoenix/Opik 自托管,均 OTLP-native),走 Inngest `extendedTracesMiddleware()` 导出 —— **可选查看器,非依赖**。

### 5.4 节奏 & 新鲜度预算(sweep vs archiver lag)

三个时间常数:archiver `~30s`、sweep `60s`、stall 阈值默认 `5min`。**有效检测延迟 = 阈值 + (archiverInterval + sweepInterval)**,即 health 最坏 ≈ 5min + 90s,可接受(stall 本就是分钟级)。**例外**:若要更快抓 run 停滞,health 的 `inflightRuns` 查询可对该一项设 `MONITOR_READ_SOURCE=live` 绕过镜像滞后 —— 仅此一处,其余读 Postgres-first。

---

## 6. 确定性监视器层(detail)

### 6.1 调度:standalone sweeper(off-Inngest)

监控不能上 Inngest(原则 2),又需周期触发。**采用与 archiver 同款已验证模式(Option C,首选):**

- **C · standalone 长轮询进程(首选)**:新增 `scripts/monitor-sweeper.ts`(tsx `while(!stopping){ sweep(); sleep(MONITOR_SWEEP_INTERVAL_MS||60000) }`),由 `scripts/dev-bootstrap.mjs` `spawn` 启动并 **`pgrep -f scripts/monitor-sweeper` 去重单实例**(完全复刻 archiver)。env `MONITOR_SWEEP=0` 关闭。**单实例由 pgrep 守卫保证**,这同时回答了并发问题。
- A/B(plain route + 外部 cron / `setInterval`)作为备选;但仓库**无外部 cron**,A 实际退化为单进程。
- **多副本部署(如有)**:仓库当前**无 advisory-lock/leader 原语**;若上多副本,须在每个 tick 外加 `pg_try_advisory_lock(sweepKey)`,只让一个副本扫。**幂等契约**:确定性侧靠 `(dedupeKey,status)` upsert 天然幂等(并发/重叠窗口不产重复 firing);判官侧靠 `MonitorEval` 的 `@@unique([kind, sampledFrom])`(§9.2)防重复采样/重复付费。

`sweep()` 体内:`Promise.allSettled([health(), sla(), cost(), errorRate()])`,各监视器独立 try/catch;产出 `CaptureInput[]` → `recordNotification`;再算 resolve(§6.6)。**全程无 LLM。**

### 6.2 health / liveness

- **读**:`inflightRuns(domain)` —— `status='Running'` 的 run + 其 `InngestStepArchive` 最新 step 时间。
- **算法**:`stalled = now - lastStepAt > thresholds.stallMs`(默认 5min);用最新 step 时间作心跳,正常长 step 不误报(有新 step 落库即活)。
- **发**:`dedupeHint=run_stalled.<runId>`(已是 `derive.ts:83` broad-impact 前缀 → critical);出口分类 `system`(若该 run 关联岗位,可在 anchors 带 `job_requisition_id`,但分类仍 system,见 §6.7)。

### 6.3 sla / latency

- **读**:`runDurations(domain, since)`(`getRunHistory` 每 step `durationMs`)。
- **算法**:p95 step / run 端到端时长 vs 域阈值;对比上窗均值的突增检测。
- **发**:`dedupeHint=sla_breach.<agent>.<domain>`,warning,分类 `agent`。

### 6.4 cost / token(含 runaway)

- **读**:`tokenUsageByRun(runIds[])`(复用 `getRunTokenUsage`,**数组入参**);`toolStepCounts(runIds[])`(InngestStepArchive 中 tool 类 step 计数,作 runaway 信号)。
- **算法**:(a) 域窗口 token 累加(经 functionSlug→domain 映射)越 `thresholds.budgetTokens` → 告警;(b) **runaway**:同 run 工具调用次数突破 `thresholds.toolLoop`(递归循环 burn budget 的确定性信号);可选叠 LLM 轨迹判官确认。
- **发**:`dedupeHint=cost_budget.<domain>` / `runaway.<runId>`,critical,分类 `system`。

### 6.5 error-rate

- **读**:`errorWindow(domain, window)` 返回 `{ errors, total }` —— `errors` = 窗口内失败 step/run + `handler.error` LogEvent;**`total` = 同窗 run(或 step)总数**(`InngestRunArchive`/`InngestStepArchive`)。
- **算法**:滑窗率 = errors/total,**min-volume 守卫**(低于 N 事件不发,避免 1/1=100% 噪声);越阈值或突增 → 告警(补足"只有单条 agent_error、无率聚合"的缺口)。
- **发**:`dedupeHint=error_rate.<agent>`,severity 随率分级,分类 `agent`/`system`。

### 6.6 告警 resolve & 抖动窗口(新增 · 承重)

`recordNotification` 今天**只写 firing、从不 resolve**,故必须由 sweeper 主动收口:每次 sweep 算出**本轮每监视器的当前 firing 集**后,把**已不在该集**的同前缀 firing 行 `status → resolved`(如 `run_stalled.*` 的 run 已恢复)。加**滞回/最小再触发窗口**(条件须连续 K 次或 ≥T 秒才翻转)防抖动刷屏。**归属:resolve 由 sweeper 写**(不是 `recordNotification`)。

### 6.7 categoryOf 约束(为什么 health/cost 不归 candidate/job)

`derive.ts:96-109` 的 `categoryOf()` **先**判 `category∈{system,llm_call,api_call,db_call}` 或 `source∈INFRA_SOURCES` → 直接返回 `system`(且 `derive.ts:181` 把 domain 置 null),**再**才看 `anchors.candidate_id/job_requisition_id`。因此:

- **基础设施型监视器(health/cost/error)**用 system/infra 类目 → 归 `system`(domain 被 null);sla 归 `agent`。**它们不会、也不应该自动填 candidate/job。**
- **填 candidate/job 的唯一干净路径**:②事实审查命中 + §9.4 的 rule-check FAIL `recordNotification` —— 用**业务类目**(非 infra)+ 带 `candidate_id/job_requisition_id` 锚点,才走到 candidate/job 分支。
- **可选改造(Open Q §18#7)**:在 `categoryOf` 里"显式锚点优先于 infra 短路",或新增 `monitor` 类目 —— 但那是 `derive.ts` 行为变更,本设计默认**不改 derive,而是约束监视器的 category/source 取值**。

> **统一出口**:确定性监视器**不新建告警表**,直接做 `recordNotification` 的新生产者,复用去重 / 域隔离 / AI 增强缓存。

---

## 7. LLM 事实审查持续监控(扩 rule-check)

### 7.1 抽样异步 groundedness 监控

off-Inngest,与 verify route 同范式;由 sweeper 调度或独立 `/api/monitor/eval` fire-and-forget。每域 `samplingPct`(默认招聘/费控 10%、能源按事件量,config)对业务产出取样。判法 = Ragas 式 faithfulness:抽原子断言 → 逐条对"本体规则 + 候选/岗位事实"核验,score=支持数/总数(**0–1 趋势**,抓部分幻觉);可先用 HHEM 小 T5 分类器廉价初筛再花 LLM。落 `MonitorEval`;低于阈值且非误报 → `recordNotification(category=candidate|job, auditId)`(点亮 rule_check 深链,**仅招聘审计**,见 §9.4)。

### 7.2 陪审团升级(PoLL · 仅争议)

常路径 1 主判官;主判官 vs 第二复核**分歧**或借线 → 升 **3 模型 panel(跨家族)**多数表决。PoLL 证据:跨家族小判官 panel 在人类一致率上胜过单大判官,且成本 **>7× 更低**;只在分歧付第 3 票,开销有界。

### 7.3 偏置缓解(MT-Bench 核实)

| 偏置 | 实测 | 缓解 |
|---|---|---|
| 自偏好 | GPT-4 +10% / Claude-v1 +25% 偏向自家(**原文标注样本有限、未能确证,仅作动机**) | 判官 ≠ 产出 agent 家族,网关选择强制 |
| 位置偏置 | 换序仅 65% 一致、30% 偏第一 | pairwise 双序取平均 |
| 冗长攻击 | GPT-3.5/Claude 91.3% 被骗 vs GPT-4 8.7% | prompt 加长度中立指令;judge 输出尽量**二元** |
| 不可解释 | — | judge 出 **CoT 理由**(G-Eval),落 `MonitorEval.rationale` 可审计 |

### 7.4 落库 `MonitorEval`(§9.2)。 7.5 漂移 + 校准

- **drift**:定时(日/周)对历史样本重评,**须同 `judgePromptVersion`**(否则把 prompt 改动误判成模型漂移);一致率偏离 → "判官需重校准"通知。
- **calibration**:定期抽样人工标注,算 judge-vs-human precision/recall/F1 + Cohen's κ + 混淆矩阵,落控制面看板。判官 60–90 天漂移,按计划重校准 prompt/few-shot(并 bump `judgePromptVersion`)。

---

## 8. 分诊 / 根因合成层

`triage`:对同窗 `firing` 告警**聚类** → 一句话业务根因(扩 `summarizeAlert` 从单条到簇)。off-Inngest、lazy-on-view、网关挂回落确定性模板,复用 `synthesize.ts` 缓存+fallback 范式。不在告警关键路径:聚类失败只少一条 AI 摘要,告警本身已由确定性主干发出。

---

## 9. 数据模型(Prisma)

### 9.1 确定性监视器 → 复用 `Notification`(零新告警表)

确定性监视器(§6)直接 `recordNotification(CaptureInput)`,复用 `Notification`(`schema.prisma:1069`)全部字段与 `(dedupeKey,status)` 去重。**唯一持久新增是 §9.2 的 `MonitorEval`(观测缓存,非告警)。**

### 9.2 `MonitorEval`(新增 · 持久观测缓存 · 自带保留期)

```prisma
model MonitorEval {
  id            String   @id @default(cuid())
  ts            DateTime @default(now())

  domain        String?
  kind          String               // "groundedness" | "jury" | "drift" | "calibration"
  agent         String?
  runId         String?
  auditId       String?              // 关联 rule-check 审计(招聘→ruleCheckAudit;能源→ontology id 空间)
  anchorsJson   String?

  // ── 判定(judge 意见,非权威;权威仍在 RuleCheckAudit/OntologyRuleCheck)──
  score         Float?               // groundedness 0-1
  verdict       String?              // "grounded" | "not_grounded" | "contested"
  juryVotesJson String?              // [{model, family, vote}]
  rationale     String?              // CoT 理由(不落原始 PII)

  // ── 判官元 + 反自偏好 + 可解释漂移 ──
  judgeModel        String?
  judgeFamily       String?          // 必须 ≠ 产出 agent 家族
  judgePromptVersion String?         // drift 比较须同版本;来自 verify-prompt 常量
  rubricVersion      String?
  primaryAgreed     Boolean?         // 主判官 vs 第二复核;false → 触发陪审团

  // ── 成本/延迟(支撑"陪审团成本有界"DoD)──
  llmPromptTokens     Int?
  llmCompletionTokens Int?
  llmDurationMs       Int?

  // ── 幂等 + 自治门控 ──
  sampledFrom   String?              // 来源 run/audit id
  sweepWindow   String?              // sweep 窗口桶(幂等)
  autonomyMode  String?              // "read_only" | "notify" | "act"
  suppressed    Boolean  @default(false) // read_only 下写库但不通知

  // ── 校准(kind=calibration)──
  humanLabel    String?
  agreement     Float?               // judge-vs-human 一致率 / κ

  aiSource      String   @default("llm") // "llm" | "fallback" | "none"(drift/calibration 可为确定性)

  @@unique([kind, sampledFrom])      // 幂等:同来源同类不重复采样/付费
  @@index([domain, ts])
  @@index([kind, ts])
  @@index([auditId])
  @@index([runId])
}
```

**保留期(定缺省,不留 Open Q)**:raw 行保留 **90d**(覆盖 60–90d 判官漂移窗),之后**降采样为日聚合**;sweeper 附带 prune。`MonitorEval` 只存"判官/趋势/校准"观测,**不**重复 rule-check 权威判定(那仍落 `RuleCheckAudit`/`OntologyRuleCheck`)。

### 9.3 监控配置 → **新增 `MonitorConfig`(域键)**

监控配置是**每域**的;而 `AgentConfig`(`schema.prisma:251`)主键是 **per-agent**(`WorkflowAgentDef.id`)、**无 domain 字段**,不适合挂域级阈值。故新增 `MonitorConfig`(`@id domain`):`enabledMonitors[]`、`samplingPct`、`judgeFamily`、`thresholds{stallMs, slaP95Ms, budgetTokens, toolLoop, errorRatePct, minVolume}`、`autonomy ∈ {read_only, notify, act}`。`enabledMonitors` 来自此表,**不写死 Set**(守 dynamic-monitor 铁律)。

**阈值 bootstrap**:`slaP95Ms/budgetTokens/errorRatePct` 由一次性**历史百分位**计算种入(如 `getRunHistory` 近 30d p95);新监视器先 `read_only` 跑到运营确认阈值,再 promote(衔接 §10)。

### 9.4 通知接线补全(承通知 spec 未竟项)

- **采集端域/锚点透传**:`CaptureInput` 本身**已含** `domain/anchors/auditId/dedupeHint`;真正缺口在**上游** —— `AgentLogContext`(`agent-logger.ts:29`)无 `domain/anchors` 字段。改:给 `AgentLogContext` / `RecordLogEventInput` 加字段,在两处 agent_error 采集点(`agent-logger.ts:152`、`log-event.ts:171`)透传进既有 `CaptureInput.domain/anchors`。
- **rule-check 业务 FAIL 发通知**:FAIL 分支(`rule-check-agent.ts:560+`)补一处 `recordNotification(category=candidate, domain, anchors, auditId)`。`auditId` 来自前面 `write-audit` step 的 `auditWriteResult.auditId`(`:496`);**须 guard undefined**(软失败 `:500` 无 auditId 时 `resolveLink` 回落 runId)。**深链 `linkKind='rule_check'` 仅招聘审计可解析**(verify route `prisma.ruleCheckAudit.findUnique`);能源审计走 `ontologyAuditDetail` 的另一 id 空间。
- 结果:candidate/job/event 分类被**事实审查命中**填满,域标签不再漏标(基础设施监视器仍归 system/agent,见 §6.7)。

### 9.5 清理 `BehaviorAlert`:孤儿表,独立 PR 删,knip+build 验。

---

## 10. 控制面(配置 + 自治分级)

配置存 `MonitorConfig`(§9.3)。**自治分级 read_only → notify → act**:新监视器先 `read_only`(只写 `MonitorEval`,`suppressed=true`,不发通知),按 §7.5 校准实测准确率 promote 到 `notify`,再到 `act`(自动干预属 Manage 轴,**本期不做**,§17)。映射 cloud 厂商"先观察、按成功率放权"与 AO 既有 energy 渐进闸口。

---

## 11. API(全 off-Inngest)

| 端点 | method | 触发 | 读 / 写 | 网关挂时降级 |
|---|---|---|---|---|
| (无端点) `scripts/monitor-sweeper.ts` | — | standalone 60s 进程 | 读黑板 → `recordNotification` + resolve | 不受影响(确定性) |
| `/api/monitor/eval` | POST | sweeper 调 / fire-and-forget | 抽样产出 → 判官 → `MonitorEval` | 跳过判官,标 `aiSource='fallback'`,确定性 rule-check 仍兜底 |
| `/api/monitor/findings` | GET | UI(`/monitor` 新 tab) | 读 `Notification` + `MonitorEval` | — |
| `/api/monitor/calibration` | GET/POST | UI / 定时 | 人工标注 in,κ/混淆矩阵 out | — |
| `/api/notifications` | GET/POST | 既有 | 统一出口(补 GET per-row `domain`) | — |

所有写入遵循 `recordNotification` 的 **fire-and-forget · 永不抛**:监控失败不拖垮被观测业务流。**确认新路径不与现有 `/api/monitor/{overview,runs,failures,agents,queue,system-status,instances}` 撞名。**

---

## 12. HITL / 升级

复用 energy 三闸口:`needs_human` 通知 → 人工待办 → companion 点击 → `HUMAN_DECISION` 事件 → 业务 agent 的 Inngest `step.waitForEvent` 续跑(事件历史重放,无路径分叉)。监控层只检测与发起人审;`act` 级自治本期不实装,干预走人审。

---

## 13. 失败模式 + "LLM 网关宕机"保证(runbook)

拔掉 LLM 网关后,断言:

1. ✅(现已保证)Inngest 业务 run 仍靠 step 重试 + try/catch 降级完成;
2. ✅(现已保证)archiver 仍镜像 runs/events/traces 进 Postgres;
3. ⏳(**P1 落地后**保证)确定性监视器①–④ + `recordNotification` 仍发告警 —— *依赖未建的 sweeper + §6.2 心跳源修正 + §6.7 类目约束;在 P1 完成前此条不成立*;
4. ✅(现已保证)判官⑤–⑦退化为"跳过/排队 + `aiSource='fallback'`",不阻塞,确定性本体 rule-check 兜底。

降级矩阵:每监视器声明 `degradeMode ∈ {unaffected, skip, queue}`;sweep 汇总降级状态发一条 `system` 信息。**§16 P1 硬验收门**:断言 3 必须真实通过(监视器存在、心跳源修好、类目带 domain),否则 runbook 会"零监视器=零 LLM 依赖"地空过。

---

## 14. 安全 / 隐私

- **内容捕获 off-by-default**(对齐 OTel GenAI `SHOULD NOT` 默认抓 prompt/response、提供 opt-in)。判官读 trace 按 rule-check 既有脱敏;`MonitorEval.rationale` 不落原始 PII。
- 判官走既有 `server/llm/gateway.ts`,不新增外部出网面。不引入 OpenClaw(§1.4),规避其 RCE 面。

---

## 15. 分阶段 + 文件清单

**P1 · 确定性监视器 + 通知接线(止血优先 · 纯算法 · 无 LLM 依赖)**
- 新增 `scripts/monitor-sweeper.ts`、`lib/monitor/read-port.ts`、`lib/monitor/{health,sla,cost,error-rate,resolve}.ts`
- 改 `scripts/dev-bootstrap.mjs`(spawn + pgrep 守卫 sweeper,env `MONITOR_SWEEP`)
- 改 `server/agent-logger.ts`/`server/log/log-event.ts`(`AgentLogContext` 加 `domain`/`anchors`,透传)
- 改 `server/inngest/agents/rule-check-agent.ts`(业务 FAIL 分支补 `recordNotification`,thread auditId)
- 改 `app/api/notifications/route.ts`(GET 返回 per-row `domain`)
- 删 `BehaviorAlert`(独立 PR)

**P2 · 事实审查持续监控 + 陪审团**
- `prisma` 新增 `MonitorEval` + `MonitorConfig` —— **经 `npm run db:push` 应用(仓库用 prisma db push,无 migrations 目录,见 CLAUDE.md;与在途 schema 改动协调避免 push 冲突)**
- 新增 `app/api/monitor/eval/route.ts`、`lib/monitor/{groundedness,jury}.ts`、阈值 bootstrap 脚本
- 扩 `lib/rule-check/*` 抽样入口 + `judgePromptVersion` 常量;判官跨家族选择写进网关选择

**P3 · 漂移 / 校准 + 分诊 + (可选)护栏 + UI**
- 新增 `lib/monitor/drift.ts`、`app/api/monitor/{calibration,findings}/route.ts`、扩 `summarizeAlert` 聚类
- `/monitor` 新增监控 tab 渲染 `MonitorEval` + findings + κ/混淆矩阵
- (可选)高风险域同步护栏

---

## 16. 测试 / Definition of Done

- [ ] **承重 runbook(§13)**:断网关脚本断言四条 —— **P1 硬验收**,且断言 3 须真实通过(监视器存在 + 心跳源修好 + 类目带 domain),不得空过。
- [ ] 确定性监视器单测:黑板 fixture(stalled run / 超时 step / token 超预算 / 错误突增)→ 断言产出正确 `CaptureInput`(category/severity/domain/dedupeKey/anchors)。
- [ ] **resolve / 抖动**:恢复的 run 一个 sweep 内翻 `resolved`;条件反复切换不产 N 条 firing(滞回窗口)。
- [ ] **幂等 / 并发**:两个并发 sweep tick / 重叠窗口,每条件**恰一条** firing 行;判官采样器不重评同一 run/audit(`MonitorEval @@unique`)。
- [ ] 通知接线:rule-check 业务 FAIL → 通知中心出现 `category=candidate` 行 + rule_check 深链解析到真实审计;域切换正确隔离;candidate/job/event 在真实流程下**非空**。
- [ ] 判官跨家族强制(`judgeFamily ≠ 产出 family`);陪审团仅在 `primaryAgreed=false` 触发(`MonitorEval` 的 token/latency 列可证成本有界)。
- [ ] drift 仅在同 `judgePromptVersion` 内比较;校准看板渲染 κ/混淆矩阵。
- [ ] 全部监控写入 fire-and-forget 永不抛。

---

## 17. 不做的事(YAGNI)

- **不接入 OpenClaw**(§1.4)。不引第二持久执行引擎。
- **不把监控检测/合成放上 Inngest**(standalone 进程 + plain route + PG;HITL 续跑除外,那是业务侧)。
- **不做单一 LLM super-monitor**(blackboard + 确定性骨干)。
- **不强制 OTel 重写**(别名映射;spec 仍 Development)。
- **不做自动干预 act 级自治**(属 Manage 轴;本期 read_only/notify + 人审)。
- **不改 `derive.ts` categoryOf 短路顺序**(默认约束监视器 category/source 取值;改 derive 列为 Open Q)。
- **不实装外部渠道**(承通知 spec:飞书/邮件/短信仍 no-op;站内唯一真实渠道)。
- **不默认上同步硬护栏**(100–300ms 热路径开销;仅高风险域按需)。
- **不引第三方 trace UI 为依赖**(Langfuse/Phoenix/Opik 自托管仅作可选查看器)。

---

## 18. Open questions

1. **sweeper 多副本**:单实例(pgrep 守卫)够用,还是要 `pg_try_advisory_lock` 上多副本?
2. **采样率默认**:招聘/费控 10%、能源按事件量 —— 是否够省又够覆盖?
3. **runaway 是否叠 LLM 轨迹判官**:纯确定性 `toolLoop` 阈值是否足,还是必须 LLM 确认递归?先纯确定性,误报多再加。
4. **judge 家族池**:网关当前可达哪些跨家族模型,够不够组 3 模型 panel?
5. **health 是否对 inflight 查询走 live**(§5.4)以削 archiver 滞后,代价是直连 Inngest?
6. **MonitorConfig vs 复用域配置**:域级配置是否已有别处载体可挂,避免新表?
7. **是否改 `categoryOf`**:让显式 candidate/job 锚点优先于 infra 短路(更直观,但改 derive 行为 + 需回归通知 spec 测试)?

---

## 附录 A · 监视器 ↔ 业界模式映射(核查来源)

| AO 监视器 | 业界模式 | 主来源(已核实) |
|---|---|---|
| 事实审查 fact-monitor | LLM-as-judge 单调用 0-1+pass/fail 五维 rubric | Anthropic multi-agent research system |
| 陪审团 | Panel-of-LLMs(PoLL,>7× 更省) | arXiv 2404.18796 |
| 偏置缓解 | MT-Bench 位置/自偏好(原文未确证)/冗长 | arXiv 2306.05685(NeurIPS'23) |
| 护栏 tripwire | OpenAI Agents SDK guardrails(廉价守贵) | OpenAI Agents SDK docs |
| 确定性 health/sla/cost/error | OTel-telemetry 上阈值监控 | AWS Bedrock AgentCore / AWS prescriptive guidance |
| 控制/数据面 + reconcile | LangGraph Platform data-plane listener | docs.langchain.com/langgraph-platform/data-plane |
| 确定性骨干 + LLM-in-step 抗宕机 | Temporal durable workflow / Inngest steps | temporal.io / inngest.com docs |
| OTel 命名对齐 | GenAI semantic conventions(Development) | opentelemetry.io semconv gen-ai |
| groundedness 抽样 | Ragas Faithfulness(+HHEM) | docs.ragas.io |

## 附录 B · OpenClaw 决策核查要点

- 真实但是**运行时**(个人 AI 助手,Peter Steinberger;~375k stars,最受欢迎的真实软件项目之一,仅聚合/教程类在其上;"史上最星"为 SEO 夸大)。
- 安全:arxiv 2603.27517,470 公告,完整未授权 RCE 链。
- 对 AO:运行时层面**倒退迁移**;可观测层面 AO 已有更强等价物;唯一可借 = OTel GenAI 约定(经 Inngest OTel 中间件,非经 OpenClaw)。

## 附录 C · 端到端示例:一条 health 告警的完整生命线

```
t=0       招聘 match-resume run 在 Inngest 启动(InngestRunArchive status=Running)
t=0..120s 正常落 step(InngestStepArchive 每 step endedAt 刷新 = 心跳)
t=120s    run 卡在某 LLM step(网关慢),无新 step 落库
t≈150s    archiver 镜像最新 step(滞后 ≤30s)
t=180s    sweeper tick:inflightRuns 读到该 run,now-lastStepAt=60s < stallMs(5min) → 不发
t=420s    now-lastStepAt=300s ≥ stallMs → recordNotification(
              level=critical, dedupeHint='run_stalled.<runId>', anchors={job_requisition_id},
              category 经 categoryOf → 'system', domain=null)  → 写 firing, count=1
          → eager-on-critical summarizeAlert(网关挂则 fallback 模板)
t=480s    sweeper tick:仍 stalled → upsert count=2, lastSeenAt 刷新(不刷屏)
t=510s    run 恢复(新 step 落库)→ 下个 archiver 镜像
t=540s    sweeper tick:run 已不在 stalled firing 集 → status→resolved(§6.6)
```

> 这条生命线同时验证了:心跳源(InngestStepArchive)、节奏/滞后预算(§5.4)、`(dedupeKey,status)` 幂等去重、resolve 收口、categoryOf 归类(system + domain=null,符合 §6.7)。
