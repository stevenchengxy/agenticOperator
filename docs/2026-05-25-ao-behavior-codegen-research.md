# AO Behavior 轴 — Prompt → Agent Code 生成器 研究文档

> 2026-05-25 · 研究阶段,不是 spec
> 范围:从"加入版本表"对话延伸出来的更大问题——AO 是否/如何用 LLM API key 自动生成 agent 代码,并把每次生成结果存为一个版本。

---

## 1. 范围与定位

这份文档**不是可立即实施的 spec**,它是把用户提出的两件事拼到一起后的可行性分析:

- (用户对话 ①) 新增一张版本表,可以选不同版本部署
- (用户对话 ②) 未来加入 prompt generator + code generator,**自动**从业务逻辑生成 agent 代码,每生成一次存为一个版本

第二件事独立成立时,就是 AO 三轴(Monitor / Manage / **Behavior**)里 Behavior 轴的核心命题。Behavior 轴在 memory `project_three_pillars.md` 里被刻意延后,这次 codegen 讨论实际上是 Behavior 轴的开题。

**这份文档要解决三个问题:**
1. 在现在的 AO 架构下,"LLM 生成 agent 代码"这件事的真实难度边界在哪
2. 用户提到"用 VS Code 开源代码"——具体哪些能用、哪些用不上、为什么
3. 如果决定做,推荐的阶段拆分和数据模型是什么

**版本表问题不会被冲走**:第 9 节会把 Phase 0 单独留给"先把 config 版本回退做完"——这部分今天就能做、和 codegen 解耦,是 codegen 的合理前置 step。

---

## 2. 问题真正长什么样

用户语句翻成机器可执行的版本:

> 给定一段自然语言业务描述(prompt),生成一份能 `npm run build` 通过 + 注册进 Inngest + 接收某个 event + 调若干现有 lib + emit 某个 event 的 TypeScript 文件,落地到 `server/inngest/agents/<slug>.ts`,并把这次生成的 (prompt, code, model+config) 三元组存为一个 AgentVersion 行。

这件事比"调 LLM 写一段 Hello World"难,原因有四,后面分别拆:

| 难点 | 一句话 |
|---|---|
| **Grounding** | 生成的代码必须调 AO 现有 lib(`@/lib/partner-pg/*`、`@/lib/robohire-client`、`em.publish` 等),不能编造 |
| **Type-safety** | TypeScript 编译必须通过——LLM 编出来不存在的 import / 类型不对都不行 |
| **Event contract** | `triggersEvents` / `emitsEvents` 必须落在 `EventDefinition` 表里实际存在的事件名上 |
| **Runtime deploy** | TS 文件写盘 ≠ Inngest 已注册;dev/prod 都需要重启进程(或 hot-reload 机制) |

用户已经预判过一个:"生成的代码也需要我们手动生成 library 和 package tools 吧?"——意识到生成器无法凭空发明 lib。这个直觉是对的,本文 7.2 会把"工具/lib 目录"做成显式输入。

---

## 3. 当前 agent handler 的解剖学

随便挑一个真实 agent([create-jd-agent.ts](server/inngest/agents/create-jd-agent.ts),236 行)看 codegen 的目标形状:

```ts
// 顶部 banner:业务定位 + workflow 编号 + 输入/输出 event
// import:大量内部 lib(partner-pg / robohire-client / allmeta-writers / inngest-client / agent-logger)
// 常量:AGENT_ID / AGENT_NAME / GENERATOR_VERSION
// 类型:Inbound envelope shape(从 event payload 推导)
// 主体:inngest.createFunction({ id, name }, { event: 'REQUIREMENT_LOGGED' }, async ({ event, step, logger }) => {
//   const log = createAgentLogger(...);
//   await runWithLogger(log, async () => {
//     await step.run('fetch-requirement', () => getRequirementDetail(...));
//     await step.run('call-robohire', () => generateJdDirect(...));
//     await step.run('sync-to-raas', () => syncJdToPartnerPg(...));
//     await inngest.send({ name: 'JD_GENERATED', data: envelope });
//   });
// });
```

代码量 200-650 行,但骨架 90% 同构:**event 订阅 → step.run 序列 → lib 调用 → emit 下游 event**。骨架可模板化;真正变化的是**业务逻辑里调哪些 lib、按什么顺序、payload 怎么拼**。

这件事直接影响生成策略选型(下一节):**模板填空** 比 **从零生成** 现实得多。

---

## 4. 生成策略 — 三档选型

### 4.1 模板填空(deterministic + LLM-fill,推荐 Phase 1)

- 模板:`{{slug}} / {{triggerEvent}} / {{emitEvents}} / {{steps[]}}` 全部参数化
- LLM 只负责两件事:① 把自然语言 prompt 解析成结构化 spec(JSON);② 在每个 `step.run` 的回调函数体里填业务逻辑
- 优点:**绝大部分代码不是 LLM 生成的**——boilerplate、import、注册、event 命名全部由模板/lookup 表保证正确;LLM 错的范围被限制在几行函数体里
- 缺点:模板表达力受限;真要写一个不规则形状的 agent(比如 hybrid 内部循环、复杂错误恢复)就破规
- 落地路径:Handlebars/EJS 模板 + JSON schema 校验 spec + LLM tool-use 填 body

### 4.2 单次大 prompt 全量生成(naive,不推荐)

- 一次 LLM 调用,prompt 里塞 = 业务描述 + AO codebase 全貌(借 Opus 4.7 的 1M context)+ 输出格式约束
- 优点:写起来最短
- 缺点:① grounding 不可控,LLM 经常瞎编 import 路径;② 单点失败,失败就重头来;③ 没有中间可校验的 artifact;④ token 巨贵
- 业界共识:**production-ready codegen 没人这么做**——所有严肃工具(Aider/Cline/Claude Code 自己)都走多轮 agentic loop

### 4.3 Agentic loop(Claude Agent SDK / Inngest AgentKit,推荐 Phase 3)

