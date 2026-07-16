# Agentic Operator 部署指南已迁移

这份旧指南曾描述 SQLite、PM2 和带 `--accept-data-loss` 的初始化流程，已经
失效且不安全。为避免出现两套部署真相，请使用当前唯一维护的指南：

- [跨机器 Docker Compose 部署与运维](deployment.md)
- 本地开发仍使用仓库根目录 `AGENTS.md` 中的 `npm run dev` 流程。

生产环境禁止使用 `prisma db push --accept-data-loss` 或 `--force-reset`。
当前容器入口只执行非破坏性的 `prisma db push`，遇到 destructive drift 会停止
启动，要求先备份并设计显式迁移。
