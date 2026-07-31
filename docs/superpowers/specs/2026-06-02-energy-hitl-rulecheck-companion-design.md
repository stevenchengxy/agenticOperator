# 能源调度 — 真跑 + 人在环路 + 规则校验 agent + 配套工作台

- 日期:2026-06-02
- 状态:设计已批(经 Q&A 确认),实现中
- 作者:Claude + Steven
- 关联:[2026-06-02-ontology-agent-generator-runnable-design.md](./2026-06-02-ontology-agent-generator-runnable-design.md)

## 1. 目标

在已落地的「本体→可运行 Inngest agents」(能源 `能源调度-v1`,28 动作)基础上:

1. **真实模拟数据贯穿全链** —— 不再用 `simulateTools` 的通用占位 hash,改用一份与用例基线一致的确定性数据集(电站/机组/WX/HY/GZL/96点曲线/水位/置信度/关口偏差),分 4 个场景。
2. **新增确定性规则校验 agent** —— 替换 factory 里 LLM 版 `validateConstraints`,真正**筛查规则 → 二次验证抓取对不对 → 数值规则判断**,写审计存储 + agent 日志。可复用核,不同域/不同步骤可有各自 rule-check agent。
3. **人工闸口改为真 HITL** —— 3 个闸口(人工确认 / 风险处置 / 定版封口)挂起等外部决定(`step.waitForEvent`),并在 AO「消息通知 → 人工待办」落 `needs_human` 通知。
4. **配套平台「调度值班工作台」** —— 独立 Node 控制台(:4100),同步 AO 人工待办,发决定事件唤醒能源 agent 续跑。
5. **端到端跑通** —— 4 场景:`happy`(全自动→ARCHIVED)、`manual-review`(闸口①)、`risk-redline`(闸口②)、`finalize-confirm`(闸口③)。

## 2. Schema 对齐结论(已研究)

- **运行图 = snapshot(v0_1_003)**,与手册(neo4j v0_1_001)不同:`triageScheme→ROUTING_DECIDED`、`manualConfirm→MANUAL_REVIEW_DECIDED`、风险拆成 `raiseRiskEvent→handle{FloodControl,GridSecurity,Equipment,Curtailment}→resolveRiskAndResume→RISK_DISPOSED`、`finalizePlan` 为 Agent。08 文档按运行图写并附映射表。
- `validateConstraints` 只 emit `CONSTRAINT_VALIDATED`(带 `redlineFlag`+`violations`);红线走 `raiseRiskEvent`(trig on CONSTRAINT_VALIDATED)。**不新增 event 名**。
- `needs_human` 通知 = `recordNotification({level:'critical', dedupeHint:'energy_human_gate.*'})`。
- `step.waitForEvent` 全仓零先例,净新增;事件 `energy/HUMAN_DECISION`,`match:'data.caseId'`,timeout 30d。
- 能源 agent 自门控 `AgentVersion.status==active`,跑前写 active 行(deploy helper)。
- 招聘 `RuleCheckAudit` 字段强耦合(candidate/resume/job 必填),**不复用**;另建通用域规则校验存储。

## 3. 数据集 `server/inngest/domains/energy/sim-data.ts`(确定性,纯函数)

基线(用例 §2):ST0101 龙盘一级 2×300MW,正常蓄水 1620 / 汛限 1612 / 死水位 1580m;ST0102 3×150、ST0103 4×100、ST0104 2×120;ST0201 风电 200MW、ST0202 光伏 150MW。生态流量最小下泄 ≥ 300 m³/s(CR-HYD-03);送出断面限额 1300MW(CR-GRID-01);GZL 午高峰 ~1100MW(CR-GRID-03)。

`buildScenarioData(scenario)` 返回 `{ caseId 元信息(DS号), stations, units, wx, hy, gzl96[], suggest96{hydro,wind,solar,gateExport}, waterLevel, forecastConfidence, gzlDeviationPct, redline? }`:

| scenario | 水位 | 置信度 | 关口偏差 | 触发闸口 |
|---|---|---|---|---|
| happy | 1610.5m | 0.93 | 1.8% | 无(全自动) |
| manual-review | 1610.5m | 0.86 | 4.7% | ① manualConfirm |
| risk-redline | 1613.2m(>1612) | 0.93 | 1.8% | ② handleFloodControl |
| finalize-confirm | 1610.5m | 0.91 | 2.4% | ③ finalizePlan 封口(版本不符) |

seed payload 带 `scenario`;`ingestAndOpenCase` 把数据集塞进 case payload,逐段透传(上游 payload 累积)。

## 4. 规则校验核 + 能源 agent

