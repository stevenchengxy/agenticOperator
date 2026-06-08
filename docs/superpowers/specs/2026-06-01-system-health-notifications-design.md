# 系统健康通知 + 通知详情(看日志、定位问题)— 设计

**日期**: 2026-06-01
**范围**: 把消息通知中心补齐到"能用于真实运行环境"。建立在已交付的通知中心之上
(`server/notifications/*`、`Notification` 表、`/notifications` UI、AI 总结层),只补三块。
关联: [2026-06-01-notification-center-and-audit-completeness-design.md](./2026-06-01-notification-center-and-audit-completeness-design.md)。

## §1 背景与目标

用户原话:"系统哪里出现问题,或者 agentic operator 的后端崩了、再重启,都是消息,都可以发送
通知;但通知系统不要太复杂,一定要让人能懂、能看到详细日志、能够定位问题所在;后台可以由
agents 监督和操作分析和发送通知。"

拆成三个可交付块,**刻意保持简单**(不做设置页、免打扰、值班轮值、限流机器):

1. **后端崩溃/重启监测 → 通知** — 进程启动即记录;若上次没有正常关闭,判为异常重启并告警。
2. **通知详情抽屉(看详细日志 · 定位问题)** — 点任一通知,展开看 AI 分析 + 关联的原始
   `LogEvent` 日志 + 深链,让人能定位问题。
3. **AI 后台值守** — 复用已有 `summarize` 层(它就是"agents 分析并组织通知");崩溃 = critical
   → eager-on-critical 已自动触发 AI 分析,网关挂时退化为确定性 fallback。

非目标(本期不做): 真实外部投递(飞书/邮件)、设置页、免打扰时段、自治率仪表盘、值班轮值。

## §2 设计原则(延续既有)

- **确定性优先**: 崩溃检测、日志关联全是纯算法,零 LLM 依赖(LLM 网关本身就是头号告警源)。
- **永不抛出**: 通知/心跳失败绝不能拖垮被观测的业务流程,全部 try/catch + 降级。
- **不上 Inngest**: 心跳/启动属于进程生命周期 + 观测,走 `instrumentation.ts` + 普通模块,
  不进 Inngest(沿用 observability 不上 Inngest 的约定)。
- **去开发者术语**: 通知正文是业务语言;原始日志收在详情抽屉里(给要定位问题的人看)。

## §3 后端崩溃/重启监测

### 数据模型 — `ServiceHeartbeat`(单行,id 固定 `'default'`)

```
id              String   @id @default("default")
bootCount       Int      @default(0)
lastBootAt      DateTime?
lastHeartbeatAt DateTime?
cleanShutdown   Boolean  @default(true)   // 上次是否正常关闭
pid             Int?
updatedAt       DateTime @updatedAt
```

### 启动流程(`instrumentation.ts` 的 `register()`,仅 `NEXT_RUNTIME === 'nodejs'`)

1. 读取上一行 `ServiceHeartbeat`。
2. `evaluateBoot(prev, now)`(**纯函数,可单测**)判定:
   - `prev == null` → `first`(首次启动)。
   - `prev.cleanShutdown === true` → `clean`(正常重启)。
   - `prev.cleanShutdown === false` → `crash`,downtime = `now - lastHeartbeatAt`。
3. 据判定记录通知(fire-and-forget,经现有 `recordNotification`):
   - `first` / `clean` → `level:'info'`, `category:'system_lifecycle'`, 文案"后端服务已启动" →
     落为 **message**(进中心、不告警)。
   - `crash` → `level:'critical'`, `category:'system'`, `dedupeHint:'backend_crash_restart'`,
     文案"后端异常重启 · 上次未正常关闭,停机约 N 分钟" → 落为 **critical alert**(告警 + 触发 AI 分析)。
4. 写新行: `bootCount+1`, `lastBootAt=now`, `lastHeartbeatAt=now`, `cleanShutdown=false`, `pid`。
5. 启动心跳: `setInterval` 每 ~30s 更新 `lastHeartbeatAt`(`unref()` 不挡退出)。
6. 注册 `SIGTERM`/`SIGINT`(用 `prependListener`,在 Next 自带 handler 之前跑)→
   `installShutdownHandlers()`: **同步**写一个 clean-shutdown marker 文件 +(best-effort)
   异步落 `cleanShutdown=true`。

