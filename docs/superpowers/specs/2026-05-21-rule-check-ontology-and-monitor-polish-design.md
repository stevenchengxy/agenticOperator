# Rule Check ontology 实时化 + Monitor polish 设计 spec

**日期**:2026-05-21
**作者**:Steven · Claude
**范围**:Monitor 轴四个具体诉求里的前三个 —— DLQ 重新上架、Workflow 拓扑补 RuleCheck 节点、Rule Check 总览接真实 Neo4j ontology、Rule Check Drawer UI 重做 + i18n 收尾。
**Out of scope**:全局追踪 Chatbot(见姐妹 spec [2026-05-21-global-tracing-chatbot-design.md](./2026-05-21-global-tracing-chatbot-design.md))。Manage(干预写)/ Behavior(新 agent)轴。
**三轴定位**:全部落在 Monitor 轴 —— 都是 read-only 观察面优化,无写操作。

---

## 0. 现状关键事实

| 主题 | 当前状态 | 文件 |
|---|---|---|
| DLQ tab | `InngestDlqTab.tsx` + `DLQPanel.tsx` 完整存在并 polling `/api/inngest-admin/dlq`,但 2026-05-19 IA 清理时 [`MonitorContent.tsx:29-32`](../../components/monitor/MonitorContent.tsx) 显式拿掉,注释 `DLQ tab → /alerts (future)` | [components/monitor/InngestDlqTab.tsx](../../components/monitor/InngestDlqTab.tsx) |
| Workflow 节点表 | `workflow-canonical.json` 22 个节点(`1-1` … `16`),**无 `10-5`** | [lib/workflow-canonical.json](../../lib/workflow-canonical.json) |
| Agent 注册表 | `RuleCheck` 已注册:`wsId: '10-5'`、`stage: match`、`owner: 合规`、`triggers: RESUME_PROCESSED`、`emits: [MATCH_RULE_CHECK_PASSED, MATCH_RULE_CHECK_FAILED]` | [lib/agent-mapping.ts:55](../../lib/agent-mapping.ts) |
| Graph 拼装 | `NODES` 由 `NODE_LAYOUT`(布局)× `CANONICAL_BY_WSID`(canonical JSON)合成;`EDGES` 从 canonical 的 `trigger` / `triggered_event` 派生 | [lib/workflow-graph-meta.ts:120-302](../../lib/workflow-graph-meta.ts) |
| Rule 数据源(给 Dashboard 矩阵) | `/api/rule-check-audits/matrix?window=Nd` —— 从已发生的 audit 反推出的 rule 集合 | [components/rule-check/RuleCheckDashboardContent.tsx:82](../../components/rule-check/RuleCheckDashboardContent.tsx) |
| Rule 数据源(给单条 Rule 详情) | `/api/ontology/rules/[ruleId]` 走 `fetchAction(matchResume, RAAS-v1)` → 命中 Neo4j `:7688`,失败 fallback 到 bundled `rules.json` | [app/api/ontology/rules/[ruleId]/route.ts](../../app/api/ontology/rules/[ruleId]/route.ts) |
| Rule list(全集) | **不存在** `/api/ontology/rules` —— 这正是 Dashboard 要"实时显示全部 rule"的缺口 | — |
| Drawer 文件 | 1771 行单文件,4 个 tab(Prompt/Rules/Response/Instances),`DecisionBanner` 装饰过重、KV 网格 4-col 太密,字号普遍 11-12.5px | [components/rule-check/RuleCheckAuditDetailDrawer.tsx](../../components/rule-check/RuleCheckAuditDetailDrawer.tsx) |
| i18n `rc_*` 覆盖 | `rc_drawer_title` `rc_tab_*` `rc_col_*` `rc_filter_*` `rc_audits_*` `rc_stat_*` 等已存在;装饰性中文(`重发`、`所有底线规则放行`、`未加载` 等)仍硬编码 | [lib/i18n.tsx](../../lib/i18n.tsx) |

---

## 1. 三个子目标 / 三个独立可发版增量