- LLM 是 agent,工具集 = `read_file` / `write_file` / `grep_codebase` / `run_tsc` / `run_test`
- 模型自己探索 AO 现有 lib 签名、写代码、跑 `tsc`、看错误、改、再跑;直到通过
- 优点:**这就是 Claude Code / Aider / Cline 现在在做的事**——已被验证、有成熟参考实现
- 缺点:① 慢(单 agent 生成可能 60-180s + 大量 token);② 需要 sandbox 环境跑 `tsc`(不能让 LLM 直接污染主仓);③ 失败模式难调试
- 关键候选:
  - [**Claude Agent SDK** (TypeScript)](https://github.com/anthropics/claude-agent-sdk-python)([TS 版](https://platform.claude.com/docs/en/agent-sdk/overview))—— Anthropic 官方,跟 Claude Code 同一 agent loop;TS 版可直接 import 进 Next.js server route。**最贴 AO 现有栈**(AO 已有 `openai` SDK,加 `@anthropic-ai/sdk` 一行 deps)
  - [**Inngest AgentKit**](https://agentkit.inngest.com/overview)—— Inngest 自家的多 agent 框架,完美贴 AO 现在跑 Inngest 的事实;可以让 codegen 本身作为一个 Inngest function 跑,享有现成的重试/observability
  - [**Mastra**](https://mastra.ai/)—— Y Combinator 撑、$13M 种子;TS-first,81 LLM provider。但跟 AO 的 Inngest-native 栈正交,价值不如 AgentKit

### 4.4 推荐:Phase 1 用 4.1,Phase 3 升级到 4.3

模板填空先把"prompt → 跑得通的 stub" 的端到端流跑通(成功率 / 速度 / cost 可控),然后再花预算上 agentic loop 拿表达力。直接跳 4.3 是高风险——一个还没跑通端到端的功能,先上最贵最慢的引擎,没法迭代。

---

## 5. VS Code 开源代码 — 哪些能用上

直接回答用户的问题:**部分能用,但不是"装一个 VS Code OSS 进 AO"**。

### 5.1 ✅ Monaco Editor — 编辑器界面

[`@monaco-editor/react`](https://www.npmjs.com/package/@monaco-editor/react) 是社区主流方案。Next.js 接法:

```tsx
import dynamic from "next/dynamic";
const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });
```

`ssr: false` 是关键——Monaco 需要 browser `document`,SSR 会爆。多 model + path-based 文件切换、TS 语法高亮、diff viewer 全部开箱即用。MIT 协议,无心智负担。
**用途**:渲染 LLM 生成的代码、operator 手动微调、diff 对比新旧版本。

### 5.2 ⚠️ Continue.dev — 借架构,不要硬嵌

[Continue 仓库](https://github.com/continuedev/continue)分三块:`core/`(TS,protocol + agent loop) + `extension/`(VS Code 适配层) + `gui/`(React UI)。理论上 `core/` 是 headless 的,**但 protocol 围绕"我是 VS Code 扩展"假设很深**——把 core 单独提出来塞进 Next.js,工作量约等于自己写一个。

**真正能借**:Continue 的 `system prompt / context provider / slash command` 设计模式,是好的参考蓝图;它教你"怎么把 codebase 摄入到 LLM context 里" 比从零想清楚要快。

**别幻想**:把 Continue 当 SDK 嵌进 AO——它不是 SDK,它是一个完整应用,中间没干净接缝。

### 5.3 ❌ VS Code Webview / OpenVSCode / code-server — 不要走这条

把整个 VS Code 嵌进 AO(iframe / web build)能跑,但意味着 AO 多一个并行 IDE 进程,体积上 GB 量级,且 codegen 还是要自己写——VS Code 本体不带 LLM。**用错工具,放弃**。

### 5.4 Cline / Roo / Aider / OpenHands — 不要嵌,但要学

这几个是 **agentic coding agents 的 SOTA**——所有人(包括 Claude Code)都在做同一类事。如果走 4.3 agentic loop,把它们的 tool set / system prompt / loop control 翻一遍,能少走半年弯路。

- **Cline** —— 5.79 万 star,VS Code 扩展,best-in-class governance(step-by-step approval)
- **Aider** —— CLI,"thinks in git"(每次 edit = 一次 commit),低 token、高准确度
- **OpenHands** —— 完整 agent platform,$18.8M A 轮;走"task → sandbox → PR"路径,接近 Devin
- **Roo Code** —— Cline fork,**2026-05-15 已经关停**,不要选

### 5.5 结论一句话

**Monaco 嵌进来当编辑器,LLM agent loop 用 Claude Agent SDK 或 Inngest AgentKit 自己写;VS Code 本体 / Continue 整个嵌入 / Cline-as-library 都不是好选择。**

---

## 6. 推荐技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 编辑器 | `@monaco-editor/react` + dynamic import | 业界标准,Next.js 现成 |
| LLM 客户端 | `@anthropic-ai/sdk` + 已有 `openai` 双轨 | AO 已有 openai;加 anthropic 一行;Opus 4.7 写 TS 代码强 |
| Agent loop(Phase 3) | **Claude Agent SDK (TS)** | 跟 Claude Code 同一 loop,reference impl;tool 接口干净 |
| 多 agent 编排(可选) | **Inngest AgentKit** | 跟 AO 用同一个 Inngest;codegen 本身可作为 Inngest fn 跑(self-hosting) |
| 模板(Phase 1) | Handlebars 或裸字符串模板 | 简单胜过聪明;Handlebars 已经在 npm 主流 |
| 验证 | `typescript` API(已有依赖)+ `tsc --noEmit` 子进程 | 不可缺;LLM 生成的 import 路径 90% 会错一次 |
| Sandbox | 临时 worktree 目录,跑完 tsc 后丢弃 | 不允许 LLM 直接写主仓 `server/inngest/agents/` |

**显式不引入**:Mastra(跟 Inngest AgentKit 重叠且不更贴 AO)、LangChain TS(过度抽象,跟 Inngest agent 模型冲突)、Continue.dev core(不可干净分离)。

---

## 7. 端到端流程

```
   ┌─────────────────┐
 ① │ Prompt 写作面板 │  Monaco + chat 输入  ──┐
   └─────────────────┘                          │
                                                ▼
   ┌──────────────────────────────────────────────┐
 ② │ Spec 提取(LLM ①)                          │
   │   → 结构化 AgentSpec JSON:                  │
   │       { slug, stage, triggerEvent,           │
   │         emitEvents[], steps[], libsNeeded[]} │
   └──────────────────────────────────────────────┘
                                                ▼
   ┌──────────────────────────────────────────────┐
 ③ │ Tool / Lib 注册表查询(deterministic)        │
   │   读 AgentToolRegistry 表(7.2 节):         │
   │   把 libsNeeded[] 解析成具体 import 路径     │
   │   + 函数签名注入到 LLM context                │
   └──────────────────────────────────────────────┘
                                                ▼
   ┌──────────────────────────────────────────────┐
 ④ │ 代码生成                                       │
   │   Phase 1:模板填空 + LLM 填 step body         │
   │   Phase 3:Claude Agent SDK 跑 agentic loop    │
   └──────────────────────────────────────────────┘
                                                ▼
   ┌──────────────────────────────────────────────┐
 ⑤ │ 验证 sandbox                                   │
   │   - 写到临时 worktree                          │
   │   - tsc --noEmit                               │
   │   - 可选:跑生成的单测                          │
   │   失败 → 回 ④ 让 LLM 修(Phase 3 自动循环)   │
   └──────────────────────────────────────────────┘
                                                ▼
   ┌──────────────────────────────────────────────┐
 ⑥ │ Review gate(强制人工)                        │
   │   Monaco diff viewer:旧版 vs 新版              │
   │   operator 必须点"批准生成"                    │
   └──────────────────────────────────────────────┘
                                                ▼
   ┌──────────────────────────────────────────────┐
 ⑦ │ 落盘 + 存版本                                  │
   │   - 写 server/inngest/agents/<slug>.ts         │
   │   - 写 AgentVersion 行(8.1):                  │
   │       { slug, version, prompt, spec, codeBlob, │
   │         modelUsed, generatedAt, generatedBy }  │
   │   - git commit(可选,建议默认开)              │
   └──────────────────────────────────────────────┘
                                                ▼
   ┌──────────────────────────────────────────────┐
 ⑧ │ 部署                                          │
   │   - 配置层(temperature/promptAppend):热切    │
   │   - 代码层:需要重启 Next.js 进程才生效        │
   │     (Inngest fn 在 process start 时注册)     │
   │   UI 必须坦诚显示这一限制                       │
   └──────────────────────────────────────────────┘
```

### 7.1 关键细节:为什么需要 Spec 中间表示(步骤 ②)

直接 prompt → code 会把"我想要的"和"代码长什么样"耦合死,LLM 一改 prompt,代码全变。中间加 Spec 这一层让 ① diff 可读、② 模板填空可控、③ 同一 spec 可重生成多版本代码对比 model 差异。

Spec 至少包含:

```ts
type AgentSpec = {
  slug: string;                    // kebab-case, e.g. "salary-checker-agent"
  displayName: string;             // human label
  stage: Stage;                    // 复用 lib/agent-mapping.ts
  ownerTeam: string;
  triggerEvent: string;            // 必须在 EventDefinition 表里存在
  emitEvents: string[];            // 同上
  steps: Array<{
    id: string;
    description: string;           // 自然语言
    callsLib?: string;             // 引用 7.2 注册表
    inputs?: Record<string, string>;
    outputs?: Record<string, string>;
  }>;
  errorHandling?: 'retry' | 'dlq' | 'hitl-fallback';
};
```

### 7.2 关键细节:工具/Lib 注册表(用户已经提到的"需要手动生成")

LLM 不能凭空知道 AO 有哪些 lib。我们要建一张 **AgentToolRegistry** 表(或一份代码内静态文件,初期用静态文件更稳):

```ts
// lib/agent-codegen/tool-registry.ts
export const TOOL_REGISTRY = {
  'partner-pg.getRequirement': {
    importFrom: '@/lib/partner-pg/requirements',
    signature: 'getRequirementDetail(id: string): Promise<Requirement>',
    summary: '从 partner Postgres 拉一个 requirement 的完整快照',
    sideEffects: 'read-only',
  },
  'em.publish': {
    importFrom: '@/lib/em-client',
    signature: 'publish(name: string, data: unknown): Promise<void>',
    summary: '通过 EM 网关发布一个事件,会落 EventInstance',
    sideEffects: 'writes EventInstance, fans out to subscribers',
  },
  // ... 几十个
};
```

每条目入 LLM context;**LLM 只能选用这里有的工具**——任何不存在的 import 在 ⑤ 阶段 tsc 会直接挂掉。

这张表的维护成本就是用户预判的那个"手动":新增 lib 时,加一条目;改 lib 签名时,改一条目。可以写 lint 强制 PR 时检查。

---

## 8. 数据模型扩展

复用现有的 [`AgentConfig` / `AgentConfigHistory`](prisma/schema.prisma#L248)([见之前对话](docs/2026-05-22-ao-raas-event-architecture.md)),新增三张表:

### 8.1 AgentVersion(核心)

```prisma
model AgentVersion {
  id            String   @id @default(cuid())
  slug          String   // agent slug,joins AGENT_MAP
  versionLabel  String   // "v1.9.4" — 显示用
  status        String   // 'draft' | 'ready' | 'active' | 'archived'
  promptText    String?  // 生成此版本时的 prompt(null = 手写)
  specJson      String?  // JSON: AgentSpec (7.1)
  codeBlob      String   // 完整 TS 源码(也存盘到文件;DB blob 是真相)
  codeHash      String   // sha256(codeBlob);用于幂等去重
  configJson    String?  // 当时的 AgentConfig 快照(temperature 等)
  modelUsed     String?  // 'claude-opus-4-7' / 'gpt-5' 等
  generatedBy   String   // 'operator-<id>' or 'human'
  notes         String?
  createdAt     DateTime @default(now())

  @@unique([slug, versionLabel])
  @@index([slug, createdAt])
}
```

每个 agent 最多一行 `status='active'`,部署 = flip active flag + 把 `codeBlob` 写回 `server/inngest/agents/<slug>.ts` + 重启提示。

### 8.2 AgentSpec(可选,Phase 1 之后)

如果 spec 经常独立编辑(没生成代码就先存),拆出来:

```prisma
model AgentSpec {
  id          String   @id @default(cuid())
  slug        String
  draftJson   String   // AgentSpec JSON
  promptText  String?
  createdAt   DateTime @default(now())
}
```

Phase 1 不一定需要,可以把 spec 直接塞进 AgentVersion.specJson。

### 8.3 AgentToolRegistry(可选,初期用代码内静态文件)

7.2 节那张表。**初期用 `lib/agent-codegen/tool-registry.ts` 静态文件**,改动走 PR review,比 DB 表更安全。等数量级到 100+ 再考虑入 DB。

### 8.4 LibraryVersion(Phase 2 引入 — 见附录 B)

```prisma
model LibraryVersion {
  id              String   @id @default(cuid())
  name            String   // 'partner-pg-candidates' / 'rms-client' 等
  versionLabel    String   // 'v1.0.0'
  status          String   // 'draft' | 'ready' | 'active' | 'archived'
  kind            String   // 'http-client' | 'db-wrapper' | 'util'
  promptText      String?
  specJson        String?  // LibrarySpec (附录 B §B.2)
  codeBlob        String   // 完整 TS 源码 (主文件 + types + 测试合并 JSON)
  codeHash        String
  modelUsed       String?
  generatedBy     String
  registryEntries String?  // JSON: 自动写入 TOOL_REGISTRY 的条目快照
  externalSchema  String?  // JSON: OpenAPI / DB schema dump 等 seed 输入快照
  notes           String?
  createdAt       DateTime @default(now())

  @@unique([name, versionLabel])
  @@index([name, createdAt])
}
```

每个 lib 同样最多一行 `status='active'`。部署 lib 版本会:
1. 把 `codeBlob` 拆回 `lib/generated/<name>/...`
2. 把 `registryEntries` 写回 `lib/agent-codegen/tool-registry.ts`
3. 跑 `tsc --noEmit` 影响分析:看哪些 agent (查 AgentVersion.specJson 里的 callsLib) 会因签名变化挂掉,挂掉的列出来让 operator 决定是阻止部署还是触发依赖 agent 的重生成

### 8.5 AgentLibraryDependency(Phase 2 引入)

```prisma
model AgentLibraryDependency {
  agentVersionId String
  libraryName    String
  libraryVersion String
  @@id([agentVersionId, libraryName])
}
```

便于 §8.4 的影响分析查询。AgentVersion 写入时,从 specJson.steps[].callsLib 解析出来一并写。

---

## 9. 推荐分六 Phase

**Phase 0 — 配置版本表 + 回退(独立,1-2 周可完成)**

这就是用户第一轮想要的事,**和 codegen 完全解耦**,且是 codegen 的合理前置 step:

- 新建 `AgentVersion` 表(8.1),`codeBlob` 字段先留空、只填 `configJson`
- /fleet/[short]/?tab=versions 渲染版本列表(从 AGENT_MAP.version 当下迁移)
- "部署"按钮 = 把选中版本的 `configJson` 写回 `AgentConfig`;`AgentConfigHistory` 自动记一行
- "代码版本"显示为只读 breadcrumb(commit SHA / git tag),手动登记或从 `git log` 自动抽
- ✅ 这一 Phase 不需要 LLM,纯前后端 + DB

**Phase 1 — Agent codegen MVP(模板填空,3-4 周)**

- /fleet/[short]/?tab=versions 加 "+ 新建版本" 按钮
- 弹一个对话框:左 Monaco 写 prompt + 右 spec 表单(triggerEvent 下拉、libsNeeded 多选自 TOOL_REGISTRY)
- LLM Call A:prompt → AgentSpec JSON(structured output 强约束)
- 模板填空 + LLM Call B 填 step body → 生成 `<slug>.ts`
- Sandbox tsc 验证 → Monaco diff → 人工 review → 写 AgentVersion + 落盘
- **完整技术细节见 [附录 A](#附录-a--phase-1-agent-codegen-技术实现)**
- ✅ 此阶段 LLM 只在两个有边界的地方介入,失败可控

**Phase 2 — Library codegen MVP(3-4 周)**

- /datasources 或独立 /libraries 页面入口
- 支持四种 seed 输入:① OpenAPI/Swagger 粘贴;② curl + response 例子;③ DB schema dump;④ 自然语言 + URL
- LLM Call C:seed → LibrarySpec JSON
- LLM Call D:per-method body 填空
- **关键副产品**:每个 method 自动作为新条目写进 `TOOL_REGISTRY`——Phase 1 的 agent codegen 立刻能用上新 lib,**无需手动维护 registry**
- 落盘到 `lib/generated/<name>/`(物理隔离手写 lib)+ 写 LibraryVersion
- **完整技术细节见 [附录 B](#附录-b--library--package-codegen-设计)**
- ✅ 此阶段后,AO 拿到"端到端从 prompt 到一个会调新外部 API 的新 agent"完整闭环

**Phase 3 — 跨模型 / 多版本对比 + 评测(2-3 周)**

- 同 spec 多次生成,跨 model 对比(claude / gpt / 模板裸跑)
- Monaco 三路 diff(旧代码 / 新代码 A / 新代码 B)
- 引入 eval harness:用真实 event 喂、对比 emit 是否正确、记 success rate
- "再生成"——operator 点击重跑同一 spec 看不同采样
- ✅ 这阶段开始有"我真的在用 codegen 改 prod" 的可能性

**Phase 4 — Agentic loop(4-8 周)**

- 上 Claude Agent SDK / Inngest AgentKit
- 给 agent 工具集:`read_file` / `grep_codebase` / `write_file_in_sandbox` / `run_tsc` / `run_test`
- LLM 自己探索 AO codebase、写代码、跑 tsc、自我修复
- codegen 本身用 Inngest function 包装(observability 现成)
- ✅ 此时表达力达到"复杂 / 非典型形状 agent 也能生成"

**Phase 5(远期)— 一键部署 + hot-reload**

- 当前限制:新 agent / lib 代码落盘 → 需要重启 Next.js 进程才能让 Inngest 注册新 fn / 让 import 路径解析新文件
- 解法:① 接 CI 触发 redeploy webhook;② 自建一个"reload Inngest registry"endpoint(需要研究 Inngest SDK 是否支持运行时 register);③ 用 Node.js `--experimental-vm-modules` 做动态 import(高级)
- 这一 phase 风险高,放到最后

---

## 10. 不要装作能搞定的事(开诚布公的限制清单)

| # | 限制 | 后果 | 当前处理 |
|---|---|---|---|
| 1 | LLM 生成代码无法 100% 通过 tsc | 必须 sandbox + 强制人工 review gate | 7.⑤+⑥ 明确写入流程 |
| 2 | TS 文件落盘后,Inngest 没有热加载 | 需要重启进程 | UI 必须显示"代码层需重启";Phase 4 解 |
| 3 | LLM 不知道 AO 有哪些 lib | 编出不存在的 import | TOOL_REGISTRY 静态注入 + tsc 兜底 |
| 4 | Event 名拼写错 | runtime 永远跑不到 | spec 验证时强校验 `EventDefinition` 表 |
| 5 | 生成的代码可能有 prompt injection / RCE 风险 | 高 | review gate 必备;sandbox 限制 LLM 写盘范围 |
| 6 | 同一 spec 多次生成结果不一致 | 调试痛苦 | Phase 1 用低 temperature;Phase 2 引入对比 |
| 7 | 老版本"代码层回退"AO 做不到 | 用户期望对齐 | UI 显示"代码回退需 git revert + redeploy";只承诺 config 层热回退 |
| 8 | 测试生成本身是另一个难题 | Phase 2+ 才考虑 | Phase 1 不要求生成 test |

第 7 条特别重要——上一轮对话用户已经知道这个,但 UI 设计必须把它表达清楚,不能让操作员误以为点了"部署 v1.9.4" 代码就回去了。

---

## 11. 给用户的下一步决策项

不在文档里替你决定,但下面是几个**真的需要回答**的问题,顺序无关:

1. **范围**:Phase 0 是不是先独立做完?(我的强推荐:是。这样版本表的产品价值今天就拿到,codegen 是后面的故事)
2. **LLM provider**:走 Anthropic(Claude Opus 4.7)还是 OpenAI(已经在 deps)?Phase 1 用哪个?Phase 3 走 Claude Agent SDK 则必然 Anthropic。
3. **codegen 跑在哪**:Next.js server route(简单)vs 独立 Inngest function(可重试、可观测,但要写 Inngest fn)?**Phase 1 用 server route 起步,Phase 3 升 Inngest function** 是合理的。
4. **review gate 严格度**:每次生成强制人工?还是高 confidence + 全 tsc 通过 + 不改主仓 lib → 允许 auto-merge?**强推荐 Phase 1-3 全部强制 review**。
5. **代码部署**:Phase 1 落地 ≠ 上线?也就是说 Phase 1 生成出来的代码是 draft,需要 dev 拉下来本地测?这样能完全规避"重启 Next.js"的麻烦——AO 只负责 draft + 版本管理,真上线走 git PR + 现有 CI。**这一条很可能是 v1 的正确选择**。

---

## 12. 关于"是否现在就启动"的推荐

**建议路径**:

- **今天就启动 Phase 0**(版本表 + config 热回退 + UI 把"权限与数据" tab 删掉)。已经讨论清楚,2 周内可完成,产品价值立即拿到
- Phase 1 codegen **不要立刻启动**,先在 Phase 0 跑顺、operator 真用上版本回退之后,再观察:operator 实际想生成什么样的 agent?现在 AGENT_MAP 那 22 个 agent 里,有多少是"高度业务化、很可能再写新版本"的?如果只有 2-3 个,投入 codegen 的 ROI 就要重新算
- **Phase 3 / 4 是研究投资**,不是产品功能——开 Phase 3 之前应该至少有一次"用 Phase 1 生成的 agent 跑通 prod 数据"的成功案例,否则上 agentic loop 是 premature

**最坏选择**:跳 Phase 0,直接开 Phase 3。结果是:产品上线 6 个月里 operator 没有任何版本回退能力,而你在调一个跑得很慢的 codegen 系统。

---

## 附录 A — Phase 1 Agent Codegen 技术实现

> 这一节是 Phase 1 (§9) 的可落地技术细节。回答用户的问题:**以现有 22 个 agent 为 ground truth,具体怎么用 LLM API 实现 prompt generator + code generator?**

### A.1 经验观察:现有 agent 代码已经几乎是模板

扫完 [create-jd-agent.ts](server/inngest/agents/create-jd-agent.ts)、[resume-parser-agent.ts](server/inngest/agents/resume-parser-agent.ts)、[rule-check-agent.ts](server/inngest/agents/rule-check-agent.ts)、[stub-factory.ts](server/inngest/agents/stub-factory.ts) 后,**所有 real agent 90% 同骨架**:

```ts
// ── 不变部分(模板)─────────────────────
// (1) 文件头 banner:中文 workflow 定位 + inbound/outbound
// (2) imports:从 @/lib/* 引若干 lib
// (3) const AGENT_ID = '<slug>'
//     const AGENT_NAME = '<camelCase>'
// (4) export const xxxAgent = inngest.createFunction(
//       { id: AGENT_ID, name: '<Display Name>', retries: N,
//         triggers: [{ event: '<EVENT_X>' }] },
//       async ({ event, step, logger, runId }) => {
//         const log = createAgentLogger({ agent, runId, traceId, anchors });
//         return runWithLogger(log, async () => {
//           log.event('handler.start', {...});

// ── 变化部分(LLM 来填)────────────────
//           const a = await step.run('<step-1-name>', () => <lib-call-1>);
//           const b = await step.run('<step-2-name>', () => <lib-call-2>);
//           ...
//           await inngest.send({ name: '<EMIT_EVENT>', data: { ... } });

//           log.event('handler.complete', {...});
//         });
//       },
//     );
```

更妙的是,**AO 已经有"deterministic codegen 先例"**:[stub-factory.ts](server/inngest/agents/stub-factory.ts) 拿 `AgentMeta` 就能合成出可注册的 Inngest function。要做的 codegen 本质上是 **stub-factory 的进化版——把"sleep + 随机 emit"换成"LLM 填的真业务逻辑"**。

这个观察决定了技术路线:**不应该把整个文件交给 LLM 写,而是固定骨架 + 让 LLM 只填业务空格**。SOTA 之所以做不到 100% autonomous 是因为他们要解开放问题;AO 的问题是 closed-form 的——agent 形状已经收敛。

### A.2 六阶段流水线

```
┌──────────────────────────────────────────────────────────────────┐
│ STAGE 1: Spec 提取(LLM Call A)                                  │
│   Input: 自然语言 prompt + Event registry + Tool registry        │
│   Output: AgentSpec JSON (structured output, schema enforced)    │
│   Model: claude-opus-4-7 with tool_choice forced                 │
│   ~1-3s, ~$0.05                                                  │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ STAGE 2: Spec 验证(deterministic)                                │
│   - triggerEvent ∈ EventDefinition table?                        │
│   - emitEvents[] ⊂ EventDefinition table?                        │
│   - 每个 step.callsLib ∈ Tool registry?                          │
│   - slug 不冲突(查 AgentVersion 表 + AGENT_MAP)                 │
│   失败 → 把错误回喂给 STAGE 1 让 LLM 修(最多 2 轮)              │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ STAGE 3: 骨架渲染(deterministic)                                 │
│   用 Handlebars 模板 + Spec → 渲染出 .ts 文件骨架               │
│   - banner / imports / 常量 / createFunction 包裹                 │
│   - 每个 step.run() 留 `// TODO: fill body` 占位                  │
│   零 LLM、零网络、~10ms                                            │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ STAGE 4: 步骤体填充(LLM Call B,per step,可并行)               │
│   For each step in spec.steps:                                   │
│     Input: step description + 该 step 可用 lib 的签名 + few-shot │
│            (从现有 agent 抠出来的 2-3 个示例 step.run 调用)     │
│     Output: 该 step.run callback 的函数体代码                     │
│   ~6 steps × 1-2s = 6-12s, ~$0.30 total                          │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ STAGE 5: 静态验证(deterministic)                                 │
│   - 写到临时 worktree:/tmp/ao-codegen-<uuid>/                    │
│   - cp 主仓的 tsconfig + 软链 node_modules                       │
│   - 子进程跑 `tsc --noEmit`                                       │
│   失败 → 把 tsc 错误回喂 STAGE 4 让 LLM 改对应 step(最多 3 轮)  │
│   ~5-15s                                                          │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ STAGE 6: 落库 + 审阅                                              │
│   - 写 AgentVersion 行 (codeBlob, specJson, promptText, ...)     │
│   - 在 Monaco diff viewer 渲染新代码 vs 旧版本                    │
│   - operator 必须点"批准"才写到 server/inngest/agents/<slug>.ts │
│   - 落盘后提示"需重启 Next.js 进程才能让 Inngest 注册新 fn"      │
└──────────────────────────────────────────────────────────────────┘
```

**总成本**:一个 250 行 agent ≈ **$0.40 / 60-90 秒**。便宜到 production-ready。

### A.3 LLM Call A(Spec 提取)— 具体形态

#### 输入 prompt

```ts
const systemPrompt = `
你是 Agentic Operator 的 agent 设计师。给定一段业务描述,输出一个严格符合 schema 的 AgentSpec JSON。

可用的事件(只能从这里选 triggerEvent 和 emitEvents):
${EventRegistry.list().map(e => `  - ${e.name}: ${e.summary}`).join('\n')}

可用的 lib 工具(只能从这里选 callsLib):
${ToolRegistry.list().map(t => `  - ${t.id}: ${t.signature}\n      ${t.summary}`).join('\n')}

可用的 stage:${STAGES.join(', ')}

参考已有 agent 的 spec(从现有 22 个 agent 反推):
${FEW_SHOT_SPECS}   // ← 2-3 个真实 AgentSpec 例子
`;

const userPrompt = `业务描述:${operatorInput}`;
```

#### 输出 schema(强约束)

```ts
const AgentSpecSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]+-agent$/),
  displayName: z.string(),
  stage: z.enum(STAGES),
  ownerTeam: z.string(),
  triggerEvent: z.string(),
  emitEvents: z.array(z.string()),
  retries: z.number().int().min(0).max(5),
  steps: z.array(z.object({
    id: z.string(),
    description: z.string(),
    callsLib: z.string().optional(),
    inputsFromEvent: z.array(z.string()).optional(),
    outputsToNextStep: z.array(z.string()).optional(),
  })),
  errorHandling: z.enum(['retry', 'dlq', 'hitl-fallback']),
});
```

#### 实际 SDK 调用

```ts
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const resp = await client.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 4096,
  system: systemPrompt,
  messages: [{ role: 'user', content: userPrompt }],
  // 关键:用 tool_use 强制结构化输出
  tools: [{
    name: 'submit_agent_spec',
    description: '提交最终的 AgentSpec',
    input_schema: zodToJsonSchema(AgentSpecSchema),
  }],
  tool_choice: { type: 'tool', name: 'submit_agent_spec' },
});

const spec = AgentSpecSchema.parse(extractToolInput(resp));
```

`tool_choice` 强制 LLM 必须调用这个 tool,等价于强制 JSON Schema 输出——LLM 编不出非法 spec。

### A.4 LLM Call B(Step 体填充)— 具体形态

这是 codegen 的"真正写代码"环节,**范围被限制在单个 step.run callback 内**(通常 5-30 行),失败半径小。

#### 输入(给每个 step 一次)

```ts
const systemPrompt = `
你正在为 Inngest agent 的某个 step 写函数体。

输入参数:你能用的变量(从上游 step 传过来的)
可用工具:仅限以下 lib(不能 import 其它任何东西):
${step.allowedLibs.map(libId => formatLibSignature(libId)).join('\n')}

参考(同 stage 已有 agent 的真实 step.run 写法):
${FEW_SHOT_STEPS}   // 3-5 个真实 step.run 例子,由 §A.5.3 自动检索

规则:
1. 输出只能是函数体代码,不要重复 step.run 包裹
2. 错误用 NonRetriableError(若是 validation 错误)抛出
3. 全部用 await(不允许裸 Promise)
4. log 通过 logger.event(...) 调用
`;

const userPrompt = `
Step ID: ${step.id}
描述:${step.description}
可用变量:${step.inputs.join(', ')}
该 step 需返回:${step.outputs.join(', ')}
`;
```

#### 输出 schema

```ts
const StepBodySchema = z.object({
  imports: z.array(z.object({ from: z.string(), names: z.array(z.string()) })),
  body: z.string(),  // 不带外层 `() => { ... }` 包裹的代码字符串
});
```

### A.5 三张关键的注册表

#### A.5.1 Event Registry(已有,无需新建)

直接读 `prisma.eventDefinition.findMany({ where: { retiredAt: null } })`,把 `name` + `schemasByVersionJson` 灌进 prompt。Spec validator 用同一份数据校验 triggerEvent / emitEvents。

#### A.5.2 Tool Registry(必须新建)

```ts
// lib/agent-codegen/tool-registry.ts
export const TOOL_REGISTRY = {
  'partner-pg.getRequirement': {
    importFrom: '@/lib/partner-pg/requirements',
    importName: 'getRequirementDetail',
    signature: 'getRequirementDetail(id: string): Promise<Requirement>',
    summary: '从 partner Postgres 拉一个 requirement 完整快照',
    sideEffects: 'read-only',
    examples: ['create-jd-agent.ts:fetch-requirement'],  // 指向 few-shot
  },
  'partner-pg.saveCandidate': {
    importFrom: '@/lib/partner-pg/candidates',
    importName: 'saveCandidateToPartnerPg',
    signature: 'saveCandidateToPartnerPg(input: SaveCandidateInput): Promise<Candidate>',
    summary: '把 parse 完的简历写进 partner Postgres',
    sideEffects: 'writes Candidate row',
    examples: ['resume-parser-agent.ts:save-candidate'],
  },
  'robohire.parseResume': {
    importFrom: '@/lib/robohire-client',
    importName: 'parseResumeDirect',
    signature: 'parseResumeDirect(pdf: Buffer): Promise<ParsedResume>',
    summary: '直连 RoboHire 解析 PDF 简历',
    sideEffects: 'external HTTP, may throw RobohireApiError',
    examples: ['resume-parser-agent.ts:parse-pdf'],
  },
  // ... 几十条,从现有 agent 里逆向抽取出来
};
```

**怎么填初版**:写一个 npm 脚本扫 `server/inngest/agents/*.ts` 里所有 `import { ... } from '@/lib/...'`,自动生成初版 registry,人工补 summary。**一次性工作 1-2 天**。

**后续维护**:Phase 2 lib codegen 上线后,**新 lib 自动写回 registry**(见附录 B §B.6);手写 lib 改签名时,加 lint:CI diff `lib/` 和 `tool-registry.ts`,签名不匹配就 fail。

#### A.5.3 Few-shot Index(必须新建)

```ts
// lib/agent-codegen/few-shot-index.ts
// 启动时扫所有 agent .ts,提取每个 step.run(...) 块,索引化:
// {
//   stepRunCalls: [
//     {
//       sourceFile: 'create-jd-agent.ts',
//       stepName: 'fetch-requirement',
//       code: 'await getRequirementDetail(reqId)',
//       libsUsed: ['partner-pg.getRequirement'],
//       stage: 'jd',
//     },
//     ...
//   ]
// }
```

检索时按 (相同 stage) + (重叠 lib 多) 排序,选 top-3。**RAG,但 corpus 是 AO 自己的代码**——这就是别人没有的 grounding 资产。

### A.6 模板长什么样(Handlebars 示意)

```hbs
{{!-- templates/inngest-agent.hbs --}}
// {{slug}} — {{displayName}}.
//
// {{description}}
//
// Inbound:  {{triggerEvent}}
// Outbound: {{#each emitEvents}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
//
// Generated by AO codegen {{generatedAt}}. Do not edit by hand.

{{> imports}}

const AGENT_ID = '{{slug}}';
const AGENT_NAME = '{{camelName}}';

export const {{camelName}}Agent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: '{{displayName}}',
    retries: {{retries}},
    triggers: [{ event: '{{triggerEvent}}' }],
  },
  async ({ event, step, logger, runId }) => {
    const log = createAgentLogger({
      agent: AGENT_NAME,
      runId: runId ?? `local-${Date.now()}`,
      traceId: getTraceId(event.data) ?? null,
      anchors: {},
    });
    return runWithLogger(log, async () => {
      log.event('handler.start', { event_name: event.name });

      {{#each steps}}
      const {{outputVar}} = await step.run('{{id}}', async () => {
        {{!-- ←─── Stage 4 LLM 填这里(body)─── --}}
        {{body}}
      });

      {{/each}}

      {{#each emitEvents}}
      await inngest.send({ name: '{{this}}', data: { /* ... */ } });
      {{/each}}

      log.event('handler.complete', {});
    });
  },
);
```

模板自己保证 99% boilerplate 正确性。**LLM 只承担 `{{body}}`**。

### A.7 AO 内文件布局

```
lib/agent-codegen/
├── tool-registry.ts                 [手维护 + lint 守护;Phase 2 后由 lib codegen 自动扩]
├── event-registry.ts                [读 EventDefinition 表]
├── few-shot-index.ts                [启动时扫现有 agent]
├── spec-types.ts                    [AgentSpec Zod schema]
├── llm/
│   ├── client.ts                    [Anthropic + OpenAI dual-backend]
│   ├── spec-extractor.ts            [Stage 1]
│   ├── step-body-filler.ts         [Stage 4]
│   └── prompts/
│       ├── spec-extractor.system.md
│       └── step-body-filler.system.md
├── templates/
│   ├── inngest-agent.hbs            [主模板]
│   └── partials/
│       ├── banner.hbs
│       ├── imports.hbs
│       └── step-run.hbs
├── sandbox/
│   ├── worktree.ts                  [/tmp 隔离]
│   └── tsc-runner.ts                [子进程 tsc --noEmit]
├── validators/
│   ├── spec-validator.ts            [Stage 2]
│   └── tsc-validator.ts             [Stage 5]
└── pipeline.ts                       [主编排,六阶段]

