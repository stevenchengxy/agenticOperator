# AO 数据库迁移 + 部署指南:SQLite → Postgres

> 适用对象:**still 跑在老 SQLite(`data/ao.db`)上的 AO 部署**,以及**要在生产环境
> 把 AO 的 Postgres 立起来**的运维同学。
>
> 本文讲清楚:① 我们为什么把 AO 的库从 SQLite 换成 Postgres、② 代码里到底改了什么、
> ③ 本地/单机怎么部署、④ **生产环境怎么部署(含备份到 MinIO)**、⑤ 出问题怎么回滚。
>
> 迁移日期:2026-05-28 · 维护者:AO 开发组 · 最后更新:2026-05-29
>
> 📎 配套文档:部署后日常拉新代码遇到 `column XXX does not exist` 报错,
> 看 [ao-database-update-guide.md](./ao-database-update-guide.md)(schema drift 修复)。

---

## 〇、一句话总览

> AO 的库从 单文件 SQLite(`data/ao.db`)迁到了 **Postgres**(开发用 Docker 容器
> `ao-postgres`,端口 5433;生产同一套 compose,改强密码 + 持久卷即可)。
> **代码层面只换了 datasource provider + driver adapter,所有表结构 / 字段名 / 业务逻辑
> 完全不变**。部署要做的就是:起一个 Postgres、把 `DATABASE_URL` 指过去、
> `prisma db push` 建表、(可选)把旧 SQLite 数据导一次过去。

---

## 一、为什么要从 SQLite 改成 Postgres

老架构里 AO 把自己的运营 / 审计 / 配置数据全塞进一个**单文件 SQLite**(`data/ao.db`)。
两个硬伤:

1. **并发写差**。SQLite 同一时刻只允许一个写者,整库级写锁。AO 现在有多个 agent 函数
   (resume-parser / match-resume / rule-check …)被 Inngest 并发调起,同时写
   `RuleCheckAudit`、`AgentActivity`、`WorkflowStep` 等表 → 频繁 `SQLITE_BUSY` / 写排队。
2. **不是生产级、单点故障**。单文件没有真正的连接池、没有 WAL 之外的持久化保障,
   文件一旦损坏 / 误删,整个 AO 的运营历史就没了。

**对运维意味着什么**(SQLite → Postgres 的心智变化):

