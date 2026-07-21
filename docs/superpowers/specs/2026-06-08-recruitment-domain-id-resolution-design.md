# 抗改名的招聘域 id 解析 + 漂移监测

- 日期：2026-06-08
- 状态：设计已批准，待写实现计划
- 范围：仅招聘域（招聘-v1）；能源/费控明确不在范围内

## 1. 背景与问题

AO 的 domain **列表**已经是全动态的——[app/api/domains/route.ts](../../../app/api/domains/route.ts)
读 Allmeta `GET /api/domains` 的 live 结果，名字/颜色从 id 派生，带磁盘缓存防 Studio 抖动。
在 Allmeta 里改名/加域，AO 自动跟随，零改代码。

但有**一个写死的锚点**：`RECRUITMENT_DOMAIN_ID = "招聘-v1"`（[lib/domain-ids.ts:15](../../../lib/domain-ids.ts)），
被 ~20 处消费。其中 ontology **读取**路径用它作为查询域：

- [lib/rule-check/ontology-source.ts:56](../../../lib/rule-check/ontology-source.ts)
- [lib/rule-check/api-rule-fetcher.ts:510](../../../lib/rule-check/api-rule-fetcher.ts)
- [lib/rule-check/instance-client.ts:14](../../../lib/rule-check/instance-client.ts)

**失败模式**：当有人在 Allmeta Studio 里把 `招聘-v1` 改成别的名字时，这些读取会 `404 → 静默 JSON 回退`
（[ontology-source.ts:53-55](../../../lib/rule-check/ontology-source.ts) 注释明写"A stale id here just 404s → silent JSON fallback"）。
没有任何可见信号告诉运维"域 id 漂移了、现在跑的是静态规则不是 live 规则"。

### 1.1 两个关键前提（核查 live Allmeta 后确认）

1. **Allmeta domain 对象无 alias/tag 字段** —— 实测 `GET :3500/api/domains` 只返回
   `{id, version, name, lastUpdated}`。所以"在 Allmeta 里存稳定标记"的方案需要改独立的
   `~/allmetaOntology` 仓（跨仓依赖）。**本设计不走这条路，纯 AO 侧实现。**

2. **招聘域的 Inngest app id 是固定常量 `"agentic-operator-main"`** ——
   见 [server/inngest/domain-app.ts:26](../../../server/inngest/domain-app.ts)，**不是**从 `招聘-v1` 派生。
   所以"改名会让 Inngest 历史孤儿化"的风险对招聘域**不适用**。
   能源/费控的 id 喂给 `agentic-operator-<domain>` + snapshot 目录名，那两个域不重新注册搬不动 →
   排除在本设计外。

## 2. 目标

在 Allmeta Studio 给 `招聘-v1` 改名时：

- (a) 不静默打断招聘域 ontology 读取（尽量解析到正确的 live id）。
- (b) 浮出可见信号让人去改一个配置值，而不是静默 404→JSON 回退。

## 3. 设计

### 3.1 纯解析器 —— `lib/domain-resolve.ts`（新增）

```ts
RECRUITMENT_ALIASES = [RECRUITMENT_DOMAIN_ID, "RAAS-v1", "raas"]
// 可用环境变量扩展：RECRUITMENT_DOMAIN_ALIASES（逗号分隔，追加到默认别名后）

resolveRecruitmentDomainId(liveIds: string[]):
  { id: string; status: 'exact' | 'alias' | 'missing' }
```

- `exact`：规范 id `招聘-v1` 在 live 列表里 → 返回它。
- `alias`：规范 id 不在，但某个已知别名（如 `RAAS-v1`）在 live 列表里 → 返回那个 live id。
- `missing`：别名都不在 live 列表里 → 返回规范常量兜底，并标记漂移。

纯函数、无 I/O → 可独立 TDD。把"哪个 live id 才是招聘那个"的整个判断收进一个可测的地方。
别名优先级：按 `RECRUITMENT_ALIASES` 数组顺序，第一个命中 live 列表的胜出。

### 3.2 最小接线（blast radius 小，不是改全部 20 个调用点）

新增一个访问器（放 `lib/domain-resolve.ts`）：

```ts
recruitmentDomainId(): string
// 返回缓存的已解析 id（来自上一次成功的 /api/domains Allmeta 读取），
// 取不到就回退到 RECRUITMENT_DOMAIN_ID 常量。
```

