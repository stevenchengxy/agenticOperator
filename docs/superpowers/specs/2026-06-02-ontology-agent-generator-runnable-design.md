# 本体智能体生成器 — 从 domain id 到可运行 agents(能源调度先行)

- 日期:2026-06-02
- 状态:设计待批
- 作者:Claude + Steven
- 关联:[2026-06-01-ontology-generator-design.md](2026-06-01-ontology-generator-design.md)(前一版:sandboxed shell draft)

## 1. 背景与目标

当前 `/behavior/ontology-generator` 的生成器产出的是**不可运行的 sandboxed shell draft**:候选 agent 由 `lib/ontology-generator/profiles.ts` 手写(`feikong` / `energy` 等假 domain id + 虚构的 `InvoiceAuditAgent` / `LoadForecastAgent` 等),`generate` 只写一条 `status='draft'` 的 `AgentVersion` 行,slug 前缀 `og-` 保证永不撞真实 Inngest 函数 —— 即"部署"也不会真的运行任何东西。

本设计把生成器改造为**端到端真实**:

1. **域跟随 Allmeta domain id** —— 不再手写假 id,域列表来自 Allmeta `GET /api/domains`(`baoxiao-v1`、`nengyuandiaodu-v1`、`R7-001`、`RAAS-v1`)。**不新增任意域**。
2. **按 domain id 抓取真实 ontology** —— 五件套(objects/rules/actions/events/workflow)从 Allmeta 按 domain id 读取,兜底用 in-repo 快照。
3. **从 action + workflow 派生真实候选 agent**,硬编码为真实 Inngest 函数。
4. **部署即激活真实函数** —— 部署后 agent 真正消费事件、调大模型、落日志,整条事件链在 AO 里跑通。
5. **Human-actor 动作做成"模拟人工"自动响应器**,让全链路(含复核/风险闸门)无需真人介入即可跑通。

**首期范围:能源调度(`nengyuandiaodu-v1`)端到端跑通**;模式验证后用同一套机制复制报销(`baoxiao-v1`)。

招聘域(`server/inngest/functions.ts` 里的 5 个 production agents)**不动**。能源/报销新增 agents 按 domain feature flag 隔离注册。

## 2. 非目标(YAGNI 红线)

- 不做真实外部工具(慧采-SCADA / 设备通 / 能控EMS …)对接 —— 确定性模拟,记为 tool 日志。
- 不做 Inngest 运行时动态注册新函数 —— 函数在 flag 下静态注册,用 `AgentVersion.status` 做"激活"语义。
- 不重绘 workflow 画布。
- 不改招聘域 production agents 的行为。

## 3. 现状勘察(已验证)

- Allmeta Studio 在 `http://localhost:3500` 可达;`GET /api/domains` 返回 4 个域含 `baoxiao-v1`、`nengyuandiaodu-v1`。
- `GET /api/v1/ontology/schema?domain=nengyuandiaodu-v1` 报告 `DataObject/Rule/Action/Event` 各 ~100 个采样节点(数据确实已部署)。
- 但 `GET /api/v1/ontology/{actions,events,objects,rules}?domain=nengyuandiaodu-v1` 的 `items` **返回空**(RAAS-v1 同端点正常返回 24 actions)—— 新域存在读路径不匹配,实现期排查;无论是否修复,**in-repo 快照**(`neo4j_data/` 里那套已校验的五件套)作为确定性兜底/主源。
- LLM 网关:`server/llm/gateway.ts` 的 `chatComplete({system,user,model,...,logger,tools})`,env 走 `AI_BASE_URL+AI_API_KEY`(默认 `google/gemini-3-flash-preview`)或 `OPENAI_API_KEY` 兜底。
- 统一日志:`server/agent-logger.ts` 的 `createAgentLogger(ctx)`(file JSONL + Prisma AgentActivity + LogEvent),`/audit` 运行日志 tab + Fleet AgentActivity 可见。
- Inngest:`server/inngest/client.ts`(id `agentic-operator-main`)+ `server/inngest/functions.ts` 注册列表;native inngest-cli 跑在 `:8288`(见 memory,不要 docker 化)。
- 能源动作 actor 分布:Agent 17 / Human 11,28 个动作全部带 system_prompt + user_prompt。

## 4. 架构

### 4.1 Domain 对齐 —— `GET /api/domains` 代理 + 生成器域下拉

- 新增 `GET /api/ontology-generator/domains`:服务端代理 Allmeta `GET /api/domains`,返回 `{ id, version, name?, lastUpdated? }[]`(失败时回落到一份内置的已知域清单,保证 UI 不空)。
- 生成器域下拉改用此列表(替代 `DOMAIN_PROFILES`)。用户选 `nengyuandiaodu-v1`。
- 删除 `profiles.ts` 里的假域定义;`raas` 映射保留给招聘演示但 id 对齐到 `RAAS-v1`。