**核** `lib/rule-check/engine/`(域无关):
- `selectRules(allRules, stage)` —— 筛查:按 `specificScenarioStage`/CR 组过滤出本步骤适用规则。
- `verifySelection(selected, expected)` —— 二次验证:断言期望的 CR-* 全部抓到(尤其 4 条硬红线)、每条解析字段完整,产出 `{ok, missing[], extra[], parseIssues[]}`;抓错/漏抓 → 校验挂起(不跳过)。
- `judge(rule, ctx)` —— 规则判断:每条规则一个确定性 evaluator(数值比较),返回 `{result: PASS|FAIL|CLAMPED|NA, checkPoint, before, after, hardSoft, defaultAction, risk?}`。

**能源 agent** `server/inngest/domains/energy/rule-check/validate-constraints-agent.ts`(手写,仿 `ruleCheckAgent`):trig `energy/SUGGESTION_GENERATED`;`fetchDomainOntology(能源调度-v1).rules` → `toRuleCheckRule`;按 PIPE-01 顺序 UNIT→HYD→GRID→SAFE→MKT 跑三阶段;emit `energy/CONSTRAINT_VALIDATED{redlineFlag, violations[], clampedSuggest}`;写通用审计存储 + `createAgentLogger`(`rules_selected`/`selection_verified`/`rule_judged`/`decision`)。从 factory 排除 `validateConstraints`,改注册此手写函数。

## 5. 通用域规则校验存储 + 看板

Prisma 新模型(域无关):
- `OntologyRuleCheck { id, domain, agentSlug, stage, caseId, runId, decision(VALIDATED|VIOLATED), redlineFlag, rulesSelected, rulesExpected, selectionOk, rulesEvaluated, createdAt, evals OntologyRuleCheckEval[] }`
- `OntologyRuleCheckEval { id, checkId, ruleId, ruleName, group, hardSoft, result, checkPoint, beforeVal, afterVal, defaultAction, riskType, riskLevel, createdAt }`

API:`GET /api/rule-check-audits?domain=能源调度-v1` 等非招聘域读通用存储(stats/list/detail);`isRuleCheckDomain` 扩为「招聘 || hasOntologyRuleCheck(domain)」。看板/审计面板:能源域读通用存储渲染(stats strip + run 列表 + 逐规则 eval 抽屉,含二次验证结果)。

## 6. HITL 闸口(factory 改造)

`GATE_ACTIONS = { manualConfirm, handleFloodControl, handleGridSecurity, handleEquipmentFault, handleRenewableCurtailment, finalizePlan(仅 confirm 场景) }`。gate 分支:
1. `recordNotification({level:'critical', category:'agent'|'event', source, message, runId:caseId, anchors:{caseId, DS, gate, RK?, AP?, evidence...}, dedupeHint})` → 落人工待办。
2. `decision = step.waitForEvent('await-decision', {event:'energy/HUMAN_DECISION', match:'data.caseId', timeout:'30d'})`。
3. 按 `decision.data.decision` emit:采纳→正常下游;退回→清 `generateSuggestion`(+`interpretData`)的 claim 并 emit 重算事件(真重入一轮);否决→记 REJECTED 重生成;暂缓→停。留痕 AP(前值/后值/理由)。

非 gate 的 simulated-human(switchOperatingMode/handoverShift/runOperationAudit/maintainConstraintConfig/validateAndDeploySystemChange)仍自动。

## 7. 唤醒端点 + 配套工作台

- `POST /api/energy/human-decision { notificationId, caseId, gate, decision, edits?, reason?, operator }` → 记决定到通知(managerAction/disposition=auto_handled/status=resolved) + `inngest.send('energy/HUMAN_DECISION', {caseId, gate, decision, edits, reason, operator})`。
- `companion/`(零依赖 `.mjs`,:4100):server 端代理 AO(`/api/notifications?needsHuman=1`、`/api/energy/human-decision`);单页渲染待办卡(闸口/案件 DS/证据 96点偏差·水位·RK/是·否按钮+改动+理由),点通过/退回调端点。

## 8. 部署 + 跑场景

- `POST /api/ontology-generator/run { domainId, scenario, enableBranches }`:写/翻能源 agents 的 `AgentVersion=active`(部署即激活)+ 发 seed `energy/DISPATCH_CYCLE_STARTED{scenario}`。redline 场景 `enableBranches:true`(放行 raiseRiskEvent)。

## 9. 测试与验收

- 单测:`sim-data` 4 场景断言;rule-check 核(selectRules/verifySelection/judge)数值用例;gate 决定路由(mock waitForEvent);chain smoke 各场景终态。
- 端到端:dev(:3002)+inngest(:8288)+工作台(:4100) → 部署 → 发场景 seed → `/audit` 看链路+规则判断日志 → 人工待办出卡 → 工作台点通过 → 挂起 agent 续跑到 ARCHIVED → `/rule-check` 看能源审计记录。
- `npm test` 绿 + `npm run build` 干净。

## 10. 边界(YAGNI)

不接真外部系统(慧采/EMS/省调 仍模拟);不做 Inngest 动态注册;不改招聘 production agents 与招聘 RuleCheckAudit;工作台只够演示(无鉴权/持久化)。
