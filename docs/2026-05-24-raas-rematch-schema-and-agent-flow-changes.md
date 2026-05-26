# RaaS 重匹配适配 — schema 改动与 agent 事件流对照

**日期**: 2026-05-24
**触发**: RaaS Web Console 上线"更换关联岗位"/"匹配同序列岗位"两个功能,需要 AO 端能接受 RaaS 直发的 thin event `RESUME_PROCESSED`。
**架构前提**: AO 与 RaaS 共用一台 shared Inngest(commit `f191ae9` 后)。**不是** 双 Inngest + bridge 拉桥。
**相关文档**:
- [2026-05-22-ao-raas-event-architecture.md](./2026-05-22-ao-raas-event-architecture.md) — single-Inngest 架构总览
- [requirements_from_RAAS/2026-05-22-raas-rematch-events-ao-adaptation-design.md](./requirements_from_RAAS/2026-05-22-raas-rematch-events-ao-adaptation-design.md) — RaaS 端两功能设计
- [requirements_from_RAAS/2026-05-23-raas-rematch-events-ao-adaptation.md](./requirements_from_RAAS/2026-05-23-raas-rematch-events-ao-adaptation.md) — RaaS 端的实现 plan(基于双 Inngest 假设,与本次架构不一致)

---

## 0. TL;DR

