# 全局追踪 Chatbot 设计 spec

**日期**:2026-05-21
**作者**:Steven · Claude
**范围**:跨 agent / 跨 run / 跨事件的自然语言追踪助手 —— 用户问"X 发生了什么 / 为什么没匹配 / 这条候选人走到哪一步了",chatbot 调只读 tool 查实数据回答。
**Out of scope**:Rule Check UI / DLQ / 拓扑节点(见姐妹 spec [2026-05-21-rule-check-ontology-and-monitor-polish-design.md](./2026-05-21-rule-check-ontology-and-monitor-polish-design.md))。任何写操作(replay / cancel / 改配置 …)— 都是 Manage 轴。
**三轴定位**:Monitor 轴 —— 提供"理解发生了什么"的对话面;不替代现有 dashboard,是补充。

---

## 0. 与现有 chat 端点的关系

| 端点 | 范围 | 入口 |
|---|---|---|
| `POST /api/agents/[short]/chat` | 单 agent 的 cross-run 问询 | `/workflow` Inspector 抽屉 [components/workflow/AgentChatbot.tsx](../../components/workflow/AgentChatbot.tsx) |
| `POST /api/runs/[id]/chat` | 单 run 的内部步骤问询 | run 详情页 RunChatbot |
| **`POST /api/chat/trace`(本 spec 新加)** | **跨 agent / 跨 run / 跨事件 / 跨实体** | 全局浮窗 + `/chat` 全屏页 |

三者**共享同一 LLM gateway + tool-loop 框架**(`server/llm/gateway.ts` + `MAX_TOOL_TURNS=4` + prompt cache),区别只在 system prompt 和注册 tool 集。

---

## 1. 用户问题样本(驱动 tool set 设计)

| 用户问 | LLM 该走的 tool 链 |
|---|---|
| "字节跳动最近 24h 有几条候选人被 rule 拦了?" | `searchAudits({client:'字节跳动', since:-24h, decision:'FAIL'})` → 给数字 + 列前 5 条 |
| "candidate XXX 走到哪一步了?" | `getEventChain({candidateId:'XXX'})` → 时间线 |
| "为什么 JR-cb932... 没出 RuleCheck PASS?" | `searchEvents({name:'MATCH_RULE_CHECK_*', jrId:'cb932...'})` → 找最新 audit → `searchAudits({jrId})` → 显示 fail 的 rule_id + 摘要 |
| "JDGenerator 最近哪些 run 失败了 RAAS 相关?" | `searchRuns({agent:'JDGenerator', status:'Failed'})` → 各 run `getRunDetail` 找 `error` 提 `raas` 关键字 |
| "DLQ 现在有多少条?能列出来吗?" | `searchDLQ()` |
| "ReqAnalyzer 这周 token 用了多少?" | `searchRuns({agent:'ReqAnalyzer', since:-7d})` → aggregate tokenUsage(tool 内部聚合) |
| "Rule R-005 在过去 30 天命中过吗?在哪几次审计?" | `searchAudits({ruleId:'R-005', since:-30d, includeAllResults:true})` |

**反例(明确不支持)**:
- "帮我重发那条失败的事件" → 拒答 + 指引到 Manage 轴入口(目前不存在,提示"暂未开放")。
- "把这个 rule 改成 severity=warn" → 同上。
- "写一段 Cypher 帮我查 …" → 默认拒;`AO_CHAT_RAW_CYPHER=1` 时切到调试模式(见 §5)。

---

## 2. 信息架构

### 2.1 两个 surface,一套实现

| Surface | 位置 | 形态 | 用途 |
|---|---|---|---|
| **Floating bubble** | `Shell` 右下角(所有 AO 页面) | 56px 圆形按钮 → 点击展开 480×620 抽屉 | "我正在看 X 顺手问一句" |
| **`/chat` 全屏页** | LeftNav `运营` 组,排 `Monitor` 之后 | 全屏 + 左侧历史会话 + 主对话区 | "我要查一晚上事故" |

