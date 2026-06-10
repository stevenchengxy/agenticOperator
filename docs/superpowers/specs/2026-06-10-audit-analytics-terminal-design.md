# 审计日志完善 + 通知修复 + 运行统计可视化 + 终端日志页 — 设计

2026-06-10。范围:(1) 审计日志全量落 Docker 本地 Postgres;(2) 消息通知系统 bug 修复与完善;(3) 新增按天/小时/周的 agent 运行统计可视化页(含 RoboHire 等外部调用次数);(4) 在审计日志里新增 terminal 风格实时日志页。

## 1. 现状调查结论(16 个并行 agent + 对抗性核实)

已有底座:`LogEvent`(统一审计日志,`/api/log-events` 可查)、`InngestRunArchive/EventArchive/StepArchive`(每条 run/event 落库,含 Failed/Cancelled)、`Notification`(策展层)。`/audit` 页已有 4 tab(运行/事件/运维/日志)。

**确认的真 bug(对抗核实通过):**

- **归档器步骤轨迹永久丢失** `scripts/inngest-archiver.ts:83-84` — `needTrace` 要求 `(isNew || statusChanged)`,若归档器在 `upsertRun`(写入终态)与 `archiveRunTrace` 之间退出(SIGTERM 不等在途 tick,`shutdown()` 直接 `process.exit`),或 `getRunHistory` 瞬时失败(soft catch 不重试),下个 tick `statusChanged=false` → trace 永远不再抓取,`traceFetched=false` 的行成为死行,monitor 对该 run 显示空轨迹且 Inngest 擦除后不可恢复。
- **通知 `read_all` 跨域误清** `app/api/notifications/route.ts:141` — `updateMany({readAt:null})` 无 domain 条件;UI(`NotificationsContent.tsx:94`)也不传 domain。招聘域点"全部已读"会把能源/费控域的未读一并清掉。
- **LeftNav 未读徽标与通知页口径不一致** `components/shared/LeftNav.tsx:22` — 徽标取全域 `needsHuman`,通知页按活动域过滤,数字对不上。

**确认的缺口(非 bug,但本任务要求覆盖):**

- `logApiCall`(RoboHire/Allmeta/partner-pg/RMHR 全部外部调用)只写 `logs/*.log` 文件 + stdout,**不落 Postgres**;且无 agent/run 归属字段 → 无法按 agent 统计 RoboHire 调用次数。
- ALS 路径(`currentLogger()?.apiCall` → LogEvent category='tool')在 Inngest step.run replay 时丢 context(2026-05-25 事故的成因),DB 覆盖不可靠。
- 无统计聚合 API、无图表页、无 terminal 日志 UI。
- EM schema 拒绝(`rejected_schema`)无任何通知;AI 富化失败被 `.catch(()=>{})` 静默吞;AppBar 铃铛无跳转无徽标。
- candidate-identity / candidate-ownership 两个 agent 不写 LogEvent(运行只在 InngestRunArchive + OntologyRuleCheck)。

## 2. 设计

### A. 审计日志全量落 Postgres

**A1 外部 API 调用落库(新 'api' lane)。** `lib/external-api-log.ts` 的 `logApiCall` 在文件写之后 fire-and-forget 调 `server/log/api-call-mirror.ts#mirrorApiCall`,写一行 LogEvent:

- `source='external'`,`category='api'`(新 lane,与 ALS 的 'tool' lane 并存避免双计;统计只读 'api')
- `eventName=label`(如 `RoboHire.parseResume`),`durationMs`,`level = error? 'error':'info'`
- `agent`/`runId`/`traceId` 来自 `ApiLogEntry` 新增可选字段 `agent`/`run_id`;`AgentLogger` 接口暴露 `ctx`,4 个 client(robohire/allmeta/partner-pg/rmhr)从手头 logger 取 ctx 透传 → 不依赖 ALS,step.run replay 也稳定
- `payloadJson` 存 `{url,method,status,error,request,response}` 截断 4000 字符(全量仍在文件日志);message 为单行摘要
- 纯映射函数 `apiLogToLogEvent(entry)` 可单测;镜像失败 swallow + console.warn,绝不影响业务调用

