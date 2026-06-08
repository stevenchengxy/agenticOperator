# Rule-Check 审计页:全规则筛选判断 + AI 验证

- **日期**:2026-06-08
- **状态**:设计已批准,待落实施计划
- **触发**:Run `01KTKGJ0QC8PQCTHZ6FVDVKFY4`(候选人陈思颖 · 腾讯 · TEST334)审计页只显示 4 条「选中」规则,被 fail-closed 排除的 10-42(CDG 专属)等 7 条规则完全不可见;页面还误显「规则库 4 → 过滤 0 → 没有规则被过滤」。

## 1. 目标

让规则检查审计页对**引擎考虑过的每一条规则**都展示两件事:

1. **确定性筛选判断** —— 纳入 / 排除 + 三层归属(tier)+ 理由(如「岗位 bg 未解析,部门专属规则(CDG)fail-closed」)。
2. **独立 AI 验证** —— 第二模型对「该不该这样筛选」的二次判断。

被排除的规则(如 10-42)由此变得可见,并带 AI 对「是否本该纳入」的意见。

**明确不改**:规则的 PASS/FAIL 判断逻辑(`规则的 AI 判断,目前保持不变`)。

## 2. 现状(为什么现在做不到)

| 层 | 文件 | 现状 | 问题 |
|---|---|---|---|
| 数据(写) | [server/inngest/agents/rule-check-agent.ts:542,549](../../../server/inngest/agents/rule-check-agent.ts) | `rule_provenance` 写了**全 11 条**(含排除,带 tier+reason);但 `rules_total_in_ontology` 被写成 `rules_evaluated`(=4),`filtered_out_rules` **根本没写** | 计数错;排除规则的名称没落库 |
| 数据(读) | [app/api/rule-check-audits/[auditId]/route.ts](../../../app/api/rule-check-audits/[auditId]/route.ts) | `rule_provenance` 透传(只 `{rule_id,tier,included,reason}`,无 rule_name);`filtered_out_rules` 解析自空字段 | 前端拿不到排除规则名称 |
| 验证 | [lib/rule-check/verify-prompt.ts](../../../lib/rule-check/verify-prompt.ts) | `rule_opinions` 仅对**选中**规则;system prompt 硬性要求「rule_opinions 恰好对应已评估规则」,排除规则只进 `missing_rules`/`over_included_rules` 的定性描述 | 排除规则没有逐条 AI 验证 |
| UI | [components/rule-check/RuleSelectionVerifyTab.tsx](../../../components/rule-check/RuleSelectionVerifyTab.tsx) | `AdaptedRules` 只渲染 `detail.flags`(选中);排除规则读独立的 `filtered_out_rules`(空)→ 折叠区不显示;因果链用错字段算计数 | 排除规则不可见;计数误导 |

**关键事实**:`rule_provenance` 已持久化全部 11 条(含 7 条排除 + 理由)。打包目录 [lib/rule-check/rules.json](../../../lib/rule-check/rules.json)(248 条)已确认覆盖本 Run 的全部排除 id(10-42/43/56/49/32/34/51),可按 id 补全名称/定义。

## 3. 路线选择

**A.（采用)读时 · provenance 驱动** —— `rule_provenance` 作为「所有规则」唯一事实源,排除规则的名称/定义读时按 id 从打包目录补全。**现存 audit 无需重跑**即可显示全规则 + AI 验证。零迁移、零 schema 改动。

**B.（部分顺带)持久化矫正** —— 修 `rules_total_in_ontology`、补写 `filtered_out_rules`。作为**前向数据矫正**顺带做,UI **不依赖**它(承重逻辑全在 A)。

放弃「重铺 fetcher→runner→agent 并重跑」作为承重方案:现存 audit 不重跑看不到效果,改动面更大。

## 4. 设计细节

### 4.1 Verify prompt + schema —— 覆盖排除规则
文件:[lib/rule-check/verify-prompt.ts](../../../lib/rule-check/verify-prompt.ts)

- 复用**现有单次** verify LLM 调用,不新增第二次调用(零额外成本/延迟)。
- `VerifyPromptInput` 新增:
  ```ts
  excluded_rules: Array<{
    rule_id: string; rule_name: string;
    applicable_client: string; applicable_department: string;
    tier: string; reason: string; definition: string;  // definition 来自目录 standardizedLogicRule
  }>;
  ```
- `composeVerifyPrompt` 新增一段「## 被排除的规则(逐条判断:该不该排除)」,列出每条排除规则的定义 + 确定性排除理由,要求 LLM 对**每条**也产出一条 `rule_opinion`。
- **复用 `selection_ok` 语义** =「该不该为此候选人×岗位纳入」:
  | 实际状态 | selection_ok | UI 解读 |
  |---|---|---|
  | 纳入 | true | 筛选正确 |
  | 纳入 | false | 疑似多纳入 |
  | 排除 | false | 排除正确 |
  | 排除 | true | **疑似漏选(AI 认为应纳入)** ← 10-42 信号 |
- 排除规则:`second_verdict = NOT_APPLICABLE`(未评估过 PASS/FAIL),`judgment_reasoning`/`dimensions` 可省。
- system prompt:把「rule_opinions 恰好对应已评估规则」放宽为「已评估规则 + 被排除规则,各恰好一条意见」。
- `parseVerification`:已按 rule_id keying;一致率计算已用 `if (resultByRuleId.has(rule_id))` 守卫 → 排除规则**不污染** `agreement_rate`。需确认 parser 保留 rule_id 不在 flags 中的意见(当前保留,`original_result='UNKNOWN'`,符合预期)。