**共享**:
- 一个 React hook `useGlobalChat()` 负责 history / send / streaming;
- 一个 localStorage key `ao:global-chat:v1`,**多会话**(historyList: [{id, title, messages[]}]);
- 浮窗 = `useGlobalChat()` + 480×620 容器;`/chat` = `useGlobalChat()` + 全屏布局 + 历史列表。

### 2.2 不重做的部分

- `AgentChatbot`(workflow Inspector 里的)和 `RunChatbot`(run 详情里的)**保留**。它们的 scoped 上下文是真有价值的差异化。本 spec 只新增"全局"那一个。

### 2.3 上下文自动注入

打开浮窗时,**根据当前页面自动 prefix 一段 context**(LLM system prompt 里):

| 当前路由 | 注入 |
|---|---|
| `/monitor?run=R-123` | `用户正在看 run R-123` |
| `/rule-check?view=audits&auditId=A-789` | `用户正在看 rule-check audit A-789` |
| `/entities/candidate/C-456` | `用户正在看 candidate C-456` |
| `/workflow` 选中 jdGenerator | `用户在 workflow 编辑器,关注 JDGenerator` |
| 其他 | 无注入 |

这让浮窗自然变成"问我这个" —— 不用用户复制 ID。

---

## 3. 数据契约 — `POST /api/chat/trace`

### Request

```ts
{
  messages: Array<{ role: 'user' | 'assistant', content: string }>;
  pageContext?: {
    route: string;
    runId?: string;
    auditId?: string;
    entityType?: string;
    entityId?: string;
    agentShort?: string;
  };
}
```

### Response(沿用现有 chat shape)

```ts
{
  reply: { role: 'assistant', content: string };
  sources: Array<{ tool: string; label: string; ref?: string }>;
  modelUsed?: string;
  toolCallsExecuted?: number;
}
```

错误形态与 `AgentChatResponse` 一致:`{ error, message }` + non-200。

### 流式 vs 一发

**v1 = 一发返回**(与现有两个 chat 端点一致)。流式留作 v2 优化,YAGNI。

---

## 4. Tool 层(只读)

**核心设计原则**:不让 LLM 写裸 Cypher/SQL。原因 ——
1. **正确性**:schema 漂移(尤其 Neo4j ontology 还在演化)会让 LLM 拿到 stale 知识时写错;
2. **安全**:即便 read-only session 也可能 OOM 一个大查询;
3. **可演进**:tool 形态稳定,内部实现可以静默切 Neo4j → Postgres 缓存;
4. **可观察**:tool 调用是结构化的,前端能渲染 Source badge → 跳页。

下面 7 个 tool 是 v1 全集。每个都有清晰的输入边界 + 结果上限。

### 4.1 `searchRuns`

```ts
input: {
  agent?: string;        // canonical short, e.g. 'JDGenerator'
  status?: 'Running' | 'Completed' | 'Failed' | 'Cancelled';
  since?: string;        // ISO 或相对 '-24h' / '-7d'
  eventName?: string;    // trigger event name
  limit?: number;        // default 20, max 50
}
output: {
  runs: Array<{
    id: string; agent: string; status: string;
    startedAt: string; durationMs?: number;
    eventName?: string;
    error?: string;      // 只在 Failed 时
  }>;
  total: number;         // 满足条件的总数(可能 > runs.length)
}
```

后端命中 `prisma.workflowRun.findMany`(已存在的表)。

### 4.2 `getRunDetail`

```ts
input: { runId: string }
output: {
  run: { ...同上 };
  steps: Array<{ idx: number; name: string; status: string; durationMs?: number; error?: string }>;
  episodes: Array<{ stepIdx: number; modelUsed: string; tokenUsage: { prompt, completion, total }; duration: number }>;
  events: { received: string[]; emitted: string[] };  // 事件名 + 时间戳
}
```

后端命中 `WorkflowRun + WorkflowStep + AgentEpisode`。

### 4.3 `searchEvents`

```ts
input: {
  name?: string;          // event name(支持 * 通配,例 'MATCH_*')
  since?: string;
  limit?: number;         // default 30, max 100
  payloadContains?: { jrId?: string; candidateId?: string; clientId?: string };
}
output: {
  events: Array<{ id: string; name: string; emittedAt: string; payloadSnippet: object }>;
  total: number;
}
```

