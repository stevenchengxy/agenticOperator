# 因果链 Chatbot —— 设计 spec

**日期:** 2026-06-04(2026-06-05 修订:合并进追踪助手 + 因果链页降级为深链)
**状态:** 待实现
**作者:** brainstorm with Claude

## 一句话

把现有 `/correlations/[traceId]` 那条确定性的跨系统 timeline,接进**已经存在**的全局追踪助手(tracing chatbot),让用户能用自然语言问"这条链为什么这样 / 卡在哪",并得到**引用具体 timeline 行**的因果解释。**不新增第二个对话面板**——追踪助手本就全局浮在每个页面上,只需让它 trace-aware;因果链时间线页从导航降级为"被深链进来"的确定性详情 / 反幻觉锚点页。

## 背景与动机

`/correlations/[traceId]`([app/api/correlations/[traceId]/route.ts](../../../app/api/correlations/%5BtraceId%5D/route.ts))叫"因果链",但它实际只把 4 张表(`AuditLog` / `EventInstance` / `WorkflowRun`+steps / `HumanTask`)按 `ts` 排序,给的是**时序**(谁先谁后),不是**因果**(谁导致谁)。"为什么失败 / 为什么卡住"要人脑自己从时间线推。

LLM 正好补这层:把排好序的 timeline 叙述成因果解释。核心风险是 **LLM 会编因果**——问它"为什么失败"它永远给得出听起来合理的原因,哪怕数据不支持。对排障工具,自信的错答比原始时间线更糟。因此 timeline 必须留作①事实地基②反幻觉锚点,LLM 每句因果判断都要引用具体行。

## 关键现状(实现前必读)

本功能**不是从零新建**。代码库里已有一套工具型流式 chatbot:

