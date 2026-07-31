# AO 数据库更新指南(给 partner)

> 适用场景:部署 AO 后日志出现 `The column XXX does not exist in the current database`
> 这类报错,或每次拉了改过 `prisma/schema.prisma` 的新代码之后。
>
> 维护者: AO 开发组 · 最后更新: 2026-05-29

---

## 一、一句话结论

这类报错**不是代码 bug,不需要改 AO 代码**。是 **AO 自己的 Postgres 表结构落后于代码**(schema drift):
代码里新增了一列(例如 `rule_provenance`),但你部署的那个 AO 数据库还是旧表结构,缺这一列。

**修法**:对 **AO 自己的库** 跑一次 `prisma db push`,把缺的列补上即可。加列是增量操作,**不丢数据**。

报错是 **soft-fail**(写审计表的代码包在 try/catch 里),所以:

- ✅ 业务判定(通过 / 失败)、Neo4j 写入、事件 emit **全部正常**,流程没断。
- ❌ 只有 AO 那张审计表(`RuleCheckAudit`)这几条没存进去 → AO 的 `/rule-check` 审计详情页会缺这些 run 的数据。

补完列之后,后续 run 自动恢复落库。已经漏掉的那几条不会自动回灌(影响仅限 UI 历史展示,业务无损)。

---

## 二、⚠️ 最重要:更新的是哪个库

AO 部署里有**两个完全独立的 Postgres**,这次要更新的是**前者**:

| | AO 自己的库 ✅ **本指南操作的对象** | RAAS partner 库 ❌ **绝对不要碰** |
|---|---|---|
| 配置项 | `DATABASE_URL` | `RAAS_POSTGRES_URL` |
| 典型值 | `postgresql://ao:ao_local_pw@localhost:5433/ao`(容器内是 `...@ao-postgres:5432/ao`) | `postgresql://postgres:postgres@192.168.1.104:5432/raas_db` |
| 访问方 | **Prisma**(`prisma.*` 全走这个) | 独立 `pg` 客户端,**完全不经过 Prisma** |
| 容器 | `ao-postgres`(或你部署里 AO 专用的 pg) | RAAS 那台 `192.168.1.104` |
| `RuleCheckAudit` 表 | ✅ 在这里 | ❌ 不在这里 |

**怎么判断报错属于哪个库**:报错来自 `prisma.ruleCheckAudit.create()`。凡是 `prisma.xxx` 的调用,数据源 100% 是 `DATABASE_URL` 指的那个库,跟 `raas_db` 无关。

> 🚨 **红线**:`prisma db push` 之前,务必确认 `DATABASE_URL` 指向的是 **AO 的库**,
> **不是** `raas_db`。如果误把 `DATABASE_URL` 设成 RAAS 的连接串再 push,会把 AO 整套
> schema(几十张表)强行推到 partner 的生产库上,可能破坏 RAAS 数据。**这是不可逆的。**

---

## 三、立即修复(3 步)

下面给两种执行环境,**二选一**。AO 用 Docker 跑(容器 `ao-main`)就用 **方式 A**;
直接在宿主机用 `npm run start` / PM2 跑就用 **方式 B**。

### 方式 A · AO 跑在 Docker 容器里(容器名 `ao-main`)

```bash
# Step 1 —— 先确认容器里的 DATABASE_URL 指向 AO 库,不是 raas_db
docker exec ao-main printenv DATABASE_URL
# 期望看到 .../ao 这种(host 多半是 ao-postgres 或 localhost:5433)
# 如果看到 192.168.1.104 / raas_db —— 立刻停手,配置错了,先排查再说

# Step 2 —— 对 AO 库同步 schema(加列,增量,不丢数据)
docker exec ao-main npx prisma db push

# Step 3 —— 验证列已存在(连 AO 的 pg 容器查)
docker exec ao-postgres psql -U ao -d ao -c '\d "RuleCheckAudit"' | grep rule_provenance
# 看到 rule_provenance 一行 → 成功
```

> 容器里能直接跑 `prisma db push`,是因为 `ao-main` 镜像里已经带着 AO 代码、Prisma schema
> 和它自己正确的 `DATABASE_URL`。**不需要也不应该**手动拼连接串。

### 方式 B · AO 跑在宿主机(`npm run start` / PM2)