app/api/agents/codegen/
├── route.ts                          [POST /api/agents/codegen]
└── stream/route.ts                   [可选 SSE 进度推送]

components/fleet/codegen/
├── CodegenModal.tsx                  [入口对话框]
├── SpecForm.tsx                      [Stage 1 后给 operator 微调 spec]
├── DiffReviewer.tsx                  [Stage 6 Monaco diff]
└── PromptArea.tsx                    [自然语言 prompt 输入]
```

总新增代码量估计:**1500-2500 行 TS**(模板 + pipeline + UI),不含 tool-registry(那是数据)。

### A.8 Phase 1 vs Phase 4(Agentic loop)的关键区别

| | Phase 1(模板填空) | Phase 4(Agentic loop) |
|---|---|---|
| LLM 控制范围 | 只能填 step.run body | 可以读任意文件、写任意文件、跑命令 |
| 单次成本 | ~$0.40 | ~$2-5(更多 LLM round) |
| 单次时长 | ~60-90s | ~3-8 分钟 |
| 失败模式 | LLM 编错 import 名 → tsc 挂(可控) | LLM 可能走偏到完全没用的探索路径 |
| 适合场景 | 跟现有 22 agent 同骨架的新 agent | 形状非常规、需要新建 lib 的复杂 agent |
| 现在该做 | ✅ | ❌(先等 Phase 1 跑出 5+ 成功案例) |

---

## 附录 B — Library / Package Codegen 设计

> 回答用户的问题:**生成 agent 代码时如果它要调一个 AO 还没有的 lib,这个 lib 自己怎么也用 AI 生成 + 保存 + 版本化?**

### B.1 为什么 Library 比 Agent 难,以及难在哪

Agent 难在"业务编排",lib 难在"**外部系统知识**"。差异:

| | Agent | Library |
|---|---|---|
| LLM 需要知道的 | AO 内部已有的 lib 接口 + event 命名 | **AO 外部系统的真相**(RAAS Postgres 列名、Neo4j schema、partner API endpoint) |
| 这些知识从哪来 | TOOL_REGISTRY + EventDefinition(AO 自己有) | **不在 AO 仓里**——必须用户提供 |
| 失败成本 | tsc 挂 → 不能跑(发现快) | tsc 过但 runtime SQL 列名错 / API 字段名错 → 静默坏掉(发现慢) |

所以 lib codegen 的**核心设计原则**是:**LLM 不允许凭空想任何外部系统的细节,所有外部真相必须从 operator 显式提供的 seed 输入抽取**。

### B.2 LibrarySpec 定义

```ts
type LibrarySpec = {
  name: string;                          // 'rms-client', 'partner-pg-applications'
  kind: 'http-client' | 'db-wrapper' | 'util' | 'sdk-wrapper';
  purpose: string;                       // 一句话:这个 lib 干啥
  externalSystem?: {
    type: 'rest-api' | 'graphql' | 'postgres' | 'neo4j' | 'minio' | 'other';
    name: string;                        // 'RAAS Postgres' / 'RMS REST API'
    baseUrl?: string;                    // for HTTP
    authStyle?: 'bearer' | 'basic' | 'api-key' | 'none';
    envVarsRequired?: string[];          // ['RMS_BASE_URL', 'RMS_API_KEY']
  };
  methods: Array<{
    name: string;                        // 'getApplication'
    description: string;
    params: Array<{ name: string; type: string; description: string }>;
    returnType: string;                  // 'Promise<Application>' (TS type 字符串)
    httpVerb?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    httpPath?: string;                   // '/api/v1/applications/:id'
    sqlTemplate?: string;                // 'SELECT * FROM applications WHERE id = $1'
    errors?: Array<{ code: string; class: string }>;
  }>;
  sharedTypes?: Array<{ name: string; tsDefinition: string }>;
};
```

### B.3 四种 seed 输入模式

operator 在 UI 里选其一,LLM Call C 从中抽出 LibrarySpec:

#### B.3.1 OpenAPI / Swagger 粘贴(推荐 — 外部 REST API)

operator 粘 YAML / JSON。LLM Call C 做的事 90% 是格式转换:把 OpenAPI 的 paths / schemas 翻译成 LibrarySpec.methods + sharedTypes。

- 优点:最有 ground truth,LLM 不太可能瞎编
- 缺点:不是所有 partner 都给 OpenAPI

#### B.3.2 curl + Response 例子(推荐 — 外部 REST API 无 OpenAPI)

```
operator 粘:
  curl -X POST https://rms.acme.com/api/v1/jobs \
    -H "Authorization: Bearer ..." \
    -d '{"title": "..."}'

  Response:
  {"id":"job_123","title":"...","status":"open","createdAt":"2026-..."}
