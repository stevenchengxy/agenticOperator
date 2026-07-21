# RaaS 重匹配事件 — agenticOperator 适配设计

**日期**:2026-05-22
**状态**:设计已定稿,待实现(交接给正在重构 AO 的同事)
**作者**:zyj
**关联**:[2026-05-19-rule-check-consolidation-design.md](./2026-05-19-rule-check-consolidation-design.md)、[2026-05-20-ao-direct-dual-write-event-flow.md](./2026-05-20-ao-direct-dual-write-event-flow.md)

---

## 1. 背景

RaaS 系统(`raas_v4`)新增了两个由招聘者主动触发的功能,两者都不在 RaaS 侧计算匹配分,而是依赖 agenticOperator(下称 AO)消费事件、跑匹配、回写结果:

| | 功能 A:更换关联岗位 | 功能 B:匹配同序列岗位 |
|---|---|---|
| 入口 | 人才库人才卡片 `CandidateHybridCard.tsx` 的"更换关联岗位"快捷键 | 人才详情 `MatchingTab.tsx` 某条岗位匹配结果上的"匹配同序列岗位"按钮 → `MatchSameSequenceDialog.tsx` |
| RaaS 接口 | `POST /api/v1/candidates/:id/reassign-job` | `POST /api/v1/candidates/:id/match-same-sequence` |
| RaaS 服务 | `candidate.service.ts` `reassignCandidateJob()` | `same-sequence-match.service.ts` `triggerMatch()` |

这两个功能此前是在一份**未共享、未合并的 AO 定制代码**里支撑的。AO 现由其他同事重构,定制代码已不可用。本文档说明:**当前 AO 仓库需要做哪些更新,才能重新支撑这两个功能。**

### 1.1 RaaS 侧已发什么事件(已上线,不在本次改动范围)

两个功能在 RaaS 后端发的是**同一个事件 `RESUME_PROCESSED`**。它们不直接发 Inngest,而是写事务性 outbox,由 worker(`OutboxDispatcherService`)轮询后经 `InngestEventPublisher` → `inngestClient.send()` 投到 RaaS 自建 Inngest 总线(`RAAS_INNGEST_URL`,默认 `http://10.100.0.70:8288`)。

| 字段 | 功能 A | 功能 B |
|---|---|---|
| 事件名 | `RESUME_PROCESSED` | `RESUME_PROCESSED` |
| `sourceAction` | `processResume` | `processResume` |
| 发送条数 | 1 条 | **每个选中 JR 各 1 条**(循环 `job_requisition_ids`,上限 20) |
| 标志位 | `reassign_trigger: true` | `same_sequence_trigger: true`、`reassign_trigger: false` |
| `source_label` | `RAAS Web Console · 关联岗位变更` | `RAAS Web Console · 同序列匹配` |

**payload 字段**(`appendOntologyEvent` 的 `payload`):

```
candidate_id, resume_id, job_requisition_id, client_id,
resume_file_path, resume_bucket,
reassign_trigger / same_sequence_trigger,
operator_id / operator_name / operator_role,
source_label
```

两个对 AO 侧设计关键的事实:

1. **thin event** —— payload **不带** `parsed` 字段,只有 `resume_id` + `resume_bucket`/`resume_file_path`。
2. **无已解析简历则不发** —— RaaS 端查不到 parsed `Resume` 时直接返回 `resume_event_emitted:false` / `no_resume:true`,一条事件都不发。所以 AO 收到的每条 `RESUME_PROCESSED` 必然对应一份已解析简历。
3. payload **无 `upload_id`**。

---

## 2. 集成架构

