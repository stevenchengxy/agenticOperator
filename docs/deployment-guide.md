# Agentic Operator — 配置与部署指南

> 给从 0 起步的工程师 / partner 看的完整部署手册。从 `git clone` 到能跑通规则审计 + Inngest event loop,所有踩坑都列在这。
>
> 维护者: AO 开发组
> 最后更新: 2026-05-22

---

## 一、TL;DR(happy path)

```bash
git clone <repo-url>
cd agenticOperator
npm install
cp .env.example .env.local        # 编辑 .env.local 填上 8 个 MUST 段
npm run setup                     # 一键: env 检查 + 建目录 + prisma db push
npm run dev                       # 端口 3002
```

打开 `http://localhost:3002` 看到 `/fleet` 页 → 成功。

跑生产模式:
```bash
npm run build                     # ★ NEXT_PUBLIC_* 变量是 build-time 嵌入,改 env 必须重 build
npm run start
```

---

## 二、前置条件

### 机器侧
| 软件 | 版本 | 检查 |
|---|---|---|
| Node | ≥ 22 | `node -v` |
| npm | 随 Node 自带 | `npm -v` |
| Git | 任何近代版本 | `git --version` |
| SQLite3 CLI | 可选,但调试很有用 | `sqlite3 --version` |
| Docker | 可选(只有跑本地 Inngest 容器才要) | `docker info` |

### 需要从协作方拿到的凭证(8 项)

| 类别 | 拿什么 | 从谁拿 |
|---|---|---|
| Shared Inngest | URL + event_key + signing_key | 运维 Inngest 容器的同事 |
| LLM 网关 | base_url + api_key | 内部 new-api 管理员(或自己 OpenAI key) |
| Allmeta Studio | base_url + api_token | Allmeta 项目维护者 |
| RoboHire | api_key | RoboHire 服务负责人 |
| Partner Postgres | 连接串(host:port + 用户名密码) | RAAS DBA |
| MinIO | endpoint + access_key + secret_key | 简历存储运维 |
| 客户端 Inngest URL | 跟 Inngest URL 同一个值 | (上面 Inngest 那条的同一个值) |
| Default employee_id | 真实存在的 recruiter ID | RAAS 业务负责人 |

---

## 三、架构一图速览

```
              ┌──────────────────────────────────────┐
              │  Shared Inngest                      │
              │  (Docker 或 native inngest-cli)      │
              │  AO + RAAS 都注册到这同一个实例     │
              └──────────────────────────────────────┘
                ▲                                  ▲
                │ register / send events           │ register / send events
                │                                  │
       ┌──────────────────┐             ┌──────────────────┐
       │  AO (本 repo)   │             │  RAAS partner    │
       │  /api/inngest   │             │  /api/inngest    │
       │  Next.js :3002  │             │                  │
       └──────────────────┘             └──────────────────┘
                │
       ┌────────┼────────┬───────────┬────────────┐
       ▼        ▼        ▼           ▼            ▼
  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌─────────────┐
  │ SQLite  │ │ Allmeta  │ │ MinIO  │ │ Partner PG  │
  │ ao.db   │ │ Studio   │ │ S3-like│ │ candidate / │
  │ (本地)  │ │ HTTP API │ │ 简历桶 │ │ match_result│
  └─────────┘ └────┬─────┘ └────────┘ └─────────────┘
                   │ bolt://
                   ▼
              ┌──────────┐
              │  Neo4j   │ ← AO 不直接连
              └──────────┘
```

**三条核心约定**:

1. **一个共享 Inngest** —— AO 和 RAAS 都注册到同一个 Inngest 实例。没有"两套 Inngest 互相 forward / bridge"。
2. **Neo4j 只走 Allmeta Studio** —— AO 不存 bolt:// 凭证。Allmeta HTTP API 是唯一通道。(例外:rule-check 的 audit-graph 写入是 §9 配置的小众功能)
3. **业务数据双写,运维数据独占** —— AO 自己的 run log / 审计表落本地 SQLite;candidate / job_posting / match_result 直接写 partner Postgres。

---

## 四、详细部署步骤

