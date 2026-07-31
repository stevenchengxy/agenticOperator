# Rule Check — 完整设计文档

> 作者: ChenYang
> 范围: matchResume Action 的规则评估能力，从底层 lib 到 SSE 流式 API 到 `/rule-check` 评估 UI 的完整链路。
> 当前分支: `create-action-prompt`
> 状态: 已落地并跑通（14 个 fixture scenarios 端到端通过 Gemini 模型评估，结果通过 SSE 流式回显并落入 sqlite）。

---

## 1. 目标与范围

### 1.1 一句话目标

把 `matchResume` Action 中的"是否给候选人继续往下推送"决策从硬编码 if-else 改成: **从 Ontology 拉取自然语言 rule → 用 LLM 按 Set 顺序逐条评估 → 在 UI 中可视化"为什么 Block / 为什么 Pass"**。

### 1.2 谁会用

| 角色 | 怎么用 |
|---|---|
| matchResumeAgent（生产路径） | 在调 RAAS `/match-resume` 前，调一次 `runRuleCheck(input)`，根据 `decision in {PASS, FAIL, REVIEW}` 决定是否继续推送、是否走 HSM 人工确认。 |
| 招聘业务方 / HSM | 打开 `/rule-check` 评估页，手工触发 14 个 scenario 的批量评估，看矩阵、看 drill-down，验证"prompt 是否还 work"。 |
| 其他 Agent（未来 dual-reader） | 通过 `GET /api/rule-check/runs/{id}` 拿到结构化 JSON，作为决策上下文消费同一份数据。 |

### 1.3 不做什么（明确的非目标）

- **不做生产闸门**: rule-check 是预筛 LLM 评判，不替代 Robohire 的深度打分。
- **不做打分**: LLM 只输出 `pass / fail / pending / insufficient_info / not_triggered / not_executed` 六态，不输出数值分。
- **不做 prompt 编辑器**: prompt 的 source-of-truth 是 `lib/rule-check/prompt.ts`，不在 UI 上改。
- **不做 version diff**: 这一版只支持"换 model 并排对比"，不支持"同 model 不同 prompt 版本 diff"。
- **不做认证授权**: `/rule-check` 是内部评估页，没有 auth gating。

---

## 2. 整体架构

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Browser (/rule-check)                                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ TopBar │ MetricsStrip │ ConfusionStrip │ ScenarioMatrix │ CaseDrawer│  │
│  └────────────────────────┬────────────────────────────────────────────┘  │
└───────────────────────────┼────────────────────────────────────────────────┘
                            │  SSE / fetch
                            ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Next.js Route Handlers — app/api/rule-check/                                │
│  GET /scenarios · GET /runs · POST /runs (SSE) · GET /runs/[id]            │
│  POST /runs/[id]/replay/[sid] · GET /config                                │
└───────────────────────────┬────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ server/rule-check/                                                          │
│  streamRuleCheckRun()  ── 逐个 scenario 调 runRuleCheck，发 SSE 事件，落库  │
│  classifyMatch()       ── 把 (expected, actual) 折叠成 match_kind          │
│  scenarios-loader.ts   ── 从 fixtures.ts 加载 14 个 scenario               │
└───────────────────────────┬────────────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ lib/rule-check/  (核心库 — 可被任何 server-side caller 直接 import)         │
│                                                                             │
│  runRuleCheck(input, opts)                                                 │
│    ① fetchRulesForMatchResume() → 从 Ontology 拉 Rule + ActionStep 节点    │
│    ② applyClientFilter(rules, dims) → 按 client_id 过滤                    │
│    ③ buildGraphContext({candidate_id, jr_id}) → 预拉 6 个 slot             │
│    ④ composeMatchResumePrompt({input, graph, steps}) → 拼 user prompt      │
│    ⑤ chatComplete({tools: …}) → LLM 评估 (含 tool-use loop)                │
│    ⑥ coerceRuleResults() + foldDecision() → 重算 stats + decision          │
│    ⑦ ruleCheckLog.* → 写 lib/rule-check/logs/YYYY-MM-DD.log               │
│                                                                             │
│  evidence/                                                                  │
│    buildInferenceChain(graph, rule, ruleResult) → 推理链 (graph_node →     │
│    computation → rule_logic → verdict)，UI 直接渲染                         │
└──────┬────────────────┬──────────────────────┬─────────────────────────────┘
       │                │                      │
       ▼                ▼                      ▼
   Ontology API     LLM Gateway              Neo4j
  (objects /         (OpenAI 协议           (graph slots:
   instances /        AI_BASE_URL +          Candidate / Resume /
   instance-links)    AI_API_KEY)            JD / Application /
                                             Blacklist / Employment)
```

---

## 3. 核心调用流程（runRuleCheck 内部）

一次 rule-check 调用的完整数据流:

```
input { runtime_context, job_requisition }
   │
   ▼
