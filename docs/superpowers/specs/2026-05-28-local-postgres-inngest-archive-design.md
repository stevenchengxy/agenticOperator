# 本地 Postgres 持久化 + Inngest 数据归档器 — 设计

**日期**: 2026-05-28
**状态**: approved (用户批准全做所有 phases)

## 1. 问题

AO 监控页(`/monitor`、`/events`、`/live`、`/fleet`)的 run / event / step-trace 数据
**全部实时读自 Inngest dev server**(`lib/inngest-admin-client.ts` 走 GraphQL/REST :8288)。
Inngest 把这些数据存在自己的 volume 里,AO 侧**没有任何持久化副本**。两个后果:

1. Inngest 的 volume 被清 / 容器崩 / 进程半死 → 历史 run/event/trace 全丢,监控页空白。
2. AO 自己的业务库是**单文件 SQLite**(`data/ao.db`),并发写差、不是生产级、单点故障。

## 2. 目标

- 起一个**本地 Postgres**,把 AO 业务库从 SQLite 迁过去(持久、并发安全)。
- 在同一个 Postgres 里加 **Inngest 镜像表**,后台**归档器**持续把 Inngest 的
  events/runs/step-traces 抓进来 → 一旦归档,即使 Inngest 后来宕机/清库也不丢。
- 监控读路径支持 **Postgres 优先、live 回退**,Inngest 宕机时监控仍可用。
- 完善部署环境变量 + 配置(docker-compose、.env、bootstrap、文档、npm 脚本)。

## 3. 关键决策(已与用户确认)

| 决策 | 选择 | 理由 |
|------|------|------|
| 范围 | 全量:迁 AO 库 + 镜像 Inngest | 一个持久库同时解决两个缺口 |
| 抓取机制 | 轮询归档器 | 复用现有 GraphQL client;幂等;可补抓已完成 run;与 agent 运行时解耦 |
| 归档器运行形态 | **独立 node 进程** | 与 Inngest 调度器 + Next.js 生命周期都解耦,AO/Inngest 重启都继续 |
| 本地 PG 端口 | **5433** | 5432 已被 `raas-postgres-dev` 占用,不能冲突 |
| JSON 列类型 | 保持 `String`/TEXT | service 层本来就 `JSON.parse`,读路径零改动,迁移风险最小 |

## 4. 架构

```
 Inngest dev :8288   ┌─ scripts/inngest-archiver.ts (独立进程) ─┐
 (live 真相源) ──────┤  每 ARCHIVE_INTERVAL_MS 轮询              │
                     │  GraphQL/REST → 幂等 upsert               │
                     └───────────────┬──────────────────────────┘
                                     ▼
 AO Next :3002 ───── 本地 Postgres :5433 (Docker ao-postgres, vol ao-pgdata)
 (Prisma client)     ① AO 业务表 24 张(从 SQLite 迁移)
                     ② Inngest 镜像表 4 张
                                     ▲
 /api/inngest-admin/* ── lib/inngest-source.ts (PG 优先 / live 回退)
```

## 5. Phase 1 — Postgres 供给 + Prisma 切换

### 5.1 供给
- 新增 `docker-compose.postgres.yml`:`postgres:17-alpine`,容器名 `ao-postgres`,
  端口 `${AO_POSTGRES_PORT:-5433}:5432`,named volume `ao-pgdata`,healthcheck。
- npm 脚本:`pg:up` / `pg:down` / `pg:logs`。

### 5.2 Prisma
- `schema.prisma`:`datasource db { provider = "postgresql" }`。
- 加依赖 `@prisma/adapter-pg`。
- `server/db/index.ts`:按 `DATABASE_URL` scheme 选 adapter
  (`postgresql://`/`postgres://` → `PrismaPg`;`file:` → 保留 better-sqlite3,仅供迁移脚本读旧库)。
- HMR-safe pool 复用(参照 `lib/partner-pg/client.ts` 的 globalThis 模式)。

## 6. Phase 1 — Inngest 镜像表(4 张,新增于 schema.prisma)

```prisma
model InngestEventArchive {
  id          String    @id            // Inngest event id
  internalId  String?   @map("internal_id")
  name        String
  data        String                   // JSON
  ts          DateTime?
  receivedAt  DateTime? @map("received_at")
  sourceApp   String?   @map("source_app")
  archivedAt  DateTime  @default(now()) @map("archived_at")
  @@index([name, ts])
  @@index([archivedAt])
  @@map("inngest_event_archive")
}

model InngestRunArchive {
  runId           String   @id @map("run_id")
  functionSlug    String   @map("function_slug")
  functionName    String?  @map("function_name")
  appId           String?  @map("app_id")
  status          String                 // Running|Completed|Failed|Cancelled
  startedAt       DateTime? @map("started_at")
  endedAt         DateTime? @map("ended_at")
  durationMs      Int?      @map("duration_ms")
  eventName       String?   @map("event_name")
  triggerEventIds String?   @map("trigger_event_ids")  // JSON string[]
  eventPayload    String?   @map("event_payload")       // JSON
  output          String?                               // JSON
  flowId          String?   @map("flow_id")
  traceFetched    Boolean   @default(false) @map("trace_fetched")
  archivedAt      DateTime  @default(now()) @map("archived_at")
  lastSyncedAt    DateTime  @default(now()) @updatedAt @map("last_synced_at")
  steps           InngestStepArchive[]
  @@index([functionSlug])
  @@index([status])
  @@index([startedAt])
  @@index([flowId])
  @@map("inngest_run_archive")
}

model InngestStepArchive {
  id          String   @id              // `${runId}:${spanID}`
  runId       String   @map("run_id")
  run         InngestRunArchive @relation(fields: [runId], references: [runId], onDelete: Cascade)
  spanId      String   @map("span_id")
  name        String
  stepOp      String?  @map("step_op")
  status      String?
  attempts    Int?
  durationMs  Int?     @map("duration_ms")
  queuedAt    DateTime? @map("queued_at")
  startedAt   DateTime? @map("started_at")
  endedAt     DateTime? @map("ended_at")
  input       String?                   // JSON
  output      String?                   // JSON
  error       String?                   // JSON
  archivedAt  DateTime  @default(now()) @map("archived_at")
  @@index([runId])
  @@map("inngest_step_archive")
}

model InngestArchiveCursor {
  id             String    @id @default("singleton")
  lastPollAt     DateTime? @map("last_poll_at")
  lastSuccessAt  DateTime? @map("last_success_at")
  eventsArchived Int       @default(0) @map("events_archived")
  runsArchived   Int       @default(0) @map("runs_archived")
  stepsArchived  Int       @default(0) @map("steps_archived")
  lastError      String?   @map("last_error")
  lastErrorAt    DateTime? @map("last_error_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")
  @@map("inngest_archive_cursor")
}
```