### Step 1 · clone + 安装

```bash
git clone <repo-url>
cd agenticOperator
npm install
```

**避坑**: 用纯 `npm install`,**不要**用 `npm install --omit=dev` 或 `npm install --production`。`prisma.config.ts` 加载 `dotenv`,而 dotenv 早期在 devDependencies 里。虽然现在已经挪到 `dependencies`,但如果用了 `--omit=dev` 的工具链(比如 PM2 ecosystem.config)也容易踩坑。

### Step 2 · 配置 `.env.local`

```bash
cp .env.example .env.local
$EDITOR .env.local                  # vim / code / nano,自选
```

**8 个 MUST 段**(没填会出明显错):

| § | Key | 示例 |
|---|---|---|
| 1 | `DATABASE_URL` | `file:./data/ao.db` (默认即可) |
| 2 | `AO_LOG_DIR` | 可选,默认 `./logs`,自动创建 |
| 3 | `INNGEST_BASE_URL` + `NEXT_PUBLIC_INNGEST_URL` + `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` + `INNGEST_SERVE_HOST` | 见下面"§3 详解" |
| 4 | `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL` (或 fallback `OPENAI_API_KEY`) | LLM 网关 |
| 5 | `ALLMETA_BASE_URL` + `ALLMETA_API_KEY` + `ALLMETA_DOMAIN` | `http://<host>:3500` / token / `RAAS-v1` |
| 6 | `ROBOHIRE_API_BASE_URL` + `ROBOHIRE_API_KEY` + `ROBOHIRE_TIMEOUT_MS` | RoboHire API |
| 7 | `RAAS_POSTGRES_URL` + `RAAS_DEFAULT_EMPLOYEE_ID` | `postgresql://user:pwd@host:5432/raas_db` |
| 8 | `MINIO_ENDPOINT` + `MINIO_PORT` + `MINIO_USE_SSL` + `MINIO_ACCESS_KEY` + `MINIO_SECRET_KEY` | 简历桶 |

**§3 详解 —— Inngest 的两个 URL**

```bash
# 服务端(AO Next 进程读)
INNGEST_BASE_URL=http://192.168.1.10:8288

# 浏览器(用户在浏览器打开的"Inngest dashboard"链接读)
# ★ 必须跟上面相等 —— Next.js 只把 NEXT_PUBLIC_* 暴露给 client bundle
NEXT_PUBLIC_INNGEST_URL=http://192.168.1.10:8288

# Inngest 回调 AO 时用的地址
# 同一台机 → http://localhost:3002
# 跨 LAN  → http://<这台机的 LAN IP>:3002
INNGEST_SERVE_HOST=http://192.168.1.20:3002

INNGEST_SERVE_PATH=/api/inngest    # 通常不改
INNGEST_EVENT_KEY=dev               # dev 环境多半就叫 "dev"
INNGEST_SIGNING_KEY=dev
```

**为什么要两个 URL?** 服务端用 `INNGEST_BASE_URL` 是从 Node 进程直接发 HTTP;浏览器里"点开 Inngest dashboard"链接是用户的浏览器直接访问 Inngest 服务器,服务器同机部署时浏览器看到的 host 跟 Node 进程看到的不一样(尤其 Docker 环境 — Node 在容器内,浏览器在宿主)。所以分两个变量。

### Step 3 · 一键 setup

```bash
npm run setup
```

这个脚本(`scripts/setup.mjs`)幂等,会做:

1. 检查 Node ≥ 22
2. 如果 `.env.local` 不存在,从 `.env.example` 复制一份
3. 加载 `.env.local` + `.env`
4. 跑 env 预检(打 ✓/✗ 表,识别占位符如 `<shared-inngest-host>` 算作"未填")
5. 创建 `./data/` 和 `./logs/` 目录
6. `npx prisma generate`(生成 Prisma Client TypeScript 类型)
7. `npx prisma db push --accept-data-loss`(把 schema 同步到 SQLite,**每次都跑**,即使 db 已存在)