| 能力 | 现状 | 文件 |
|---|---|---|
| 对话 UI(流式/输入/来源引用/自动滚动) | ✅ 已有 | [components/chat/GlobalChatPanel.tsx](../../../components/chat/GlobalChatPanel.tsx) |
| SSE LLM 工具循环端点 | ✅ 已有 | [app/api/chat/trace/route.ts](../../../app/api/chat/trace/route.ts) |
| 反幻觉 grounding(禁止从对话/训练知识编造 ID/数字/状态) | ✅ 已有 | [lib/chat/global-chat-system-prompt.ts](../../../lib/chat/global-chat-system-prompt.ts) |
| 自然语言→实体定位 | ✅ 已有 `searchEntities/searchRuns/searchEvents` 工具 | [lib/chat/global-chat-tools.ts](../../../lib/chat/global-chat-tools.ts) |
| 因果链工具 | ⚠️ 已有 `getEventChain` 但有缺口(见下) | 同上 |
| LLM 网关 + 不可达降级 | ✅ 已有 `chatComplete` / `isGatewayConfigured` / `pickGateway` | [server/llm/gateway.ts](../../../server/llm/gateway.ts) |
| 追踪助手全局浮窗(每页都在) | ✅ 已有,无条件挂载 | [components/shared/Shell.tsx:45](../../../components/shared/Shell.tsx#L45) `<GlobalChatBubble/>` |
| 追踪助手整页 | ✅ 已有导航项 `/chat` "追踪助手" | [app/chat/page.tsx](../../../app/chat/page.tsx) |
| 路由→PageContext 映射 | ✅ 已有 `usePageContext()`,浮窗与整页共用 | [lib/chat/page-context.ts](../../../lib/chat/page-context.ts) |

### IA 决定(2026-06-05)

追踪入口原本**三个重叠**:`/chat`(追踪助手整页)、全局浮窗(同一 chatbot,每页都在)、`/correlations`(确定性时间线)。chatbot 本就浮在因果链页上,**不该再挂第二个对话面板**。取舍拆成两条:

- **对话层 → 合并进追踪助手。** 不双挂 chat;让已全局存在的助手 trace-aware,在 `/correlations/<id>` 自动 scope 到该 trace。
- **确定性时间线 → 从导航降级为深链。** 它是 chatbot 的反幻觉地基 + 审计级可扫描视图,保留;但**移出 LeftNav**,改由助手引用 + run/事件/告警/收件箱页**深链**进来。导航里追踪只留"追踪助手"一个入口。

> 为什么不删时间线:chatbot 是概率性的、会漏会编;确定性时间线是完整、可复现、零幻觉的扫描视图,也是 `getCorrelationTimeline` 工具的数据来源。两者认知模式不同(问 vs 扫),互补不替代。

### 唯一的真缺口

现有 `getEventChain` 工具**只读 `EventInstance` 一张表**(按 candidate/jrId/uploadId 的 `payloadSummary` 子串匹配,或 eventId 精确匹配),返回事件链。它**看不到**另外三张表:`WorkflowRun`+steps、`HumanTask`(HITL)、`AuditLog`。

后果:当"为什么卡住"的答案是"挂在某 step 的人工节点等某人处理"时,`HumanTask` 不在 `getEventChain` 数据里,**chatbot 看不到这个挂起点,只能瞎猜**。这正是 `/correlations/[traceId]` 页有、chatbot 没有的那块关键因果证据。

## 范围

### In scope (v1)

1. 抽取共享 timeline 构建逻辑(route 与新工具共用,零重复)。
2. 给 chatbot 加 `getCorrelationTimeline` 工具,覆盖完整 4 表 timeline(含 HITL/run-steps/audit)。
3. 系统 prompt 补一条因果引用纪律。
4. **让全局追踪助手 trace-aware:** 在 `usePageContext()` 加分支,`/correlations/<id>` 路由下注入 `traceId`。不双挂面板。
5. **因果链页从导航降级为深链:** 移除 LeftNav 的 correlations 项;助手回答与 run/事件/告警页深链进 `/correlations/<id>`。

### Out of scope (YAGNI / 已存在)

- ❌ 新缓存表 `CorrelationNarrativeCache` —— 对话是多轮工具循环,按 trace 缓存没意义;真要省 token 后置。
- ❌ 新 SSE / narrative 端点 —— 复用 `/api/chat/trace`。
- ❌ 新对话 UI / 第二个对话面板 —— 复用已全局浮挂的追踪助手(`GlobalChatBubble`)。
- ❌ 删除确定性时间线页 —— 保留为深链详情 + 反幻觉锚点,仅退出导航。
- ❌ 跨链自然语言入口("为什么字节那个岗位的候选人没进来")—— 现有 `searchEntities` 等工具已能从名字定位,bot 自行串联。

## 设计

### 改动 1 —— 抽取 `buildCorrelationTimeline(traceId)`

新文件 `lib/correlation/build-timeline.ts`,把 [app/api/correlations/[traceId]/route.ts](../../../app/api/correlations/%5BtraceId%5D/route.ts) 第 46–208 行的 4 表 join + 排序逻辑原样搬过来:

```ts
export type TimelineEntry = { /* 从 route 移过来,保持字段不变 */
  ts: string;
  source: "audit" | "event_instance" | "workflow_run" | "workflow_step" | "human_task";
  kind: string;
  title: string;
  detail?: string;
  refType?: string;
  refId?: string;
  link?: string;
};

export type CorrelationTimeline = {
  traceId: string;
  totals: { auditLog: number; eventInstance: number; workflowRun: number; humanTask: number };
  timeline: TimelineEntry[];
};

export async function buildCorrelationTimeline(traceId: string): Promise<CorrelationTimeline>;
```

route handler 改成薄壳:`const data = await buildCorrelationTimeline(traceId); return NextResponse.json({ ...data, meta: { generatedAt } })`。**对外 JSON 结构保持不变**(回归测试守住)。每张表的 try/catch 降级(表缺失→跳过)随逻辑一起搬。

### 改动 2 —— 新工具 `getCorrelationTimeline`

在 [lib/chat/global-chat-tools.ts](../../../lib/chat/global-chat-tools.ts) 加:

```ts
{
  name: "getCorrelationTimeline",
  schema: { /* OpenAI tool format */
    parameters: {
      type: "object",
      properties: {
        traceId: { type: "string", description: "trace_id / external_event_id / run_id / event instance id —— 任一锚点 id" },
      },
      required: ["traceId"],
    },
    description:
      "拉取一个 trace 的完整跨系统因果时间线:合并 publish 审计 / 事件实例 / workflow run+steps / HITL 人工节点,按时间升序。比 getEventChain 更全 —— getEventChain 只看事件,这个能看到 run 失败、step 报错、以及挂起在哪个人工节点。回答'为什么卡住/为什么失败'时优先用本工具。",
  },
  execute: async (input) => {
    const traceId = String(input?.traceId ?? "");
    if (!traceId) return { result: { timeline: [] } };
    const data = await buildCorrelationTimeline(traceId);
    // 每行带稳定序号 + refType/refId,供 LLM 引用
    const rows = data.timeline.map((e, i) => ({ idx: i + 1, ...e }));
    return {
      result: { traceId, totals: data.totals, timeline: rows },
      sources: rows.filter(r => r.link).map(r => ({ /* ChatSource */ label: r.title, url: r.link! })),
    };
  },
}
```

- `sources` 走现有 `emit({ type: "sources" })` 通道,UI 自动渲染可点击来源。
- `idx` 给 LLM 一个稳定的引用编号,配合 grounding 纪律。

### 改动 3 —— grounding prompt

**3a. 系统 prompt** —— [lib/chat/global-chat-system-prompt.ts](../../../lib/chat/global-chat-system-prompt.ts) 在现有"禁止编造"段后补一条:

> 解释因果时,每个"因为 X 所以 Y"的判断必须对应 `getCorrelationTimeline` 返回的具体 timeline 行(用其 `title` 或 `idx`/`refId` 指明)。链路数据不足以判定原因时,直接说"现有链路数据无法判定",**不要脑补未出现在时间线里的事件或原因**。"卡住/挂起"优先在 `human_task`(HITL)与未完成的 `workflow_step` 里找证据。

**3b. PageContext system-prompt 渲染** —— `pageContextLine`(同文件)在 `pc.traceId` 存在时渲染成"当前正在查看 trace `<id>`,优先用 getCorrelationTimeline 对它取证"。

### 改动 4 —— 让全局追踪助手 trace-aware(替代原"页面挂第二个面板")

**不再在因果链页挂 `GlobalChatPanel`。** 追踪助手浮窗已在 [Shell.tsx:45](../../../components/shared/Shell.tsx#L45) 全局挂载,且通过 [lib/chat/page-context.ts](../../../lib/chat/page-context.ts) 的 `usePageContext()` 读当前路由。只需两步:

**4a. PageContext 类型** —— 给 [lib/chat/types.ts](../../../lib/chat/types.ts) 的 `PageContext` 加可选 `traceId?: string`。

**4b. usePageContext 分支** —— 在 [lib/chat/page-context.ts](../../../lib/chat/page-context.ts) 加:路由 `/correlations/<id>` 时,从 pathname 抽出 traceId 注入 `ctx.traceId`。已挂载的浮窗下一次发问就带上 trace scope,**零双挂、零新组件**。

**4c.(可选轻量)唤起按钮** —— 因果链页 Header 可加一个"问 AI 为什么"按钮,打开已有浮窗。这需要一个共享的 open 信号(浮窗目前自管 open 状态);若该机制不存在则**先不做**,用户自己点右下角浮窗即可(YAGNI)。

Timeline 照旧渲染在主区——它是反幻觉锚点,用户拿助手叙述对照原始行。

### 改动 5 —— 因果链页从导航降级为深链

**5a. 移出 LeftNav** —— 删 [components/shared/LeftNav.tsx](../../../components/shared/LeftNav.tsx) 第 63 行 `correlations` 项。`/correlations` 与 `/correlations/[traceId]` 路由**保留**。

**5b. 深链入口** —— 时间线靠"被链接到"存活:
- 助手 `getCorrelationTimeline` 工具的 `sources` 里追加一条指向 `/correlations/<traceId>` 的"查看完整时间线"链接。
- run / 事件 / 告警 / 收件箱页在展示某条 trace 时,提供深链进 `/correlations/<traceId>`(逐页接线,可分批做;v1 至少接 run 详情与告警)。
- `/correlations`(无 id 的着陆搜索页)保留,作为"我手里正好有个 id"的兜底入口。

## 数据流

```
用户在 /correlations/<id> 看确定性时间线,右下角追踪助手浮窗问"为什么卡住"
  → usePageContext() 已注入 { route:"/correlations/[traceId]", traceId }
  → GlobalChatPanel(浮窗)POST /api/chat/trace { messages, pageContext }
  → 工具循环 LLM 看到 trace scope → 调 getCorrelationTimeline(traceId)
  → buildCorrelationTimeline 4 表 join(含 HITL) → 带 idx/refId 的 timeline
  → LLM 引用具体行叙述因果 + emit sources(含"查看完整时间线"深链)
  → 浮窗流式渲染;主区 timeline 不变,供对照
```

## 降级

- LLM 网关不可达:`/api/chat/trace` 已有 `isGatewayConfigured()` 守卫,emit 一句"LLM gateway 未配置"。timeline 主区照常可用 —— 功能优雅退回纯时间线。
- 某张表缺失/查询失败:`buildCorrelationTimeline` 每张表独立 try/catch 跳过(逻辑随 route 一起搬),工具仍返回可用的部分 timeline。

## 测试(vitest)

1. **`buildCorrelationTimeline` 单测:** 塞一条挂在 HITL 的 trace(audit + event + run + 未完成 human_task),断言返回的 timeline 含 `source: "human_task"` 行、按 ts 升序、totals 计数正确。
2. **route 回归:** 重构后 `GET /api/correlations/[traceId]` 的 JSON 结构与字段不变(对比快照)。
3. **工具 execute:** 给定 traceId,断言 `getCorrelationTimeline.execute` 返回带 `idx` 的行 + `human_task` 行 + `sources` 数组。
4. **prompt 注入:** 断言 `buildSystemPrompt({route, traceId})` 含 trace scope 行。
5. **usePageContext 分支:** 断言 `/correlations/abc` 路由下 `usePageContext()` 返回的 ctx 含 `traceId: "abc"`(routing 单测,若已有 page-context 测试则并入)。

## 文件清单

| 动作 | 文件 |
|---|---|
| 新建 | `lib/correlation/build-timeline.ts` |
| 改薄 | `app/api/correlations/[traceId]/route.ts` |
| 加工具 | `lib/chat/global-chat-tools.ts` |
| 加纪律 | `lib/chat/global-chat-system-prompt.ts`(grounding + traceId scope 行) |
| 加字段 | `lib/chat/types.ts`(`PageContext.traceId`) |
| 加分支 | `lib/chat/page-context.ts`(`/correlations/<id>` → 注入 traceId) |
| 移导航项 | `components/shared/LeftNav.tsx`(删 correlations 项) |
| 深链接线 | run 详情 / 告警页(指向 `/correlations/<id>`;可分批) |
| 测试 | `lib/correlation/build-timeline.test.ts`、`lib/chat/global-chat-tools.test.ts`、`lib/chat/page-context.test.ts`(或并入现有) |

> 注:不再改动 `components/correlation/CorrelationContent.tsx`(原计划挂面板,已取消);唤起按钮(4c)为可选,视共享 open 机制是否存在再定。