| Phase | 名称 | 估时 | 风险 | 独立可 ship |
|---|---|---|---|---|
| α1 | DLQ tab 回归 /monitor | <1h | 极低 | ✅ |
| α2 | Workflow 拓扑补 RuleCheck 节点 + 边 | 2-3h | 低(布局回归) | ✅ |
| β1 | 新端点 `GET /api/ontology/rules` | 2h | 中(Neo4j drift / fallback 路径) | 需配合 β2 用 |
| β2 | Rule × Audit 网格切到 ontology 全集 + Dead-Rule 标识 | 2-3h | 低 | ✅(依赖 β1) |
| β3 | Drawer UI 重做(视觉层级 + 排版) | 1d | 中(回归各 tab 内容) | ✅ |
| β4 | i18n 硬编码中文清扫 | 2-3h | 低 | ✅(可与 β3 同 PR) |

总估时 **2-3 天**。

---

## 2. α1 — DLQ tab 回归 `/monitor`

### 改动点
1. 在 `/monitor` 现有 tab nav 里追加 `DLQ` 项(i18n key `monitor_tab_dlq` 已存在,直接用)。
2. tab body 切到现成的 `<InngestDlqTab />`,**不**改 panel 内部任何样式或 polling 逻辑。
3. URL state:`?tab=dlq` 直链可分享。沿用现 `MonitorContent` 的 `sp` 解析方式。

### 不做
- 不改 DLQPanel 内部样式 —— 维持现有"产品级别一致性"(它已经按 OKLCH token + atoms 写好)。
- 不在 `/alerts` 再做一份(原 IA 注释里的 `→ /alerts (future)` 不兑现 —— 用户明确要在 monitor 里)。
- 不动 `/api/inngest-admin/dlq`。

### 验收
- 打开 `/monitor` 默认还是运行视图;点击 `DLQ` tab 看到 ≥0 个失败/取消 run;点行进 RunDetailDrawer 一致。
- ESC 关 drawer 不破坏 tab state。

---

## 3. α2 — Workflow 拓扑补 RuleCheck 节点

### 视觉位置

Resume 处理列(col 4, x=920)与 Match 列(col 5, x=1220)之间塞入 RuleCheck:

```
… resumeParser (920, 400) ──RESUME_PROCESSED──▶ ruleCheck (1070, 400) ──MATCH_RULE_CHECK_PASSED──▶ matcher (1220 → 1370, 400) …
                                                              │
                                                              └─MATCH_RULE_CHECK_FAILED (虚线 → 终态)
```

为给 ruleCheck 让位,**matcher 整列(包括 interviewInviter/aiInterviewer/evaluator/resumeRefiner/packageBuilder/...)整体右移 150px**,保证横排留白一致。

### 实现要点

**注入点在 `lib/workflow-graph-meta.ts`,不动 `workflow-canonical.json`**(canonical 是 allmetaOntology 的 mirror,RuleCheck 是 AO 自有合规节点,不在主仓 ontology — 见 memory 项目记录)。

```ts
// NODE_LAYOUT 里在 resumeParser 之后追加:
{ id: 'ruleCheck', wsId: '10-5', x: 1070, y: 400, kind: 'agent', icon: 'shield' },

// matcher 起整列右移:
{ id: 'matcher', wsId: '10', x: 1370, y: 400, ... },   // 1220 → 1370
// 后续列 +150:1520 → 1670, 1820 → 1970, 2080 → 2230
// GRAPH_VIEWBOX / GRAPH_WIDTH 同步:'0 0 2200 800' → '0 0 2350 800'
```

**TITLE_BY_WSID** 加 `'10-5': 'RuleCheck'`。

**RPA_OWNED_WSIDS**:`RuleCheck` 是 `resume-parser-agent` 项目里 [server/inngest/agents/rule-check-agent.ts](../../server/inngest/agents/rule-check-agent.ts) 真实部署的 — 加 `'10-5'` 进集合,这样 `deriveDeployment` 返回 `'deployed'`。

**边的派生**:`workflow-canonical.json` 没有 `10-5`,但 `agent-mapping.ts` 的 `RuleCheck` 已经有 `triggersEvents: ['RESUME_PROCESSED']` 和 `emitsEvents: ['MATCH_RULE_CHECK_PASSED', 'MATCH_RULE_CHECK_FAILED']`。