[1] extractDims(input.job_requisition)
   └── 推出 client_id / business_group / studio 三个维度
   │
   ▼
[2] fetchRulesForMatchResume()
   └── 从 ONTOLOGY_API_BASE 拉 ActionStep + Rule 节点 (有 fallback 到本地 JSON)
   │   → sourceResult = { rules: Rule[], steps: MatchResumeStepGroup[], source }
   ▼
[3] applyClientFilter(rules, dims)
   └── 按 client_id 过滤掉客户不适用的 rule
   │   → filteredSteps (按 Set 顺序排好)
   ▼
[4] buildGraphContext({ candidate_id, job_requisition_id })
   └── 一次性预拉 6 个 slot (并发 HTTP):
   │     candidate / resume / job_requisition / applications /
   │     blacklist_hits / employment_links
   │   后续的 LLM tool_calls 也走同一个 cache，命中不再回源
   ▼
[5] composeMatchResumePrompt({input, graph, steps})
   └── 拼 Markdown prompt: §1 Role → §2 Inputs → §3 Graph context →
   │   §4 Rules (按 Set 顺序，每个 rule 带 markdown 原文) → §5 Decision fold
   │   → §6 Output schema (compact: 只要 rule_id+status+reason?) → §7 自检
   ▼
[6] chatComplete({ system, user, tools, maxTokens: 16000, model? })
   └── 调 LLM (gateway 自动按 model 选 temperature / extra_body)
   │   支持 tool-use loop (get_instance / list_instances / list_links)
   │   → { text, finishReason, durationMs, usage, modelUsed }
   ▼
[7] parseLlmJson() + coerceRuleResults(parsed, filteredSteps)
   └── 去 markdown 围栏 → JSON.parse → 严格校验
   │   注意: rule_name / step_id 在 runner 端从 filteredSteps 查表回填 (不依赖 LLM 输出)
   │   长度对不上 (LLM 漏了 rule) → 走 parse-error fail-safe
   ▼
[8] statsFromResults + deriveExplanations + foldDecision
   └── 重算 stats / explanations / decision (LLM 自己的 stats / decision 一概忽略)
   ▼
[9] ruleCheckLog.info('runRuleCheck.done', …)
   └── 追加一行 JSON 到 lib/rule-check/logs/YYYY-MM-DD.log
   ▼
return MatchResumeCheckResult {
  decision, stats, rule_results, explanations,
  graph_context,   // ← UI 用来画 graph view + 推 inference chain
  audit { llm_*, graph_calls, fail_reason?, raw_llm_text? },
}
```

**关键不变量**:
- LLM 输出的 `decision` 和 `stats` 永远被 runner 重算覆盖 — 防止 LLM 在汇总环节"自由发挥"。
- 每条 rule 必须在 `rule_results` 中有对应条目（按 Set 顺序、Set 内顺序）。少一条 → parse-error fail-safe，整次结果作废。
- 失败 in-band: 任何错误（Ontology 401、LLM 超时、JSON 解析失败、tool 循环超限）都返回 `decision='FAIL'` + `audit.fail_reason='…'` 的 fail-safe 结果，**不抛异常**。

---

## 4. 目录与文件清单

下面是这个能力涉及到的全部代码与文档（不含 node_modules）。每个文件用一行注明职责。

### 4.1 `lib/rule-check/` — 核心库（与 UI 解耦，可被任何 server 调用）

```
lib/rule-check/
├── index.ts                    # 公共导出: { buildRuleCheckInput, runRuleCheck, types }
├── runner.ts                   # ★ runRuleCheck() 主编排函数（约 410 行）
├── types.ts                    # RuleStatus / RuleResult / MatchResumeCheckResult / RuleCheckInput
├── prompt.ts                   # composeMatchResumePrompt + MATCH_RESUME_SYSTEM_PROMPT
├── prompt.test.ts
├── ontology.ts                 # extractDims (从 JR 推 client_id 等) + applyClientFilter
├── ontology-source.ts          # fetchRulesForMatchResume — 从 Ontology API 拉 Rule + ActionStep
├── ontology-source.test.ts
├── graph-context.ts            # buildGraphContext — 6-slot 预拉 + 内存 cache + tool dispatcher
├── graph-context.test.ts
├── instance-client.ts          # getInstance / listInstances / listLinks — Ontology HTTP 层
├── instance-client.test.ts
├── resume-projection.ts        # 简历字段投影 (用于 prompt 的 §2.5 简历摘要)
├── resume-projection.test.ts
├── runner.test.ts              # ★ runner 的 mock-LLM + mock-graph 测试 (13 cases)
├── log.ts                      # ruleCheckLog — 异步 fire-and-forget JSON-lines logger
├── evidence/                   # 推理链 (Inference Chain) 提取器
│   ├── types.ts                #   InferenceStep / InferenceChain / NodeKind / ExtractorFn
│   ├── index.ts                #   buildInferenceChain + registry + fallback + 9 个注册
│   ├── index.test.ts           #   13 cases 覆盖 fallback + 9 个 extractor
│   ├── _date-utils.ts          #   monthsDiffYM / yearsBetween / asArray (neo4j JSON-string 兼容)
│   ├── rule-10-5.ts            #   学历硬性要求 (candidate.highest_acquired_degree vs jd.degree_requirement)
│   ├── rule-10-9.ts            #   空窗期 > 3 月
│   ├── rule-10-10.ts           #   空窗期 > 1 年
│   ├── rule-10-17.ts           #   通用黑名单 — 高风险回流
│   ├── rule-10-21.ts           #   年龄超限
│   ├── rule-10-25.ts           #   华为 / 荣耀 冷冻期
│   ├── rule-10-26.ts           #   OPPO / 小米 冷冻期
│   ├── rule-10-27.ts           #   亲属回避
│   └── rule-10-32.ts           #   岗位冷冻期 (同 JR 的历史投递)
└── logs/                       # 运行日志 (gitignored)
    ├── .gitignore              #   *.log
    └── YYYY-MM-DD.log          #   每天一个，自动追加
