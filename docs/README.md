# Agentic Operator · 文档索引

按用途分区。每个目录下的文档都在本页列出，**先看本页再点进去**，避免在 180 多份
文档里翻找。

> 约定:一个主题**只有一份"当前有效"的文档**。被取代的文档不删除,而是移进
> [`archive/`](./archive) 或在开头加过时横幅并指向接任者 —— 这样搜索引擎和旧链接
> 仍然能找到它,但读者不会照着过时的步骤操作。

---

## 🚀 我该从哪份开始?

| 我想… | 看这份 |
|---|---|
| 了解这个产品是什么 | 仓库根 [`README.md`](../README.md) → [`product/PROJECT_INTRODUCTION_AGENTIC_OPERATOR.md`](./product/PROJECT_INTRODUCTION_AGENTIC_OPERATOR.md) |
| **把 AO 部署到另一台机器** | **[`deploy/deployment.md`](./deploy/deployment.md) —— 唯一维护的部署指南** |
| 本地跑起来开发 | 根 [`README.md` § Getting started](../README.md#getting-started) + [`../AGENTS.md`](../AGENTS.md) |
| 配环境变量 | [`../.env.example`](../.env.example)(开发) · [`../.env.deploy.example`](../.env.deploy.example)(生产) |
| 搞懂事件链怎么流转 | [`architecture/event-flow-deep-dive.md`](./architecture/event-flow-deep-dive.md) |
| 对接 RAAS / 合作方 | [`raas/`](./raas) + [`api/`](./api) |
| 改 rule-check | [`rule-check/rule-check-unified-plan.md`](./rule-check/rule-check-unified-plan.md) |
| 查某次改动的设计稿 | [`superpowers/specs/`](./superpowers/specs)(按日期命名) |

---

## 📁 目录

### [`deploy/`](./deploy) — 部署与运维

| 文档 | 说明 |
|---|---|
| [`deployment.md`](./deploy/deployment.md) | **唯一维护的部署指南**。Docker Compose 跨机部署、共享 Inngest 两种模式、离线包、备份恢复、故障排查表 |
| [`ao-production-upgrade-guide.md`](./deploy/ao-production-upgrade-guide.md) | 生产环境升级流程 |
| [`ao-database-update-guide.md`](./deploy/ao-database-update-guide.md) | 数据库变更操作指引 |
| [`ao-sqlite-to-postgres-migration.md`](./deploy/ao-sqlite-to-postgres-migration.md) | 历史:SQLite → Postgres 迁移 |
| [`deployment-guide.md`](./deploy/deployment-guide.md) | ⚠️ 已废弃,重定向到 `deployment.md` |
| [`inngest-docker-deployment.md`](./deploy/inngest-docker-deployment.md) | ⚠️ 历史快照(AO 自带 Inngest 时代),与现行共享单实例铁律冲突 |

### [`architecture/`](./architecture) — 系统与事件架构

agent 编排、事件链、workflow 设计。包含 [`event-flow-deep-dive.md`](./architecture/event-flow-deep-dive.md)、
[`agent-event-flow.md`](./architecture/agent-event-flow.md)、
[`end-to-end-pipeline-walkthrough.md`](./architecture/end-to-end-pipeline-walkthrough.md)、
[`workflow-event-chain.md`](./architecture/workflow-event-chain.md)、
[`resume-agent-engineering-spec.md`](./architecture/resume-agent-engineering-spec.md)、
[`event-manager-and-tracking-design.md`](./architecture/event-manager-and-tracking-design.md) 等 12 份。

### [`rule-check/`](./rule-check) — 规则校验

从设计到端到端流程的全套:
[`rule-check-unified-plan.md`](./rule-check/rule-check-unified-plan.md)(总体方案)、
[`rule-check-user-guide.md`](./rule-check/rule-check-user-guide.md)(使用)、
[`rule-check-end-to-end-workflow.md`](./rule-check/rule-check-end-to-end-workflow.md)、
[`rule-check-prompt-pipeline.md`](./rule-check/rule-check-prompt-pipeline.md)、
[`full-event-chain-with-rule-check-detail.md`](./rule-check/full-event-chain-with-rule-check-detail.md)。

### [`raas/`](./raas) — RAAS 合作方对接

事件契约、字段对齐、adapter 规格。给合作方的对接清单在
[`AO-对接清单-给付卓新-2026-06-23.md`](./raas/AO-对接清单-给付卓新-2026-06-23.md);
I/O 契约在 [`raas-ao-v0_1_010-io-contract.md`](./raas/raas-ao-v0_1_010-io-contract.md);
合作方提出的需求原件在 [`requirements_from_RAAS/`](./raas/requirements_from_RAAS)。

### [`ontology/`](./ontology) — Allmeta / Neo4j 本体

字段对齐表、runtime ↔ Allmeta 一致性、Neo4j 实例存储方案,以及
[`action_object_prompt/`](./ontology/action_object_prompt)(action/object 提示词模板与
ontology API 使用指南)。

### [`api/`](./api) — 对外 API 指南

[`agent-execution-api-partner-guide.md`](./api/agent-execution-api-partner-guide.md)、
[`AO-agent-execution-api-调用指南.md`](./api/AO-agent-execution-api-调用指南.md)、
[`AO-neo4j-ontology-api-接入卡.md`](./api/AO-neo4j-ontology-api-接入卡.md)、
[`match-resume-api-user-guide.md`](./api/match-resume-api-user-guide.md)。

### [`product/`](./product) — 产品与知识产权

PRD、专利交底书、项目介绍。

### [`superpowers/specs/`](./superpowers/specs) — 设计稿(按日期)

每次较大改动的设计文档,文件名前缀是决策日期。**改动前先看有没有对应 spec。**

### [`research/`](./research) — 调研与可行性

2026-05 的 codegen / AI-native 生成方向调研集群,含用例与评估走查。

### [`reports/`](./reports) — 一次性分析报告(HTML)

18 份历史架构分析与审计报告。这些是**某个时间点的快照**,不随代码更新 ——
以 [`superpowers/specs/`](./superpowers/specs) 和本索引指向的当前文档为准。

### [`archive/`](./archive) — 已归档

一次性排查记录与 e2e 运行报告,保留供追溯。

### [`assets/`](./assets) · [`data/`](./data) · [`handoff-export/`](./handoff-export)

图表资源 · DataObject schema SSoT(`objects_v0_1_010.json`)· 对外交付物导出。