```bash
# Step 1 —— 确认 .env.local 里的 DATABASE_URL 指向 AO 库
grep DATABASE_URL .env.local
# 期望 postgresql://ao:...@localhost:5433/ao(或你 AO pg 的实际地址)
# 不能是 raas_db

# Step 2 —— 同步 schema(prisma 会读 .env.local 里的 DATABASE_URL)
npm run db:push          # 等价于 npx prisma db push

# Step 3 —— 验证
psql "postgresql://ao:ao_local_pw@localhost:5433/ao" -c '\d "RuleCheckAudit"' | grep rule_provenance
```

### 修完要不要重启 AO?

**不用**。`prisma db push` 只改数据库表结构,不改代码。列补上的那一刻起,后续 run 的
审计写入立即恢复。无需重启 `ao-main` / 重新 build。

---

## 四、为什么这样做是安全的

- **加的是可空列**(schema 里是 `rule_provenance String?`)。`prisma db push` 对新增可空列
  是纯 `ALTER TABLE ADD COLUMN`,**不动现有数据、不锁表风险极低**。
- **一次 push 补齐所有 drift**。如果你的 AO 库还差别的列(不只 `rule_provenance`),
  `prisma db push` 会一次性把 schema 里所有缺的列 / 表都补上,你不用逐个排查。
- **幂等**。已经同步好的表 / 列会跳过,可以放心多跑几次。

> ⚠️ 唯一要避开的命令是 `npm run db:reset` / `prisma db push --force-reset` ——
> 那个会**清空重建**整个 AO 库(丢掉所有审计历史)。本次修复**不要**用它,只用普通
> `prisma db push`。

---

## 五、防止复发:以后每次拉新代码的标准动作

这次报错的根因是**部署流程缺一步 schema 同步**。AO 每次改了 `prisma/schema.prisma`,
你拉新代码后必须同步一次数据库,否则同类 drift 会反复出现(这次是 `rule_provenance`,
下次改别的列还会撞)。

**推荐的拉新版本流程**:

```bash
git pull                 # 拉新代码
# 重新 build AO 镜像 / npm run build(按你的部署方式)

# ★ 起 AO 之前,先同步 AO 库:
docker exec ao-main npx prisma db push     # 容器方式
#  或
npm run db:push                            # 宿主机方式

# 再(重)启 AO
```

**更稳妥的做法**:把 `prisma db push` 接进 `ao-main` 容器的启动入口(entrypoint),
让它在 app 启动前自动跑一次。这属于**部署脚本 / 镜像配置**改动,不是 AO 业务代码改动。
需要的话联系 AO 开发组帮你接。

---

## 六、红线清单(务必遵守)

| 禁止 | 原因 |
|---|---|
| ❌ 把 `DATABASE_URL` 设成 `raas_db` 再 `prisma db push` | 会把 AO schema 推到 RAAS 生产库,破坏 partner 数据,不可逆 |
| ❌ 用 `prisma db push --force-reset` / `npm run db:reset` 修这个报错 | 会清空整个 AO 库的审计历史 |
| ❌ 改 AO 代码来"绕过"这个报错 | 不是代码问题;改代码反而掩盖了 schema 没同步的真问题 |
| ❌ 对 `192.168.1.104:5432` 那个库做任何 Prisma 操作 | 那是 RAAS 的库,AO 只用独立 pg 客户端读写约定好的表,从不用 Prisma 碰它 |

---

## 七、一条命令快速自检

贴给 partner 一次跑,确认这次该往哪个库 push:

```bash
echo "=== AO 库(该 push 的目标)===" && \
docker exec ao-main printenv DATABASE_URL 2>/dev/null || grep DATABASE_URL .env.local; \
echo "=== RAAS 库(绝不能 push 的)===" && \
docker exec ao-main printenv RAAS_POSTGRES_URL 2>/dev/null || grep RAAS_POSTGRES_URL .env.local; \
echo "=== rule_provenance 列是否已存在 ===" && \
docker exec ao-postgres psql -U ao -d ao -c '\d "RuleCheckAudit"' 2>/dev/null | grep rule_provenance || echo "缺这一列 → 需要 prisma db push"
```

两个连接串必须明显不同(一个是 AO 的 `/ao`,一个是 RAAS 的 `/raas_db`),
确认无误后再执行第三节的 `prisma db push`。
```