```

### 4.2 `server/rule-check/` — 服务编排层（依赖 Prisma、依赖 fixtures，不在 lib 里）

```
server/rule-check/
├── runs-service.ts             # ★ streamRuleCheckRun — async generator 发 SSE 事件 + 落库
├── runs-service.test.ts        #   3 cases: 正常流 / 异常 / abort
├── match-classifier.ts         # classifyMatch — (expected, actual) → match_kind + failures[]
├── match-classifier.test.ts    #   6 cases 覆盖六种 match_kind
├── scenarios-loader.ts         # 从 scripts/rule-check-test-suite/fixtures.ts 重导出
└── scenarios-loader.test.ts    #   3 cases
```

### 4.3 `app/api/rule-check/` — Next.js API 路由

```
app/api/rule-check/
├── scenarios/route.ts                          # GET — 返回 14 个 scenario + expected
├── runs/route.ts                               # GET (list / latest=1) + POST (SSE 流)
├── runs/[run_id]/route.ts                      # GET — 单次 run 详情
├── runs/[run_id]/replay/[scenario_id]/route.ts # POST — 单 scenario 重跑，覆盖原行
└── config/route.ts                             # GET — { neo4j_browser_base } (从 env 暴露)
```

### 4.4 `app/rule-check/` + `components/rule-check/` — UI

```
app/rule-check/
└── page.tsx                    # 薄壳: <Shell crumbs=[…]><RuleCheckContent/></Shell>

components/rule-check/
├── RuleCheckContent.tsx        # ★ 页面顶层 state + SSE 消费 + 所有子组件编排
├── use-run-stream.ts           # useRunStream hook — POST /runs 流式读取 → state 更新
├── TopBar.tsx                  # Run All / Replay Failed / Export + Model/Client/Run/Compare 4 个 select
├── MetricsStrip.tsx            # 真指标条: ✓N/14 · AvgXs · Σt out/in · cap-hits · parse-errors
├── RuleConfusionStrip.tsx      # 每条 rule 的 TP/TN/FP/FN 计数 chip — 点击过滤矩阵列
├── ScenarioMatrix.tsx          # ★ 主矩阵 (rows=scenarios × cols=rules) — 按 actual status 着色
├── CaseDrawer.tsx              # 右侧 60% 抽屉 — header + per-rule 列表 + 推理链 + Graph view
├── InferenceChainView.tsx      # 把 InferenceStep[] 渲染成带颜色徽章的有序列表
├── GraphView.tsx               # 静态 SVG (6-slot 手工布局) + 点击 node → 内联展开真实 JSON
├── bucketing.ts                # bucketCell(expected, actual) → TP/TN/FP/FN/excluded
├── bucketing.test.ts           #   16 cases
├── neo4j-jump.ts               # buildNeo4jBrowserUrl(base, kind, id) — ?cmd=edit&arg=… 深链
└── neo4j-jump.test.ts          #   8 cases (含 cypher 注入防御)
```

### 4.5 `prisma/` — 持久化

```
prisma/
└── schema.prisma               # +2 个 model (RuleCheckRun, RuleCheckScenarioResult)
                                # 见 §7。
```

### 4.6 `scripts/` — 测试套件 + 种子数据 + CLI 入口

```
scripts/
├── rule-check-test-suite/
│   └── fixtures.ts             # ★ 14 个 scenario 定义 (S01..S14) + 共享 JD + LINK_SPECS
├── seed-rule-check-fixtures.ts # 把 fixtures.ts 写入 Ontology API (→ neo4j)
├── run-rule-check-test-suite.ts # CLI 跑 14 个 scenario，输出 data/rule-check-test-report.md
└── run-match-resume-rule-check.ts # 单次手动调试入口
```

### 4.7 `__tests__/` — 跨模块测试

```
__tests__/
└── prisma/
    └── rule-check.test.ts      # Prisma model 持久化测试 (2 cases)