**A2 归档器修复。** `needTrace = isTerminalStatus(r.status) && !prev?.traceFetched`(去掉 `(isNew||statusChanged)` 门),崩溃/瞬时失败后下个 tick 自动补抓;24h 滚动窗口天然给重试设上限。`shutdown()` 等待在途 tick 完成再退出。

**A3 候选人侧 agent 补审计。** candidate-identity / candidate-ownership 加 `createAgentLogger` + handler.start/done/error 三相(走既有 mirrorAgentFileLog 桥),运行轨迹进 LogEvent。

### B. 消息通知修复/完善

- **B1** `POST /api/notifications` 接受 `domain`,`read_all` 复用 `domainScopeWhere`;UI 传活动域。
- **B2** LeftNav 徽标请求带 `domain`(读 `useDomain()`),与页面口径一致。
- **B3** EM 拒绝通知:`server/em/publish.ts` 的 `rejected_schema` 路径(严格模式两处)落 `recordNotification`(warning alert,`dedupeHint='em_schema_reject.'+name`,category 走 event lane);`rejected_filter` 是有意过滤不通知。
- **B4** `summarizePendingAlerts` 失败由 `.catch(()=>{})` 改为记一行 LogEvent warn(category='anomaly', source='system'),仍不抛。
- **B5** AppBar 铃铛:跳 `/notifications` + 未读红点(domain-scoped unread,10s 轮询,与 LeftNav 同模式)。

### C. /analytics 运行统计页(业务名"运行统计")

- **API** `GET /api/analytics/stats?window=24h|7d|30d&bucket=hour|day|week`(bucket 默认随 window:24h→hour,7d→day,30d→day;week 仅 30d 可选)。`$queryRaw` + `date_trunc`:
  - `runsByAgent`: inngest_run_archive 按 (bucket, function_slug) 计数 + 状态拆分(Completed/Failed/Cancelled/Running)
  - `apiCalls`: log_event `category='api'` 按 (bucket, eventName 的 provider 前缀, agent) 计数 + error 数 + p50/总耗时
  - KPI: 总 run 数、失败率、外部调用总数、RoboHire 调用数
- **UI** `app/analytics/page.tsx` + `components/analytics/AnalyticsContent.tsx`:KPI 条 + 手绘 SVG 堆叠柱状图(每 agent 一色,按 bucket)+ 外部调用分 provider 柱状图 + agent 筛选 pill + 窗口/粒度切换。复用 atoms(Card/Badge/Metric),不引第三方图表库。LeftNav "Observability" 组加 `nav_analytics`(运行统计),i18n zh+en。

### D. /audit 终端实时日志 tab

`AuditContent` 加第 5 个 tab "实时终端"。`TerminalLogTab`:

- 终端视觉:固定深色面板(不随主题翻转)、mono、level 着色(error 红/warn 黄/notice 青/info 灰)、`[ts] [level] [agent] message` 行格式,payload 展开为缩进 JSON
- 实时:2s 轮询 `/api/log-events?since=<lastTs>` 增量 append(复用现有 API,新增 `order=asc` 支持增量拉取),上限保留最近 2000 行
- 交互:follow-tail(滚到底自动跟随,上滚暂停)、暂停/继续、清屏、agent/level 过滤

## 3. 测试与验证

- vitest:`apiLogToLogEvent` 映射、archiver `needTrace` 判定(抽成纯函数)、notifications POST domain 范围(现有 ingest/derive 测试模式)、stats bucket 参数归一化纯函数。
- `npm test` + `npm run build`;实测:触发一次 RoboHire 调用路径(或直接调 mirrorApiCall)后查 `log_event` 表 category='api' 行存在。
