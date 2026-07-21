# 外部依赖健康度(External Dependency Health)— 设计文档

- **日期**:2026-06-05
- **状态**:设计已定,待落实现计划(writing-plans)
- **作者**:Steven + Claude
- **范围**:Monitor 轴(观测 + 告警),不含 Manage 轴的写操作(自动暂停 agent 是后续)

---

## 1. 问题陈述

AO 的 5 个招聘 agent 都依赖外部付费服务:

| Agent | 外部调用 | 厂商 |
|---|---|---|
| resume-parser | 简历解析 | RoboHire |
| create-jd | 生成 JD | RoboHire |
| match-resume | 简历匹配 | RoboHire |
| interview-inviter | 面试邀约 | RoboHire |
| rule-check | 规则校验推理 | LLM 网关 |

当 **RoboHire 没钱了 / LLM 网关没额度了**,外部调用失败或返回空内容,这个 run **本应失败**,但今天在 Inngest 里**仍显示成功**,且**消息通知里没有任何告警**。运营无法察觉一个付费依赖已经"断供",候选人被静默丢弃。

### 1.1 同一个症状,5 个 agent 有三种不同表现

调研结论 —— 这不是一个 bug,是三种形态,所以修法要统一:

| Agent | 没钱时今天的行为 | Inngest 显示 | 进消息通知? |
|---|---|---|---|
| match-resume | catch 402 → 返回 `{ok:false}` + 发 `MATCH_FAILED` 事件 | ✅ 成功 | ❌ |
| interview-inviter | catch 402(`ROBOHIRE_QUOTA`)→ 发 `INTERVIEW_INVITATION_FAILED` | ✅ 成功 | ❌ |
| resume-parser | `throw NonRetriableError`,候选人静默丢弃 | ❌ 失败/无重试 | ❌ |
| create-jd | `throw NonRetriableError` | ❌ 失败 | ❌ |
| rule-check | `llm-call-error` → infra-fail → throw → 重试+park | ⏸ park | ⚠️ 部分 |

(参照:`server/inngest/agents/*.ts`、`lib/robohire-client.ts:117`、`lib/rule-check/runner.ts`、`server/inngest/domains/energy/make-agent.ts:47` 的 `safeLlm` 把 LLM 错误吞成 `''`。)

### 1.2 两个让问题"很可修"的事实

1. **信号已经在源头**:`lib/robohire-client.ts:117` 在 402 / `200+success:false` 时抛 `RobohireApiError`,`code` 可为 `QUOTA_EXHAUSTED`。"没钱了"是**精确的结构化信号**,不必从空输出去猜。
2. **现有监控骨干天生看不到**:`lib/monitor/`(health/sla/cost/error-rate)读的是 Inngest **归档**(run 状态、step 时长、token)。match/invite 的 run 是**绿的**,所以现有任何监控都永远抓不到 —— 必须新增一个检测信号,调阈值没用。

### 1.3 硬约束:只能在 AO 侧做

**我们改不了 RoboHire 或大模型厂商一行代码。** 只能读厂商返回给我们的东西(HTTP 状态码、错误体、响应内容),在 AO 侧**判断 + 发消息**。本设计全部组件都在 AO 侧。

---

## 2. 目标 / 非目标

### 目标
- 侦测外部依赖"断供",覆盖三种形态:**结构化额度/错误码**、**200-空响应/退化成功**、**LLM 返回空文本**。
- **在 AO 侧判断**这是"没钱了 / 故障了 / 说不准",并据此发不同的消息 + 建议动作。
- 让受影响的 run **不再假成功**(退化时让 run 失败/park)。
- 在**消息通知**里发一条 **去重、按业务域分区、critical** 的告警;**充值/恢复后自动关闭**。

### 非目标(本 spec 不做)
- 不改 RoboHire / 大模型厂商。
- 不做"自动暂停 agent"(熔断)—— 属 Manage 轴,后续独立 spec。
- 能源域 `safeLlm` 的静默吞错 —— 同类病、不同域,默认不纳入(见 §9 边界),可选后续。
- 不引入 LLM 来做判断 —— 判断逻辑是确定性的,符合 `feedback_ao_observability_not_inngest` 与监控骨干"纯函数、零 LLM"的基调。

---

## 3. 已锁定的决策(来自 brainstorm)