后端命中 `EventInstance`(由 `em.publish()` 写入)。`payloadSnippet` 截前 1KB。

### 4.4 `searchAudits`

```ts
input: {
  decision?: 'PASS' | 'FAIL';
  ruleId?: string;        // 命中某条具体 rule 的所有 audit
  ruleResultFilter?: 'FAIL' | 'PASS' | 'NOT_APPLICABLE' | 'INSUFFICIENT_INFO';
  client?: string;
  jrId?: string;
  candidateId?: string;
  since?: string;
  limit?: number;         // default 20, max 50
}
output: {
  audits: Array<{
    audit_id: string; decision: string;
    created_at: string; client_name: string;
    job_requisition_id: string; candidate_id: string;
    n_flags: number; rules_evaluated: number;
    failure_reasons?: string[];
  }>;
  total: number;
}
```

后端命中 `RuleCheckAudit`(Postgres + Neo4j)。

### 4.5 `searchEntities`

```ts
input: {
  type: 'candidate' | 'jd' | 'requisition' | 'client';
  q: string;             // free-text query — 命中 name / id / 别名
  limit?: number;        // default 10, max 30
}
output: {
  entities: Array<{ id: string; type: string; displayName: string; url: string }>;
  total: number;
}
```

后端命中 Neo4j `:7688` ontology(用现有 `lib/allmeta-client.ts` 或类似 reader)。

### 4.6 `searchDLQ`

```ts
input: { since?: string; limit?: number }   // default 20
output: {
  items: Array<{ id: string; function: string; status: string; startedAt: string; eventName?: string }>;
  total: number;
}
```

后端命中 `/api/inngest-admin/dlq`(reuse,不直连 Inngest)。

### 4.7 `getEventChain`

最复杂的一个 —— 给定一个起点(候选人 / JR / upload_id / event_id),把整条因果链拉出来。

```ts
input: {
  anchor: { type: 'candidate' | 'jrId' | 'uploadId' | 'eventId'; value: string };
  windowHours?: number;   // default 24
}
output: {
  chain: Array<{
    timestamp: string;
    kind: 'event' | 'run' | 'audit';
    name: string;
    summary: string;
    refId: string;        // 跳进对应详情用
    url: string;          // 前端 sources 用
  }>;
  // 按时间排序,首条是 anchor,后面是它衍生出的所有 event/run/audit
}
```

后端命中 `lib/em-bridge.ts`(已经有"按 upload_id 串链"的能力 — 复用)。

### 4.8 调试逃生口 `runReadOnlyCypher`(可选,默认关闭)

```ts
input: { cypher: string }   // 必须 read-only;白名单仅 MATCH/OPTIONAL MATCH/WITH/RETURN/UNWIND/LIMIT/SKIP/ORDER BY
output: { rows: object[]; meta: { rowCount: number; truncated: boolean } }
```

**仅当 `AO_CHAT_RAW_CYPHER=1` 启用**。LLM system prompt 会被告知"该 tool 在这个环境可用",同时强制要求"先用结构化 tool,做不到再用这个"。生产关。

### 4.9 不做的 tool(明确)

- 任何写工具(`replayEvent`, `cancelRun`, `updateRule`, ...) —— Manage 轴
- `executePython` / `executeJS` 沙箱 —— 不需要
- `searchSlack` / `emailUser` —— 不是 monitoring scope
- `searchInbox`(HITL)—— v2,如果用户反馈频繁问起再加

---

## 5. LLM 配置

| 项 | 值 |
|---|---|
| Gateway | `pickGateway()` 复用 |
| 模型默认 | gateway 配置(目前 `google/gemini-3-flash-preview` per 截图,与 rule-check 同) |
| `MAX_TOOL_TURNS` | 4 |
| `MAX_TOOL_RESULT_BYTES` | 16_000(略大于 agent chat 的 12k,因为 tracing 单个 tool 结果可能更长) |
| Prompt caching | system + tool definitions 走 cache |
| 历史保留 | client 端 30 条 / 会话;server 不存 |
| 多会话 | 客户端 localStorage `ao:global-chat:v1`(`historyList: [{id, title, createdAt, messages}]`) |