### 4.2 Ontology 读取层 —— `lib/ontology-generator/ontology-source.ts`

```ts
export type DomainOntology = {
  domainId: string;
  objects: OntologyObject[];
  rules: OntologyRule[];
  actions: OntologyAction[];   // 含 actor / trigger / triggered_event / tool_use / system_prompt / user_prompt / outputs / target_objects / side_effects
  events: OntologyEvent[];      // 含 name / payload(source_action / event_data / state_mutations)
  workflow: OntologyWorkflow | null;
  source: "allmeta" | "snapshot";
};

export async function fetchDomainOntology(domainId: string): Promise<DomainOntology>;
```

- **按 domain id 抓取**:先打 Allmeta live;`items` 为空或失败 → 回落 in-repo 快照。
- 快照位置:`lib/ontology-generator/snapshots/<domainId>/{objects,rules,actions,events,workflow}.json`。首期把 `neo4j_data/能源调度/*` 复制进 `snapshots/nengyuandiaodu-v1/`(并归一化文件名),`neo4j_data/报销/*` 进 `snapshots/baoxiao-v1/`。
- 纯数据层,无副作用,可服务端调用。

### 4.3 候选派生 —— `lib/ontology-generator/analyze.ts`

```ts
export type DerivedAgent = {
  key: string;                 // 稳定 id = action.name
  actionName: string;          // camelCase, e.g. "forecastOutput"
  slug: string;                // inngest 函数 id, e.g. "energy-forecast-output"
  short: string;               // AgentVersion.short, e.g. "ForecastOutputAgent"
  nameZh: string; nameEn: string;
  kind: "llm" | "simulated-human";  // actor 含 Agent → llm;否则 simulated-human
  triggerEvents: string[];     // action.trigger
  emitEvents: string[];        // action.triggered_event
  tools: string[];             // action.tool_use(模拟)
  objects: string[];           // action.target_objects
  systemPrompt: string; userPrompt: string;
  rationaleZh: string;         // 真实 trigger→emit + dangling 缺口
  confidence: number;
};

export function deriveAgents(onto: DomainOntology): DerivedAgent[];
```

- 候选 = **全部 28 个动作**,按 `kind` 区分。`infer` route 返回这些真实候选(替代手写 profiles)。
- 卡片「本体依据」用真实事件边。

### 4.4 可运行 agents(硬编码)—— `server/inngest/domains/energy/`

- 每个动作一个文件(或一个工厂 + 一份能源动作清单),生成一个 Inngest 函数。
- 命名:Inngest 事件名用 `nengyuandiaodu-v1/<EVENT_NAME>`(如 `nengyuandiaodu-v1/DATA_INGESTED`),函数 id 用 slug。
- 每个函数(Agent-actor,`kind=llm`)的步骤:
  1. `event_received` 日志。
  2. **自门控**:查 `AgentVersion`(domain=`nengyuandiaodu-v1`, short=该 agent)status;非 `active` → 记一条 skip 日志并 return(未部署不响应)。
  3. 载入相关 ontology objects 作为上下文(`fetchDomainOntology` 取 target_objects 的 schema)。
  4. **模拟工具调用**:对 `tool_use` 每个工具产出确定性占位结果(由 action+事件名派生,无随机),逐个记 `tool` 日志。
  5. **真实 LLM 调用**:`chatComplete({ system: action.system_prompt, user: 填充后的 user_prompt + 工具结果 + 上下文, logger })`,要求按"该 agent emit 事件的 `event_data`"输出结构化 JSON;解析失败则降级为按 schema 造的确定性载荷(记 anomaly)。
  6. `decision` 日志(关键分支,如 triageScheme 自动放行)。
  7. emit `triggered_event`(`nengyuandiaodu-v1/<EMIT>`),载荷符合 events schema 的 `event_data`;记 `event_emitted` + `done`。
- **Human-actor(`kind=simulated-human`)**:同骨架,但跳过真实 LLM(或用一次轻量 LLM 产"模拟人工决定"),自动产出其 output 事件;日志 agent 名标注 `(模拟人工)` / metadata `simulated:true`,与真实 agent 区分。让 `manualConfirm→MANUAL_REVIEW_DECIDED`、`resolveRiskAndResume→RISK_DISPOSED` 等闸门自动闭合。
- 注册:在 `server/inngest/functions.ts`,`ENERGY_AGENTS=1` 时把这批函数加入导出列表。默认关闭,与招聘域隔离。

### 4.5 能源端到端事件链(happy path 全自动)