把 `buildEdges()` 改成:**当 `NODE_LAYOUT` 里某节点没有 canonical 时,回落到从 `AGENT_MAP` 拿 triggers/emits**。这一处改造同时也修了未来任何"AO 自有节点"的注入路径。

伪代码:
```ts
function getEdgeMeta(layout: NodeLayout): { triggers: string[]; emits: string[] } {
  const canon = CANONICAL_BY_WSID.get(layout.wsId);
  if (canon) return { triggers: canon.trigger, emits: canon.triggered_event };
  // Fallback:从 AGENT_MAP 找 RuleCheck 这类 AO-only 节点
  const agentMeta = AGENT_MAP.find(a => a.wsId === layout.wsId);
  if (agentMeta) return { triggers: agentMeta.triggersEvents, emits: agentMeta.emitsEvents };
  return { triggers: [], emits: [] };
}
```

### 副作用 / 回归点
- 既有 `workflow-graph-meta.test.ts` / `workflow-meta.test.ts` 跑 22-node 断言 —— 改成 23,补 RuleCheck 期望坐标 + deployment=`deployed`。
- `/workflow` 顶部 `已注册 / 蓝图` 计数自动跟着 `liveOverlay` 走,不用手动加。
- `/monitor` 如果存在 RuntimeTopologyView mirror,自动吃到新坐标(它复用 graph-meta)。
- `MATCH_RULE_CHECK_PASSED` 进 [EDGE_LABEL_MAP](../../lib/workflow-graph-meta.ts):label = `规则通过`(EN: `Rules OK`);`MATCH_RULE_CHECK_FAILED` → `规则拦截` (`Rules Block`),归入 `isExceptionalEvent` 走虚线。

### 不做
- 不在 `workflow-canonical.json` 里加 `10-5` —— 那是 ontology mirror,不该被 AO 自有节点污染。
- 不动 Matcher 之外的事件订阅(`Matcher` 的 `triggersEvents` 已经是 `['MATCH_RULE_CHECK_PASSED']`,边自动连通)。
- 不重画 RuleCheck 的子内部流程图(那是 Inspector 抽屉里的事,不属于拓扑图)。

---

## 4. β1 — `GET /api/ontology/rules`

### 契约

```ts
GET /api/ontology/rules
→ 200 {
    ok: true;
    rules: Rule[];               // 全部 matchResume rule,severity 推断完
    source: 'ontology-api' | 'json-fallback';
    fetched_at: string;          // ISO
    drift?: {                    // 仅当 ontology API 命中且与 JSON 集合不一致
      only_in_api: string[];
      only_in_json: string[];
    };
    api_error?: string;          // ontology API 出错时附带,前端可在 UI 角落标灰
  }
→ 500 { ok: false; error: string }  // JSON fallback 都失败才会到这
```

复用 [lib/rule-check/ontology-source.ts:fetchRulesForMatchResume](../../lib/rule-check/ontology-source.ts)。route 的工作就是 `const r = await fetchRulesForMatchResume()` + 套外壳。

**缓存策略**:`export const revalidate = 30` —— 服务端 30s ISR。前端 polling 周期独立(下面 β2)。

### 不做
- 不分页 —— matchResume rule 总集 < 200 条,一次性返回。
- 不暴露 client/business_group filter —— 那是 audit 时刻的事,Dashboard 要看的就是全集。
- 不写新 fetcher —— 复用 ontology-source。

---

## 5. β2 — Rule × Audit 网格切到 ontology 全集

### 改动点(均在 [RuleCheckDashboardContent.tsx](../../components/rule-check/RuleCheckDashboardContent.tsx))