## 7. Phase 2 — 一次性数据迁移

`scripts/migrate-sqlite-to-pg.ts`:
- 两个 Prisma client(源 = better-sqlite3 读旧 `data/ao.db`;目标 = pg)。
- 按 FK 安全顺序逐表 `createMany`(parent 先于 child)。
- 旧 SQLite 文件保留作回滚。
- npm `db:migrate-from-sqlite`。

## 8. Phase 3 — 轮询归档器

### 8.1 `lib/inngest-archive/writer.ts`(纯逻辑,可单测)
- `archiveEvents(events)` → upsert `InngestEventArchive`。
- `archiveRuns(runs)` → upsert `InngestRunArchive`(更新 status/endedAt)。
- `archiveRunTrace(runId, history)` → upsert run output/eventPayload + `InngestStepArchive`,标 `traceFetched=true`。
- `readRunSyncState()` → Map<runId, {status, traceFetched}> 用于决定哪些 run 要抓 trace。
- `updateCursor(stats)`。

### 8.2 `scripts/inngest-archiver.ts`(长驻进程)
每 `ARCHIVE_INTERVAL_MS`(默认 30000):
1. `listEvents(ARCHIVE_EVENT_LIMIT)` → `archiveEvents`。
2. `listRecentRuns({ limit: ARCHIVE_RUN_LIMIT, sinceHours: ARCHIVE_WINDOW_HOURS })` → `archiveRuns`。
3. 对**新出现**或**状态刚转终态**且 `traceFetched=false` 的 run:`getRunHistory(runId)` → `archiveRunTrace`(并发上限节流)。
4. `updateCursor`。
- 全部幂等;`ARCHIVE_ENABLED=0` 时空转退出。
- npm `archive` = `tsx --env-file=.env.local scripts/inngest-archiver.ts`。

## 9. Phase 4 — 读路径(PG 优先 / live 回退)

- `lib/inngest-archive/reader.ts`:与 `inngest-admin-client.ts` **同签名**,读 Postgres
  (`listRecentRuns`、`getRunHistory`、`listEvents`、`listRunsWithEvents`)。
- `lib/inngest-source.ts`:解析器,按 `MONITOR_READ_SOURCE`:
  - `live` → 只走 Inngest(现状)。
  - `postgres` → 只走 PG。
  - `auto`(默认)→ PG 优先;PG 空/陈旧/抛错则回退 live。
- `/api/inngest-admin/*` 路由从 `inngest-admin-client` 改 import `inngest-source`。
  保持返回 shape 不变(零 UI 改动)。

## 10. Phase 5 — 配置 / ops / 文档

- `.env.local` + `.env.example`:
  - `DATABASE_URL=postgresql://ao:ao_local_pw@localhost:5433/ao`
  - `ARCHIVE_ENABLED=1`、`ARCHIVE_INTERVAL_MS=30000`、`ARCHIVE_WINDOW_HOURS=24`、
    `ARCHIVE_EVENT_LIMIT=200`、`ARCHIVE_RUN_LIMIT=200`、`ARCHIVE_TRACE_CONCURRENCY=4`
  - `MONITOR_READ_SOURCE=auto`
  - compose 用 `AO_POSTGRES_USER/PASSWORD/DB/PORT`
- `dev-bootstrap.mjs`:best-effort `pg:up` + `prisma db push` + 起归档器(soft-fail)。
- `CLAUDE.md`:更新 stale 的 "frontend-only / no backend" 段,补 Postgres + 归档器。
- `README`:部署章节补 PG/archiver。
- npm 脚本:`pg:up`/`pg:down`/`pg:logs`/`archive`/`db:migrate-from-sqlite`。

## 11. 验证(确保无 bug)

- `npm run build`(typecheck + lint)绿。
- `vitest run` 绿(writer / reader / source 单测)。
- 端到端:`pg:up` → `prisma db push` → 起归档器 → 发测试事件 →
  查 PG 三张表有数据 → `/api/inngest-admin/runs` 在 `MONITOR_READ_SOURCE=postgres` 下返回归档数据。

## 12. 范围外(YAGNI)

- 归档保留/裁剪策略(先全留)。
- 跨 app 归档(仍受 `MONITORED_APP_PREFIX` 限制)。
- Inngest Cloud REST 源。
- 任何新 UI 页面(Phase 4 只换数据源)。