```

LLM 从 request + response shape 推 method signature + 类型。**operator 提供 2-5 个不同 endpoint 的例子**,LLM 拼成 LibrarySpec。

- 优点:跟 partner 沟通成本最低,直接拿 curl
- 缺点:LLM 可能漏推 edge case;Phase 3 eval harness 跑真实请求兜底

#### B.3.3 DB Schema dump(推荐 — Postgres / Neo4j wrapper)

```
operator 粘:
  \d applications
  Column          | Type                     | Nullable
  ----------------+--------------------------+----------
  id              | uuid                     | not null
  job_id          | uuid                     | not null
  candidate_id    | uuid                     | not null
  status          | text                     | not null
  ...
```

LLM 生成对应的 typed query 函数(`getApplicationById`、`listApplicationsByJob` 等)。**SQL 模板是 LLM 写的,但列名一定来自 operator 提供的 schema**——LLM 不允许偏离。

#### B.3.4 自然语言 + URL(回退 — 不推荐但要支持)

operator 写"我要调 RMS 的 /api/v1/applications 接口,会返回 application 列表"。LLM 猜一切。**UI 必须显示巨大警告**:"This mode produces unreliable code. Verify all field names manually."

### B.4 六阶段 lib codegen 流水线

```
┌──────────────────────────────────────────────────────────────────┐
│ LIB STAGE 1: Lib Spec 提取(LLM Call C)                          │
│   Input: seed(B.3 四选一) + 现有 lib registry(避免命名冲突)   │
│   Output: LibrarySpec JSON (Zod schema enforced)                 │
│   ~2-5s(seed 大时更慢),~$0.10                                  │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ LIB STAGE 2: Spec 验证                                            │
│   - name 不冲突(lib/ 和 lib/generated/ 都查)                    │
│   - method 名内部不重复                                          │
│   - TS 类型字符串能 parse(用 ts.createSourceFile 试一下)        │
│   - http-client kind 要求 baseUrl 必须有                          │
│   失败 → STAGE 1 回喂(最多 2 轮)                                │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ LIB STAGE 3: 多文件骨架渲染                                       │
│   生成:                                                           │
│   - lib/generated/<name>/types.ts          (sharedTypes)         │
│   - lib/generated/<name>/client.ts         (auth setup, HTTP fn) │
│   - lib/generated/<name>/index.ts          (re-exports)          │
│   - lib/generated/<name>/<method>.ts       (per method, 大 lib) │
│     或 lib/generated/<name>/index.ts 单文件 (小 lib < 5 methods)│
│   - lib/generated/<name>/__tests__/<name>.test.ts (test 骨架)    │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ LIB STAGE 4: Per-method body 填充(LLM Call D,可并行)           │
│   For each method in spec.methods:                               │
│     Input: method spec + auth 上下文 + few-shot(同类已有 lib)  │
│     Output: 该 method 的函数体 + 必需的额外 import               │
│   ~3-8 methods × 1-2s ≈ 6-15s, ~$0.30-0.80                       │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ LIB STAGE 5: Test 生成(LLM Call E,可选但推荐)                  │
│   For each method 生成 vitest 测试:                              │
│     - http-client → mock fetch,assert URL/headers/body          │
│     - db-wrapper → mock prisma,assert query shape               │
│   测试只断言"调用形状",不断言外部系统真值                       │
│   ~5-10s, ~$0.20                                                  │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ LIB STAGE 6: 验证 + 落库                                          │
│   - sandbox tsc --noEmit(同 §A.2 STAGE 5)                       │
│   - sandbox vitest run(仅跑新生成的测试)                        │
│   - 自动追加条目到 lib/agent-codegen/tool-registry.ts:          │
│     每个 method → 一条 TOOL_REGISTRY 条目                        │
│   - Monaco diff (跨多文件) → 人工 review                         │
│   - 写 LibraryVersion 行 + 落盘到 lib/generated/<name>/          │
│   - git commit(默认开)                                          │
└──────────────────────────────────────────────────────────────────┘
```

**总成本**:一个 5 method 的 HTTP client lib ≈ **$1-1.5 / 90-180 秒**。

### B.5 LLM Call C(Lib Spec 提取)— 关键 prompt 设计

每种 seed 模式有专门的 system prompt:

```ts
// lib/agent-codegen/llm/prompts/lib-spec-extractor.openapi.md
你正在把 OpenAPI 3.x 规格转换成 LibrarySpec JSON。

