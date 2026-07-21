# 招聘漏斗 · 端到端追踪（Recruitment Funnel & Lineage）设计

- 日期：2026-06-05
- 状态：设计已与用户对齐（待 spec review gate）
- 路由：新建 `/funnel`（导航项「追踪」），把现有 `/correlations` 折为其最底层时间线

## 1. 背景与诉求

现有 `/correlations`（关联追踪）页只能按**单一 `trace_id`** 把
`audit / event / run / step / hitl` 串成一条纵向时间线。它回答的是
**"这一个实体身上发生了什么、为什么"**——排障/审计视角。

用户希望把它扩展成**招聘漏斗追踪**：不只追单个候选人，而是按
**岗位 / 候选人**两个维度看招聘漏斗——**候选人在哪一环流失、岗位卡在哪。**

这两者不是同一个控件，而是**总览 → 下钻**的关系。本设计把它们合成
**一页三级下钻**。

## 2. 数据现实（决定漏斗能多"真"——这是本设计的硬约束）

查证 `prisma/schema.prisma` 与 `app/api/correlations/[traceId]/route.ts` 后：

| 数据 | 主键/可聚合维度 | 能否按 岗位×候选人 聚合 |
|---|---|---|
| `WorkflowRun` / `AgentActivity` / `AuditLog` / `HumanTask` / `EventInstance` | 只有 `traceId` / `runId`（`WorkflowRun.triggerData` 是 JSON 字符串，无外键） | ❌ 不带候选人/岗位身份 |
| **`RuleCheckResult`**（规则预筛结果，schema 中 `candidate_id`+`job_requisition_id`+`trace_id`+`decision`+`created_at`+`client_display_name`） | candidate × job × trace | ✅ **唯一既带候选人又带岗位、还带 `trace_id` 的真表** |
| `JobRequisition` | `id` + `status`（pending_clarification…published…closed） | ✅ 岗位本体 |
| `Notification.anchorsJson` | `{candidate_id, job_requisition_id}` | ⚠️ 字段存在，但据现状 candidate/job 分支基本未真填（rule-check park 短路） |
| 入库人数 / offer 结果 | RAAS partner-pg / Neo4j（伙伴系统） | 🔌 AO 这侧无数据通路 |

**桥**：`RuleCheckResult.trace_id` 一头连「候选人×岗位」业务身份，一头连
`AuditLog.traceId` / `WorkflowRun`（经 `triggerData`）的技术时间线。

**结论（基调）**：
- **时间线（单实体 L3）今天就能落真**——复用 `/api/correlations/:traceId`。
- **漏斗（聚合 L1/L2）只有"规则预筛"这一环今天有真数据**（`RuleCheckResult`）；
  上游（入库/简历）与下游（评分/邀约/HITL/offer）要么只在事件流里按 trace
  散着、未按岗位聚合，要么在伙伴系统里。
- 因此漏斗**诚实地区分"已接入 / 数据未接入"，绝不编造未接入环的数字。**

## 3. 选定方案：A · 读时聚合，零新表（Phase 1）

> 备选 B（建 `RecruitmentFunnelEntry` 投影表 + 事件流回填，漏斗补满）与
> C（只给时间线加岗位筛选、不做漏斗）均被否。A 让截图那页立刻从 mock 变真、
> 漏斗骨架搭起、预筛环见真章，且零回填风险；补满漏斗留作独立的 Phase B spec。

- L1/L2 直接在 `RuleCheckResult` + `JobRequisition` 上**读时聚合**，不引入需回填的新表。
- L3 复用现有 `/api/correlations/:traceId`，不改其逻辑。
- 未接入环：**打灰 +「数据未接入」角标**，hover 提示数据源去向。

## 4. 三级下钻结构

### L1 · 漏斗总览
- 维度切换：**按岗位 / 按候选人**。
- **按岗位**：每个 `JobRequisition` 一条横向漏斗。阶段（见 §5）逐环显示
  *通过数 · 掉队数 · 转化率*。预筛环真，其余环灰 +「数据未接入」。
  顶部 KPI 条：在招岗位数、漏斗中候选人总数、整体预筛通过率。
- **按候选人**：候选人列表（同截图左栏，但变真），选中看 TA 横跨多岗位的小漏斗。

### L2 · 阶段候选人名单
- 点 L1 漏斗某一环 → 落在/通过该环的候选人名单。
- 列：候选人 · 岗位 · 当前阶段 · `trace_id` · 最近活动时间。
- 数据：`RuleCheckResult` 按 `(candidate_id, job_requisition_id)` 分组，取每组最新一条；
  状态映射见 §6；可按状态筛（全部/进行中/待复核/已拦截/失败/已提交）。
- 这一栏即截图左侧候选人列表的"真数据版"。

### L3 · 端到端时间线
- 点候选人 → 现有 `/correlations` 时间线（截图右栏），`audit/event/run/step/hitl` 一条线。
- 复用 `GET /api/correlations/:traceId`，`trace_id` 取自该候选人 L2 行。
- 不改动其现有渲染/过滤逻辑。

导航：L1↔L2↔L3 通过 URL query 维持（如 `/funnel?job=<id>&stage=<k>&trace=<traceId>`），
可前进/后退、可深链。

## 5. 漏斗阶段定义（招聘）