```

### 4.8 `docs/` — 文档

```
docs/
├── RULE_CHECK_DESIGN_DOC_chenyang.md       # ← 本文件
├── superpowers/specs/
│   ├── 2026-05-12-match-resume-neo4j-rule-check-design.md   # 设计 v1
│   ├── 2026-05-12-match-resume-per-rule-results-design.md   # 设计 v2 (per-rule visibility)
│   └── 2026-05-13-rule-check-ui-design.md                   # UI 设计
├── superpowers/plans/
│   ├── 2026-05-12-match-resume-neo4j-rule-check.md          # 实施计划 v1
│   └── 2026-05-13-rule-check-ui.md                          # UI 实施计划
└── action_object_prompt/
    ├── match_resume_action_and_rules.json                   # ★ 规则语料 (JSON fallback)
    ├── match-result-rule-check-test-user-guide.md           # 测试用户指南
    └── rule_check_advices.md                                # 业务方对 UI 的 8 条产品要求
```

### 4.9 全局文件改动

| 文件 | 改动 |
|---|---|
| `prisma/schema.prisma` | +2 model |
| `components/shared/LeftNav.tsx` | +1 行 nav item (`rule-check` → `/rule-check`) |
| `lib/i18n.tsx` | +2 key (`nav_rule_check`, 中英) |
| `.env.local` | +1 行 `NEO4J_BROWSER_BASE=http://localhost:7474/browser/` |

---

## 5. 关键设计决策

### 5.1 LLM 输出 schema 极度精简（compact contract）

**问题**: New-API gateway 在 max_tokens 上做了变动配额，最低时被夹在 ~640 token；17 条 rule 每条 ~70 token 的输出会被截断 → parse-error → 整轮报废。

**决策**: LLM 只输出 `{ rule_id, status, reason? }`，**不输出 `rule_name` / `step_id` / `decision` / `stats` / `explanations`**。runner 端从 `filteredSteps` 查表反向回填 `rule_name` / `step_id`，重算 `stats` / `decision` / `explanations`。

**收益**: 每条 entry 从 ~70 token 压到 ~20 token，17 条 ~340 token，加上 reason 文字 ~500-650 token，稳定在 cap 以下。

**位置**: `lib/rule-check/prompt.ts:OUTPUT_SCHEMA_MATCH_RESUME` + `lib/rule-check/runner.ts:coerceRuleResults`。

### 5.2 失败一律 in-band — 不抛异常

`runRuleCheck` 不对外抛错。所有异常路径都返回 `MatchResumeCheckResult` with `decision='FAIL'` + `audit.fail_reason ∈ {parse-error, ontology-graph-unavailable, llm-call-error, tool-use-loop-exceeded}`，调用方一处 `if (result.decision === 'FAIL' && result.audit.fail_reason)` 即可分流。

**原因**: 这个能力被插在 matchResumeAgent 关键路径上；一处 try/catch 漏掉就会让整个 Agent 链路炸掉。in-band 失败让上游不用考虑异常路径，**fail-safe 行为是显式契约**。

### 5.3 Graph context 一次预拉，LLM 工具复用同一个 cache

`buildGraphContext` 在调 LLM 之前并发拉 6 个 slot（Candidate / Resume / JD / Applications / Blacklist hits / Employment links），结果放进 `_cache: Map`。LLM 在 tool-use loop 里调 `get_instance` / `list_instances` 时，dispatcher 先查 cache 再回源 Ontology。

**收益**:
1. LLM 在 prompt 里直接看到 §3 Graph context，绝大多数 rule 不需要再调 tool —— 实测 14 个 scenario 全是 `llm_round_trips=0`。
2. UI drawer 不用再去拉 neo4j：`graph_context` 直接随 `MatchResumeCheckResult` 返回，drawer 渲染时是纯客户端逻辑。

### 5.4 推理链（Inference Chain）由服务端推导，不由 LLM 输出

**问题**: 让 LLM 输出结构化 `evidence: [{type:'graph_node', ref:'resume.work_experience[0]'}, …]` 会再次撑爆 max_tokens（参考 5.1），而且 LLM 输出的 ref 经常错（"resume.work_experience[5]" 但实际只有 3 条）。

**决策**: 在 `lib/rule-check/evidence/` 写一个 per-rule extractor registry。每次拿到 `result.graph_context` + `ruleResult`，runner 端调用 `buildInferenceChain(graph, runtime, rule, ruleResult)` 推出 `InferenceStep[]`：`graph_node → computation → rule_logic → verdict`。结果嵌在 `RuleCheckScenarioResult.inferenceChain`，UI 直接渲染。

