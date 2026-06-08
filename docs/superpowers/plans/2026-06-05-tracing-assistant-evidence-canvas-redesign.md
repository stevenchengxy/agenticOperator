# 追踪助手 /chat 证据画布重设 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 /chat 整页追踪助手从"灰散文聊天框"重做成「左问 / 右长证据」的三列双面工作台,右侧证据画布实时长出确定性因果链 timeline + 实体/run/审计卡,HITL 挂起行是全页唯一被框的焦点,并加入一套连贯、可访问(prefers-reduced-motion)的动画。

**Architecture:** 三列 grid `232px 1fr 320px`(datasources/alerts 同款字面骨架)。中列复用现有 `GlobalChatPanel`(去掉 82% 空洞 + 加 grounded 条/结论卡渲染纪律);右列新 `EvidenceCanvas` 复用 `CorrelationContent` 抽出的确定性 timeline 组件,**独立**从 `/api/correlations/[traceId]` 拉数据(不信 LLM 工具输出,反幻觉)。对话/浮窗仍是同一个 `GlobalChatPanel`,不双挂第二个对话面板(守 2026-06-05 spec)。

**Tech Stack:** Next.js 16 App Router · React 19 · Tailwind v4(OKLCH `--c-*` tokens,CSS 动画)· Prisma 7 → Postgres · vitest。

**Design 依据:** 设计综合见本会话 design workflow 输出(证据画布·AO 原生收束版);Phase 0 数据地基见 [因果链 chatbot spec](../specs/2026-06-04-causal-chain-chatbot-design.md)。

---

## 复用 / 不要重造(实测确认)