```
RaaS Web Console 操作
   │  reassign-job / match-same-sequence
   ▼
RaaS outbox 表  ──(worker OutboxDispatcher 轮询)──►  RaaS Inngest 总线 (10.100.0.70:8288)
                                                          │
              ┌───────────────────────────────────────────┘
              │  AO 的 raas-bridge 单向拉取(AO 出网可达,反向不可达)
              ▼
AO raas-bridge.ts ──em.publish──► AO 本地 Inngest ──► ruleCheckAgent ──► matchResumeAgent
                                                          │                    │
                                                    rule-check 审计         RoboHire /match-resume
                                                    Neo4j CMR 实例          partner-pg 写回:
                                                                            candidate_match_result(_runtime_state)
```

回写后,RaaS 的 `MatchSameSequenceDialog` 通过 `CandidateMatchResultRuntimeState` 读出 `already_matched`,人才详情展示新的匹配结果。

---

## 3. AO 已就绪、本次**不改动**的部分

| 组件 | 为什么不用改 | 证据 |
|---|---|---|
| `ruleCheckAgent` 订阅 | 已直订 `RESUME_PROCESSED` | [rule-check-agent.ts:551](../../../server/inngest/agents/rule-check-agent.ts) |
| 单 JR 匹配(路径 A) | `job_requisition_id` 存在时只匹配该 JR;两个功能都带此字段 | [rule-check-agent.ts:109-136](../../../server/inngest/agents/rule-check-agent.ts) |
| thin-event 回查 | payload 缺 `parsed` 时按 `candidate_id`+`resume_id` 回查 partner Postgres | [rule-check-agent.ts:192-228](../../../server/inngest/agents/rule-check-agent.ts) |
| 重派语义 | 注释明确:"重派场景……走路径 A,无任何额外订阅或代码改动" | [rule-check-agent.ts:14-17](../../../server/inngest/agents/rule-check-agent.ts) |
| 事件契约 | `RESUME_PROCESSED` 目录 publishers 已含 `raas.reassign-republisher` | [builtin.ts:148](../../../server/em/schemas/builtin.ts) |
| 匹配评分 | `matchResumeAgent` 订阅 `MATCH_RULE_CHECK_PASSED`,逻辑与 trigger 来源无关 | `match-resume-agent.ts` |
| 多 JR 写回 | `saveMatchResultsToPartnerPg` 按 `(candidate, requisition)` 去重 upsert + 稀疏度保护;PK `cmr_<candidate>_<jr>` 每对一行,同序列多 JR 不冲突 | [match-results.ts:189-191](../../../lib/partner-pg/match-results.ts) |

**结论:agent 链路零改动。** 缺口只在"事件进得来"和"schema 不拦"。

---

## 4. 缺口分析与改动方案

### 改动 1 — 桥接事件列表加入 `RESUME_PROCESSED`

`raas-bridge.ts` 拉取哪些事件由 env `RAAS_BRIDGE_EVENTS` 决定([raas-bridge.ts:17](../../../server/inngest/raas-bridge.ts)),默认仅 `RESUME_DOWNLOADED`。

- **改动**:部署环境把 `RAAS_BRIDGE_EVENTS` 设为 `RESUME_DOWNLOADED,RESUME_PROCESSED`。
- **配套**:`.env.example` 增补该变量说明。
- **类型**:纯配置,无代码改动。

### 改动 2 — 桥接内容过滤(防环)

当前 `tick()` 只按事件名过滤([raas-bridge.ts:102-107](../../../server/inngest/raas-bridge.ts)):

```ts
for (const e of events) {
  if (_seenIds.has(e.id)) continue;
  if (!EVENT_NAMES.includes(e.name)) { _seenIds.add(e.id); continue; }
  // ... em.publish
```

一旦把 `RESUME_PROCESSED` 加入拉取列表,桥会**无差别**地拉 RaaS 总线上所有 `RESUME_PROCESSED`。问题在于:`raas-forward.ts` 的 `forwardToRaas()` 设计上会把 AO 自产的 `RESUME_PROCESSED` 转发回 RaaS 总线(目前未启用,但 `RESUME_PROCESSED` 目录 subscribers 含 `raas-backend.resume-processed-ingest`,说明该转发迟早会开)。届时桥会把 AO 自己刚发的 `RESUME_PROCESSED` 又拉回来 → 成环 / 重复处理。