**成功输出**:
```
[setup] Node v22.9.0 ✓
[setup] Checking env vars…
── env check ──────────────────────────────
REQUIRED
  ✓ DATABASE_URL
RECOMMENDED
  ✓ INNGEST_BASE_URL
  ✓ NEXT_PUBLIC_INNGEST_URL
  ✓ ALLMETA_BASE_URL
  ✓ AI_API_KEY (or OPENAI_API_KEY)
  ✓ RAAS_POSTGRES_URL
  ✓ MINIO_ENDPOINT
  ✓ ROBOHIRE_API_KEY
✓ All required env vars present.
[setup] Running prisma generate + db push…
✔ Generated Prisma Client
🚀  Your database is now in sync with your Prisma schema.

✓ Setup complete.
```

任何一项 ✗ 都要回去补 `.env.local` 然后**重新跑 `npm run setup`**。

### Step 4 · 验证 SQLite 数据库

```bash
ls -la data/ao.db                                # 文件存在,200-500 KB
sqlite3 data/ao.db ".tables" | tr ' ' '\n' | wc -l   # 应该 ≥ 31
sqlite3 data/ao.db ".tables" | tr ' ' '\n' | grep RuleCheckAudit   # 必须看到
```

### Step 5 · 验证外部依赖能连上

逐项 curl 一下:

```bash
# Inngest
curl -sf http://<inngest-host>:8288/health   # → 200 OK / {"status":200}

# Allmeta Studio
curl -sf http://<allmeta-host>:3500/api/v1/ontology/actions   # → 200 或 401

# Partner Postgres
psql "$RAAS_POSTGRES_URL" -c "SELECT 1"      # → 1

# MinIO(用 mc 或简单 nc 通 9000)
nc -zv <minio-host> 9000

# RoboHire 一般是公网 https,curl 一下健康端点
curl -sf https://api.robohire.io/health
```

任何一个不通 → AO 启动后那块功能会失败,但**不会阻塞启动**(per design,每个子系统独立 degrade)。

### Step 6 · 起 AO

```bash
npm run dev          # 开发模式,端口 3002
# 或
npm run build        # 生产构建(★ NEXT_PUBLIC_* 在这一步嵌入 bundle)
npm run start
```

打开 `http://localhost:3002`:
- `/fleet` → 看到 agent 列表(右上语言切换、主题切换、⌘K 命令面板)
- `/monitor` → 看 infrastructure 健康度(各子系统 ✓/✗)
- `/events` → 看 Inngest event firehose

### Step 7 · 把 AO 的 SDK 注册到 Inngest

Inngest 必须知道 AO 的 `/api/inngest` 地址才能回调:

```bash
curl -X POST http://<inngest-host>:8288/fn/register \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"http://<这台机的-LAN-IP>:3002/api/inngest\"}"
```

成功后访问 Inngest dashboard `http://<inngest-host>:8288/apps`,应该看到 `agentic-operator-main` 这个 app 出现,里面挂着 5+ 个 functions(`createJdAgent` / `matchResumeAgent` / `resumeParserAgent` / `ruleCheckAgent` 等)。

**或者**:直接 PUT AO 的 SDK 端点,让 SDK 自己反向注册:
```bash
curl -X PUT http://localhost:3002/api/inngest
```

### Step 8 · 触发一个测试事件

从 Inngest dashboard 的 "Send event" 面板发一个 `REQUIREMENT_LOGGED` 或 `RESUME_DOWNLOADED`:

```json
{
  "name": "RESUME_DOWNLOADED",
  "data": {
    "bucket": "recruit-resume-raw",
    "objectKey": "test/sample.pdf",
    "filename": "sample.pdf",
    "etag": "test-001",
    "receivedAt": "2026-05-22T00:00:00Z",
    "size": 12345,
    "hrFolder": null,
    "employeeId": null,
    "sourceEventName": "test"
  }
}
```

发完到 AO 的 `/monitor` 看 Run 记录,点进去看 step trace。看到 `resumeParserAgent` Completed → 全链路通了。

---

## 五、环境变量速查表

完整列表见 [`.env.example`](../.env.example)。