**已覆盖的 9 条 rule**: 10-5, 10-9, 10-10, 10-17, 10-21, 10-25, 10-26, 10-27, 10-32。其余 rule 走 fallback chain `[rule_logic(markdown), verdict(status, reason)]` —— 没有图节点高亮，但 rule 原文 + LLM reason 仍然可读。

### 5.5 矩阵着色按 actual status 而非"是否匹配 expected"

**问题（早期版本）**: 矩阵单元格按 `bucketCell(expected, actual)` 着色，但 fixture 只在少数 rule 上 pin 了 expected，大多数 rule 的 expected 是 `missing-from-expected` → cell 显示 `·`，**LLM 真的判过这条 rule、有结果，但 UI 看不到**。

**决策**: 单元格颜色直接绑定 `actual` rule status —— pass=绿 / not_triggered=灰 / fail=红 / pending&insufficient_info=黄 / not_executed=⊘。fixture-pin 不一致时，叠加一层红色外框作为"PIN MISMATCH"标记。

**对 confusion strip 的影响**: 上方 TP/TN/FP/FN 计数仍然按 `bucketCell` 统计（pin 缺失则不计入），保持"评估指标"的统计学语义。

### 5.6 SSE 流式 + 增量持久化

每跑完一个 scenario：先 `upsert` 到 `RuleCheckScenarioResult` → 再 yield `result` 事件。前端 14 行矩阵立刻有一行被填充，无须等 12 分钟全跑完才看到任何东西。`abort` 时已写入的 N 行保留，run 行 status 改为 `error`，前端把它显示为"aborted at SXX"。

### 5.7 fixture 是 single source of truth

`scripts/rule-check-test-suite/fixtures.ts` 同时是:
1. `seed-rule-check-fixtures.ts` 写入 neo4j 的源数据
2. `run-rule-check-test-suite.ts` (CLI) 的预期断言来源
3. `/rule-check` UI `/api/rule-check/scenarios` 端点的数据来源

→ "seeded 数据"和"预期结果"永远同步，不会漂移。

### 5.8 dual-reader 原则

`GET /api/rule-check/runs/{id}` 返回的 JSON 和 UI 内部消费的 `ScenarioResultPayload` 是 **同一个 shape**。这意味着：
- UI 是这份数据的一个消费者，不是制造者。
- 任何 Agent / 脚本可以直接 GET 同一个 URL 拿到结构化 JSON，无需另发明 API。

---

## 6. 数据契约（核心类型）

### 6.1 RuleStatus（六态）

```ts
type RuleStatus =
  | 'pass'              // 规则触发且通过
  | 'fail'              // 规则触发且不通过（终止匹配）
  | 'pending'           // 规则触发但需人工 / HSM 介入 — 挂起，不终止
  | 'insufficient_info' // 数据不足以判定 — 标"待补充信息"，不终止
  | 'not_triggered'     // 进入条件不满足，本条 rule 跳过
  | 'not_executed';     // 前序 rule 已 fail，本条短路（only when terminal rule fail）
```

**决策聚合规则** (`foldDecision` in runner.ts):
- 任一 `fail` → `decision='FAIL'`
- 否则任一 `pending` 或 `insufficient_info` → `decision='REVIEW'`
- 否则 → `decision='PASS'`

### 6.2 MatchResumeCheckResult（runner 的返回值）

```ts
type MatchResumeCheckResult = {
  decision: 'PASS' | 'FAIL' | 'REVIEW';
  stats: { total, pass, fail, pending, insufficient_info, not_triggered, not_executed };
  rule_results: RuleResult[];        // 每条评估过的 rule
  explanations: RuleExplanation[];   // 仅 status ≠ pass 且 ≠ not_triggered 的
  graph_context?: GraphContext;      // 6-slot 预拉数据 — UI 直接用
  audit: {
    rules_evaluated; graph_calls;
    llm_model; llm_duration_ms; llm_round_trips;
    llm_prompt_tokens?; llm_completion_tokens?;
    rule_source: 'ontology-api' | 'json-fallback';
    fail_reason?: 'parse-error' | 'ontology-graph-unavailable'
                | 'llm-call-error' | 'tool-use-loop-exceeded';
    raw_llm_text?: string;           // 仅 parse-error 时填，用于 UI 诊断
    llm_finish_reason?: string;      // "stop" / "length" / "tool_calls"
  };
};
```

### 6.3 InferenceChain（UI 推理链）

```ts
type InferenceStep =
  | { kind: 'graph_node'; node: NodeKind; field?: string; value: string }
  | { kind: 'rule_logic'; markdown: string }
  | { kind: 'computation'; label: string; value: string }
  | { kind: 'verdict'; status: RuleStatus; reason: string };

type InferenceChain = {
  rule_id: string;
  steps: InferenceStep[];
  highlight_nodes: NodeKind[];   // graph view 高亮哪些方块
};

type NodeKind = 'candidate' | 'resume' | 'jd' | 'application' | 'blacklist' | 'employment';
```