- **改动**:在 `tick()` 增加按事件名分流的内容过滤——对 `RESUME_PROCESSED`,仅当 payload 带 `reassign_trigger === true` 或 `same_sequence_trigger === true` 才放行;否则 `_seenIds.add(e.id)` 跳过并计入一个过滤计数器。其他事件名(如 `RESUME_DOWNLOADED`)行为不变。
- **判定取值**:RaaS 事件为信封形态 `{ entity_type, entity_id?, event_id?, payload:{...}, trace? }`(与 `RESUME_DOWNLOADED` 一致,见 [builtin.ts:24-35](../../../server/em/schemas/builtin.ts)),故读 `e.data.payload?.reassign_trigger` / `same_sequence_trigger`,并兜底读扁平 `e.data.reassign_trigger`。
- **为什么用这个判据**:`reassign_trigger`/`same_sequence_trigger` 是 RaaS Web Console 这两个功能独有的标志,AO 自产的 `resumeParserAgent` 输出永远不会带 → 正向白名单,简单且未来安全。
- **类型**:`raas-bridge.ts` 约 10 行新增 + 一个小 helper。

### 改动 3 — 放宽 `RESUME_PROCESSED_v1` 的 `upload_id`

桥经 `em.publish` 入库,`em.publish` 会做 schema 校验,不过校验即丢弃(`rejectedSchema`),事件到不了 `ruleCheckAgent`。当前 schema([builtin.ts:62-72](../../../server/em/schemas/builtin.ts)):

```ts
const RESUME_PROCESSED_v1 = envelope(
  z.object({
    upload_id: z.string().min(1),          // ← 必填
    parsed: z.object({ data: z.record(z.string(), z.unknown()) }).optional(),
    job_requisition_id: z.string().optional(),
  }).passthrough(),
);
```

RaaS 重匹配 payload **无 `upload_id`**(用 `candidate_id`+`resume_id` 定位简历),会被 `upload_id: z.string().min(1)` 拦下。

- **改动**:`upload_id` 改为 `z.string().min(1).optional()`。可选地显式补 `candidate_id`、`resume_id` 为 `.optional()`(`.passthrough()` 本就放行,补上仅为可读性)。
- **正确性**:这是修 schema 与 agent 契约的不一致——`ruleCheckAgent` 第 94-96 行本就接受"有 `candidate_id` 即可,`upload_id` 可缺";builtin.ts 头注释亦称 schema "intentionally permissive"。
- **类型**:1 行改动。

---

## 5. 端到端流程(改动后)

**功能 A(更换关联岗位)**:招聘者在卡片选新 JR → RaaS `reassignCandidateJob()` 写 1 条 `RESUME_PROCESSED`(`reassign_trigger:true`,带新 `job_requisition_id`)→ outbox → RaaS Inngest → AO 桥(改动 2 放行)→ `em.publish`(改动 3 通过 schema)→ `ruleCheckAgent` 走路径 A,thin-event 回查解析简历,单 JR 跑 rule-check → `MATCH_RULE_CHECK_PASSED` → `matchResumeAgent` 调 RoboHire 评分 → 写回 `candidate_match_result(_runtime_state)`。

**功能 B(匹配同序列岗位)**:招聘者选 N 个同序列 JR → RaaS `triggerMatch()` 循环写 N 条 `RESUME_PROCESSED`(`same_sequence_trigger:true`,各带不同 `job_requisition_id`,各自独立 outbox 行/事件 id)→ 桥分别放行 N 条 → N 条独立 `ruleCheckAgent` run → N 条独立 `matchResumeAgent` run → 写回 N 行 `cmr_<candidate>_<jr>`,互不冲突 → RaaS `MatchSameSequenceDialog` 读 `CandidateMatchResultRuntimeState` 翻 `already_matched`。

---

## 6. 验证项(实现/联调时务必确认)