```
(seed) nengyuandiaodu-v1/DISPATCH_CYCLE_STARTED
  → ingestAndOpenCase ─DATA_INGESTED→ interpretData ─DATA_INTERPRETED→ forecastOutput
  ─FORECAST_COMPLETED→ generateSuggestion ─SUGGESTION_GENERATED→ validateConstraints
  ─CONSTRAINT_VALIDATED→ compareSchemes ─SCHEMES_COMPARED→ triageScheme
  ─ROUTING_DECIDED→ (manualConfirm 模拟人工 ─MANUAL_REVIEW_DECIDED→) finalizePlan
  ─PLAN_FINALIZED→ postToEMS ─POSTED_TO_EMS→ dispatchInstruction ─DISPATCHED→ captureExecution
  ─EXECUTION_FEEDBACK→ analyzeDeviation ─DEVIATION_ANALYZED→ archiveCase ─ARCHIVED→ (runOperationAudit 模拟人工)
分支:declareMarket(off PLAN_FINALIZED)、rollingRevision(off EXECUTION_FEEDBACK)、
      raiseRiskEvent(off CONSTRAINT_VALIDATED/EXECUTION_FEEDBACK)→ resolveRiskAndResume(模拟人工)、
      assessForecastAccuracy(off DEVIATION_ANALYZED)
```

`ingestAndOpenCase` 无 trigger → 由 seed 事件 `nengyuandiaodu-v1/DISPATCH_CYCLE_STARTED` 起跳。为避免无限回滚,`rollingRevision`/`raiseRiskEvent` 等回边在首期设最大触发次数/或仅在 seed 载荷带 `enableBranches:true` 时激活。

### 4.6 部署即激活 —— 生成器 ↔ 运行时

- 函数在 `ENERGY_AGENTS=1` 下**始终注册**;靠 §4.4 步骤 2 的自门控决定是否真正干活。
- 生成器 `generate`(部署):对选中的候选写/翻 `AgentVersion` 行为 `status='active'`(复用 `lib/ontology-generator/draft-store.ts` + AgentVersion 生命周期)。能源候选的 slug 用真实函数 id(不再强制 `og-` 前缀);为避免误伤招聘域,门控按 `domain + short` 精确匹配。
- 部署结果页新增「运行一次演示」按钮 → `POST /api/ontology-generator/run`(body `{domainId}`)→ 发 seed 事件 → 整链跑起来。
- 自门控的副作用:未部署的能源 agent 即便注册了也不响应事件 —— "部署"语义因此是真的。

### 4.7 日志与可观测

全程走既有统一日志(`createAgentLogger`),`event_received / tool / decision / event_emitted / done / anomaly`。`/audit` 运行日志 tab + Fleet AgentActivity 直接可见;模拟人工步骤带 `simulated:true` metadata 以便区分。无需新建日志设施。

## 5. 受影响文件

新增:
- `app/api/ontology-generator/domains/route.ts` —— 代理 Allmeta 域列表
- `app/api/ontology-generator/run/route.ts` —— 发 seed 事件
- `lib/ontology-generator/ontology-source.ts`、`lib/ontology-generator/analyze.ts`
- `lib/ontology-generator/snapshots/nengyuandiaodu-v1/*.json`(+ 后续 `baoxiao-v1/*`)
- `server/inngest/domains/energy/*`(28 个动作的函数 + 清单)

改:
- `lib/ontology-generator/profiles.ts` —— 移除假域,改为真实派生(或退化为只留 RAAS 映射)
- `app/api/ontology-generator/infer/route.ts`、`generate/route.ts` —— 接真实 ontology + 真实激活
- `server/inngest/functions.ts` —— `ENERGY_AGENTS` flag 注册
- 生成器 UI 组件(域下拉、候选卡、部署结果页「运行一次」按钮)
- `.env.example` / `.env.local` —— `ENERGY_AGENTS`、seed 说明

## 6. 测试与验收

- **单测(vitest,纯函数)**:`ontology-source` 快照解析 + live→snapshot 回落;`analyze.deriveAgents` 对能源快照断言 17 个 llm + 11 个 simulated-human、事件边正确。
- **集成冒烟**:`ENERGY_AGENTS=1` 下发 seed 事件,断言链路推进至 `ARCHIVED`,且每个 Agent-actor 都产生了 `event_received`+`event_emitted` LogEvent、至少一次 LLM tool/apiCall 记录。
- **AO 内人工验收**:`npm run dev` → 生成器选 `nengyuandiaodu-v1` → infer 出 28 候选(17 真 +11 模拟)→ 部署 → 「运行一次」→ `/audit` 看到 ingest→…→archive 全链路日志 + LLM 调用。
- 跑通后复制报销(`baoxiao-v1`,12 Agent-actor + 13 Human)。

## 7. 风险与缓解

- **Allmeta 新域 items 为空**:已知;快照兜底,live 仅作 best-effort + 日志。
- **LLM 网关不可达 / 慢**:每步 try/catch,失败降级为按 event_data schema 造确定性载荷并记 anomaly,链路不中断。
- **事件回边导致无限循环**:回边设触发上限 / seed flag 控制(§4.5)。
- **误伤招聘 production agents**:domain flag + 自门控按 domain 精确匹配;招聘函数完全不改。
- **commit 规范**:按 memory 用 `git commit -- <files>` pathspec;不碰 main;不建 worktree。