| # | 阶段 | 数据源 | 状态 |
|---|---|---|---|
| 1 | 入库（sourced / RESUME_PROCESSED） | RAAS / 事件流 | 🔌 未接入（灰） |
| 2 | **规则预筛**（MATCH_RULE_CHECK，PASS/FAIL） | **`RuleCheckResult`** | ✅ 真 |
| 3 | 深度评分（EVALUATION_PASSED，score≥阈值） | 事件流（未按岗位聚合） | 🔌 未接入（灰） |
| 4 | 面试邀约（interviewInviter） | run + 事件 | 🔌 未接入（灰） |
| 5 | 人工确认（HITL · HSM accept） | `HumanTask` | 🔌 未接入（灰） |
| 6 | 已提交 / offer | 伙伴系统 | 🔌 未接入（灰） |

掉队分支：每环旁标 *已拦截 / 失败* 计数（预筛环的 FAIL 来自 `RuleCheckResult.decision`）。

## 6. 候选人状态映射（L2）

以 `RuleCheckResult` 每组最新一条为基，必要时按 `trace_id` 富化 `HumanTask`/`WorkflowRun`：

| 截图状态 | 来源判据 |
|---|---|
| 进行中 | decision=PASS 且无终态后续 |
| 待复核 | 该 trace 有 `HumanTask` pending（HITL 挂起） |
| 已拦截 | decision=FAIL（预筛拦截） |
| 失败 | 该 trace 关联 `WorkflowRun.status` ∈ {failed, timed_out} |
| 已提交 | 终态（offer/submitted；Phase 1 仅当有信号时） |

> REVIEW 已在写入侧折成 PASS（见既有 rule-check 契约），故不单独成状态。

## 7. API 表面

- **新增** `GET /api/funnel/jobs` → L1 按岗位：`JobRequisition` 列表 + 每岗位
  各阶段计数（仅预筛环为真，其余返回 `{ available:false }`）。
- **新增** `GET /api/funnel/candidates?job=<id>&stage=<k>` → L2 名单：
  `RuleCheckResult` 分组 + 状态映射 + `trace_id`。
- **新增** `GET /api/funnel/candidates`（无 job）→ 按候选人维度列表。
- **复用** `GET /api/correlations/:traceId` → L3 时间线（不改）。

所有聚合**读时**完成；未接入环统一返回 `available:false` + 数据源说明，由前端打灰。

## 8. 前端结构（遵循 CLAUDE.md 约定）

- `app/funnel/page.tsx`：薄壳 `<Shell crumbs=…><FunnelContent/></Shell>`。
- `components/funnel/FunnelContent.tsx`：维度切换 + 三级容器 + URL query 驱动。
- 子组件：`FunnelBar`（L1 横向漏斗，含未接入灰态）、`CohortList`（L2，可复用截图左栏样式）、
  L3 直接复用 `components/correlation/CorrelationContent` 的时间线渲染（抽出可复用部分，避免重复）。
- 颜色/状态点一律走 `--c-*` token 与 `atoms.tsx`（`StatusDot/Badge/Card`），不硬编码颜色。
- LeftNav 新增「追踪」项指向 `/funnel`（`nav_group_observe` 组内，紧邻 correlations）。

## 9. i18n

`lib/i18n.tsx` 新增键（zh+en 双份）：`nav_funnel`、漏斗阶段名 `fn_stage_*`、
状态名（复用现有或新增 `fn_status_*`）、`fn_data_not_wired`（「数据未接入」）、
维度切换 `fn_by_job`/`fn_by_candidate`、KPI 标签 `fn_kpi_*`。
用户可见处去开发者术语（事件名→业务语言 + badge），保留 `trace_id`/tokens 这类数据标识。

## 10. 错误处理与空态

- `RuleCheckResult` 为空 → L1/L2 显示空态（"暂无预筛数据"），不报错。
- `/api/correlations` 拿不到 → 沿用现有空态（参考既有 correlations 空态）。
- 任一聚合表缺失 → 该段降级跳过（沿用 correlations 路由的 `try/catch` 容错风格）。

## 11. 测试

- `/api/funnel/jobs`、`/api/funnel/candidates` 路由单测（vitest）：
  造 `RuleCheckResult` + `JobRequisition` 假数据，断言计数、状态映射、未接入环 `available:false`。
- 不为复用的 `/api/correlations` 重复写测（已有）。

## 12. 明确的范围外（留作后续 spec）

- **Phase B：补满漏斗。** 建 `RecruitmentFunnelEntry` 投影 + 事件流回填，
  给入库/评分/邀约/HITL/offer 各环补 `job_requisition_id` 归属，使漏斗每环都真。
- 跨岗位候选人去重的高级视图、漏斗时间区间对比、转化率趋势。
- 写操作（从漏斗里直接干预候选人）——属 Manage 轴，独立 spec。

## 13. 验收

1. `/funnel` L1 按岗位渲染真漏斗，预筛环数字来自 `RuleCheckResult`，其余环灰 +「数据未接入」。
2. 点预筛环 → L2 出真候选人名单（带 `trace_id`、状态映射正确）。
3. 点候选人 → L3 即现有端到端时间线，数据真。
4. 维度可切「按候选人」；URL query 支持深链与前进/后退。
5. 无 mock 数据撑场；未接入环不出现编造数字。