- **V1 — 信封形态**:确认 RaaS 投递的 `RESUME_PROCESSED` 是信封形态 `{ payload:{...} }`(与 `RESUME_DOWNLOADED` 一致)。若为扁平形态,`envelope()` 会因缺 `payload` 拒收,需让桥补信封或 schema 增加扁平变体。
- **V2 — `employee_id`**:`ruleCheckAgent` 第 97-99 行硬要求 `employee_id`,缺失即 `NonRetriableError`。`pickEmployeeId` 兜底链为 `claimer_employee_id → employee_id → employeeId → operator_id → RAAS_DEFAULT_EMPLOYEE_ID`。确认 RaaS payload 的 `operator_id` 是可用工号;否则部署环境设 `RAAS_DEFAULT_EMPLOYEE_ID`。
- **V3 — schema 真实来源**:EM registry 优先用 Neo4j `EventDefinition` 行,Neo4j 无行才回退 builtin.ts([builtin.ts:3-7](../../../server/em/schemas/builtin.ts))。确认线上 `RESUME_PROCESSED` 走的是哪条;若走 Neo4j,改动 3 须同步到 Neo4j 的 `EventDefinition`,只改 builtin.ts 无效。
- **V4 — 端到端**:RaaS Web Console 实际触发一次更换关联岗位 → AO `/events` 出现 `RESUME_PROCESSED` 行 → `ruleCheckAgent`/`matchResumeAgent` run 成功 → `candidate_match_result_runtime_state` 有新行 → RaaS 人才详情/对话框出新结果。

---

## 7. 已知限制(建议记录,不强制本次修)

- **L1 — 桥重启会漏事件**:`seedSeen()`([raas-bridge.ts:85-94](../../../server/inngest/raas-bridge.ts))启动时把最近 50 条事件直接标记为已见以跳过历史。AO 宕机期间 RaaS 发的重匹配事件会被永久跳过,而这是用户主动操作,静默无响应体验差。廉价缓解:改为按 `received_at`/`ts` 水位线过滤而非一刀切跳过。此为既有问题,`RESUME_DOWNLOADED` 同样受影响,可另开工单。
- **L2 — seen-set 内存态**:进程重启 seen-set 清空,有极小概率重处理;`em.publish` 用 `externalEventId = e.id`(RaaS outbox 行 id)作 Inngest 幂等键,真重复会被收敛,影响可忽略。
- **L3 — 重匹配仍走完整 rule-check**:候选人若硬命中规则(黑名单/资格门槛等)会得到 `MATCH_RULE_CHECK_FAILED`、无匹配分。这是预期行为,与正常流程一致。

---

## 8. 范围外

- RaaS 侧任何改动(两个功能已上线)。
- `forwardToRaas` 出站转发的启用(独立工作流;改动 2 的内容过滤已为其落地做了防环准备)。
- 同序列 peer-JR 列表 `GET /api/v1/candidates/:id/same-sequence-jrs` —— 纯 RaaS 侧读取,无 AO 参与。
- 新增 AO 事件或 agent(即"方案 1",已否决:与既有 `RESUME_PROCESSED` 复用契约相悖)。

---

## 9. 改动清单汇总

| # | 文件 / 位置 | 改动 | 量级 |
|---|---|---|---|
| 1 | 部署 env + `.env.example` | `RAAS_BRIDGE_EVENTS=RESUME_DOWNLOADED,RESUME_PROCESSED` | 配置 |
| 2 | `server/inngest/raas-bridge.ts` `tick()` | `RESUME_PROCESSED` 按 `reassign_trigger`/`same_sequence_trigger` 内容过滤 + helper | ~10 行 |
| 3 | `server/em/schemas/builtin.ts` `RESUME_PROCESSED_v1` | `upload_id` 必填 → 可选(若走 Neo4j 则同步 `EventDefinition`,见 V3) | 1 行 |

agent 链路(`ruleCheckAgent`、`matchResumeAgent`、写回)零改动。