| 段 | 变量 | 必填? | 缺了会怎样 |
|---|---|---|---|
| 1 | `DATABASE_URL` | **必** | AO 启不起来 |
| 2 | `AO_LOG_DIR` | 可选 | 默认 `./logs`,自动建 |
| 3 | `INNGEST_BASE_URL` | **必** | 事件流死 |
| 3 | `NEXT_PUBLIC_INNGEST_URL` | **必** | 浏览器里"打开 Inngest"链接指向 localhost,partner 看不到正确仪表盘 |
| 3 | `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | **必** | Inngest SDK 直接 throw |
| 3 | `INNGEST_SERVE_HOST` | **必** | Inngest 回调 AO 失败 |
| 4 | `AI_BASE_URL` + `AI_API_KEY` (或 `OPENAI_API_KEY`) | **必** | rule-check、chatbot 全废 |
| 5 | `ALLMETA_BASE_URL` + `ALLMETA_API_KEY` | **必** | rule-check 回退到 `rules.json` 老版本;候选人 / 岗位显示成裸 ID |
| 6 | `ROBOHIRE_API_KEY` | **必** | 简历解析 + match-resume 整条断 |
| 7 | `RAAS_POSTGRES_URL` | **必** | save-candidate / match-result 全失败 |
| 7 | `RAAS_DEFAULT_EMPLOYEE_ID` | **必** | matchResume 没办法兜底归属 recruiter |
| 8 | `MINIO_*` (5 个) | **必** | RESUME_DOWNLOADED 卡在 parser,根本拿不到简历文件 |
| 9 | `NEO4J_INSTANCE_*` | 几乎不用 | rule-check 的 audit graph 写入功能停;UI 不影响 |
| 10 | `WS_BASE_URL` / `EM_BASE_URL` | 几乎不用 | 只在跑 P3 老 sidecar 时才要 |

**调试用 flag**:
```bash
RULE_CHECK_BYPASS=true     # 跳过 LLM,每个规则审计直接 PASS(联调下游用)
RAAS_BRIDGE_ENABLED=1      # 启用 RAAS 事件 bridge(单 Inngest 架构下不需要)
NEO4J_SYNC_ENABLED=1       # 启用 Neo4j → EventDefinition 同步(off-VPN 时自动降级)
```

---

## 六、常见错误 + 修法

### ① `Cannot find module 'dotenv/config'`(跑 `prisma db push` 时)

**症状**:
```
Failed to load config file "prisma.config.ts" as a TypeScript/JavaScript module.
Error: Cannot find module 'dotenv/config'
```

**根因**:用了 `npm install --omit=dev` / `NODE_ENV=production npm install`,dotenv 没装上。

**修**:
```bash
npm install                    # 不加任何 --omit / --production 标志
npm run setup
```

### ② `The table 'main.RuleCheckAudit' does not exist`

**症状**:UI 上规则审计模块报错,运行时 throw 一个 Prisma error。

**根因**:`prisma db push` 推到的 SQLite 文件,跟 app runtime 打开的 SQLite 文件**不是同一个**。三种触发方式:

| 触发 | 解释 |
|---|---|
| App 在 push 前就在跑 | SQLite 连接缓存了空 db 的 schema,push 完不重启永远看不到新表 |
| Push 和 app 启动用了不同 cwd | `file:./data/ao.db` 是相对路径,cwd 不同 → 文件不同 |
| `.env.local` 里改过 DATABASE_URL 到非默认路径 | (历史问题,现在 prisma.config.ts 也加载 .env.local 了,但老版本会撞) |

**修(一键通杀)**:
```bash
# 1. 杀掉所有 Next 进程
pkill -f "next dev"; pkill -f "next start"

# 2. 拉最新代码(含 prisma.config.ts 加载 .env.local 的修复)
git pull

# 3. 重建 db
rm -f data/ao.db data/ao.db-journal data/ao.db-wal data/ao.db-shm
npm run setup

# 4. 验证
sqlite3 data/ao.db ".tables" | tr ' ' '\n' | grep RuleCheckAudit
# 必须看到 RuleCheckAudit

