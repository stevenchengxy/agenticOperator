# 智能体工厂 v3 — 四项智能化优化

日期：2026-06-26 · 状态：已批准，实现中 · 顺序 ①→④→②→③

承接技术架构分析里识别的智能瓶颈。用户决策：① 留 gemini-flash（分级做成可配置管道）；③ 完整动态执行。

## ① 模型分级（可配置管道，默认 flash）
- `stream-gateway.ts` 导出 `FACTORY_FLASH_MODEL`(=FACTORY_AI_MODEL 默认 gemini-3-flash) + `FACTORY_STRONG_MODEL`(=`FACTORY_STRONG_MODEL` env，默认 = flash)。
- 路由：`conductor` 主 ReAct 流（设计/写码/规划都在此）传 `model: isSubAgent ? FLASH : STRONG`；`review judge`(index.ts) + `generate_test_cases`(test-cases.ts) 的 chatComplete 传 `model: STRONG`；子大脑 / 压缩摘要 / 生成的 product agent 运行时 = flash。
- 默认两档都 flash → 零成本零行为变化；`FACTORY_STRONG_MODEL=...` 一设主脑变强。

## ④ 复用既有 agent（接通多-harness）
- `read_ontology`：`listRegistryAgents(domain)` 取一次，对每个 Agent 动作 `selectFromAgents(registry, {triggerEvents,emitEvents,domain,capability})`，decision="reuse" 的浮出 `reusable_agent`（id/name/score/why）。
- 新工具 `reuse_agent({action, agent_id})`：查 `AgentVersion(agent_id).specJson` → 完整 GeneratedAgentSpec → 适配当前域(domainId/slug/actionName) → 推入 ctx.specs(标 reused，保留 generatedCode+codeSource=ai 以过 finish 门) → emit agent.created → lastSandbox=null。preset(无 specJson)只作信息提示。
- system prompt 加：设计前先看可复用的，能复用别重造。

## ② 测试用例正确性断言
- `fireAndObserve` 触发每条用例时已用唯一 `_runId`(=`factory2-fire-<domain>-case-i-<ts>`)，整条链共享。settle 后查事件归档(带 data)，按 `data._runId` 分组 → 每条用例追到它走到的终态。
- 按 kind 断言：`pass`→非失败终态；`reject`→FAILISH 终态；`edge`→容忍降级/未达终态。返回 `caseResults:[{name,kind,expectedOutcome,reachedTerminal,isFailureTerminal,ok,detail}]`。
- `sandbox` 事件 + RunReport 加 `caseResults`；验证面板逐条 ✓/✗ + eval 加「用例预期匹配 N/M」。

## ③ 沙箱跑 AI 亲写的 .ts（完整动态执行）
- 新 `lib/agent-factory-v3/load-generated.ts` · `loadGeneratedAgentFunction(spec, domain, client)`：
  - `ts.transpileModule(generatedCode, {module:CommonJS})` → CJS。
  - require 垫片：只喂 import 白名单的真实依赖——`@/server/inngest/client`→**命名空间代理 inngest**、`@/server/llm/gateway`→{chatComplete}、`@/lib/ontology-rules`→真模块、绑定工具的真实模块(registry.get(tool).impl)。
  - `new Function('require','exports','module', cjs)` 跑 → 从 exports 取出 Inngest 函数（有 `.id()`/createFunction 产物）。
  - **命名空间代理**：代理的 `createFunction(config,handler)` 把 triggers 改 `${domain}/${event}`、包 handler（event.name 去前缀给代码看裸名、step.sendEvent 加前缀、并借 sendEvent 拦截写 agentActivity 保观测）→ 注册到 per-domain client。
  - 任何编译/加载/运行失败 → 返回 null。
- `buildDomainFunctions`：沙箱域 + `codeSource:"ai"` 代码 + `FACTORY_EXEC_GENERATED!="0"` → 用真代码函数；null → 回退 `makeShellFunction`(现通用 executor)。
- 安全：仅沙箱域 + import 白名单 + 工具 dry-run + env kill-switch。

## 测试 / 验证
- typecheck 干净；既有工厂测试不回归；selection/load-generated 关键逻辑加单测；预览渲染验证 caseResults。