1. 新加 state `rules: Rule[] | null`,从 `/api/ontology/rules` 拉,**30s 轮询**。`matrix` 端点继续拉 —— 但只用它的 `total / pass / fail / not_applicable` 计数。
2. 网格行的来源从 `matrix.rules` 切到 `rules`(ontology 全集)。每行 left-side 信息从 ontology 拿(rule_name / step / severity / applicableDepartment 等),计数 badge 还是 matrix 提供。
3. 新增 **Dead Rule** 标识:`evaluated_count === 0`(即在当前窗口的审计里 0 次出现)的 rule:
   - 整行字体压灰
   - 行尾贴 `dead` badge(i18n: `rc_rule_dead`)
   - 排序优先级提到底部(原来"按 fail 数倒序"逻辑保留,dead 单独成一组沉底)
4. KPI strip 增加 `覆盖率`:`evaluated_rule_count / ontology_rule_count`(i18n: `rc_kpi_coverage`)。
5. `top_failure_rules` / `lowCoverage` 两个面板:`lowCoverage` 现在的逻辑是 `total <= 10%`,改成 `total === 0`(真 Dead Rule)就行。
6. 时间窗切换器(`7d/30d/90d`)行为不变。
7. Source 标识:如果 `/api/ontology/rules` 返回 `json-fallback`,顶部贴一个 `Badge variant="warn"` ⚠ `ontology API 不可达 · 用 JSON 静态规则`(i18n: `rc_rules_fallback_warn`),用户能感知。

### 验收
- 打开 `/rule-check?view=dashboard`,首屏在 ≤300ms 给出全集(matrix + ontology 并发拉),Dead Rule 标识可见。
- 用 `ONTOLOGY_API_BASE` 主动卸了的情况下,顶部出现 warn badge,网格仍正常(JSON fallback)。

---

## 6. β3 — Drawer UI 重做

**目标**:把 `RuleCheckAuditDetailDrawer.tsx` 从"功能堆叠的 dashboard"改成"读完一条决策需要看的内容,层级清楚"。

### 视觉规范(与 `RuleCheckPageContent` / `RuleCheckDashboardContent` 已有的 serif 头部对齐)

| 元素 | 当前 | 改后 |
|---|---|---|
| Drawer 宽度 | `min(940px, 92vw)` | 不变 |
| DecisionBanner(`PASS`/`FAIL` 大字 + summary) | 蓝/绿全宽,28px 加粗 sans + 12.5px 摘要 | 改用 surface 底 + `border-left: 4px` 强调色;`PASS`/`FAIL` 用 **serif 32px** 与页面头部一致;summary 改 14px 行高 1.55 |
| DetailHeader KV grid | 4-col,8 个字段挤一行 | 改 3-col;每个 KV 增高 16px 间距;`label` 改 10.5px uppercase letter-spacing 0.06em |
| `failure_reasons` / `parse_error` | 跨 4 列贴在 grid 末尾 | 单独提取成 **callout 卡片**(`bg-err-bg` + 左边框红 + `Ic.alert`) |
| Tab 栏 | 12.5px,2px 下划线 var(--c-accent) | 改 13px,1.5px 下划线 var(--c-ink-1),与 `RuleCheckPageContent` 顶部 layer tabs 对齐(同一视觉语法) |
| 每个 tab 内容(Prompt/Rules/Response/Instances) | 各自不同 padding/section header | 统一用一个新 `<DrawerSection title hint>` shell(serif 14px 小标题 + 8px gap),内部内容仍由各 Tab 自决 |
| Replay 按钮 | banner 右侧 `Btn size=sm` | 改成 secondary 风格,与 `Neo4jLinkBtn` 同列;banner 内不再放操作 |

### 文件结构

不拆分 `RuleCheckAuditDetailDrawer.tsx`(用户偏好"先把视觉做对再拆"),但内部按职责清晰分段:
1. `RuleCheckAuditDetailDrawer`(主体 + ESC + fetch + tab state)
2. `DecisionBanner` / `DetailHeader`(新版式)
3. `<DrawerSection>` shell 抽出
4. `PromptTab` / `RulesTab` / `ResponseTab` / `InstancesTab` 各自接 `<DrawerSection>` 重排

如果重做完文件超 1800 行 —— 那就拆,但不在本 spec 强制。