# 5. 再起
npm run dev    # 或 npm run start
```

### ③ Partner 端"打开 Inngest dashboard"链接仍指 `localhost:8288`

**根因**:
- 没设 `NEXT_PUBLIC_INNGEST_URL`,或者
- 设了但没重新 `npm run build`(`NEXT_PUBLIC_*` 是 build-time 嵌入 bundle 的,改 env 必须重 build)

**修**:
```bash
# .env.local 里加上:
NEXT_PUBLIC_INNGEST_URL=http://<跟-INNGEST_BASE_URL-同一个值>

# 然后 ★ 重新 build:
npm run build
npm run start
```

`npm run dev` 模式不需要重 build —— Next 的 dev server 每次请求都重新读 env。但 `npm run start` 跑的是 build 产物。

### ④ `Inngest dev server timeout after 5000ms`

**根因**:`INNGEST_BASE_URL` 配的地址不通,或者 Inngest 服务器宕机。

**诊断**:
```bash
curl -v http://<INNGEST_BASE_URL>/health
```

如果是 LAN 部署,检查防火墙 / Docker 端口映射 / `--host 0.0.0.0` 是否生效。

### ⑤ `NEO4J_INSTANCE_URI not configured` 警告

**正常**。99% 功能不依赖直连 Neo4j,Allmeta 已经覆盖了 Neo4j 访问。这个 warning 表示 rule-check 的 audit-graph 写入功能被禁用 —— 主审计表 `RuleCheckAudit`(在 SQLite 里)照常工作。

**只有真的需要 audit graph 才配 §9**。

### ⑥ `INNGEST_SERVE_HOST` 写错导致 Inngest 注册成功但 callback 失败

**症状**:Inngest dashboard 上 `agentic-operator-main` app 在,但触发事件后 run 一直 stuck 在 "Started",或者直接 Failed,error log 显示 connection refused。

**根因**:Inngest 服务器要"反向调用"AO,如果 `INNGEST_SERVE_HOST` 写的是 `http://localhost:3002`,但 Inngest 跑在另一台机 / 容器里,它的 localhost 不是 AO 这台。

**修**:写 AO 这台机器的 LAN IP:
```bash
# 假如 AO 跑在 192.168.1.20
INNGEST_SERVE_HOST=http://192.168.1.20:3002
```

注册一次:
```bash
curl -X POST http://<inngest-host>:8288/fn/register \
  -d '{"url":"http://192.168.1.20:3002/api/inngest"}'
```

---

## 七、生产模式 vs 开发模式

| 维度 | `npm run dev` | `npm run build` + `npm run start` |
|---|---|---|
| 端口 | 3002 | 3002 |
| 热更新 | 是 | 否 |
| TypeScript 检查 | 弱(运行时) | **强**(build 时全量) |
| Env 变量改动 | 立即生效 | **必须重 build** 才能让 NEXT_PUBLIC_* 生效 |
| 启动速度 | ~3 秒 | ~1 秒(build 已完成) |
| 性能 | 慢(开发优化) | 快(production-grade) |

**Partner 实际部署用 production 模式**:
```bash
npm install
npm run setup
npm run build      # 一次性,改 env 后要重跑
npm run start      # 长驻进程,推荐配 PM2 / systemd 守护
```

PM2 守护示例:
```bash
npm install -g pm2
pm2 start npm --name "agentic-operator" -- run start
pm2 save
pm2 startup     # 让 PM2 开机自启
```

---

## 八、健康检查清单(部署完跑这一遍)

```bash
# A. AO 本身
curl -sf http://localhost:3002/api/health 2>&1 | head -5

# B. SQLite 健全
sqlite3 data/ao.db "SELECT COUNT(*) FROM sqlite_master WHERE type='table';"
# → 应该 ≥ 31

# C. Inngest 连通
curl -sf http://<inngest-host>:8288/health

# D. Allmeta 连通
curl -sf "$ALLMETA_BASE_URL/api/v1/ontology/actions" -H "Authorization: Bearer $ALLMETA_API_KEY" | head -c 200

# E. Postgres 双写通道
psql "$RAAS_POSTGRES_URL" -c "SELECT COUNT(*) FROM candidate" 2>&1 | head -3

# F. MinIO 可达
nc -zv $MINIO_ENDPOINT $MINIO_PORT

# G. 浏览器端 NEXT_PUBLIC_INNGEST_URL 正确
# → 用浏览器开 http://localhost:3002/monitor,点 "↗ Inngest" 链接
#   检查跳转地址 = 你 .env.local 里的 NEXT_PUBLIC_INNGEST_URL
```

