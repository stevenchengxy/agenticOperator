# 智能体工厂 v3 — 大脑活动日志 / 测试用例验证闭环 / 后台持久运行

日期：2026-06-26 · 状态：已批准，实现中

## 背景

工厂 v3 三栏 cockpit（[FactoryV3Content.tsx](../../../components/behavior/factory-v3/FactoryV3Content.tsx)）已经端到端跑通：自主 ReAct 大脑（[conductor.ts](../../../lib/agent-factory-v3/brain/conductor.ts)）流式生成 agent、真实部署沙箱、验收门。本次补三个洞：

1. **右侧「大脑」展示不够**：只有放射状计数图 + 扁平 trace，看不到「每个 actor（主大脑/子大脑）具体做了什么、每步的输入/输出」。
2. **验证 UI 不够**：能证明「部署了、跑了 N 个」，但看不到每个 agent 跑时吃进什么、吐出什么；喂的是写死种子数据，无「用例」抽象。
3. **无持久后台运行**：大脑主循环跑在 SSE 请求体内（[conductor.ts:325](../../../lib/agent-factory-v3/brain/conductor.ts) `if (opts.signal?.aborted) break`），离开页面 → EventSource 关 → abort → 大脑停。无停止按钮。

## 设计一：大脑活动日志（前端为主）

把右侧「大脑」tab 的主视图从放射计数图换成**按角色分组的活动日志**。

- 角色分组：🧠 主大脑、每个 🧩 子大脑各成一段；每段下是它的步骤流（按时间）。
- 每步一行（简洁）：`工具业务名 · 一句理由 · ✓/✗`；点开展开完整 `输入 JSON / 结果`。生成的 agent/技能/工具/子大脑作为里程碑内联。
- 数据零新增：前端已收到 `tool.call`(input+reasoning)、`tool.result`(ok+summary)、`subagent.start/done`、`agent.created` 等，[toBlocks()](../../../components/behavior/factory-v3/FactoryV3Content.tsx) 已解析——纯渲染改造。放射图降级为次级「活动图」视图保留。
- 子大脑内部步骤后端未打 tag → 以 `subagent.start→done` 为一个折叠单元（task + 结论）。

## 设计二：测试用例闭环 + 逐 agent I/O（用户采纳方案）

到沙箱阶段变成有**人工确认门**的闭环：

1. 大脑调 `generate_test_cases`（专用工具，发 `subagent.start/done` 让它以「子大脑」出现在活动日志里）→ 沿编译好的事件图从入口回溯到终态，造 N 个**全流程覆盖用例**（通过 / 规则不符 / 缺字段，含入口事件 + payload + 预期终态）。
2. 大脑调 `propose_test_cases` → 发 `test.cases` 事件 + 置 `ctx.awaitingApproval=true`。
3. conductor 主循环 stream 前检测 `awaitingApproval` → **轮询 mailbox 等决策**（尊重 signal/超时），期间不 streamTurn。
4. 中栏 feed 弹确认卡：**执行 / 重新生成**。点击 → `POST /api/factory-v3/brain/inject`（复用 HITL 通道）文本 `[测试用例决策:执行]` / `[测试用例决策:重新生成] <note>`。
5. conductor 识别决策前缀：批准 → 清 flag，注入 user 消息，大脑去 `sandbox_run`（用 `ctx.testCases`）；重新生成 → 提示大脑再 `generate_test_cases`。
6. `sandbox_run` 把 `ctx.testCases` 透传给 [fireAndObserve](../../../lib/agent-factory-v2/deploy.ts)（替换写死种子）；settle 后用 `collectAgentRuns` 从归档（`inngestRunArchive.eventPayload/output` + `agentActivity` 决策 + 发出事件 payload）拼出每个 agent 的 `输入事件+payload → 工具 → 输出事件+payload`，塞进 `sandbox` 事件新增 `agentRuns` + `cases` 字段。
7. 验证 tab 渲染：用例 → 逐 agent I/O 链 → eval 清单裁决。真实 runId + 真 I/O = 证明跑通。