### 不做
- 不动 4 个 tab 的内容 / 数据契约(prompt 渲染、flags 表、LLM response JSON 树、instances list 都保留)。
- 不做 Replay 自身的 UX 改造。
- 不做 keyboard nav(tab 间 ←/→ 切换之类的)—— YAGNI。

---

## 7. β4 — i18n 硬编码中文清扫

### 范围

`grep` 出 `RuleCheckAuditDetailDrawer.tsx` 里所有中文字面量(预计 30-50 处),逐个落 key。Key 命名风格沿用 `rc_drawer_*`。

### 已知补漏清单(非穷尽)

| 出现处 | 文案 | 建议 key |
|---|---|---|
| `DecisionBanner` | `所有底线规则放行(评估 X/Y 条)…` | `rc_decision_summary_pass` |
| 同上 | `底线规则触发 FAIL → 中止流程,跳过 matchResume。命中:` | `rc_decision_summary_fail` |
| 同上 | `(LLM 解析失败)` | `rc_decision_summary_llm_parse_err` |
| `Replay button` | `🔁 Replay` / `重跑中…` | `rc_replay` / `rc_replay_running` |
| `DetailHeader` Kv label | `decision` / `client × bg × studio` / `model · latency` 等 | 全部走 key(很多已有,补齐) |
| Drawer 抽屉关闭文案 | `关闭 (Esc)` | `rc_drawer_close`(已有) |
| `FilteredOutRulesSection` | `点击展开` / `executor` / `client` / `department` 等 | `rc_filtered_*` |
| 网格 cell tooltip | `未加载` | `rc_cell_unloaded` |
| `dead` badge | (新增,β2) | `rc_rule_dead` |

英文同步落 `en` 字典。

### 验收
- `grep -nE "[一-龥]" components/rule-check/RuleCheckAuditDetailDrawer.tsx` 输出**只剩注释**,不剩 JSX 文本。
- `/rule-check?lang=en` 走一遍 dashboard + drawer,无中文残留。

---

## 8. 跨阶段 — 测试 / 回归

### 单元测试
- `workflow-graph-meta.test.ts`:节点数 22→23、`ruleCheck` 坐标 + deployment 期望、`getEdgeMeta` fallback 路径。
- 新加 `lib/api/ontology-rules.test.ts`:mock `fetchAction`,断言 fallback 行为 + drift 报告 + api_error 透传。

### 手动 E2E
1. `/monitor?tab=dlq` → 看到 DLQ。
2. `/workflow` → 看到 RuleCheck 节点 + 两条出边(实线 PASSED / 虚线 FAILED)。
3. `/rule-check?view=dashboard` → 看到全部 ontology rule(包括 dead rule 标识)。
4. 关闭 `ONTOLOGY_API_BASE`,刷新 dashboard → 顶部 warn badge + JSON fallback 仍可用。
5. `/rule-check?view=audits` → 点任意一条 → drawer 排版与 mockup 一致;切 `lang=en` 全部翻译。

### 不写
- 不写 E2E 自动化(项目无 e2e 套件)。
- 不写视觉回归(项目无 visual diff)。

---

## 9. 时间表(顺序约束)

```
α1 (<1h) ──┐
α2 (3h)  ──┴── 半天 ship 一个 polish PR(可独立合)
β1 (2h)   ──┐
β2 (3h)   ──┴── 第二天 ship 一个 ontology 实时化 PR
β3 (1d)   ──┐
β4 (3h)   ──┴── 第三天 ship 一个 drawer + i18n PR
```

每 phase 独立 PR,失败回滚不互相牵连。

---

## 10. Out of scope(明确不做)

- **全局追踪 chatbot** — 见 [2026-05-21-global-tracing-chatbot-design.md](./2026-05-21-global-tracing-chatbot-design.md)
- **干预操作**(replay 改 retry / cancel / pause) — Manage 轴
- **Behavior 维度**(自动告警、Monitor Agent) — Behavior 轴
- **`workflow-canonical.json` 改造** — 保持 ontology mirror 不被污染
- **DLQ 单独子路由** — 一个 tab 就够,不开 `/monitor/dlq`
- **Rule edit / publish UI** — 这是 ontology 管理后台的事,本 spec read-only