铁律:
1. methods 的字段名、httpPath、httpVerb 必须 1:1 从 OpenAPI 复制,不允许改写
2. sharedTypes 必须从 components/schemas 转换,字段名严格保留
3. 如果 OpenAPI 里某 endpoint 没明确的 responseSchema,标 returnType 为 'unknown'
   并在 description 里写 "TODO: response shape unclear from spec"
4. 不允许猜测 OpenAPI 里没有的字段
```

```ts
// lib/agent-codegen/llm/prompts/lib-spec-extractor.curl-examples.md
你正在从 curl 命令 + response 例子推 LibrarySpec。

铁律:
1. 列名 / 字段名只能从 operator 提供的 JSON 例子里取,不允许"补充"看起来"应该有"的字段
2. 字段类型从值推断(string / number / boolean / 对象 / 数组),null 标 nullable
3. 多个 response 例子里出现的字段才标 required,只在部分例子里出现的标 optional
4. 如果操作员给的例子之间不一致(同字段不同类型),返回 ambiguity error 让用户澄清
```

```ts
// lib/agent-codegen/llm/prompts/lib-spec-extractor.db-schema.md
你正在从 DB schema 描述生成 typed query lib。

铁律:
1. 列名 / 表名严格按 operator 提供的内容,不改大小写、不补 _ 前缀
2. SQL 模板用 prisma.$queryRaw 或 prisma.<model>.findMany 风格 — 看 examples 里现有 partner-pg lib 怎么写就怎么写
3. 不允许编造 JOIN — 只 JOIN operator schema 里明确出现的外键
4. nullable 列在 returnType 里必须标 | null
```

### B.6 Tool Registry 自动扩展 — 关键副产品

LIB STAGE 6 落库时,**自动追加条目到 `lib/agent-codegen/tool-registry.ts`**:

```ts
// 假设刚生成了 lib/generated/rms-client/ 含 3 methods
// codegen 自动 append 到 tool-registry.ts:
TOOL_REGISTRY['rms.getApplication'] = {
  importFrom: '@/lib/generated/rms-client',
  importName: 'getApplication',
  signature: 'getApplication(id: string): Promise<Application>',
  summary: '从 RMS 拉单个 application 详情',
  sideEffects: 'external HTTP GET',
  examples: [],  // 暂无 agent 用过
  generatedByLibVersion: '<LibraryVersion.id>',
};
TOOL_REGISTRY['rms.listJobs'] = { ... };
TOOL_REGISTRY['rms.createApplication'] = { ... };
```

下一次 agent codegen(§A)的 prompt 里,LLM 立即就能"看到"这三个新工具——**zero 手动 registry 维护**。

`generatedByLibVersion` 字段是反向链接:rollback lib 版本时,同时清掉它注册的 registry 条目。

### B.7 影响分析 — Lib 版本切换的依赖检查

LibraryVersion `status='active'` flip 时,跑:

```sql
-- 查所有依赖此 lib 的 agent
SELECT av.slug, av.versionLabel
FROM AgentVersion av
JOIN AgentLibraryDependency ald ON av.id = ald.agentVersionId
WHERE ald.libraryName = '<lib>'
  AND av.status = 'active';