1. **出问题后的动作**:告警 **+ run 标失败**(不再是假成功)。
2. **侦测范围**:结构化错误 **+ 空响应** 都要管。
3. **判断粒度**:**三档** —— 没钱了 / 故障了 / **说不准**(弱信号判不出时诚实上报,不瞎猜)。
4. **架构**:方案 C —— 源头写信号 + 骨干监控聚合/自动关闭。
5. **信号存储**:复用 `LogEvent`(零迁移),不另开表。
6. **可恢复原因(quota 等)**:run 用 **park + 重试**,充值后候选人自动续跑,不永久丢弃。

---

## 4. 架构与数据流

```
外部调用 (RoboHire / LLM)
        │  厂商返回 status / 错误体 / 响应体
        ▼
① 分类器 classify.ts  ── 纯函数,判 ok / {provider, op, reason, detail}
        │  reason ∈ {quota, auth, rate_limit, empty, server, network}
        ▼  (退化时)
② reportDependencyDegraded(outcome, ctx)
        ├─ 写 LogEvent  type='dependency_degraded'  payload={provider,op,reason,domain,anchors}
        ├─ (match/invite) 照旧 step.sendEvent('*_FAILED')
        └─ throw  → run 失败/park(可恢复→park 重试)
        ▼
   [LogEvent 表 — 零迁移信号槽]
        ▼  每 60s,扫 15min 窗口
③ MonitorReadPort.dependencyFailures(windowMs)  ── pg-read-port 读上面的 LogEvent
        ▼
④ dependency 监控 dependency.ts ── 纯函数
        ├─ 按 (provider, domain) 分组
        ├─ 三层证据判 没钱/故障/说不准(§6)
        ├─ findings: dedupeKey='dep_down.<provider>.<domain>', level=critical, domain
        └─ activeKeys → sweeper.resolveStale 自动关闭已恢复的
        ▼
⑤ recordNotification → 消息通知
        ├─ 一条带 count(去重),按域分区
        ├─ critical 首现 → 懒加载 AI 摘要 + 建议动作
        └─ 恢复 → 自动翻"已解决"
```

---

## 5. 组件设计

### ① 退化分类器 —— 单一事实来源

新建 `lib/dependency-health/classify.ts`,纯函数:

```ts
export type DepReason = 'quota' | 'auth' | 'rate_limit' | 'empty' | 'server' | 'network';
export type DepProvider = 'robohire' | 'llm';

export type DepOutcome =
  | { ok: true }
  | { ok: false; provider: DepProvider; op: string; reason: DepReason; detail: string };

export function classifyRobohire(op: string, errOrData: unknown): DepOutcome;
export function classifyLlm(op: string, errOrText: unknown): DepOutcome;
```

**结构化错误映射**(读厂商返回):
- RoboHire:`RobohireApiError.code` → `QUOTA_EXHAUSTED`→`quota`、429→`rate_limit`、`NETWORK`→`network`、`SERVER`/5xx→`server`、4xx(非 429)→`auth`(若 401/403)或客户端坏输入。
- LLM:`GatewayUnavailableError`、错误体含 `insufficient_quota`/`quota`/`billing`→`quota`;429→`rate_limit`;timeout/连接错误→`network`;5xx→`server`;401/403→`auth`。

**空响应谓词**(200 但没用),每种调用一个 `isEmptyPayload(op, data)`:
- 简历解析:抽不出任何可用字段(name/phone/education(endDate)/experience 全无,或 data 为 `{}`/null)。
- 匹配:无分数 / `overall_fit` 缺失。
- 生成 JD:正文空白 / 缺失。
- 邀约:无 invite id。
- LLM:`text.trim() === ''`。

> 谓词的确切字段名在 writing-plans 阶段对照 `lib/robohire-client.ts` 的类型确认。参照 `reference_robohire_no_gender`(parse 字段)、`reference_robohire_generate_jd_no_skill_arrays`(JD 字段)。

### ② reportDependencyDegraded —— 上报 + 让 run 失败

新建共享 helper(放 `lib/dependency-health/report.ts` 或 `server/` 下),5 个 agent 在各自已有 catch / 返回点调用:

```ts
reportDependencyDegraded(outcome: Extract<DepOutcome, {ok:false}>, ctx: {
  logger: AgentLogger; runId?: string|null; domain: string;
  anchors?: Record<string,string|null|undefined>;
}): never  // 总是 throw
```