### 6.4 MatchKind（UI/分类用）

```ts
type MatchKind =
  | 'pass'
  | 'fail-decision'      // decision 字符串不一致
  | 'fail-rule'          // 某 pinned rule 的 status 不一致
  | 'fail-missing-rule'  // LLM 没有为某 pinned rule 输出 entry
  | 'fail-parse'         // LLM 输出无法解析为合法 JSON / rule_results 数量不匹配
  | 'fail-runtime';      // ontology / LLM gateway 网络层错误
```

---

## 7. 持久化 — Prisma 模型

```prisma
model RuleCheckRun {
  id                    String    @id @default(cuid())
  startedAt             DateTime  @default(now())
  finishedAt            DateTime?
  status                String    @default("running")  // running | done | error
  model                 String
  clientIdOverride      String?
  totalScenarios        Int       @default(0)
  passCount             Int       @default(0)
  failCount             Int       @default(0)
  totalLlmMs            Int       @default(0)
  totalPromptTokens     Int       @default(0)
  totalCompletionTokens Int       @default(0)
  capHits               Int       @default(0)         // finish_reason='length' 的次数
  errorMessage          String?
  results               RuleCheckScenarioResult[]
  @@index([startedAt])
}

model RuleCheckScenarioResult {
  id                String   @id @default(cuid())
  runId             String
  run               RuleCheckRun @relation(fields: [runId], references: [id])
  scenarioId        String                  // "S01".."S14"
  scenarioName      String
  expectedDecision  String
  expectedRules     String                  // JSON: Record<rule_id, RuleStatus>
  actualDecision    String
  actualStats       String                  // JSON: MatchResumeCheckStats
  ruleResults       String                  // JSON: RuleResult[]
  matchKind         String                  // pass | fail-* (见 §6.4)
  failures          String?                 // JSON: string[]
  inferenceChain    String                  // JSON: InferenceChain[]
  graphContext      String                  // JSON: GraphContext (含 6 slot)
  llmMs             Int
  llmModel          String
  promptTokens      Int?
  completionTokens  Int?
  finishReason      String?
  graphCalls        Int      @default(0)
  rawLlmText        String?                 // 仅 fail-parse 时填
  ranAt             DateTime @default(now())
  @@unique([runId, scenarioId])             // 用于 replay 时的 upsert
  @@index([runId])
}
```

**为什么 inferenceChain / graphContext 也存到 db**: 抽屉 (drawer) 加载历史 run 时不再回头拉 neo4j —— 把那一刻的 LLM 看到的快照原样回放。对 dual-reader 也意味着外部消费方拿到的就是当时的判定依据。

---

## 8. 日志 — `lib/rule-check/logs/YYYY-MM-DD.log`

格式: JSON-lines。每行 `ISO-8601 [LEVEL] event_name {json}`。

### 8.1 写入点

| 事件 | 来源 | 关键字段 |
|---|---|---|
| `run.started` | runs-service | run_id, model, client_id_override, scenarios |
| `scenario.start` | runs-service | run_id, scenario_id, candidate_id |
| `runRuleCheck.start` | runner | candidate_id, model_override, expected_rule_count, rule_source |
| `neo4j.graph.fetched` | runner | candidate_id, fetch_count, slots (全部 6 slot 原数据) |
| `neo4j.graph.failed` | runner | candidate_id, message |
| `llm.request` | runner | model, system_chars, user_chars, user_prompt (≤20k 截断), rules_in_prompt |
| `llm.response` | runner | model, duration_ms, tool_rounds, finish_reason, tokens, text |
| `llm.failed` | runner | reason, message |
| `parse.failed` / `parse.count-mismatch` | runner | expected / got |
| `runRuleCheck.done` | runner | candidate_id, decision, stats |
| `scenario.done` | runs-service | run_id, scenario_id, match_kind, decision, failures, llm_ms, finish_reason |
| `run.done` | runs-service | run_id, total, pass, fail, total_llm_ms, cap_hits |
| `run.failed` | runs-service | run_id, message |

### 8.2 设计原则

- **fire-and-forget**: 异步追加，失败 → stderr，不影响 eval 流。
- **大字段自动截断**: 任何 string > 20k 字符自动截断 + 加 `[+N chars truncated]` 标记，避免 log 文件失控。
- **Map / Set 自动序列化**: replacer 把 `Map` 转 `Record`、`Set` 转 array。Neo4j temporal 类型 (`{low, high}`) 在 graphContext 写入时也会被压平。
- **当天文件名**: `YYYY-MM-DD.log` (本地时区)；文件不存在自动创建；目录在第一次写入时 `mkdir -p`。

### 8.3 不会写入的内容

- 没有 PII 脱敏 — log 里有候选人姓名、出生日期等真实字段。**线上慎用**。开发环境 OK，生产前需要叠一层 redaction。
- 没有 logrotate — 文件会一直追加；如果生产用，建议外部 logrotate by day。