```

然后在 sandbox 里跑 `tsc --noEmit` 看哪些 agent 会因签名变化挂掉。结果有三种:

| 结果 | UI 表现 |
|---|---|
| 无 agent 依赖 | 直接切 |
| 有 agent 依赖,但签名兼容 | 提示"X 个 agent 依赖,签名兼容,可切" |
| 有 agent 依赖,签名 break | 红色警告 + 列出会挂的 agent + 选项:"阻止切换" / "切换并自动触发依赖 agent 重生成" |

第三种是 lib codegen 的杀手 feature——**lib v2 改 method 签名时,自动重 codegen 所有依赖的 agent 而不是手改**。这是 lib codegen 真正的产品价值。

### B.8 lib/generated 物理隔离

```
lib/
├── partner-pg/              ← 手写,人审,prod-critical
├── robohire-client.ts       ← 手写
├── em-client.ts             ← 手写
├── allmeta-writers.ts       ← 手写
├── ...
└── generated/               ← codegen 写入,只读、不允许手改
    ├── rms-client/
    │   ├── index.ts
    │   ├── types.ts
    │   ├── client.ts
    │   └── __tests__/
    ├── workday-applications/
    └── .gitattributes       ← linguist-generated=true,GitHub 折叠 diff
```

**关键约束**:
1. **手写 lib(`lib/*` 但不含 `lib/generated/`)** 永远不会被 codegen 覆盖
2. **`lib/generated/` 内的文件不允许 PR 手改**——CI lint 校验,违反就 fail("如果要改这个 lib,改 LibrarySpec 重生成,不要手改")
3. tool-registry.ts 自动管理 `lib/generated/` 引用;手写 lib 仍人工维护

### B.9 关于"package"的语义澄清

用户说"library/package",在 AO 上下文中:
- **"library"** = `lib/*` 下的本地 TS 模块(本附录全篇说的就是这个)
- **"package"** = npm 包(`package.json` deps),**不在 codegen 范围**

为什么 npm package 不能自动加:
1. 引入新 deps 是供应链安全决策,需要 license / 维护活跃度 / 已知 CVE 全部人工审
2. `npm install` + bundle size 变化需要看 build / Next.js 行为
3. 工程惯例:`package.json` 改动总是走 PR review

所以 lib codegen **只在 `@/lib/*` 范围生成**,如果 operator 想要的功能需要新 npm 包,UI 应该提示:"这个 lib 需要 `@some/package`,请先 PR 加 dep 再回来生成"。

### B.10 限制清单(对应 §10)

| # | 限制 | 后果 | 处理 |
|---|---|---|---|
| L1 | LLM 无法发明外部 schema | 必须 seed 输入 | §B.3 四种 seed |
| L2 | 自然语言 mode 极易瞎编 | runtime 静默坏 | UI 强警告 + Phase 3 eval harness 跑真请求 |
| L3 | lib 版本切换可能 break agent | prod 事故 | §B.7 影响分析强制人工决策 |
| L4 | 测试只 mock 外部系统 | 业务正确性无法自动验证 | Phase 3 引入"用真实数据 dry-run"的 eval |
| L5 | 不能改 package.json | 缺包就生成不出来 | UI 提示先 PR 加 dep |
| L6 | `lib/generated/` 不准手改 | 手动 fix 不行 | 必须改 spec 重生成;CI lint 守护 |

---

## Sources

- [Building agents with the Claude Agent SDK · Anthropic](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [Agent SDK overview · Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Inngest AgentKit · Build multi-agent networks in TypeScript](https://agentkit.inngest.com/overview)
- [Continue.dev · Open Source AI Code Agent (GitHub)](https://github.com/continuedev/continue)
- [@monaco-editor/react · npm](https://www.npmjs.com/package/@monaco-editor/react)
- [How to add Monaco to a Next.js app](https://www.swyx.io/how-to-add-monaco-editor-to-a-next-js-app-ha3)
- [Mastra · TypeScript-first agent framework](https://www.firecrawl.dev/blog/best-open-source-agent-frameworks)
- [Open-Source AI Coding Agents 2026: The Complete Comparison](https://wetheflywheel.com/en/guides/open-source-ai-coding-agents-2026/)
- [Agentic Coding Tools Compared 2026](https://www.requesty.ai/blog/agentic-coding-tools-compared-2026-claude-code-cursor-codex-aider)
- [CodeCoR: Self-Reflective Multi-Agent Code Generation (arxiv)](https://arxiv.org/pdf/2501.07811)
- [Inngest Documentation](https://www.inngest.com/docs)