做两件事:
1. **写结构化信号**:走 `recordLogEvent`(见 `server/agent-logger.ts:139`),但 `type: 'dependency_degraded'`、`payloadJson: {provider, op, reason, domain, anchors, inngestRunId}`。**零迁移**,类型独立 → 监控查询精确。
2. **throw,让 run 不再假成功**:
   - 可恢复(`quota`/`rate_limit`/`network`/`server`)→ 抛**可重试**错误 → run park + 退避重试 → 充值/恢复后候选人**自动续跑**。
   - 不可恢复(`auth` 中的坏凭证 / 客户端坏输入)→ `NonRetriableError` 直接失败。
   - 两者都满足"run 标失败 / 不再绿"。
   - match/invite:**先**照旧 `step.sendEvent('*_FAILED')` 保住下游上下文,**再** throw。

**每个 agent 的接入点**:
- `resume-parser-agent.ts:158-219`:catch 后 classify;成功路径加空响应检查;退化→report→throw。
- `create-jd-agent.ts:217-246`:同上。
- `match-resume-agent.ts:110-162`:catch / `ok:false` 分支 → classify → report(保留 `MATCH_FAILED`)。
- `interview-inviter-agent.ts:183-294`:已有 `QUOTA_EXHAUSTED` 分类 → report(保留 `INTERVIEW_INVITATION_FAILED`)。
- `rule-check-agent.ts` + `lib/rule-check/runner.ts`:run-fail 已正确(infra-fail 已 throw+park);在该 infra-fail 点**追加** `reportDependencyDegraded(provider='llm', ...)`,并在 runner 里加 LLM 空文本检测。

### ③ MonitorReadPort 扩展

`lib/monitor/monitor-types.ts` 的 `MonitorReadPort` 加:

```ts
dependencyFailures(windowMs: number): Promise<DepFailure[]>;
// DepFailure = { provider, op, reason, domain, runId, ts, anchors }
// 读最近 windowMs 内 type='dependency_degraded' 的 LogEvent
```

`pg-read-port.ts` 实现。`DEFAULT_THRESHOLDS` 加:`depFailWindowMs: 15*60_000`、`depFailMinCount`(见 ④)。`domainForRun` 的同款命名空间→域映射用于给信号打 domain。

### ④ dependency 监控 —— 聚合 + 三档判断 + 自动关闭

新建 `lib/monitor/dependency.ts`,和 health/error-rate 同构纯函数:

- 读 `port.dependencyFailures(depFailWindowMs)`,按 `(provider, domain)` 分组。
- 每组按 §6 三层证据判 `没钱了 / 故障了 / 说不准`。
- **触发阈值**:`quota`/`auth`(钱/凭证)→ N≥1 立即报;`empty`/`server`/`network`/`rate_limit`(可能抖动)→ N≥`depFailMinCount`(默认 2)才报。
- finding:`dedupeKey='dep_down.<provider>.<domain>'`、`level='critical'`(说不准首报可 `warn`,持续升 `critical`)、带 `domain`、`source` 用友好名(`RoboHire`/`AI 网关`)、消息按判断结果选文案(§5⑤)。
- `activeKeys` = 本 tick 在烧的 key → sweeper 的 `resolveStale` 自动关闭不再出现的 key(窗口内不再失败 = 已恢复)。
- 在 `scripts/monitor-sweeper.ts` 的 monitors 数组注册一行。

### ⑤ 消息通知文案 —— 三种判断,三种消息

去开发者黑话(遵 `feedback_ao_no_dev_jargon_ui`):不出现 `402`/`QUOTA_EXHAUSTED`/函数名;保留 model/tokens 这类数据。

```
🔴 没钱了    RoboHire 额度耗尽 · 招聘域 · ×23
            近 15 分钟简历解析/匹配 100% 失败且持续未恢复 → 判定额度耗尽。
            建议:充值;受影响候选人将自动续跑。  [查看受影响运行]

🟠 故障了    RoboHire 疑似故障 · 招聘域 · ×8
            近 15 分钟间歇性服务端错误/超时 → 判定厂商故障(通常自愈)。
            建议:持续 N 分钟未恢复再联系厂商;候选人排队重试中。

⚪ 说不准    RoboHire 持续异常 · 招聘域 · ×12
            持续返回空结果/凭证异常,AO 无法区分欠费还是故障。
            建议:人工核查账户余额与服务状态。
```