### 4.2 Verify route —— 构造 excluded_rules
文件:[app/api/rule-check-audits/[auditId]/verify/route.ts](../../../app/api/rule-check-audits/[auditId]/verify/route.ts)

从 `rule_provenance.filter(p => !p.included)` 构造 `excluded_rules`,逐条按 `rule_id` 用 `loadAllRules()` 查目录补 `rule_name` / `applicable_client` / `applicable_department` / `definition`;目录查不到则降级为「仅 id + reason」。传入 `composeVerifyPrompt`。

### 4.3 详情 API —— 给 provenance 补名称
文件:[app/api/rule-check-audits/[auditId]/route.ts](../../../app/api/rule-check-audits/[auditId]/route.ts)

`RuleCheckAuditDetail.rule_provenance` 每条加 `rule_name?: string`,服务端按 id 查目录补全(复用 `loadAllRules`/`severityForRuleId` 同源)。前端因此无需打包 248 条 JSON。

### 4.4 UI —— provenance 全量驱动 + 分组
文件:[components/rule-check/RuleSelectionVerifyTab.tsx](../../../components/rule-check/RuleSelectionVerifyTab.tsx)

- `AdaptedRules` 改由 `detail.rule_provenance`(全量)驱动,分两组渲染,都用现有可展开卡片 `AdaptedRuleCard`:
  - **选中 (N)** —— 维持现状(纳入理由 + AI `selection_ok`;full 模式另有 PASS/FAIL)。
  - **未选中 · 排除 (M)** —— 新:排除徽章 + tier + 排除理由 + AI `selection_ok`(排除正确 / 疑似漏选);**不显示 PASS/FAIL 块**(规则判断保持不变)。
- 卡头派生标签:按 §4.1 四象限表。`排除 + selection_ok=true`(疑似漏选)用红/警示色突出。
- 因果链计数改为派生自 provenance:`规则库 {prov.length} 条 → 排除 {excludedCount} 条 → 选中 {includedCount} 条`;当存在排除规则时去掉「没有规则被过滤」。
- 选中规则的 flag 与 provenance 用 rule_id 关联(已有 `provById`);排除规则直接用 provenance(已带 rule_name)。

### 4.5(顺带)写入矫正 —— 不承重
文件:[server/inngest/agents/rule-check-agent.ts](../../../server/inngest/agents/rule-check-agent.ts)

- `rules_total_in_ontology` 改写为真实总数(provenance 长度 / 目录候选数),不再等于 `rules_evaluated`。
- 持久化 `filtered_out_rules`(从排除 provenance + API 规则元数据)。
- 纯前向矫正:新 audit 数据自洽;UI 不依赖此项(读时仍以 provenance 为准)。

## 5. 单元边界与数据流

```
rule_provenance (全量, 已持久化)
        │  读时按 id 补 rule_name / definition (loadAllRules, 服务端)
        ├──────────────► 详情 API: provenance[].rule_name ──► UI 全量分组渲染
        └──────────────► verify route: excluded_rules ──► verify prompt
                                                              │ 单次 LLM
                                                              ▼
                                       rule_opinions(选中 + 排除, 各一条 selection_ok)
                                                              │
                                                              ▼
                                       UI 卡片: 每条规则 = 确定性筛选判断 + AI 验证
```

每个单元职责单一、接口清晰:
- **目录补全器**(read-time enrich):输入 rule_id → 输出 name/definition;依赖打包目录。
- **verify-prompt**:输入选中 flags + excluded_rules → 输出每条 selection_ok。纯函数,可测。
- **detail/verify route**:组装 + LLM 调用。
- **UI AdaptedRules**:输入 provenance + flags + opinions → 渲染。

## 6. 测试(TDD)

- `verify-prompt.test.ts`:`composeVerifyPrompt` 输出含「被排除的规则」段且列出排除 id;`parseVerification` 保留排除规则意见、且**不计入** `agreement_rate`。
- 详情 API:`rule_provenance` 每条带 `rule_name`(由目录补全)。
- 计数派生:total/filtered/selected 由 provenance 算出(可作纯函数小测)。
- UI:沿用现有组件测试模式(若无则以数据层测试 + 手动 `verify` 走查 Run `01KTKGJ0QC8PQCTHZ6FVDVKFY4` 兜底)。

## 7. 验收

在现存 audit `rca_no-trace_JRQ-a5f6029a-8af8-4f9a-81e8-7c594cc52aa8-TEST334_1780918850764`(**不重跑**)上:
- 「适配规则」显示全部 11 条,分「选中 4 / 排除 7」两组。
- 10-42 出现在排除组,确定性理由 =「岗位 bg 未解析,部门专属规则(CDG)fail-closed」。
- 运行交叉验证后,10-42 带 AI `selection_ok` 意见(若 AI 认为应纳入 → 红色「疑似漏选」)。
- 因果链显示「规则库 11 → 排除 7 → 选中 4」,不再显示「没有规则被过滤」。

## 8. 不做(YAGNI)

- 不改 PASS/FAIL 判断逻辑。
- 不改 ontology API 服务端预过滤(Human-executor / optional 规则仍被服务端剔除,不纳入「所有规则」范围 = 11 条 Agent+mandatory 候选集)。
- 不做 schema 迁移(provenance 已是现成字段)。