兜底：每域一个 golden fixture（domain-aware 种子）作为 AI 生成失败时的 fallback。

## 设计三：进程内后台运行 + 停止（用户选 A）

核心：把大脑主循环从 SSE 请求体解耦。

- **新 [run-registry.ts](../../../lib/agent-factory-v3/brain/run-registry.ts)（进程内）**：`Map<runId, ActiveRun>`，ActiveRun = `{events[], subscribers, status, abort:AbortController, domain, goal, stats}`。`startRun` 起一个**脱离请求**的 driver 跑 `runBrain(signal:abort.signal)`，每事件 → 推 events[] + 通知订阅者 + 节流落 `FactoryBrainRun.transcript`；结束 → fail-safe reflection + `finalizeBrainRun` + 置 status + TTL 后清。`subscribe` 回放缓冲 + 接实时；`abortRun` → abort。createBrainRun/finalizeBrainRun 从 route 迁入。
- **SSE 路由订阅化**：新增 `runId`(attach) 参数。attach 活跃 run → subscribe；attach 已结束 → 读 `FactoryBrainRun` 回放 transcript + done（status 仍 running=被重启中断 → 提示「已中断，点继续」）；无 attach → 新 run 或 convId-resume → startRun + subscribe。**断连只 unsubscribe，不 abort**（关键反转，去掉 `cancel(){ac.abort()}`）。
- **新 [stop/route.ts](../../../app/api/factory-v3/brain/stop)**：`POST {runId}` → `abortRun` → conductor 下轮 break → 收尾 `aborted`。
- **前端**：localStorage 记当前活跃 runId，返回页面 attach 重连看实时；composer 加**停止按钮** + 「后台运行中」指示。
- **已知局限**（用户接受）：dev 重启/HMR 中断在跑的 run；重连检测 `FactoryBrainRun.status=running` 但 registry 无 → 显示「已中断，点继续」走 convId rehydrate。

## 类型改动（types.ts）

```ts
type TestCase = { id; name; scenario; kind:"pass"|"reject"|"edge"; entryEvent; payload; expectedOutcome };
| { t: "test.cases"; cases: TestCase[]; awaitingApproval: boolean }
// sandbox 事件扩展：
agentRuns?: Array<{ agentSlug; agentShort; status; degraded; triggerEvent; inputPayload; tools; outputEvent; reasoning; outputPayload; runId; url }>;
cases?: Array<{ name; entryEvent; payload }>;
// BrainCtx：testCases?: TestCase[]; awaitingApproval?: boolean;
```

## 实现清单（按依赖序）

1. types.ts — TestCase + test.cases 事件 + sandbox.agentRuns/cases + ctx.testCases/awaitingApproval
2. run-registry.ts（新）— 后台 run 生命周期 + 迁入 createBrainRun/finalizeBrainRun
3. stream/route.ts — 订阅模型 + attach 参数 + 去掉断连 abort
4. stop/route.ts（新）
5. conductor.ts — awaitingApproval 等待循环 + 决策识别
6. test-cases.ts（新）+ generate_test_cases / propose_test_cases 工具
7. deploy.ts — fireAndObserve 接 cases；collectAgentRuns 助手
8. sandbox_run — 透传 cases + 挂 agentRuns/cases
9. 工具接线（ALL_TOOLS）
10. FactoryV3Content.tsx — 活动日志 + 验证 I/O + 确认卡 + 停止按钮 + attach 重连
11. globals.css / 内联 — 新样式

## 测试

- run-registry：subscribe 回放 / 实时转发 / abort 转 aborted（vitest 纯逻辑）
- test-cases fixture builder：golden fixture 兜底形状
- `npm run build` typecheck 全绿 + 既有 vitest 不回归
