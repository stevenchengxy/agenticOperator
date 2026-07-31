# AO 生产环境升级指南(老版本 → 当前版本)

> 适用场景:生产环境正跑着一个**老版本 AO**(老代码,多半还在 SQLite `data/ao.db`),
> 你要把它升到**当前版本**(HEAD,Postgres)。
>
> 这次升级会**顺带修掉两个已知线上问题**:① `must_have_skills` 写库报
> `invalid input syntax for type json`、② 审计写库报 `column rule_provenance does not exist`。
> 见 [第五节](#五这次升级到底修了什么为什么必须升)。
>
> 维护者:AO 开发组 · 最后更新:2026-05-29
>
> 📎 相关文档:
> - Postgres 怎么立起来 / 生产加固 / 备份到 MinIO → [ao-sqlite-to-postgres-migration.md](./ao-sqlite-to-postgres-migration.md)
> - 升级后 `column XXX does not exist` 报错 → [ao-database-update-guide.md](./ao-database-update-guide.md)
> - 从 0 部署(env / Inngest 注册等) → [deployment-guide.md](./deployment-guide.md)

---

## 〇、一句话流程

> **备份 → build 新版本 →(若还在 SQLite)起 Postgres + 建表 + 迁数据 → 切流量到新版本 → 验证 →(出问题)回滚。**
> 准备阶段全程**不停服**,只有最后切换那一下需要**几分钟停服**。

---

## 一、先搞清楚:你从哪升到哪

升级前先确认**两件事**,决定走哪条路径。

### 1.1 当前跑的是哪个版本

```bash
# 容器部署(容器名假设 ao-main):看镜像里 baked 的 git SHA / tag
docker inspect ao-main --format '{{.Config.Image}}'
# 或在你 build 镜像的源码目录:
git -C <你的-AO-源码目录> rev-parse --short HEAD

# 当前 HEAD(目标版本)
git rev-parse --short HEAD     # 应是 601b565 或更新
```

如果当前部署的 commit **早于 `601b565`(2026-05-28)**,就缺了 `must_have_skills` 的修复
和(可能)`rule_provenance` 列对应的代码 —— 这次升级正是要解决它们。

### 1.2 当前 AO 的库是 SQLite 还是 Postgres

```bash
# 看运行中的 DATABASE_URL
docker exec ao-main printenv DATABASE_URL    # 容器
# 或
grep DATABASE_URL .env.local                 # 宿主机/PM2
```

| 看到的值 | 你的路径 |
|---|---|
| `file:./data/ao.db`(或 `file:` 开头) | **路径 A**(还在 SQLite)→ [第三节](#三路径-a还在-sqlite--升级并迁到-postgres) |
| `postgresql://...` / `postgres://...` | **路径 B**(已在 Postgres)→ [第四节](#四路径-b已在-postgres--常规代码升级) |

---

## 二、升级前必做:备份 +快照(回滚的前提)

**不备份不要往下走。** 升级失败时,这是你唯一的退路。

```bash
# ① 备份数据库
#   —— 还在 SQLite:就是拷文件(连 WAL 一起)
docker cp ao-main:/app/data/ao.db        ./backup-ao-$(date +%F-%H%M).db   # 容器
docker cp ao-main:/app/data/ao.db-wal    ./backup-ao-$(date +%F-%H%M).db-wal 2>/dev/null || true
#   —— 已在 Postgres:pg_dump(详见 migration 指南 5.6,可直接 pipe 到 MinIO)
docker exec ao-postgres pg_dump -U ao -Fc ao > ./backup-ao-$(date +%F-%H%M).dump

# ② 备份当前 env(尤其 .env.local) + 记录当前镜像 tag,方便回滚
cp .env.local ./backup-env-$(date +%F-%H%M).local 2>/dev/null || \
  docker exec ao-main printenv > ./backup-env-$(date +%F-%H%M).txt
docker inspect ao-main --format '{{.Config.Image}}' > ./backup-image-tag.txt
```

> SQLite 文件路径以你的实际挂载为准(上面假设容器内 `/app/data/ao.db`)。
> 如果 `data/` 是**宿主机挂载卷**,直接 `cp` 宿主机上那个文件更省事。

---

## 三、路径 A:还在 SQLite → 升级并迁到 Postgres

这是当前生产的典型情况。**分三段**:准备阶段不停服,cutover 阶段短停服。

### 阶段 1 · 准备(老版本继续在线,零影响)

```bash
# 1. 拉新代码 + build 新版本镜像 / 产物(不影响在跑的老 ao-main)
git pull
npm ci
npm run build                 # 生产构建(顺带全量 typecheck + lint)
#   容器部署:用新代码 build 一个新 tag 的镜像,先别 run

# 2. 起 AO 的 Postgres(详见 migration 指南第五节:强密码、端口不暴露公网、持久卷)
export AO_POSTGRES_PASSWORD='<强密码>'
docker compose -f docker-compose.postgres.yml up -d --wait

# 3. 对新 Postgres 建表(36 张)。此刻老 app 还在用 SQLite,互不干扰
DATABASE_URL="postgresql://ao:<强密码>@127.0.0.1:5433/ao" npm run db:push
docker exec ao-postgres psql -U ao -d ao -c '\dt' | grep -c table     # 期望 36
```

> ⚠️ 跑 `db:push` 前确认 `DATABASE_URL` 指的就是**这个新 AO Postgres**,别指错库。

### 阶段 2 · Cutover(短停服,几分钟)

为了不丢"迁移当下还在产生"的审计数据,**把数据迁移放在停老 app 之后**:

```bash
# 1. 停老 ao-main(从这一刻起到新 app 起来之间是停服窗口)
docker stop ao-main

# 2.(可选)把老 SQLite 历史数据导进 Postgres
#    需要让迁移脚本能同时读到老 ao.db + 连到新 PG:
#    SQLITE_SOURCE 指老库文件,DATABASE_URL 指新 PG
SQLITE_SOURCE=./backup-ao-XXXX.db \
DATABASE_URL="postgresql://ao:<强密码>@127.0.0.1:5433/ao" \
  npm run db:migrate-from-sqlite        # 幂等;按外键安全顺序逐表导

# 3. 用新版本起 AO,DATABASE_URL 指向 Postgres
#    容器:run 新镜像,环境里 DATABASE_URL=postgresql://ao:<强密码>@ao-postgres:5432/ao
#         (新 ao-main 与 ao-postgres 要在同一 docker 网络)
#    宿主机/PM2:改 .env.local 的 DATABASE_URL 后
#         npm run start   /   pm2 restart agentic-operator
```

> 不想保留历史审计数据 → 跳过第 2 步,新库从空开始即可(业务无损,只是 `/rule-check`
> 等页面看不到升级前的历史)。

### 阶段 3 · 验证 → 见 [第六节](#六验证清单)

完成后,这台 AO 已经跑在新代码 + Postgres 上。以后再升级走 [路径 B](#四路径-b已在-postgres--常规代码升级)。

---

## 四、路径 B:已在 Postgres → 常规代码升级

适用于已经迁过 Postgres 之后的**每一次**版本升级。核心只有"build + 同步 schema + 重启"。

```bash
# 0. 先备份(第二节的 pg_dump)

# 1. 拉代码 + 重 build
git pull
npm ci
npm run build                 # 容器部署:build 新镜像

# 2. ★ 同步数据库 schema(补这次新增的列/表;加列是增量,不丢数据)
npm run db:push               # 容器:docker exec ao-main npx prisma db push
#   —— 这一步是防 `column XXX does not exist` 的关键,千万别漏

# 3. 重启 AO(让新代码 + 新 schema 生效)
pm2 restart agentic-operator  # 宿主机
#   或 容器:docker stop ao-main && docker run ... 新镜像
```

> **强烈建议**:把 `npx prisma db push` 接进 `ao-main` 容器的 **entrypoint**,
> 让它在 app 启动前自动同步 schema。这样每次升级镜像不会再忘记第 2 步,
> `rule_provenance` 这类 drift 就不会复发。

---

## 五、这次升级到底修了什么(为什么必须升)

如果你当前部署早于 `601b565`,线上正在踩这两个坑(它们都**不是数据库迁移引起的**,
是老代码 + 老 schema 的问题,升级即修复):

| 线上报错 | 根因 | 这次怎么修好 |
|---|---|---|
| `must_have_skills … invalid input syntax for type json`(写 job_requisition 时) | 老代码把 JS 数组直接塞进 jsonb 列,被驱动编码成 Postgres 数组字面量 `{…}`,jsonb 解析失败 | HEAD(`601b565`)已改为 `JSON.stringify` 后再写。**重 build 到 HEAD** 即修。详见 [2026-05-28-jd-salary-arrival-and-must-have-skills-bug-analysis.md](../archive/2026-05-28-jd-salary-arrival-and-must-have-skills-bug-analysis.md) |
| `column rule_provenance does not exist`(写 `RuleCheckAudit` 时) | schema 加了 `rule_provenance` 列,但部署的库没 `prisma db push` 同步 → schema drift | 升级流程里的 `npm run db:push`(路径 A 阶段 1 / 路径 B 第 2 步)补上该列即修 |

> 注:第二个是 **soft-fail** —— 只影响 AO 的审计落库,业务判定 / 下游事件全程正常。
> 但仍应升级修掉,否则审计历史一直缺。

---

## 六、验证清单

升级后逐项确认:

```bash
# A. 新版本确实在跑(commit / 镜像 tag 是新的)
docker inspect ao-main --format '{{.Config.Image}}'

# B. AO 起来了,监控页有数据
curl -sf http://localhost:3002/api/health | head -5
#    浏览器开 /fleet /monitor /rule-check —— 列表有数据 = 读库通了

# C. 库连对了 + 表齐(路径 A:应在 Postgres,36 张表)
docker exec ao-postgres psql -U ao -d ao -c '\dt' | grep -c table     # 36

# D. 两个老 bug 不再出现 —— 触发一次真实流程后,看日志没有:
#    "invalid input syntax for type json"
#    "column rule_provenance does not exist"
docker logs --since 10m ao-main 2>&1 | grep -iE "invalid input syntax for type json|rule_provenance does not exist" || echo "✓ 两个报错都没了"

# E. 审计确实落库了(路径 A:查 Postgres)
docker exec ao-postgres psql -U ao -d ao -c \
  'select audit_id, decision, created_at from "RuleCheckAudit" order by created_at desc limit 5;'
```

D 显示 `✓` + E 有新行 → 升级成功。

---

## 七、回滚

升级在 cutover 那一下才有风险。出问题就立刻回退到老版本:

**路径 A 回滚(刚切到 Postgres 就发现不对)**

```bash
# 1. 停新版本
docker stop ao-main            # 新镜像那个

# 2. 用老镜像 tag 起回老 ao-main(tag 在 backup-image-tag.txt 里)
#    老镜像的 DATABASE_URL 本来就是 file:./data/ao.db,老 SQLite 文件没动过

# 3. 起来后确认老版本恢复服务
```

回滚成立的前提:**老 `data/ao.db` 一直没删**(第二节备份过 + cutover 只是停容器没删卷)。

> ⚠️ 回滚后,切到 Postgres 期间产生的新数据留在 Postgres,不会自动回灌 SQLite。
> 所以一旦决定回滚,要趁早(cutover 后几分钟内),别让两边数据越漂越远。

**路径 B 回滚**:用 `backup-image-tag.txt` 的老镜像重新起;若新版本加的列导致老代码异常
(罕见,加列通常向后兼容),从第二节的 `pg_dump` 恢复库即可。

---

## 八、常见坑

| 坑 | 说明 |
|---|---|
| 漏了 `npm run db:push` | 直接触发 `column XXX does not exist`。升级流程里这步**不能省** |
| 升级后没重 build,只重启 | `NEXT_PUBLIC_*` 是 build-time 嵌进 bundle 的,改 env / 升级代码必须**重 build** |
| 新 ao-main 容器连不上 Postgres | 容器里 `DATABASE_URL` 要用 `ao-postgres:5432`(同 docker 网络),**不是** `localhost:5433` |
| 迁数据时 SQLite 与 PG 没对上 | `db:migrate-from-sqlite` 需要 `SQLITE_SOURCE` 指老库、`DATABASE_URL` 指新 PG,两者都要可达 |
| cutover 前没停老 app 就迁数据 | 老 app 还在往 SQLite 写 → 迁完那部分新数据进不了 PG。先 `docker stop` 再迁 |
| 用 `db:reset` / `--force-reset` 修 schema | 那会**清空重建**整库,丢全部数据。升级只用普通 `db:push`(增量加列) |
| 删了老 `data/ao.db` | 删了就没法回滚 / 重导。确认升级稳定运行几天后再归档备份它 |

---

## 九、一条命令快速自检(升级前先跑,看清现状)

```bash
echo "=== 当前镜像 ===" && docker inspect ao-main --format '{{.Config.Image}}' 2>/dev/null; \
echo "=== 当前 DATABASE_URL(判断 SQLite 还是 PG)===" && \
( docker exec ao-main printenv DATABASE_URL 2>/dev/null || grep DATABASE_URL .env.local ); \
echo "=== 目标版本(源码 HEAD)===" && git rev-parse --short HEAD; \
echo "=== AO Postgres 是否已起 ===" && \
docker ps --filter name=ao-postgres --format '{{.Names}} {{.Status}}' || echo "未起 → 路径 A 阶段1 再起"
```