---

## 9. 测试

| 测试 | 文件 | 数量 |
|---|---|---|
| Prisma 持久化 | `__tests__/prisma/rule-check.test.ts` | 2 |
| runner 核心 | `lib/rule-check/runner.test.ts` | 13 |
| prompt composer | `lib/rule-check/prompt.test.ts` | 6 |
| graph context | `lib/rule-check/graph-context.test.ts` | (既有) |
| instance-client | `lib/rule-check/instance-client.test.ts` | (既有) |
| ontology-source | `lib/rule-check/ontology-source.test.ts` | (既有) |
| resume-projection | `lib/rule-check/resume-projection.test.ts` | (既有) |
| evidence | `lib/rule-check/evidence/index.test.ts` | 13 |
| match-classifier | `server/rule-check/match-classifier.test.ts` | 6 |
| scenarios-loader | `server/rule-check/scenarios-loader.test.ts` | 3 |
| runs-service | `server/rule-check/runs-service.test.ts` | 3 |
| bucketing | `components/rule-check/bucketing.test.ts` | 16 |
| neo4j-jump | `components/rule-check/neo4j-jump.test.ts` | 8 |
| **总计** | | **~120 cases** |

运行: `npx vitest run` 全套；`npx vitest run lib/rule-check server/rule-check components/rule-check __tests__/prisma` 仅 rule-check 相关。

**没有覆盖到的**: SSE 路由 handler 本身（用 curl smoke）、UI 组件渲染（无 RTL 配置，靠手工测试）。

---

## 10. 使用方式

### 10.1 在项目代码中调用 lib

```ts
import { buildRuleCheckInput, runRuleCheck } from "@/lib/rule-check";

const input = buildRuleCheckInput({
  runtime_context: {
    upload_id: "upload-abc",
    candidate_id: "C-S02-100024",      // 必须在 neo4j 中已存在
    resume_id: "R-S02-100024",
    employee_id: "EMP_TEST",
    received_at: new Date().toISOString(),
  },
  parsed_resume: null,                   // 库内部从 neo4j 拉
  job_requisition: { job_requisition_id: "JR-TENCENT-001" },
});

const result = await runRuleCheck(input, { model: "gemini-3-flash-preview" });

if (result.decision === 'PASS') {
  // 继续推送
} else if (result.decision === 'REVIEW') {
  // 挂起 → HSM 人工确认
} else {  // 'FAIL'
  if (result.audit.fail_reason) {
    // 系统错误（parse-error / ontology-graph-unavailable / …）
    // → 走重试逻辑或上报告警
  } else {
    // 真业务 fail（某 rule 触发了 fail）
    // result.explanations 里能拿到为什么
  }
}
```

### 10.2 跑 CLI 批量评估

```bash
# 一次性写入 14 个 fixture 到 neo4j (有 idempotent upsert)
npx tsx scripts/seed-rule-check-fixtures.ts

# 跑全套 14 个 scenario，输出 Markdown 报告到 data/rule-check-test-report.md
npx tsx scripts/run-rule-check-test-suite.ts

# 只跑前 N 个或指定 IDs
npx tsx scripts/run-rule-check-test-suite.ts --first 3
npx tsx scripts/run-rule-check-test-suite.ts --only S02,S08
```

### 10.3 通过 UI 跑

1. `npm run dev` (端口 3002)
2. 打开 `http://localhost:3002/rule-check`
3. 顶部下拉选 Model / Client → 点 **▶ Run All**
4. 矩阵实时填充；点任意 cell 进入抽屉（drill-down）
5. 抽屉内点 Graph view 的方块 → 看真实 neo4j 实例 JSON
6. 抽屉内点 **▶ Replay this scenario** → 单 case 重跑

### 10.4 程序化调用 SSE 流

```ts
const resp = await fetch('/api/rule-check/runs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'gemini-3-flash-preview',
    client_id_override: 'CLI_TENCENT_PCG',
    scenarios: ['S01', 'S02'],          // 省略则跑全部 14 个
  }),
});
// resp.body 是 text/event-stream — 解析 SSE 即可
```

### 10.5 拿历史结果（dual-reader）

```bash
curl -s http://localhost:3002/api/rule-check/runs           # 最近 20 次 run 列表
curl -s 'http://localhost:3002/api/rule-check/runs?latest=1' # 最近一次 run 全量
curl -s http://localhost:3002/api/rule-check/runs/{run_id}  # 任意 run + scenarios
```

---

## 11. 运维

### 11.1 必备环境变量