7 项全 ✓ → 部署完成。

---

## 九、后续日常维护

### 拉新版本

```bash
git pull
npm install                       # 有新依赖时
npm run setup                     # 同步可能的 prisma schema 变更
npm run build                     # 生产模式必须
pm2 restart agentic-operator      # 或重启你的进程管理器
```

### 重置本地状态

```bash
npm run db:reset                  # rm -f data/ao.db && prisma db push
```

### 看日志

```bash
tail -f logs/*-$(date +%Y-%m-%d).log     # agent 文件日志(JSON-lines)
pm2 logs agentic-operator                 # Next 进程标准输出
```

### 看实时事件流

打开 `/events` 页 → "Firehose" tab → 看 Inngest event 实时流。

或者:
```bash
curl -N http://localhost:3002/api/events/stream      # SSE 流
```

---

## 十、需要更深 reference 时去哪

| 想了解 | 看这 |
|---|---|
| 这个文档总览 | 你正在看的这份 |
| README(高层介绍) | [`README.md`](../README.md) |
| 单个 env 变量的逐项注释 | [`.env.example`](../.env.example) |
| Agent / Workflow 设计 | [`docs/agent-fleet-architecture-2026-05-15.md`](agent-fleet-architecture-2026-05-15.md) |
| Inngest Docker 化的特殊场景 | [`docs/inngest-docker-deployment.md`](inngest-docker-deployment.md) |
| Rule-check 完整流程 | [`docs/rule-check-end-to-end-workflow.md`](rule-check-end-to-end-workflow.md) |
| AO ↔ RAAS 接口契约 | [`docs/raas-ao-v0_1_010-io-contract.md`](raas-ao-v0_1_010-io-contract.md) |

---

## 附录 A · scripts/setup.mjs 做了什么(对照表)

| 步骤 | 等价手动命令 | 失败时的兜底 |
|---|---|---|
| 1. Node 版本检查 | `node -v` | 直接 exit 1 |
| 2. `.env.local` 脚手架 | `cp .env.example .env.local` | warn,继续 |
| 3. dotenv 加载 | `source .env.local` | 失败 → exit 1(dotenv 没装) |
| 4. env 预检 | `npx tsx scripts/check-env.ts` | 报错但不阻塞 |
| 5. 创建 `data/` `logs/` | `mkdir -p data logs` | 永远成功 |
| 6. prisma generate | `npx prisma generate` | exit 1 + 提示 |
| 7. prisma db push | `npx prisma db push --accept-data-loss` | exit 1 + 提示 |

幂等设计 —— 任何步骤已完成都会跳过,所以可以放心 `npm run setup` 跑 N 次。

---

## 附录 B · 单条命令做诊断

把这一坨贴到 partner 那边一次跑,告诉你部署到哪一步了:

```bash
echo "=== Node ===" && node -v && \
echo "=== Pwd ===" && pwd && \
echo "=== .env.local exists? ===" && ls -la .env.local && \
echo "=== DATABASE_URL ===" && grep DATABASE_URL .env.local && \
echo "=== INNGEST_BASE_URL ===" && grep INNGEST_BASE_URL .env.local && \
echo "=== NEXT_PUBLIC_INNGEST_URL ===" && grep NEXT_PUBLIC_INNGEST_URL .env.local && \
echo "=== ao.db tables ===" && sqlite3 data/ao.db ".tables" | tr ' ' '\n' | sort | head -40 && \
echo "=== RuleCheckAudit? ===" && sqlite3 data/ao.db ".tables" | tr ' ' '\n' | grep -i rulecheck && \
echo "=== AO process? ===" && pgrep -fa "next.*3002" | head -3
```