缓存来源：复用 [app/api/domains/route.ts](../../../app/api/domains/route.ts) 已有的
`data/allmeta-domains-cache.json` 磁盘缓存读取——解析器在那份 live 列表上跑，结果写进一个
轻量缓存（内存 + 复用同一份磁盘缓存即可，不新增持久化文件）。

只有 ontology **读取**路径（真正会 404 的那条）换用 `recruitmentDomainId()`：

- [ontology-source.ts:56](../../../lib/rule-check/ontology-source.ts)
- [api-rule-fetcher.ts:510](../../../lib/rule-check/api-rule-fetcher.ts)
- [instance-client.ts:14](../../../lib/rule-check/instance-client.ts)

那 ~20 处 `?? RECRUITMENT_DOMAIN_ID` **默认值**点保持不动——它们只是在"没指定域"时
需要*一个*具体 id，改名不影响它们的语义。

环境变量优先级不变：`process.env.ALLMETA_DOMAIN` 若显式设置，仍然优先于解析器（运维硬覆盖的逃生口）。
解析器只在 `ALLMETA_DOMAIN` 未设置时介入。

### 3.3 漂移监测 —— "动态监测"那块

[app/api/domains/route.ts](../../../app/api/domains/route.ts) 本来就拉 live Allmeta 域列表。
在它构建完列表后：

1. 调用 `resolveRecruitmentDomainId(liveIds)`。
2. 当 `status === 'missing'` 时，记一条 `LogEvent category='dependency'` 漂移信号
   （复用现有依赖健康度模式——零迁移；见 memory `project_external_dependency_health`）。
3. 在 `/api/domains` 响应里加字段：
   ```ts
   recruitmentAnchor: { configured: string; resolved: string; status: 'exact'|'alias'|'missing' }
   ```
   让 UI/切换器能在 `status !== 'exact'` 时弹警告横幅
   （文案示意："招聘域 id 在 Allmeta 已改名，AO 仍指向 招聘-v1 —— 请更新别名"）。

UI 横幅本身是后续小改，不阻塞本设计的后端落地；本设计交付到 `recruitmentAnchor` 字段 + 漂移 LogEvent 即闭环。

## 4. 明确不做（YAGNI）

- 能源/费控的自动解析——它们的 id 绑着 Inngest app id + snapshot 目录名；不重新注册搬不动，保留硬编码常量。
- 不动 `~/allmetaOntology` 仓（不给 Allmeta domain 对象加 alias 字段）。
- 不改那 ~20 处默认值调用点。
- 不新增持久化表/迁移（漂移信号走现有 LogEvent，缓存复用现有磁盘缓存）。

## 5. 测试

- **解析器纯函数**（TDD）：
  - exact：live 含 `招聘-v1` → `{id:'招聘-v1', status:'exact'}`
  - alias：live 含 `RAAS-v1` 不含 `招聘-v1` → `{id:'RAAS-v1', status:'alias'}`
  - missing：live 都不含 → `{id:'招聘-v1', status:'missing'}`
  - 别名优先级：多个别名同时在 live 时按数组顺序取第一个
  - 环境变量扩展：`RECRUITMENT_DOMAIN_ALIASES` 追加的别名能命中
- **接线**：`ALLMETA_DOMAIN` 显式设置时解析器不介入（逃生口生效）。
- **漂移信号**：`status==='missing'` 时确实 emit 了 `category='dependency'` 的 LogEvent，
  且 `/api/domains` 响应里 `recruitmentAnchor` 字段正确。

## 6. 受影响文件清单

| 文件 | 改动 |
| --- | --- |
| `lib/domain-resolve.ts` | 新增：解析器 + `recruitmentDomainId()` 访问器 |
| `lib/domain-resolve.test.ts` | 新增：解析器单测 |
| `app/api/domains/route.ts` | 调解析器、emit 漂移 LogEvent、加 `recruitmentAnchor` 响应字段 |
| `lib/rule-check/ontology-source.ts` | 读取路径换用 `recruitmentDomainId()` |
| `lib/rule-check/api-rule-fetcher.ts` | 同上 |
| `lib/rule-check/instance-client.ts` | 同上 |