- `--c-suspended` amber token 已存在([globals.css:99](../../../app/globals.css#L99))且绑定为 `bg-suspended`/`text-suspended`/`border-suspended` utility → HITL 挂起行直接用,**不要**用泛 warn。
- `Timeline`/`TimelineRow`/`sourcePalette`/`Counter`/`KindBadge`/`kindVariant` 在 [CorrelationContent.tsx](../../../components/correlation/CorrelationContent.tsx) 里**是私有 function**(未 export)→ 必须先抽成共享模块(Task 1.1)。
- 现有动画体系:`chatMessageIn`/`chatSendFly`/`chatTypingDot`/`chatCursorBlink` + `aoFadeRise`/`aoPopIn`/`aoStreamIn`/`aoExpandReveal`/`ogCheckPop`,且有 `@media (prefers-reduced-motion: reduce)` 守卫([globals.css:503,559](../../../app/globals.css#L503))→ 新动画沿用同一模式 + 进同一守卫。
- 原子:`Metric`/`StatusDot`/`Badge`/`Btn`/`Card`/`CardHead`/`Spark`、`.tbl`、`Ic.*`、`EmptyState`(现有于 GlobalChatPanel)。
- 既有 chat 基建:SSE `tool_call_start/done` + `sources` + `text_chunk`([chat/trace route](../../../app/api/chat/trace/route.ts)),`MessageRow`/`SourcesList`/`SourcePill`/`ToolCallIndicator`/`TypingIndicator`(GlobalChatPanel.tsx)。

## File Structure

**Create:**
- `components/correlation/timeline-parts.tsx` — 从 CorrelationContent 抽出的 `Timeline`/`TimelineRow`/`sourcePalette`/`Counter`/`KindBadge`/`kindVariant`(导出),供 CorrelationContent 与 EvidenceCanvas 共用。
- `components/chat/ChatWorkbench.tsx` — 新三列骨架,取代 GlobalChatFullContent。
- `components/chat/SessionRail.tsx` — 左列(HistoryList + 搜会话 + 两个信任 Metric)。
- `components/chat/EvidenceCanvas.tsx` — 右列证据画布(tab + 因果链 + 实体/run/审计卡 + 折叠)。
- `components/chat/HitlSuspendRow.tsx` — timeline 内 HITL 挂起行升级块(amber 框 + 三只读深链 + 呼吸动画)。
- `components/chat/GroundedBar.tsx` — 助手气泡顶"本轮 N 工具·M 行·grounded✓"(纯前端聚合 SSE)。
- `lib/correlation/build-timeline.ts` — Phase 0:4 表合并 timeline(因果链 spec 改动 1)。
- `lib/chat/use-evidence.ts` — 从当轮 sources/pageContext 解析 traceId、拉 `/api/correlations/[traceId]`、给画布喂数据的 hook。
- 测试:`lib/correlation/build-timeline.test.ts`、`lib/chat/global-chat-tools.test.ts`(getCorrelationTimeline)、`app/inbox/inbox-task-param.test.ts`(或并入现有)、`components/chat/GroundedBar.test.tsx`。

**Modify:**
- `app/chat/page.tsx` — 渲染 `ChatWorkbench` 代替 `GlobalChatFullContent`。
- `components/correlation/CorrelationContent.tsx` — 改为 import timeline-parts(行为不变)。
- `components/chat/GlobalChatPanel.tsx` — 去 `MessageRow` 的 `maxWidth:'82%'`;插入 `GroundedBar`;结论卡渲染纪律。
- `lib/chat/types.ts` — `ChatSource` 加 `anchor?`/`traceId?`;`PageContext` 加 `traceId?`。
- `lib/chat/global-chat-tools.ts` — 加 `getCorrelationTimeline` 工具(因果链 spec 改动 2)。
- `lib/chat/page-context.ts` — `/correlations/<id>` 注入 traceId(spec 改动 4b)。
- `lib/chat/global-chat-system-prompt.ts` — 因果引用纪律 + traceId scope + 气泡"结论+3要点"分工。
- `app/api/correlations/[traceId]/route.ts` — 改薄壳调 build-timeline(JSON 不变)。
- `app/inbox/page.tsx` — 读 `?task=<id>` 预选。
- `components/shared/LeftNav.tsx` — 移除 correlations 导航项(降级为深链)。
- `app/globals.css` — 新动画 keyframes + reduced-motion 守卫(见下)。
- `lib/i18n.tsx` — 新 UI 文案 zh+en。

---

## 动画设计(Animation Design)

**原则:** 动画**服务信息**,不是装饰——每个动画对应一次"数据到达/状态变化",让 grounding 的"实时长出证据"被看见。全部用 CSS keyframes(进 globals.css,跟现有 `ao*` 同块),全部进 `prefers-reduced-motion: reduce` 守卫(reduce 时 `animation: none`、用即时状态)。时长 160–520ms,缓动 `cubic-bezier(0.22,1,0.36,1)`(现有 ao 同款)。

| # | 动画时刻 | 触发 | 实现 | 复用/新建 |
|---|---|---|---|---|
| A1 | **证据画布揭幕** | 本轮首次拿到 traceId/timeline | 画布列从右侧 16px + opacity 滑入 | `aoFadeRise` 变体 `canvasReveal`(新) |
| A2 | **证据卡 staggered 长出** | `sources` 到达 / 卡渲染 | 每卡 `aoFadeRise` + `animationDelay: i*60ms` | 复用 `aoFadeRise` |
| A3 | **timeline 行级联** | 因果链数据加载 | 每行 fade+上移 8px,`animationDelay: i*40ms` | 复用 `aoFadeRise` |
| A4 | **tab 计数脉冲** | `tool_call_done` 使某 tab 计数+1 | Badge scale 1→1.18→1 + accent 闪 | 新 `canvasCountPulse` |
| A5 | **HITL 挂起呼吸**(签名动画) | 挂起行常驻 | 慢呼吸 amber box-shadow(2.4s 循环,极轻) | 新 `hitlBreathe` |
| A6 | **grounded✓ 数字递增 + 勾弹** | 助手 `done` | "N 工具/M 行"数字 count-up(JS rAF)+ 勾 `ogCheckPop` | 复用 `ogCheckPop` + JS |
| A7 | **来源↔画布 ring 高亮** | 点 ◣来源 pill / 点画布卡 | 目标 scrollIntoView + 外环 expand+fade(700ms) | 新 `canvasRingPing` |
| A8 | **画布折叠/展开** | ⟨⟩ 按钮 | grid 列宽 + 中列 max-width transition(320ms) | CSS transition(非 keyframe) |
| A9 | **结论卡入场** | 助手首段渲染 | `aoPopIn`(scale 0.96→1 + fade) | 复用 `aoPopIn` |
| — | 消息入场/发送飞入/打字点/流光标 | 现有 | 保留 `chatMessageIn`/`chatSendFly`/`chatTypingDot`/`chatCursorBlink` | 不动 |

新 keyframes 一次性加进 globals.css 并登记进 reduced-motion 守卫(Task 1.2)。

---

## Chunk 0: Phase 0 — 数据与契约地基(TDD,无 UI)

> 这一块让 chat 真能拿到含 HITL 的确定性 timeline,是右侧画布的数据前提。多数项已在因果链 spec,这里落实现 + 测试。

### Task 0.1: 抽 `buildCorrelationTimeline`

**Files:** Create `lib/correlation/build-timeline.ts` + `lib/correlation/build-timeline.test.ts`;Modify `app/api/correlations/[traceId]/route.ts`

- [ ] **Step 1: 写失败测试** — 塞 AuditLog+EventInstance+WorkflowRun(+steps)+ 未完成 HumanTask 各若干(用现有测试 DB / mock prisma),断言 `buildCorrelationTimeline(traceId)` 返回:含 `source:"human_task"` 行、按 `ts` 升序、`totals` 四项计数正确、每行带 `idx`(1-based)+ `refId`。
- [ ] **Step 2: 跑测试确认 fail**(`buildCorrelationTimeline is not defined`)。Run: `npm test -- build-timeline`
- [ ] **Step 3: 实现** — 把 route.ts 第 46–208 行的 4 表 join+排序原样搬进 `build-timeline.ts` 导出 `buildCorrelationTimeline`,给每行加 `idx`;保留每表 try/catch 降级。
- [ ] **Step 4: route 改薄壳** — `const data = await buildCorrelationTimeline(traceId); return NextResponse.json({ ...data, meta:{ generatedAt } })`。
- [ ] **Step 5: 回归** — 加/跑 route 测试断言对外 JSON 结构不变(字段快照)。Run: `npm test -- correlations`
- [ ] **Step 6: 跑测试确认 pass + commit**(`git commit -- lib/correlation/build-timeline.ts lib/correlation/build-timeline.test.ts "app/api/correlations/[traceId]/route.ts" -m "feat(correlations): extract buildCorrelationTimeline (4-table join + idx)"`)

### Task 0.2: `getCorrelationTimeline` 工具 + 契约字段

**Files:** Modify `lib/chat/global-chat-tools.ts`、`lib/chat/types.ts`;Test `lib/chat/global-chat-tools.test.ts`

- [ ] **Step 1: 写失败测试** — 断言 `getCorrelationTimeline.execute({traceId})` 返回带 `idx` 行 + `human_task` 行,且 `sources` 含一条指向 `/correlations/<traceId>` 的来源(带 `traceId` 字段)。
- [ ] **Step 2: 跑确认 fail**。
- [ ] **Step 3: 实现** — `types.ts`:`ChatSource` 加 `anchor?: string`、`traceId?: string`;`PageContext` 加 `traceId?: string`。`global-chat-tools.ts`:加工具,execute 调 `buildCorrelationTimeline`,行带 `idx/refId/anchor`,`sources` 带 `traceId` + `/correlations/<id>` 链接 + 每行 anchor。
- [ ] **Step 4: 跑确认 pass + commit**。

### Task 0.3: system prompt 纪律 + page-context traceId

**Files:** Modify `lib/chat/global-chat-system-prompt.ts`、`lib/chat/page-context.ts`;Test `lib/chat/page-context.test.ts`

- [ ] **Step 1: 写失败测试** — `usePageContext`/解析函数在路由 `/correlations/abc` 下返回 `traceId:"abc"`;`buildSystemPrompt({route,traceId})` 含 trace scope 行。
- [ ] **Step 2–4:** 实现因果引用纪律 + "气泡只给结论+3要点(触发/当前/影响),数字/列表/实体进证据区"分工 + traceId scope 渲染;page-context `/correlations/<id>` 注入 traceId。跑 pass + commit。

### Task 0.4: /inbox `?task=` 预选 + LeftNav 降级

**Files:** Modify `app/inbox/page.tsx`、`components/shared/LeftNav.tsx`

- [ ] **Step 1:** 读 `app/inbox/page.tsx` 当前选中逻辑(默认 recent[0]);加 `useSearchParams` 读 `?task=<id>`,命中则预选该 HumanTask,否则保持原行为。包 `<Suspense>`(Next 要求)。
- [ ] **Step 2:** 移除 LeftNav 第 63 行 correlations 项(`/correlations` 路由保留,作深链)。
- [ ] **Step 3:** `npm run build` 过 typecheck;commit。

---

## Chunk 1: Phase 1 — 工作台壳 + 动画词汇 + 信任条(纯前端,零新后端)

> 立刻治毛病1(空洞)/2(像通用聊天)/5(空历史栏),不依赖 Phase 0 数据。

### Task 1.1: 抽 timeline-parts 共享模块

**Files:** Create `components/correlation/timeline-parts.tsx`;Modify `components/correlation/CorrelationContent.tsx`

- [ ] **Step 1:** 把 `Timeline`/`TimelineRow`/`sourcePalette`/`Counter`/`KindBadge`/`kindVariant` 从 CorrelationContent 移入 `timeline-parts.tsx` 并 `export`。
- [ ] **Step 2:** CorrelationContent 改为 `import { Timeline, Counter } from "./timeline-parts"`;删除本地副本。
- [ ] **Step 3:** `npm run build` 过 + 现有 correlations 测试仍绿;commit。

### Task 1.2: 动画 keyframes 进 globals.css

**Files:** Modify `app/globals.css`

- [ ] **Step 1:** 在 `ao*` 块后加 `canvasReveal`/`canvasCountPulse`/`hitlBreathe`/`canvasRingPing` keyframes + 对应 utility class（`.canvas-reveal`/`.canvas-count-pulse`/`.hitl-breathe`/`.canvas-ring-ping`），缓动 `cubic-bezier(0.22,1,0.36,1)`。
- [ ] **Step 2:** 把这四个 class 加进 `@media (prefers-reduced-motion: reduce)` 守卫(`animation: none`;hitlBreathe 退为静态 amber 边)。
- [ ] **Step 3:** `npm run build` 过;commit。

### Task 1.3: ChatWorkbench 三列骨架 + SessionRail

**Files:** Create `components/chat/ChatWorkbench.tsx`、`components/chat/SessionRail.tsx`;Modify `app/chat/page.tsx`、`components/chat/GlobalChatPanel.tsx`、`lib/i18n.tsx`

- [ ] **Step 1:** `ChatWorkbench` = `<div className="flex-1 grid min-h-0" style={{gridTemplateColumns: canvasOpen ? "232px 1fr 320px" : "232px 1fr"}}>`;列1 `SessionRail`,列2 `GlobalChatPanel scope="full"`,列3 `EvidenceCanvas`(Task 2 前先放占位空态)。grid 列宽过渡(A8)。
- [ ] **Step 2:** `SessionRail` = 现有 `HistoryList` + 顶部搜会话 input(bg-panel/border-line)+ 底部两个 `Metric`(本会话调了 N 工具 / 引用 M 处,数据先接 0,Phase 后接真值)。
- [ ] **Step 3:** `GlobalChatPanel` 的 `MessageRow` 去掉 `maxWidth:'82%'`(`components/chat/GlobalChatPanel.tsx:436`):画布开时填 1fr,画布关时中列 `max-w-[760px] mx-auto`。
- [ ] **Step 4:** `app/chat/page.tsx` 渲染 `ChatWorkbench`。i18n 加文案(zh+en)。
- [ ] **Step 5:** 验证 — `npm run dev`,打开 `http://localhost:3002/chat`,确认三列、空洞消失、窄屏 <1280px 画布默认折叠。commit。

### Task 1.4: GroundedBar(信任条,纯前端聚合 SSE)

**Files:** Create `components/chat/GroundedBar.tsx` + `components/chat/GroundedBar.test.tsx`;Modify `GlobalChatPanel.tsx`

- [ ] **Step 1: 写测试** — 给定一组 `tool_call_done` 事件(name+ms),`GroundedBar` 渲染"本轮 N 工具 · M 行 · 总 Xms · grounded✓",N=去重工具数。
- [ ] **Step 2:** 跑 fail。
- [ ] **Step 3:** 实现 — 从 panel 已聚合的 tool 调用状态算 N/M/ms;`StatusDot kind="ok"` + 数字 count-up(A6,rAF)+ `ogCheckPop` 勾;挂助手气泡顶。
- [ ] **Step 4:** 跑 pass;`npm run dev` 目视一次真实流式;commit。

### Task 1.5: 排障模板空态

**Files:** Modify `GlobalChatPanel.tsx`(EmptyState)、`lib/i18n.tsx`

- [ ] **Step 1:** EmptyState 的 suggestions 换成 4 张排障模板卡(为什么这条链卡住 / 这条事件去哪了 / 这个候选人的全链路 / DLQ 这条谁发的),复用现有 EmptyState + `Ic.sparkle` + `aoFadeRise` stagger。i18n zh+en。
- [ ] **Step 2:** 目视 + commit。

---

## Chunk 2: Phase 2 — 证据画布主体 + HITL 挂起行

### Task 2.1: use-evidence hook(独立拉确定性 timeline)

**Files:** Create `lib/chat/use-evidence.ts`

- [ ] **Step 1:** hook 输入 = 当前 session 的 messages/sources + pageContext;输出 = `{ traceId, timeline, totals, loading, error }`。逻辑:优先 `pageContext.traceId`,否则从最近一条助手消息的 `sources` 里取带 `traceId` 的来源;有 traceId 则 fetch `/api/correlations/[traceId]`(确定性,**不信 LLM 输出**);无则返回空态。带请求去抖 + 选中态缓存。
- [ ] **Step 2:** 简单单测(给 sources 含 traceId → 解析出该 id;无 → null)。pass + commit。

### Task 2.2: EvidenceCanvas + 因果链区

**Files:** Create `components/chat/EvidenceCanvas.tsx`;Modify `ChatWorkbench.tsx`

- [ ] **Step 1:** `EvidenceCanvas` = `bg-surface` 容器;CardHead 放当前 trace pill + 折叠 `⟨⟩`(A8)+ `[在/correlations开↗]` 深链;tab 行 `[因果链][实体N][运行N][审计N]`(Badge 计数,A4 脉冲)。
- [ ] **Step 2:** 因果链 tab 用 Task 1.1 的 `<Timeline>` + `<Counter>` 渲染 use-evidence 的数据(A3 行级联);顶部四色 totals。揭幕用 A1。
- [ ] **Step 3:** 空态/降级:无 traceId → "提问后,证据会在这里实时长出";有 traceId 拉取失败 → "本轮未关联到因果链"。
- [ ] **Step 4:** 接进 ChatWorkbench 列3;`npm run dev` 跑一条带 trace 的问答目视画布长出;commit。

### Task 2.3: HitlSuspendRow(签名焦点 + 只读深链)

**Files:** Create `components/chat/HitlSuspendRow.tsx`;Modify `timeline-parts.tsx`(TimelineRow 在 `source==="human_task"` 且未完成时委托渲染 HitlSuspendRow)

- [ ] **Step 1:** HitlSuspendRow = `bg-suspended/15` + `border-suspended` 框 + `StatusDot`(amber/paused 脉冲)+ 挂起时长 + assignee + HumanTask id;呼吸动画 A5(`.hitl-breathe`)。
- [ ] **Step 2:** 三动作全为只读深链 `Btn`:[去待办处理]→`Link /inbox?task={id}`、[改派]→`/inbox?task={id}`、[询问为何挂起]→回填输入框(纯 client,继续对话)。**无一调 POST**。
- [ ] **Step 3:** timeline-parts 的 TimelineRow 守卫:`human_task` 未完成 → 渲染 HitlSuspendRow,否则原样。确认这不影响 /correlations 页(同组件复用,视觉升级是想要的)。
- [ ] **Step 4:** `npm run dev` 构造一条挂在 HITL 的 trace 目视;commit。

---

## Chunk 3: Phase 3 — 实体/run/审计卡 + 结论卡分工

### Task 3.1: EvidenceCards 矩阵

**Files:** Modify `EvidenceCanvas.tsx`

- [ ] **Step 1:** 实体/运行/审计 tab 用 `Card`+`CardHead`+`StatusDot`+`.tbl` 渲染 use-evidence/sources 里的对象;每卡带深链 `Btn`(在 fleet 看 / 在 live 打开 / 筛此客户)。卡 stagger 入场 A2。
- [ ] **Step 2:** 目视 + commit。

### Task 3.2: VerdictCallout 结论卡渲染纪律

**Files:** Modify `GlobalChatPanel.tsx`(MessageRow)

- [ ] **Step 1:** 系统 prompt 已让助手产出"结论行 + • 触发/• 当前/• 影响"(Task 0.3)。前端 MessageRow 把首段结论行样式化:`Badge`(warn=挂起/err=失败/ok)+ 要点 `text-ink-2`;入场 A9(`aoPopIn`)。**不扩 SSE**,只按文本约定渲染;解析不到结构就回退现有 markdown(优雅降级)。
- [ ] **Step 2:** 目视真实回答 + commit。

---

## Chunk 4: Phase 4 — 来源↔画布联动 + KPI 条 + 可访问性验收

### Task 4.1: 双向 source↔canvas 高亮

**Files:** Modify `SourcePill`(GlobalChatPanel)、`EvidenceCanvas`、`timeline-parts`

- [ ] **Step 1:** 点气泡 ◣来源 pill → 用 `anchor`(Task 0.2 加的字段)找右侧对应 timeline 行/卡 → `scrollIntoView` + `.canvas-ring-ping`(A7);反向点画布行 → 高亮气泡里对应 pill。
- [ ] **Step 2:** 目视 + commit。

### Task 4.2: KPI 条(可选打磨)

**Files:** Modify `ChatWorkbench.tsx`、`lib/i18n.tsx`

- [ ] **Step 1:** sub-header 下跨三列 `Metric`+`Spark`:[待人工节点 N ▁▃▂▅▇][近1h 失败链 N][钉住实体 N][●LLM 网关在线];读现成 `/api/human-tasks`?+`/api/runs`+`/api/system/config`。
- [ ] **Step 2:** 目视 + commit。

### Task 4.3: 可访问性 + 窄屏验收

- [ ] **Step 1:** 系统开"减弱动态效果",确认所有 A1–A9 退为即时态(无动画/无呼吸),功能不变。
- [ ] **Step 2:** 窗口 <1280px → 画布默认折叠为对话单列;>1280 → 三列。明暗主题各扫一遍颜色(全走 token)。
- [ ] **Step 3:** `npm run build` 全绿(typecheck+lint);最终 commit。

---

## 验收标准

- /chat 不再有右侧空洞;三列像 fleet/datasources 同族页。
- 问"为什么卡住"→ 右侧长出确定性因果链 timeline,HITL 挂起行被 amber 框 + 呼吸 + 三只读深链。
- grounded✓ 条显示真实工具数/行数;来源 pill 点击高亮画布对应行。
- 全部动画在 reduced-motion 下优雅退化;明暗主题无硬编码色。
- /chat 内零写操作(HITL 动作只深链 /inbox);/api/correlations JSON 契约不变。
