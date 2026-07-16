# Mac Studio Docker 部署方案（离线镜像 + 原地升级）

日期：2026-07-16 · 状态：已确认方向，随勘察结果微调

## 背景与目标

把当前工作区版本的 Agentic Operator 部署到一台内网 Mac Studio（Apple
Silicon / arm64，Docker Desktop）。该机器：

- 只通内网 10.100.x，不能 docker pull / npm install 公网资源；
- 已在跑一套**老版本 AO**（容器 `ao-main`，占 3002 端口，项目目录
  `/Users/ai-eas-coe/agentic-operator`）→ 本次是**原地升级**；
- 已在跑完整 **Allmeta 栈**（app :3500 + Neo4j + MinIO + Postgres），
  即 `ALLMETA_BASE_URL` 走 `http://host.docker.internal:3500`；
- 操作者只能通过 ToDesk 远程桌面操作，机器上没有 Claude →
  所有步骤必须可整段复制粘贴。

验收范围：RAAS-v1 域 6 个核心 agent 函数注册成功 + 端到端事件跑通。

## 方案（B：文档 + 最小修补 + 离线部署套件）

1. **传输方式**：本机（同为 arm64 Mac）原生构建镜像 → `docker save`
   打包 app + postgres + inngest 三个镜像 → 连同 compose/env 模板/校验
   脚本打成一个 bundle tar.gz → ToDesk/scp 传到 Mac Studio →
   `docker load` + `docker compose up`（不 build）。代码本身 commit 后
   push GitHub（kenny/steven）存档，与部署传输解耦。
2. **基建修补**（本 repo 内）：
   - `.env.deploy.example`：RoboHire 改为实际在用的
     `https://api.gohire.top` + `ROBOHIRE_TIMEOUT_MS=300000`（match
     实测 ~195s，120s 必超时）；Allmeta 示例改
     `host.docker.internal:3500`；补工厂可选变量注释。
   - `docker-compose.deploy.yml`：`skills-library/`、`tools-library/`
     挂 named volume（工厂运行时写盘，防容器重建丢失）；
     `extra_hosts: host.docker.internal:host-gateway`（Linux 兼容，
     Docker Desktop 无害）。
   - 新增 `scripts/make-deploy-bundle.sh`：一条命令产出
     `ao-deploy-bundle-<日期>.tar.gz`。
   - 新增 `scripts/check-connectivity.sh`：目标机零依赖（bash+curl+nc）
     自检 LLM 网关 / Allmeta / RoboHire / RAAS PG / MinIO / Inngest
     回调五类可达性，在 `compose up` 之前暴露网络问题。
3. **重写 `docs/deployment.md`**：以"本机打包 → 传输 → Mac Studio
   原地升级"为主线的分步指南；老部署勘察（survey 脚本）、端口冲突
   处理（3002 老容器）、数据迁移决策点、验收清单、离线升级/回滚、
   故障排查表。在线部署路径降级为附录。

## 不解决 / 外部前提

- RoboHire 是公网 API：Mac Studio 必须有到 `api.gohire.top` 的出网
  通道，勘察脚本验证，打不通需网络侧开口子（非本方案范围）。
- RAAS partner PG / MinIO（当前 env 指向 192.168.1.112）跨网段可达性
  由勘察脚本验证；不通则六函数链路中 parse/双写环节失败。
- 老 AO 的数据是否迁移（SQLite → Postgres）待用户决策；老部署具体
  形态（是否带 Inngest、volume 布局）以勘察结果为准。

## 验收标准

1. Mac Studio 上五容器 `running/healthy`；
2. Inngest Apps 页 `agentic-operator-main` 注册且 6 个 RAAS-v1 函数
   齐全无报错；
3. 隔离测试事件端到端跑完，归档可在 UI 分页回读；
4. `docker compose restart` 后监控/审计历史仍在（volume 持久化）；
5. 文档每一步在本机验证过或在目标机实跑过。