### System prompt 骨架

```
你是 Agentic Operator 的全局追踪助手。你能查询的范围:
- 所有 Inngest function 的 run 记录(WorkflowRun + WorkflowStep + AgentEpisode)
- 所有事件(EventInstance,由 em.publish 写入)
- 所有 Rule Check audit(RuleCheckAudit,Postgres + Neo4j)
- 所有 ontology 实体(Candidate / JD / Requisition / Client,Neo4j :7688)
- DLQ(Inngest admin)
- 跨 agent 的事件因果链(em-bridge upload_id 关联)

硬约束:
- **任何关于 ID / 数字 / 时间戳 / 状态的事实必须经过工具查询。** 禁止从对话历史 / 训练知识编造。
- 这是只读端点。用户问"如何 replay / cancel / 改",答"目前未开放,建议去 /monitor 手动操作"或"等 Manage 轴上线"。
- 用户提到的 ID(run id / audit id / candidate id / event name)优先以工具查询验证存在;不存在直接说明。
- 回答带 markdown link:run 用 [R-xxx](/monitor?run=R-xxx),audit 用 [A-xxx](/rule-check?view=audits&auditId=A-xxx),candidate 用 [候选人名](/entities/candidate/X)。

回答风格:
- 第一句结论,后面才是证据。
- 数字 / 时间 / agent 名加粗;ID / 事件名 / 状态用反引号。
- 默认 ≤10 行,问"详细" / "展开"再展开。
- 跟随用户语言(中文进 → 中文出,英文进 → 英文出)。

当前页面上下文:{ pageContext 注入,如 "用户正在看 run R-123" }

可用工具:
{ tool schemas — 自动来自 OpenAI tools 定义 }
```

---

## 6. UI 细节

### 6.1 Floating bubble

```
位置:fixed bottom-6 right-6,z-index 50
形态:56px 圆形,bg-accent,白色 icon(Ic.chat)
打开后:
  - 480 × 620 抽屉,vertically 钉在右下
  - 顶部:页面 context badge(例 "正在看 run R-123")+ "新会话" + "×"
  - 中部:消息流(同现有 ChatMessage bubble 样式)
  - 底部:input + send + 历史会话切换
```

### 6.2 `/chat` 全屏页

```
布局:
┌─────────────────────────────────────────────────┐
│ Shell AppBar                                    │
├──────────┬──────────────────────────────────────┤
│ 历史    │  消息流                              │
│ 列表    │  ...                                  │
│         │                                       │
│ (220px) │                                       │
│         ├──────────────────────────────────────┤
│         │  input                                │
└──────────┴──────────────────────────────────────┘
```

- LeftNav 加入口:`运营` 组 → `追踪助手`(i18n key `nav_trace_chat`),icon `chat`,排 `Monitor` 之后。
- 历史列表:每个会话一个标题(由 LLM 第一条 reply 自动起,降级为时间戳)。可重命名 / 删除。

### 6.3 Source 渲染

每条 assistant 回答下方,展示 `sources: AgentChatSource[]` 数组:每个变成可点击 Badge,点击跳对应详情页(参 `AgentChatbot.tsx:256-264`)。

例:用户问 "candidate XXX 走到哪步了" → reply 下方有
```
[Badge: getEventChain · upload_id=u-abc] [Badge: searchAudits · A-789 →]
```

---

## 7. 安全 / 边界

| 风险 | 应对 |
|---|---|
| LLM 编造 ID | system prompt 硬约束 + 工具调用必须 + 结果带回 source |
| 一次问询打爆 DB | 每个 tool 有 `limit` 上限;后端 cap 二次校验 |
| 用户问敏感字段(简历手机号) | tool 返回 `payloadSnippet` / 隐藏 PII;v1 不做 redaction,信任内部用户 |
| 跨 client 数据越权 | v1 不做;AO 当前所有用户视为 admin。下游 Manage 轴会做 RBAC,本 spec 先不耦合 |
| 注入(用户输入里塞 prompt) | OpenAI tool-calling 模式天然抗 prompt injection(用户消息走 user role,无法越权改 system) |
| 模型 hallucinate 不存在的 tool | LLM SDK 强制按 schema 调,name mismatch 直接 fail-loop |
| Raw Cypher 滥用 | 默认关闭 + 白名单关键字校验 + read-only session |