| | 老 SQLite | 新 Postgres |
|---|---|---|
| 形态 | 一个文件 `data/ao.db` | 一个**服务**(进程 / 容器),要管端口、连接、卷 |
| 备份 | 拷文件 | `pg_dump`(见 [第五节 5.6](#56-备份到-minio)) |
| 并发 | 整库写锁 | 行级 MVCC,多 agent 并发写 OK |
| 凭证 | 无 | 用户名 / 密码(生产务必改强密码) |

> 同一批改动(2026-05-28)里还顺手加了 **Inngest 镜像归档**(把 Inngest 的
> runs/events/traces 持续抓进同一个 Postgres,防止 Inngest 崩了监控页空白)。那部分是
> **附带功能**,本文聚焦"AO 库从 SQLite 换 Postgres + 怎么部署";归档器只在
> [第七节](#七可选附带功能inngest-归档器) 简单提一下。
> 完整设计见 [docs/superpowers/specs/2026-05-28-local-postgres-inngest-archive-design.md](./superpowers/specs/2026-05-28-local-postgres-inngest-archive-design.md)。

---

## 二、代码层面到底改了什么(只有 5 处)

迁移**没有重写任何业务代码**,改动收敛在数据访问层 + 部署脚手架:

| # | 文件 | 改动 | 影响 |
|---|------|------|------|
| 1 | `prisma/schema.prisma` | `datasource db { provider = "sqlite" → "postgresql" }` | 表结构 / 字段名 **一个没动**。JSON 列仍是 `String`/TEXT(service 层本来就 `JSON.parse`),所以读写代码零改动 |
| 2 | `server/db/index.ts` | 改成**双 adapter**:按 `DATABASE_URL` 的 scheme 选驱动 | `postgresql://` / `postgres://` → `@prisma/adapter-pg`(默认);`file:` → `better-sqlite3`(只剩迁移脚本读旧库时用) |
| 3 | `package.json` | 加依赖 `@prisma/adapter-pg`;新增 npm 脚本 | `pg:up` / `pg:down` / `pg:logs` / `db:migrate-from-sqlite` / `archive` |
| 4 | `docker-compose.postgres.yml`(新增) | 起 AO 专属 Postgres | `postgres:17-alpine`,容器 `ao-postgres`,端口 **5433→5432**,named volume `ao-pgdata`,`restart: unless-stopped`,healthcheck |
| 5 | `.env.example` / `dev-bootstrap.mjs` / `prisma.config.ts` | 默认连接串改 Postgres;首跑自动供给 | `npm run dev` 会自动 `pg:up` + `prisma db push`(**仅 dev**;生产要手动) |

**关键设计点 ——「按 scheme 自动选驱动」**(`server/db/index.ts`):

```ts
// postgresql:// | postgres://  → PrismaPg     (默认,prod + dev)
// file:                        → better-sqlite3 (legacy / 仅迁移脚本读旧库用)
function makeAdapter(url: string) {
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
    return new PrismaPg(url);
  }
  return new PrismaBetterSqlite3({ url: url.replace(/^file:/, "") });
}
```

> ✅ **好处**:回滚极简单 —— 只要把 `DATABASE_URL` 改回 `file:./data/ao.db`,
> 代码自动切回 SQLite 驱动,不用改一行代码、不用 rebuild。见 [第六节](#六回滚)。

当前 schema 共 **36 张表**(32 张业务表 + 4 张 Inngest 镜像表),全部由 `prisma db push`
在 Postgres 里一次建好。

---

## 三、关键概念:这个库装什么 + 一条安全红线

- 这个 Postgres 是 **AO 私有的运营 / 审计 / 配置库**,由 `DATABASE_URL` + Prisma
  访问(`prisma.*` 全走它)。装的是 `WorkflowRun` / `RuleCheckAudit` / `AgentConfig` /
  `EventInstance` 等 36 张表。
- 它和 **MinIO 各司其职、互不替代**:MinIO 是 S3 兼容对象存储,存简历 PDF 二进制;
  这个 Postgres 存的是**结构化运营数据**。两者在生产里通常跑在同一套基础设施上,
  但角色完全不同。

> 🚨 **唯一红线**:`prisma db push` / `db:reset` / `db:migrate-from-sqlite` 这些命令
> 会按 `DATABASE_URL` 把 36 张表 schema **推到它指向的那个库**。跑之前**务必确认
> `DATABASE_URL` 指的就是你要建表的那个 AO Postgres**,别指到任何其它生产库 ——
> push 是结构性写操作,推错库不可逆。

> 端口说明:**本地开发默认用 5433(host)→ 5432(container)**,避免和本机可能已有的
> 其它 Postgres(默认占 5432)冲突;容器内仍是标准 5432。生产端口你自己定
> (见 [第五节](#五生产环境部署))。

---

## 四、本地 / 单机快速部署(开发,或从 SQLite 切过来)

> 前置条件:**Docker**、**Node ≥ 22**、本机 **5433 端口空闲**。
> 不用 Docker、想连一个已有的 Postgres → 跳过 Step 1,Step 2 直接把 `DATABASE_URL`
> 指向那个库(scheme 仍是 `postgresql://`)。

### Step 0 —— 拉新代码 + 安装依赖

```bash
git pull                 # 拉到含 Postgres 迁移的 AO 代码
npm install              # 装上 @prisma/adapter-pg 等新依赖
```

### Step 1 —— 起 AO 的本地 Postgres

```bash
npm run pg:up
# = docker compose -f docker-compose.postgres.yml up -d
# 起容器 ao-postgres(postgres:17-alpine),端口 5433,数据存 named volume ao-pgdata
```

确认起来了:

```bash
docker ps | grep ao-postgres        # 应看到 ao-postgres 在跑 + 0.0.0.0:5433->5432
npm run pg:logs                      # 看健康日志(Ctrl-C 退出)
```

### Step 2 —— 配 `DATABASE_URL`

编辑 `.env.local`(没有就 `cp .env.example .env.local`):

```bash
DATABASE_URL="postgresql://ao:ao_local_pw@localhost:5433/ao"
```

- AO 跑在**宿主机**(`npm run dev` / `start` / PM2)→ host 用 `localhost:5433`。
- AO 跑在**另一个容器**里 → host 用容器名 `ao-postgres:5432`(同一 docker 网络),
  **不是** `localhost:5433`(容器内 localhost 不是宿主机)。

> 📌 `prisma.config.ts` **先加载 `.env.local` 再加载 `.env`**,确保 `prisma db push`
> 和运行中的 app 用**同一个** `DATABASE_URL`,不会一个推 A 库、app 连 B 库。

### Step 3 —— 建表

```bash
npm run db:push    # = prisma db push,把 36 张表建进 Step 2 指的那个 Postgres
docker exec ao-postgres psql -U ao -d ao -c '\dt' | head -40   # 验证
```

### Step 4 —— (可选)把旧 SQLite 数据导进 Postgres

**只有想保留老 `data/ao.db` 的历史数据时才做。** 想从空库开始就跳过。

```bash
ls -lh data/ao.db                    # 确认旧库还在(别的路径用 SQLITE_SOURCE 覆盖)
npm run db:migrate-from-sqlite       # 幂等;= tsx --env-file=.env.local scripts/migrate-sqlite-to-pg.ts
```

迁移脚本(`scripts/migrate-sqlite-to-pg.ts`)行为:
- `better-sqlite3` **只读**打开旧库,逐表 `createMany` 进 Postgres,按**外键安全顺序**
  (先父后子),自动类型转换(`0/1`→`boolean`、ISO 串→`DateTime`)。
- **幂等**:重复跑只 `skipDuplicates`。旧库只读不删 → 天然回滚兜底。
- 旧库没有的新表(`inngest_*_archive`)自动跳过。
- 想先清空再全量重导(谨慎):`npm run db:migrate-from-sqlite -- --wipe`(先 `TRUNCATE ... CASCADE` AO 表)。

### Step 5 —— 起 AO

```bash
npm run dev          # 开发:自动再确认 pg:up + prisma db push + 起归档器,端口 3002
```

`npm run dev` 内部跑 `dev-bootstrap.mjs`,**首跑自动**建 `.env.local`、`pg:up`、
`prisma db push`、后台起归档器(全 soft-fail)。**生产部署不会自动做这些**,见下一节。

---

## 五、生产环境部署

> 场景:在生产机(通常就是已经跑着 MinIO 等服务那套基础设施)上把 AO 和它的 Postgres
> 立起来。**和开发的核心差异只有三点:强密码、持久卷在可靠磁盘上、定时备份。**
> 命令本身一样。

### 5.1 拓扑

```
 生产机 / 一套内网基础设施
 ├─ AO (Next 生产 build,端口 3002;宿主机 或 容器 ao-main)
 │     └── DATABASE_URL ──► AO Postgres
 ├─ AO Postgres (容器 ao-postgres,postgres:17-alpine,卷 ao-pgdata)   ← 本节立的就是它
 └─ MinIO (S3 对象存储,存简历 PDF;AO 备份也丢这里,见 5.6)
```

AO Postgres 与 MinIO 是**两个独立服务**:Postgres 存运营/审计结构化数据,MinIO 存简历
二进制 + (推荐)数据库备份文件。

### 5.2 起生产级 Postgres

复用同一个 `docker-compose.postgres.yml`,但**生产务必覆盖默认弱密码**。compose 里这些
都是 env 可覆盖的(`${AO_POSTGRES_PASSWORD:-ao_local_pw}` 等):

```bash
# 把生产凭证放进部署密钥管理 / 宿主机环境变量,严禁写进 git。
export AO_POSTGRES_USER=ao
export AO_POSTGRES_PASSWORD='<在这里放一个强密码>'
export AO_POSTGRES_DB=ao
export AO_POSTGRES_PORT=5433

docker compose -f docker-compose.postgres.yml up -d --wait
```

生产加固要点:

- **强密码**:别用默认 `ao_local_pw`。
- **不要把 DB 端口暴露到公网**。两种安全姿势:
  - AO 也跑在容器里 → 让 `ao-main` 和 `ao-postgres` 进**同一个 docker 网络**,DB **不映射
    宿主机端口**(删掉 compose 的 `ports:`),AO 直接连 `ao-postgres:5432`。
  - AO 跑在宿主机 → 把端口**只绑到 127.0.0.1**。compose 默认是 `5433:5432`(等于
    `0.0.0.0`),改成只绑本地需要一个 override 文件:

    ```yaml
    # docker-compose.postgres.prod.yml  —— 与主 compose 叠加,只覆盖端口绑定
    services:
      postgres:
        ports:
          - "127.0.0.1:${AO_POSTGRES_PORT:-5433}:5432"
    ```
    ```bash
    docker compose -f docker-compose.postgres.yml -f docker-compose.postgres.prod.yml up -d --wait
    ```
- **持久化 + 重启**:已配 named volume `ao-pgdata` + `restart: unless-stopped`。确认
  Docker 的 volume 目录落在**可靠 / 有空间 / 进备份**的磁盘上。`npm run pg:down` 停容器
  **保留**数据;**只有** `down -v` 才清 volume。
- **镜像版本**已 pin 在 `postgres:17-alpine`。

### 5.3 配生产 `DATABASE_URL`

```bash
# AO 在宿主机:
DATABASE_URL="postgresql://ao:<强密码>@127.0.0.1:5433/ao"
# AO 在容器(同 docker 网络,推荐):
DATABASE_URL="postgresql://ao:<强密码>@ao-postgres:5432/ao"
```

### 5.4 建表 +(可选)导旧数据

生产**不会**自动跑 `prisma db push`(那是 dev-bootstrap 才做的),要**手动**执行一次:

```bash
# 宿主机:
npm run db:push
# 容器:
docker exec ao-main npx prisma db push
```

要保留老 SQLite 历史数据 → 把旧 `data/ao.db` 拷到生产机,按 [Step 4](#step-4--可选把旧-sqlite-数据导进-postgres) 跑一次 `db:migrate-from-sqlite`。

### 5.5 部署 AO 本体

```bash
# 方式 A · 宿主机(配 PM2 / systemd 守护)
npm ci
npm run build          # 生产 build(顺带 typecheck + lint)
npm run start          # 端口 3002

# 方式 B · 容器 ao-main
#   - 镜像里带 AO 代码 + Prisma + 正确的 DATABASE_URL(指 ao-postgres:5432)
#   - 和 ao-postgres 同一 docker 网络
#   - 推荐:把 `npx prisma db push` 接进容器 entrypoint,app 启动前自动同步 schema
#     —— 这样每次升级镜像后不会忘了建/补列(见 5.7)
```

> 提醒:`NEXT_PUBLIC_*` 类变量(如 `NEXT_PUBLIC_INNGEST_URL`)是 **build 时**嵌进
> bundle 的,改了要**重新 build**;`DATABASE_URL` 是运行时读的,改了**重启进程**即可。

### 5.6 备份到 MinIO

Postgres 的备份不是"拷文件",是 `pg_dump`。生产既然有 MinIO,直接把 dump 丢进 MinIO 桶
做冷备(用 MinIO Client `mc`):

```bash
# 一次性配置 mc 指向你的 MinIO,并建一个备份桶
mc alias set prodminio http://<minio-host>:9000 <ACCESS_KEY> <SECRET_KEY>
mc mb --ignore-existing prodminio/ao-db-backups

# 备份:pg_dump(custom 压缩格式)直接 pipe 上传,不落本地盘
docker exec ao-postgres pg_dump -U ao -Fc ao | \
  mc pipe prodminio/ao-db-backups/ao-$(date +%F-%H%M).dump
```

每天定时备份 + 留 14 天(放进生产机 crontab,示例 03:00):

```bash
0 3 * * * docker exec ao-postgres pg_dump -U ao -Fc ao | mc pipe prodminio/ao-db-backups/ao-$(date +\%F).dump
# 清理 14 天前的备份(MinIO 侧也可以直接配 bucket 生命周期规则替代这行)
30 3 * * * mc rm --recursive --force --older-than 14d prodminio/ao-db-backups
```

**恢复**(灾备演练务必跑通一次):

```bash
mc cp prodminio/ao-db-backups/ao-2026-05-29.dump ./restore.dump
cat restore.dump | docker exec -i ao-postgres pg_restore -U ao -d ao --clean --if-exists
```

> 建议:用 MinIO bucket 的 versioning / object-lock 或生命周期规则管理保留期,
> 比 cron 删更稳。

### 5.7 升级流程(每次拉新代码)

AO 改了 `prisma/schema.prisma`(加列/加表)后,生产**必须同步一次 DB**,否则会出现
`column XXX does not exist` 这类 schema drift(详见 [ao-database-update-guide.md](./ao-database-update-guide.md)):

```bash
git pull && npm ci && npm run build      # 或 重新 build ao-main 镜像
npm run db:push                          # ★ 起 app 前先同步 AO 库(容器:docker exec ao-main npx prisma db push)
# 再(重)启 AO
```

> 最稳妥:把 `prisma db push` 接进 `ao-main` 容器的 entrypoint,启动前自动跑。

### 5.8 生产 checklist

- [ ] `AO_POSTGRES_PASSWORD` 是强密码,且来自密钥管理而非 git
- [ ] DB 端口未暴露公网(私有网络 或 127.0.0.1)
- [ ] `ao-pgdata` volume 在可靠磁盘上
- [ ] `prisma db push` 已跑、`\dt` 能看到 36 张表
- [ ] 定时 `pg_dump` → MinIO 已配,且**恢复**演练过一次
- [ ] 升级流程含 `prisma db push` 这一步
- [ ] (如启用)归档器在跑,见 [第七节](#七可选附带功能inngest-归档器)

---

## 六、回滚

迁移设计成**可秒回**,因为旧 SQLite 文件没删、代码按 scheme 自动选驱动:

```bash
# 把 DATABASE_URL 改回 SQLite,重启 AO(不用改代码、不用 rebuild):
DATABASE_URL="file:./data/ao.db"
```

改成 `file:` 开头后,`server/db/index.ts` 自动切回 `better-sqlite3` 驱动。
**前提是 `data/ao.db` 还在** —— 迁移期间务必留着它。

> ⚠️ 回滚后,迁到 Postgres 期间产生的新数据**留在 Postgres 里**,不会自动回灌 SQLite。
> 回滚只适合"迁移当场发现问题、立即切回",不适合"跑了几天再切回"。

---

## 七、(可选)附带功能:Inngest 归档器

同一批改动还加了个**独立长驻进程** `scripts/inngest-archiver.ts`(`npm run archive`),
定时把 Inngest 的 runs/events/step-traces 抓进这个 Postgres 的 `inngest_*_archive` 表。
作用:Inngest 崩了 / volume 被清,监控页能回退读 Postgres 不空白。

- `npm run dev` 会**后台自启**(去重,见 `dev-bootstrap.mjs`);生产可单独 `npm run archive`
  (建议也用 PM2 / systemd 守护)。不想要 → `.env.local` 设 `ARCHIVE_ENABLED=0`。
- 监控读数据源由 `MONITOR_READ_SOURCE` 控制:`auto`(默认,PG 优先、缺则回退 live)/
  `postgres` / `live`。

不影响 DB 迁移本身;只想换库不要归档,设 `ARCHIVE_ENABLED=0`,其余步骤不变。

---

## 八、红线清单 + 常见坑

| 禁止 / 注意 | 原因 |
|---|---|
| ❌ `prisma db push` 前没确认 `DATABASE_URL` 指向哪个库 | push 是结构性写操作,推错库不可逆 |
| ❌ 迁移期间删 `data/ao.db` | 删了就没法回滚 / 重导。迁完确认无误再归档备份它 |
| ❌ 用 `npm run db:reset`(= `prisma db push --force-reset`)修问题 | 会**清空重建**整个库,丢掉所有数据 |
| ❌ AO 在容器里却把 `DATABASE_URL` 写 `localhost:5433` | 容器内 localhost 不是宿主机 → 连不上。要用 `ao-postgres:5432` |
| ❌ 生产用默认密码 `ao_local_pw` / 把 DB 端口开到公网 | 数据库裸奔 |
| ⚠️ 改了 `DATABASE_URL` 后 app 还连旧库 | `.env.local` 改完要**完全重启**进程(不是 reload) |
| ⚠️ `pg:down` vs `pg:down -v` | `pg:down` 停容器**保留**数据(volume `ao-pgdata`);加 `-v` 才清 |
| ⚠️ 拉了加列的新代码后忘了 `prisma db push` | 触发 `column XXX does not exist`,见 [ao-database-update-guide.md](./ao-database-update-guide.md) |

---

## 九、一条命令快速自检

```bash
echo "=== DATABASE_URL(确认指向你要建表的 AO Postgres)===" && \
( grep DATABASE_URL .env.local 2>/dev/null || docker exec ao-main printenv DATABASE_URL ); \
echo "=== AO Postgres 容器是否在跑 ===" && \
docker ps --filter name=ao-postgres --format '{{.Names}} {{.Status}} {{.Ports}}'; \
echo "=== 36 张表是否已建好 ===" && \
docker exec ao-postgres psql -U ao -d ao -c '\dt' 2>/dev/null | grep -c table
```