- 一条带 count,不是 N 条(`recordNotification` 按 `dedupeKey` 去重 + 累加)。
- critical 首现 → 已有的"懒加载 AI 摘要"自动补 [建议动作]。
- 自动翻"已解决"。

---

## 6. 核心:AO 侧怎么判"没钱了 / 故障了 / 说不准"

厂商信号是脏的(没钱可能是 402,也可能 401、也可能 200-空体)。所以用**三层证据**加权,而非认死一个状态码:

| 证据层 | 倾向"没钱了" | 倾向"故障了" | 说不准 |
|---|---|---|---|
| **① 直接信号**(状态码/错误体关键词) | 402、`quota`/`balance`/`insufficient`/`billing`/`credit`/`payment` | 5xx、超时、连接重置、DNS 失败 | 401/403、429、**200-空体** |
| **② 范围**(窗口内失败占比) | 接近 100%、突然、全候选人一起挂 | 间歇、只挂一部分 | 零散少量 → 可能只是单条输入没数据,**先不报** |
| **③ 持续性**(跨监控窗口) | 持续、不自愈(钱不到不会自己好) | 抖动、会自愈 | — |

**判断规则**:
1. 有直接的钱信号(`quota`)→ **没钱了**(高置信)。
2. 全是 `server`/`network`/`rate_limit` 且间歇 → **故障了**。
3. 只有弱信号(`auth`/`empty`/`rate_limit` 模糊)→ 用范围+持续性兜底:
   - 接近 100% 失败 **且** 持续数分钟不恢复 → **没钱了/系统性**;
   - 间歇 → **故障了**;
   - 仍判不出 → **说不准**。

**"持续性"几乎白送**:sweeper 本就每 60s 扫 15min 窗口,"持续不自愈" vs "抖一下就好"它天然看得到 —— AO 不问厂商,光看自己窗口里的失败形态就能区分。

**实现风险(writing-plans 要解的)**:第②层"失败占比"需要分母(窗口内总调用数)。来源候选:RoboHire client 对每次调用已写的 `tool` 类 LogEvent 可作分母;若不可靠,**降级为只用①+③**(直接信号 + 持续性),不阻塞主体。

---

## 7. 数据模型(零迁移)

复用现有 `LogEvent`(`recordLogEvent`,`server/log/log-event.ts`):
- `type`: `'dependency_degraded'`(新值,独立可查)。
- `agent`: 触发的 agent 短名。
- `runId`: Inngest run id(可空)。
- `payloadJson`: `{ provider, op, reason, detail, domain, anchors }`。

不新增表、不改 schema。监控读口按 `type='dependency_degraded'` + 时间窗查询。

---

## 8. 测试策略(TDD)

- **分类器 ①**:逐 `(provider, op)` 单测 —— 结构化错误码映射 + 每种空响应谓词;边界(`{}`、null、空字符串)。
- **监控 ④**:假 port 纯函数测(同现有 monitor 测法)—— 分组、三档判断规则、阈值(quota N≥1 / 其余 N≥2)、`activeKeys` 关闭逻辑、说不准升级。
- **读口 ③**:对 `LogEvent` 的集成测(写 `dependency_degraded` → `dependencyFailures` 读回)。
- **Agent 集成**:402 / 空-200 → 确实 throw(run 失败/park)+ 写了 `dependency_degraded` 信号 + match/invite 仍发 `*_FAILED`。参照现有 `route.test.ts` 模式。

---

## 9. 边界与后续

- **能源域 `safeLlm`**(`server/inngest/domains/energy/make-agent.ts:47`):把 LLM 错误吞成 `''`,同类病、不同域,**默认不纳入本 spec**。后续:让它复用 ② 的 helper。
- **自动暂停 agent(熔断)**:Manage 轴,后续独立 spec。
- **分母/失败占比**:见 §6 实现风险,可降级。

---

## 10. 我替你定了、可推翻的默认值

1. 信号存 `LogEvent`(零迁移),不另开表。
2. `quota` 类 → 可重试 park(充值自动续跑),不硬失败永久丢候选人。
3. 阈值:`quota`/`auth` 立即报(N≥1),`empty`/`server`/`network`/`rate_limit` 攒到 2 次。
4. 窗口 15min(对齐 error-rate),sweep 60s。
5. `safeLlm`(能源域)不纳入本 spec。
6. "说不准"首报 `warn`,持续升 `critical`。