> **为什么需要 marker 文件**(实现中发现的关键点): Next.js 自己的 SIGTERM handler 会在异步 DB
> 写入 flush 之前就退出进程,导致每次正常重启都被误判为崩溃、刷屏告警。所以"是否正常关闭"以
> **同步写入的 marker 文件**为权威信号(瞬时完成,不受进程立即退出影响);`evaluateBoot` 判定为
> clean 的条件是 **marker 存在 或 DB flag=true**(双保险)。marker 路径默认 `os.tmpdir()`,
> 可用 `AO_SHUTDOWN_MARKER` 覆盖。已用真实 `next start` 进程 SIGKILL/SIGTERM 验证三态。

> `derive.ts` 仅需把 `'system_lifecycle'` 加入 `MESSAGE_CATEGORIES`,使正常启动作为 message 浮现;
> 崩溃走已有的 critical-system-alert 路径,无需改动。

## §4 通知详情抽屉(看日志、定位问题)

### `GET /api/notifications/[id]`

返回该通知 + **关联的原始日志**。关联规则(纯函数 `correlateLogs`,可单测,按优先级取第一个命中):

- 有 `runId` → `LogEvent where runId`(按 ts,取 ~100)。
- 否则有 `traceId` → `LogEvent where traceId`。
- 否则有 `agent` → `LogEvent where agent` 且 ts ∈ [firstSeenAt−窗口, lastSeenAt+窗口]。
- 否则(系统类) → `LogEvent where ts ∈ 窗口 且 level ∈ {warn,error,critical}`,取 ~100。

(窗口默认 ±10 分钟。)返回结构: `{ notification, logs: LogEventRow[], href }`。

### 抽屉 UI `NotificationDetailDrawer`(沿用 `RuleCheckAuditDetailDrawer` 的右侧遮罩模式)

- 头部: 标题 + severity badge + 重复次数 + 首次/最近时间 + 来源。
- **AI 分析结论**: `aiSummary`(无则提示"分析中/算法兜底"),带 LLM/算法来源 badge。
- **详细日志**: 关联 `LogEvent` 列表(时间 · level · 来源 · message,error/critical 高亮;
  可展开 `payloadJson`)。这是"定位问题"的核心。
- **跳转**: 深链到运行详情 / 运行日志(`/audit`),以及"在审计日志查看完整上下文"。

### 接入

`NotifCard` 由 `<a href>` 跳转改为 `onClick` 打开抽屉(深链移到抽屉内)。打开即标记已读
(`POST {action:'read'}`)。

## §5 测试

- `evaluateBoot`: first / clean(marker 或 DB flag)/ crash 三态 + downtime 计算。
- `correlateLogs`: runId / traceId / agent / 系统窗口四条优先级分支构造正确 where。
- `GET /api/notifications/[id]`: 命中 + 404 + 日志关联(route test)。
- `derive`: `system_lifecycle` 走 message 分支、`backend_crash_restart` 走 critical alert 分支。
- AI fallback 行: 已有覆盖,崩溃 critical 复用之。

## §6 文件清单

- `prisma/schema.prisma` — 新增 `ServiceHeartbeat`。
- `server/health/boot.ts` — `evaluateBoot`(纯) + `recordBoot` / `markCleanShutdown` / `startHeartbeat`。
- `server/health/boot.test.ts`。
- `instrumentation.ts` — `register()` 调用上面三者 + 信号处理。
- `server/notifications/correlate.ts` + `.test.ts` — `correlateLogs` where 构造器。
- `app/api/notifications/[id]/route.ts` + `.test.ts`。
- `components/notifications/NotificationDetailDrawer.tsx`。
- `components/notifications/NotificationsContent.tsx` — 接入抽屉。
- `server/notifications/derive.ts` — `MESSAGE_CATEGORIES` 加 `system_lifecycle`(+ 测试)。
- `lib/i18n.tsx` — 详情抽屉文案(zh + en)。