---

## 8. 文件清单

### 新建
```
app/chat/page.tsx                                    # 全屏页
app/chat/layout.tsx                                  # 可选
app/api/chat/trace/route.ts                          # POST 端点
lib/chat/global-chat-tools.ts                        # 7+1 个 tool 定义 + 实现
lib/chat/global-chat-system-prompt.ts                # system prompt 生成
lib/chat/use-global-chat.ts                          # React hook + localStorage
components/chat/GlobalChatBubble.tsx                  # 浮窗组件
components/chat/GlobalChatPanel.tsx                   # 抽屉/全屏共用主体
components/chat/HistoryList.tsx                       # /chat 页历史侧栏
```

### 改动
```
components/shared/Shell.tsx                           # 挂浮窗
components/shared/LeftNav.tsx                         # 加 /chat 入口
lib/i18n.tsx                                          # nav_trace_chat + 内部文案
server/llm/gateway.ts                                 # 无改;只复用
```

### 不改
- `/api/agents/[short]/chat`, `/api/runs/[id]/chat` 及其前端
- 现有 Neo4j / Postgres reader

---

## 9. 时间表

| Phase | 范围 | 估时 |
|---|---|---|
| γ1 | tool 层 7 个 tool + 测试 | 1.5d |
| γ2 | `/api/chat/trace` + system prompt + LLM loop | 0.5d |
| γ3 | `useGlobalChat` hook + localStorage 多会话 | 0.5d |
| γ4 | `GlobalChatBubble` + Shell 集成 + pageContext 注入 | 0.5d |
| γ5 | `/chat` 全屏页 + 历史侧栏 | 0.5d |
| γ6 | i18n + 视觉收尾 + 测试 | 0.5d |

合计 **~4 天**。

---

## 10. 验收 / 测试

### Tool 单元测试(`lib/chat/global-chat-tools.test.ts`)
- 每个 tool 一组 happy path + 边界(`limit` 截断 / 不存在 ID / 时间窗解析)
- mock Prisma + mock Neo4j driver

### 端点测试(`app/api/chat/trace/route.test.ts`)
- mock OpenAI gateway → 强制返回 tool_call → 验证 tool dispatch
- 错误路径:LLM 返回不存在的 tool name → 报 fail-loop

### 手动 E2E
1. 浮窗:打开 `/monitor?run=R-123`,展开浮窗 → 顶部能看到 `正在看 run R-123` badge;问 "这个 run 失败原因?" → reply 引用 `getRunDetail · R-123`,带 source badge 可点。
2. `/chat`:输入 "字节跳动最近 24h 几条 fail?" → reply 给数字 + 列出前 5 条 audit 链接;点链接跳 `/rule-check?view=audits&auditId=...`。
3. 多会话:`/chat` 新建第二会话,切换不丢内容,清空浏览器后丢失(localStorage 行为)。
4. 关闭 `OPENAI_API_KEY`:浮窗输入框 placeholder 改 `LLM 未配置`,禁用 send;不报红。
5. `AO_CHAT_RAW_CYPHER=1`:问 "用 Cypher 列 ontology 里所有 Rule" → reply 真的写了 read-only Cypher 并执行,sources 里有 `runReadOnlyCypher`;关掉环境变量重启,同问题 reply 改用 `/api/ontology/rules` 路径(或拒答 cypher)。

---

## 11. Out of scope

- **流式响应**(token-by-token 渲染) — v2
- **写操作**(Manage 轴所有内容)
- **多用户协作**(共享会话 / @ 同事) — 内部工具,先不上
- **会话持久化**(server-side 存储) — v1 仅 localStorage,够用
- **可视化输出**(chart / timeline) — v1 仅 markdown + source badge;v2 看反馈
- **跨语言混合**(同一会话切中英) — 跟随单条消息语言,不强制一致
- **PII redaction** — 内部工具,信任用户
- **RBAC** — Manage 轴会带,本 spec 不做
- **Slack / Email 集成** — 不在 scope