| 维度 | 数字 |
|---|---|
| Schema 改动文件 | 1 个([server/em/schemas/builtin.ts](../server/em/schemas/builtin.ts)) |
| Schema 实质修改行 | 1 行(`upload_id` 必填 → 可选)+ 2 行显式 optional 字段(可读性) |
| UI cosmetic 改动 | 1 行([components/events/EventInstancesTab.tsx:185](../components/events/EventInstancesTab.tsx#L185)) |
| Agent 代码改动 | **0 行**(三个 real agent `resumeParserAgent`/`ruleCheckAgent`/`matchResumeAgent` 全部不动) |
| 配置改动 | 0(`.env.example` / `.env.local` 已齐) |

**核心洞察**: 三个真实 agent 在 2026-05-19 consolidation 时就已经把"thin event back-pull"和"path A 单 JR"两条分支预埋好了。RaaS 这两个新功能在 agent 视角下就是流程"短路版"——只是少了上游 `RESUME_DOWNLOADED → resumeParserAgent` 两跳,从 `RESUME_PROCESSED` 进来后链路完全一样。本次唯一缺口是 `RESUME_PROCESSED_v1` schema 的 `upload_id` 必填会把 RaaS thin event 拦在 `em.publish` 路径上(详见 §3 关于"hot path 是否过 em.publish"的细节)。

---

## 1. Schema 改动详解

### 1.1 [server/em/schemas/builtin.ts:62-83](../server/em/schemas/builtin.ts#L62-L83) — `RESUME_PROCESSED_v1`

#### 改动前

```ts
const RESUME_PROCESSED_v1 = envelope(
  z.object({
    upload_id: z.string().min(1),          // 必填,非空
    parsed: z
      .object({
        data: z.record(z.string(), z.unknown()),
      })
      .optional(),
    job_requisition_id: z.string().optional(),
  }).passthrough(),
);
```

含义:
- `payload.upload_id` **必填**,且非空字符串。RaaS thin event 无此字段,直接被 zod 拒绝。
- `payload.parsed.data` 可选(允许 thin event 不带 parsed 体)。
- `payload.job_requisition_id` 可选(fat-event 默认不带;重派功能必带新 JR)。
- `.passthrough()` 表示其他字段(`candidate_id`、`resume_id`、`reassign_trigger`、`operator_id` 等)放行不校验,只是不出现在静态类型里。

#### 改动后

```ts
// 2026-05-24: upload_id 由必填改可选 — RaaS Web Console "更换关联岗位" / "匹配
// 同序列岗位" 两个功能不带 upload_id,只发 candidate_id + resume_id +
// job_requisition_id 的 thin event,由 ruleCheckAgent back-pull partner-pg 补齐
// parsed。ruleCheckAgent 第 94-96 行本就接受 upload_id 缺失;此处修 schema 与
// agent 契约不一致。candidate_id / resume_id 显式 .optional() 仅为可读性,
// .passthrough() 本就放行。
// 见 docs/2026-05-22-ao-raas-event-architecture.md §7
const RESUME_PROCESSED_v1 = envelope(
  z.object({
    upload_id: z.string().min(1).optional(),   // ★ 必填 → 可选
    candidate_id: z.string().optional(),       // ★ 新增:显式列出(原靠 passthrough)
    resume_id: z.string().optional(),          // ★ 新增:显式列出(原靠 passthrough)
    parsed: z
      .object({
        data: z.record(z.string(), z.unknown()),
      })
      .optional(),
    job_requisition_id: z.string().optional(),
  }).passthrough(),
);
```

#### 三点行为差异

| 形态 | 改动前 | 改动后 |
|---|---|---|
| AO 自产 fat-event(`resumeParserAgent` 出口,有 `upload_id` + `parsed`) | 通过 | 通过(无变化) |
| RaaS 重派 thin-event(无 `upload_id`,带 `candidate_id` + `reassign_trigger`) | **拒绝** `payload.upload_id: Required` | **通过** |
| 既不带 `upload_id` 也不带 `candidate_id` 的畸形事件 | 拒绝(`upload_id` required) | 通过 schema(但下游 `ruleCheckAgent` 第 94-96 行会 `NonRetriableError`) |

最后一行是个权衡:schema 不再做这个交叉校验,把这层防御推到 agent handler 第 94-96 行兜底(本来就有)。这是合理的——schema 该做"形状"校验,"业务必填的组合关系"留给 agent。

### 1.2 [components/events/EventInstancesTab.tsx:185](../components/events/EventInstancesTab.tsx#L185) — UI hint

纯 cosmetic 改动。改动前:

```
EventInstance 行由 em.publish 写入。raas-bridge 上 VPN 后会自动产生流量；
离线时可用 POST /api/em/publish 发测试事件。
```

改动后:

```
EventInstance 行由 em.publish 写入。shared Inngest 上 RaaS 直接 send 事件即可
路由到订阅 agent;离线时可用 POST /api/em/publish 发测试事件。
```

原文还在描述"双 Inngest + raas-bridge 拉桥"的旧架构(commit `f191ae9` 之前)。当前架构下 RaaS 直发 shared Inngest,没有 VPN/bridge 这一环。

### 1.3 没动的 schema(同事提的 plan 有列,但与本架构无关)

| 提议(出自 RaaS plan) | 在 single-Inngest 架构下评估 | 决定 |
|---|---|---|
| `RAAS_BRIDGE_EVENTS` 加入 `RESUME_PROCESSED` | bridge 默认关([.env.example:330-336](../.env.example#L330-L336)),env 改了也无效 | **不动** |
| `tick()` 按 `reassign_trigger`/`same_sequence_trigger` 内容过滤防成环 | bridge 不跑,无环可防 | **不动** |

---

## 2. 关于 schema "实际是否生效"的一个细节(很关键)

`RESUME_PROCESSED_v1` schema **只在通过 `em.publish` 写事件的路径上被校验**。

### 2.1 哪些路径过 `em.publish`

- AO 内部 agent emit(`step.sendEvent` → 走 Inngest SDK,在我们这里没有强制走 `em.publish`;但 raas-bridge 走 `em.publish`)
- raas-bridge `tick()` 拉到事件后调 `em.publish`([raas-bridge.ts:115](../server/inngest/raas-bridge.ts#L115))— 在我们架构下 bridge 关掉
- `POST /api/em/publish` 测试入口

### 2.2 哪些路径**不过** `em.publish`

- **RaaS Backend 直接 `inngest.send()` 到 shared Inngest** ← single-Inngest 架构下重派/同序列功能走的就是这条路
- shared Inngest 直接根据事件名路由到订阅 agent;AO 的 `ruleCheckAgent` 在 [/api/inngest](../app/api/inngest/route.ts) 反向 callback 被触发,不经 `em.publish` 这一层

### 2.3 那本次 schema 改动到底为什么要做?

三个理由:

1. **修 schema ↔ agent 契约不一致**:`ruleCheckAgent` 第 94-96 行明文允许 `upload_id` 缺失("有 `candidate_id` 即可"),但 schema 写的是必填——契约自相矛盾。修了避免下次读代码的人困惑。
2. **走 `em.publish` 的副路径会被解锁**:若将来 RaaS 改走 raas-forward,或者本地用 `POST /api/em/publish` 模拟 RaaS 事件做联调,schema 会先于 agent 拦下 thin event。修了之后这两个副路径也能跑通。
3. **EventDefinition Neo4j 同步的对齐**:若 Neo4j 那张 `EventDefinition` 表里有 `RESUME_PROCESSED` 行而且 `upload_id` 是 required,em registry 会优先用 Neo4j 行,届时 builtin 改动失效。这条本次没解决——见 §5 验证项 V3。

### 2.4 所以本次改动的真实"hot path 影响"

| 场景 | 是否被本次 schema 改动直接修复 |
|---|---|
| RaaS Backend 直发 shared Inngest → AO ruleCheckAgent(主路径) | 不直接修复(本来就不走 em.publish);但 ruleCheckAgent 第 94-96 行已经接受 thin event |
| 通过 `POST /api/em/publish` 模拟测试 RaaS thin event | **直接修复**(本次之前会被拒) |
| 本地 raas-bridge 临时开起来联调 | **直接修复**(em.publish 路径) |
| 未来 EventDefinition 从 Neo4j 同步覆盖 builtin | 见 §5 V3 |

简言之:**这次的 schema 改动是"该做"而非"必须做"——hot path 上 agent 早已能消化 thin event;但放着不修就是知道有 bug 不修。**

---

## 3. 每个 agent 的事件流详细对照

下面把流程 ②(简历主链路)和流程 ③(重派/同序列)的 4 个 agent 跳点逐个拆开。本次改动**仅影响 §3.3 ruleCheckAgent 的"事件能不能到 handler"前置环节**,handler 内部逻辑零变化;`resumeParserAgent` 与 `matchResumeAgent` 整段不变。

### 3.1 `resumeParserAgent` — 完全不变

#### 注册
- 文件: [server/inngest/agents/resume-parser-agent.ts](../server/inngest/agents/resume-parser-agent.ts)
- 订阅触发: `RESUME_DOWNLOADED`
- 输出事件: `RESUME_PROCESSED`(fat event,带 `upload_id` + `parsed`)
- 出口处: [resume-parser-agent.ts:372-375](../server/inngest/agents/resume-parser-agent.ts#L372-L375)

#### 步骤(改动前 / 改动后**完全一致**)
1. MinIO 拉 PDF binary
2. POST RoboHire `/parse-resume` → 拿结构化 4 对象(`name` / `experiences` / `educations` / `skills` 等)
3. partner Postgres 写 `candidate` + `resume`(dual-write)
4. Allmeta → Neo4j 写 `Candidate` / `Resume` / `Education` 实例
5. `step.sendEvent('emit-resume-processed', { name: 'RESUME_PROCESSED', data: { upload_id, candidate_id, resume_id, parsed: { data: {...} }, ... } })`

#### 跟本次改动的关系
零关系。`resumeParserAgent` 出口的事件 100% 带 `upload_id`(`processedPayload` 必填该字段),无论 schema 改不改都通过。

#### 在两条主路径里的位置
- **正常上传链路**:RaaS Nextcloud webhook → MinIO 落新简历 → RaaS 发 `RESUME_DOWNLOADED` → 本 agent → emit fat `RESUME_PROCESSED`
- **重派/同序列链路**:**跳过本 agent**。RaaS Backend 直接发 thin `RESUME_PROCESSED`(不带 `parsed`,因为 partner Postgres 那条简历早就解析过了,没必要重跑 RoboHire `/parse-resume`)

### 3.2 `ruleCheckAgent` — 内部逻辑零变化,但本次解锁 thin event 通过 `em.publish` 路径

#### 注册
- 文件: [server/inngest/agents/rule-check-agent.ts](../server/inngest/agents/rule-check-agent.ts)
- 订阅触发: `RESUME_PROCESSED`(2026-05-19 consolidation 后直订)
- 输出事件: `MATCH_RULE_CHECK_PASSED`(每 JR 一条) 或 `MATCH_RULE_CHECK_FAILED`
- 注册处: [rule-check-agent.ts:551](../server/inngest/agents/rule-check-agent.ts#L551)

#### 设计时就预言了重派场景
[rule-check-agent.ts:14-17](../server/inngest/agents/rule-check-agent.ts#L14-L17) 自带注释:

> 重派场景:partner 直接重发 `RESUME_PROCESSED`(带新 `job_requisition_id`),
> 本函数走路径 A,无任何额外订阅或代码改动。

#### 步骤(改动前 / 改动后**完全一致**)
逐行追迹两种 payload 进 handler 后怎么处理。**最右一列标"本次解锁"的就是改动前会因 schema 必填 `upload_id` 而到不了 handler 的场景**。

| Step | 代码位置 | fat-event(`resumeParserAgent` 出口) | thin-event(RaaS 重派/同序列) |
|---|---|---|---|
| 1. unwrap envelope | [rule-check-agent.ts:67](../server/inngest/agents/rule-check-agent.ts#L67) | `payload.{upload_id, parsed, candidate_id, ...}` | `payload.{candidate_id, resume_id, job_requisition_id, reassign_trigger}` |
| 2. `pickUploadId` | [rule-check-agent.ts:69, 569-574](../server/inngest/agents/rule-check-agent.ts#L569-L574) | 返回 `upload_id` | 返回 `null`(无 upload_id) |
| 3. `pickCandidateId` | [rule-check-agent.ts:70, 576-579](../server/inngest/agents/rule-check-agent.ts#L576-L579) | 返回 `candidate_id` | 返回 `candidate_id` |
| 4. `pickEmployeeId` | [rule-check-agent.ts:71, 581-592](../server/inngest/agents/rule-check-agent.ts#L581-L592) | 兜底链 `claimer_employee_id → employee_id → employeeId → operator_id → env.RAAS_DEFAULT_EMPLOYEE_ID` | 走 `operator_id`(RaaS 给的工号) |
| 5. **`if (!uploadId && !candidateId) throw`** | [rule-check-agent.ts:94-96](../server/inngest/agents/rule-check-agent.ts#L94-L96) | uploadId 有 → 通过 | candidateId 有 → 通过 |
| 6. `if (!employeeId) throw` | [rule-check-agent.ts:97-99](../server/inngest/agents/rule-check-agent.ts#L97-L99) | 通过 | 有 operator_id → 通过 |
| 7. `if (!isPartnerPgConfigured()) throw` | [rule-check-agent.ts:100-102](../server/inngest/agents/rule-check-agent.ts#L100-L102) | 依赖 `RAAS_POSTGRES_URL` 已配 | 同 |
| 8. `linkedJrId` 判定 | [rule-check-agent.ts:109-112](../server/inngest/agents/rule-check-agent.ts#L109-L112) | fat-event 默认无 `job_requisition_id` → null → 走路径 B | 重派/同序列必带 `job_requisition_id` → 走**路径 A** |
| 9a. 路径 A: 单 JR 查 partner-pg | [rule-check-agent.ts:117-135](../server/inngest/agents/rule-check-agent.ts#L117-L135) | — | `getRequirementDetail(linkedJrId)` 拿单条 JR |
| 9b. 路径 B: 查 recruiter 名下 published JR | [rule-check-agent.ts:137-175](../server/inngest/agents/rule-check-agent.ts#L137-L175) | `getRecruitingJobsAsRequirements({ claimerEmployeeId })` | — |
| 10. **F1 — parsed.data 缺失 back-pull** | [rule-check-agent.ts:192-228](../server/inngest/agents/rule-check-agent.ts#L192-L228) | parsed 存在 → 直接用 | parsed 缺 → `getParsedResume(candidate_id, resume_id)` 从 partner-pg 拉 |
| 11. for each JR: 镜像 Neo4j Job_Requisition | [rule-check-agent.ts:244-251](../server/inngest/agents/rule-check-agent.ts#L244-L251) | 同 | 同 |
| 12. for each JR: `runRuleCheck()`(Allmeta 查规则 + LLM) | 同上文件下方 | 同 | 同 |
| 13. for each JR: 写 Prisma `RuleCheckAudit` | 同 | 同 | 同 |
| 14. for each JR: 写 Allmeta `Candidate_Match_Result`(PK `cmr_<c>_<jr>`) | 同 | 同 | 同 |
| 15. for each JR: `decision === FAIL` → emit `MATCH_RULE_CHECK_FAILED`;else → `MATCH_RULE_CHECK_PASSED` | 同 | 同 | 同 |

#### "改动前 / 改动后"在本 agent 上的真实区别

| 状态 | RaaS thin event 走 `em.publish`(本地测试 / raas-bridge 入站) | RaaS thin event 直发 shared Inngest |
|---|---|---|
| 改动前 | **被 schema 拒**(upload_id required)→ ruleCheckAgent **不被触发** | **直接触发**(shared Inngest 路由不过 em.publish)→ ruleCheckAgent handler 内部全部通过(handler 早已不依赖 upload_id) |
| 改动后 | **通过 schema** → ruleCheckAgent 被触发 → handler 全部通过 | 同改动前(本来就通) |

**所以本次改动对本 agent 的真实价值**:解锁 `em.publish` 这条路径,使得本地用 `POST /api/em/publish` 模拟 RaaS thin event、或将来重新启用 raas-bridge 时不再被 schema 拦。生产 hot path(RaaS 直发 shared Inngest)在改动前**就已经能跑通**——这条本来就没经过 schema 校验。

### 3.3 `matchResumeAgent` — 完全不变

#### 注册
- 文件: [server/inngest/agents/match-resume-agent.ts](../server/inngest/agents/match-resume-agent.ts)
- 订阅触发: `MATCH_RULE_CHECK_PASSED`(2026-05-19 consolidation 后只订这一个)
- 输出事件: `MATCH_PASSED_NEED_INTERVIEW` 或 `MATCH_FAILED`(单阈值 `score < 40`)
- 注册处: [match-resume-agent.ts:41](../server/inngest/agents/match-resume-agent.ts#L41)

#### 步骤(改动前 / 改动后**完全一致**)
1. 校验 `data.job_requisition` + `data.parsed_resume` 都在([match-resume-agent.ts:77-86](../server/inngest/agents/match-resume-agent.ts#L77-L86))
2. 构建 `resumeText`(优先 `parsed_content`,fallback `JSON.stringify(parsed_resume)`)+ `jdText`(`flattenRequirementForMatch`)
3. **直连** RoboHire `POST /match-resume`(不走 RAAS proxy)→ 拿 `matching_score` + 维度细分([match-resume-agent.ts:109-137](../server/inngest/agents/match-resume-agent.ts#L109-L137))
4. partner-pg `saveMatchResultsToPartnerPg` 写 `candidate_match_result` + `candidate_match_result_runtime_state`(PK `cmr_<c>_<jr>`,去重键 `(candidate_id, job_requisition_id)`)([match-resume-agent.ts:162-186](../server/inngest/agents/match-resume-agent.ts#L162-L186))
5. Allmeta 写 Neo4j `Candidate_Match_Result` 的 `overall_*` 字段(跟 ruleCheckAgent 之前写的 `rule_check_*` 同一 PK 合并)([match-resume-agent.ts:195-213](../server/inngest/agents/match-resume-agent.ts#L195-L213))
6. `decideMatchEvent(matching_score)` 选事件名,`step.sendEvent` 发出([match-resume-agent.ts:239](../server/inngest/agents/match-resume-agent.ts#L239))

#### 跟本次改动的关系
零关系。本 agent 完全不读 `reassign_trigger`/`same_sequence_trigger`,也不在乎 trigger 源是 fat 还是 thin——只看 `MATCH_RULE_CHECK_PASSED` 这条规范化事件携带的 `job_requisition` + `parsed_resume`(由 ruleCheckAgent 已经规整好)。

#### 多 JR 并发的天然支持(功能 B 同序列岗位)
[lib/partner-pg/match-results.ts:212](../lib/partner-pg/match-results.ts#L212) 去重键 = `(candidate_id, job_requisition_id)`,每对一行。功能 B 选 N 个同序列 JR → RaaS 发 N 条独立 `RESUME_PROCESSED`(各带不同 `job_requisition_id`)→ N 次独立 `ruleCheckAgent` run → N 条独立 `MATCH_RULE_CHECK_PASSED` → N 次独立 `matchResumeAgent` run → 写 N 行 `cmr_<c>_<jr>`,互不冲突。

---

## 4. 改动前 vs 改动后:端到端时间线对照

### 4.1 功能 A — 更换关联岗位(单条事件)

#### 改动前(假设 RaaS 已经在发 thin event)

```
T+0    │ Recruiter 在 RaaS Web Console 点"更换关联岗位"提交
T+50ms │ RaaS reassignCandidateJob() 写 outbox + OutboxDispatcher
T+60ms │ RaaS InngestEventPublisher → shared Inngest:RESUME_PROCESSED (thin)
T+70ms │ shared Inngest 路由 → 反向 callback POST AO /api/inngest
T+150ms│ AO ruleCheckAgent handler 启动(注意:**没过 em.publish,所以不被旧
       │ schema 拦**;旧 schema 只在 em.publish 路径生效)
T+150ms│ handler 第 94-96 行:候选 candidate_id 在 → 通过
T+200ms│ partner-pg 单 JR 查 + thin-event back-pull parsed
T+5s   │ runRuleCheck (LLM)
T+5.2s │ emit MATCH_RULE_CHECK_PASSED → matchResumeAgent → ... → 写回 partner-pg
```

→ **本来就跑得通**(shared Inngest 直发不经过 em.publish)

但若是同时在测试 `POST /api/em/publish` 模拟 RaaS thin event:

```
T+0  │ tester curl POST /api/em/publish '{"name":"RESUME_PROCESSED","data":{...thin...}}'
T+5ms│ em.publish 进 schema 校验
T+6ms│ ❌ zod.parse 失败:payload.upload_id: Required
T+7ms│ em.publish 返回 { accepted: false, reason: 'schema' },写一行 EVENT_REJECTED
     │ ruleCheckAgent 永远收不到
```

#### 改动后

shared Inngest 直发路径不变(本来就通)。`em.publish` 模拟路径解锁:

```
T+0  │ tester curl POST /api/em/publish ...
T+5ms│ em.publish schema 校验
T+6ms│ ✅ 通过(upload_id optional)
T+10ms│ inngest.send 入 shared Inngest → 触发 ruleCheckAgent
T+...│ 同上,链路跑通
```

### 4.2 功能 B — 匹配同序列岗位(N 条事件并发)

跟功能 A 同样的单条流程,RaaS 端在 `triggerMatch()` 里循环 N 次。每条事件在 AO 这边都是独立 Inngest run id、独立 ruleCheckAgent run、独立 matchResumeAgent run、独立写一行 `cmr_<c>_<jr>`。改动前后**只在 em.publish 模拟路径上有区别**——主路径(shared Inngest 直发)两份完全一样。

---

## 5. 部署/联调验证清单

| # | 项 | 改动前会出现的失败现象 | 改动后预期 |
|---|---|---|---|
| V1 | RaaS 发的事件是**信封形态** `{ payload: {...} }` 不是扁平 | 主路径:agent 自己 unwrap 双形态都吃,无影响。em.publish 路径:扁平形态会被 `envelope()` 拒 | 同左(本次未改 envelope) |
| V2 | `operator_id` 真实可用 | ruleCheckAgent 第 97-99 行 `NonRetriableError` 缺 employee_id | 若不可用,设 `RAAS_DEFAULT_EMPLOYEE_ID=0000199059`(已在 `.env.local`) |
| V3 | Neo4j `EventDefinition` 表里 `RESUME_PROCESSED` 行的 `upload_id` 是否也 required | em registry 优先用 Neo4j 行,本次 builtin.ts 改动可能**不生效** → em.publish 仍被拒 | 联调时盯 [/api/raas-bridge/status](../app/api/raas-bridge/status) 的 `rejectedSchema` 计数;若涨,需走 Neo4j EventDefinition 同步流程把 `upload_id` 也改 optional |
| V4 | partner Postgres 那条简历的 `parsed_content` 非空 | ruleCheckAgent 第 10 步 back-pull 返回 null → `NonRetriableError` | RaaS 端"无解析则不发"已内置保护 |
| V5 | 端到端 trace | — | RaaS Web Console 点"更换关联岗位" → AO `/events` 5-15s 内出 `RESUME_PROCESSED` 行 → ruleCheckAgent + matchResumeAgent run 成功 → `candidate_match_result_runtime_state` 有新行 → RaaS 人才详情可见 |

---

## 6. 改动汇总(供回顾 / PR 描述用)

| # | 文件 | Hunk | 改动类型 |
|---|---|---|---|
| 1 | [server/em/schemas/builtin.ts:62-83](../server/em/schemas/builtin.ts#L62-L83) | `RESUME_PROCESSED_v1`:`upload_id` 必填 → 可选;显式补 `candidate_id`/`resume_id` optional;头部注释 | schema 放宽 |
| 2 | [components/events/EventInstancesTab.tsx:185](../components/events/EventInstancesTab.tsx#L185) | EmptyState hint 由 "raas-bridge 上 VPN" 改为 "shared Inngest 上 RaaS 直接 send" | UI cosmetic |

`npm run build` 通过(TypeScript 0 错,lint 0 错)。

agent 链路代码零改动 — `resumeParserAgent` / `ruleCheckAgent` / `matchResumeAgent` 内部逻辑全部不动。

---

## 7. FAQ

**Q1: RaaS plan 列了 3 个改动,为什么本次只做了 1 个?**
RaaS plan 基于双 Inngest + bridge 的旧架构假设。我们已经 single-Inngest(commit `f191ae9` 后),bridge 代码休眠不启用。plan 里 #1(env 加 RESUME_PROCESSED)和 #2(tick 内容过滤)在 bridge 不跑的前提下全部无效;只有 #3(schema 放宽 upload_id)在 single-Inngest 架构下仍然有意义(详见 §2.3)。

**Q2: 既然 hot path 不走 em.publish,这次 schema 改动是不是白做了?**
不是白做。三个理由(§2.3 详述):修契约不一致、解锁副路径、为 Neo4j EventDefinition 同步对齐做准备。1 行 0 风险,该做。

**Q3: ruleCheckAgent 为什么"早就预言"了重派场景?**
2026-05-19 那次 consolidation 合并 matchResume 第一段到 ruleCheckAgent 时,作者写代码就把 path A(单 JR)和 thin-event back-pull 两条分支显式做出来了。注释 [rule-check-agent.ts:14-17](../server/inngest/agents/rule-check-agent.ts#L14-L17) 是该设计意图的直接证据。

**Q4: 功能 B 同序列 N 个 JR,会不会 N 个 run 互相覆盖写 `candidate_match_result`?**
不会。partner-pg 去重键 `(candidate_id, job_requisition_id)` + PK `cmr_<c>_<jr>` 保证每对一行。N 条事件 → N 个 PK 不同 → N 行不冲突。

**Q5: 如果想本地验证(没连 RaaS),怎么模拟?**
两条路:
- `POST /api/em/publish` body `{ "name": "RESUME_PROCESSED", "data": { "payload": { "candidate_id": "...", "resume_id": "...", "job_requisition_id": "...", "reassign_trigger": true, "operator_id": "0000199059" } } }`,本次改动后该 payload 通过 schema 直接落地。
- 写一个 `/api/test/trigger-raas-rematch` 路由(参考现有 `/api/test/trigger-resume-uploaded`),直接 `inngest.send('RESUME_PROCESSED', ...)` 绕过 em.publish——这条本来就行,跟本次改动无关。