| 变量 | 用途 | 示例 |
|---|---|---|
| `AI_BASE_URL` | LLM gateway URL (OpenAI 协议) | `https://api.openai-proxy.org/v1` |
| `AI_API_KEY` | gateway API key | `sk-…` |
| `AI_MODEL` | 默认 model（每次调用可覆盖） | `gemini-3-flash-preview` |
| `ONTOLOGY_API_BASE` | Ontology HTTP server | `http://localhost:3500` |
| `ONTOLOGY_API_TOKEN` | Ontology Bearer token | `abc12345def` |
| `NEO4J_URI` | neo4j Bolt 地址（项目其他模块也用） | `bolt://localhost:7687` |
| `NEO4J_BROWSER_BASE` | neo4j Browser 深链 base（仅 UI 用） | `http://localhost:7474/browser/` |
| `DATABASE_URL` | sqlite | `file:./data/ao.db` |

### 11.2 已知坑位

1. **Gateway max_tokens 是变动配额**: 即使 prompt 端要 16000，gateway 可能在高峰期夹到 ~640。我们用 compact schema (§5.1) 把输出压到 ~600t 以下规避。若未来 gateway 改了规则，可以放回完整 schema。
2. **Resume 在 neo4j 中存的是 JSON 字符串**: `Resume.work_experience` 字段的 schema 是 String，seed 时 `JSON.stringify`，读时是 string；evidence extractor 用 `asArray()` helper 做兜底解析（见 `evidence/_date-utils.ts`）。
3. **`prisma migrate dev` 在本仓库会触发 reset**: 已有 schema drift；新增表用 `npx prisma db push` 而不是 `migrate dev`。已记在本文档。
4. **Kimi K2.6 模型有特殊要求**: 需要 `temperature=1`、需要 `extra_body.thinking.type='disabled'`、tool-use 时要保留 `reasoning_content`。`server/llm/gateway.ts` 已经按 `modelLower.includes('kimi')` 做了默认值兜底；写新代码时不用关心。
5. **`/rule-check` 页面没有 auth**: 任何能访问 3002 端口的人都能跑评估、看历史。上线前需要叠 auth gating。

### 11.3 重跑数据

```bash
# 重新种子（neo4j）
npx tsx scripts/seed-rule-check-fixtures.ts

# 重置 sqlite 中的 rule-check 历史（不影响其他表）
sqlite3 data/ao.db "DELETE FROM RuleCheckScenarioResult; DELETE FROM RuleCheckRun;"
```

---

## 12. 已知限制与后续工作

| 项 | 状态 | 后续 |
|---|---|---|
| Version diff 矩阵（同 model 跨 prompt 版本对比） | 未做 | 需要给 RuleCheckRun 加 `promptSha` 字段，UI 加"版本"选择器和 diff 视图。 |
| 业务价值锚（HR 工时 / 漏判损失） | 未做 | 客户基线数据齐全后再加，不然就是"装样子"。 |
| 推理链覆盖率 | 9 / ~30 rule | 写更多 extractor（每个 ~30 行）；fallback 仍然可读。 |
| neo4j Browser 一键执行 cypher | 仅"打开 + 预填"，需用户 ⌘↵ 触发 | 改成 `cmd=play` 形式可自动执行，但跨 neo4j 版本不稳定。 |
| 客户切换（`CLI_HUAWEI` 等）覆盖 | 列表是写死的，部分 client 没对应 seed 数据 | 等真实客户数据接进来。 |
| Replay loss-of-context 边角 | replay 端点目前会创建一个临时 run 再 copy 进原 run，最后删除临时 — 略 hacky | 重构 streamRuleCheckRun 支持 "append to existing run" 模式。 |
| 日志 PII | 全字段裸写 | 上线前加 redaction 中间件（候选人姓名、生日、手机号）。 |
| 日志 rotation | 文件单向追加 | 外部 logrotate。 |

---

## 13. 提交记录速览

主分支: `create-action-prompt`（基于 `steven`）。本能力相关提交（最近优先）:

```
6754456  feat(rule-check): logger, matrix-cell-by-actual-status, graph-node detail panel
dcaad2a  fix(rule-check): JSON-parse neo4j string fields in evidence extractors
8568c56  feat(rule-check): /rule-check UI — page shell, top bar, strips, matrix, drawer, …
45524a5  feat(rule-check): API routes (scenarios, runs list+SSE, run detail, replay, config)
3ef8105  feat(rule-check): runs-service streaming async generator
187e70f  feat(rule-check): inference chain registry + 9 per-rule evidence extractors
6d56795  feat(rule-check): foundation utilities
c7b1064  feat(rule-check): add RuleCheckRun + RuleCheckScenarioResult Prisma models
…        (前面是 lib/rule-check 本身的 v1 / v2 设计与实现，见 docs/superpowers/{specs,plans}/)
```

---

## 14. 一句话总结

`runRuleCheck` 是 matchResume 决策的 LLM 评估核心；`/rule-check` 是它的可视化测试台；两者共享同一份输出 schema，UI 是这份数据的消费者而不是制造者。生产链路只要 `import { runRuleCheck }` 即可接入，UI 与日志是免费送的可观测性。
