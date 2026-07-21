# AO Agent 执行 API — 对接条件(交付给 付卓新 / eval-test-builder)

> 提供方:Agentic Operator(AO)团队 · 2026-06-11
> 配套契约全文:[agent-execution-api-partner-guide.md](./agent-execution-api-partner-guide.md)(字段语义/归因/对齐清单都在这里)
> 本文只讲**怎么连**:地址、密钥、四个端点、联调步骤。

---

## 0. 现在就能连 —— MVP 已上线并自测通过

AO 侧已**实装**这套执行 API,完全旁路生产流程(直接调 `runRuleCheck` 纯计算引擎,不发事件、不写生产表、无外部副作用),对 AO 正常招聘链路零影响。已自测通过的路径:鉴权、版本固定、幂等、场景校验、Neo4j 候选人解引用、异步受理+轮询。

| 能力 | 状态 |
|---|---|
| A1 受理 + A2 轮询 + A3 LLM 全文 + A4 capabilities | ✅ 已上线 |
| API Key 鉴权(仅本组端点,不动其它接口) | ✅ |
| 本体版本固定(`rules_v0_1_002` / `rules_v0_1_003`,未知版本硬报错不回退) | ✅ |
| 幂等(`clientRequestId`,窗口 7 天) | ✅ |
| `matchResume` 单场景、shadow 模式 | ✅ |
| 结构化三态 decision + 逐规则 5+1 态 + retrievedRuleIds + meta(版本/token) | ✅ |
| ⚠️ `interpretation`/`evidence` 暂从 `reason` 派生(标记 `interpretationSource:"derived-from-reason"`) | 待 prompt 拆分(§10-④) |
| ⚠️ inline candidate、entry.stepIds、usd 计费 | 见 §4 对齐清单 |

---

## 1. 连接条件(三样)

| # | 条件 | 值 |
|---|---|---|
| 1 | **Base URL** | `http://<AO-内网-IP>:3002`(联调地址由 AO 现场提供;dev 为 `http://localhost:3002`) |
| 2 | **API Key** | `AGENT_EXECUTION_API_KEY` —— **通过安全渠道(WeLink)单独发你**,勿写进代码库/截图 |
| 3 | **数据环境** | 用例锚定的 candidate/job id 必须存在于 AO 所连的 Neo4j。联调前双方对齐一次(§4-⑦) |

**鉴权方式**:每个请求带下面任一 header(二选一):

```
Authorization: Bearer <API_KEY>
```
```
x-api-key: <API_KEY>
```

缺失/错误 → `401 { "error": { "code": "UNAUTHORIZED", ... } }`。

---

## 2. 四个端点

Base path:`{BASE_URL}/api/agent-execution`

| 端点 | 方法 | 作用 |
|---|---|---|
| `/executions` | POST | A1 受理一次执行,异步,返回 `executionId`(202) |
| `/executions/{executionId}` | GET | A2 轮询;完成后返回 结论 + trace + meta(轮询 2–5s) |
| `/executions/{executionId}/llm-calls/{callId}` | GET | A3 取该次 LLM 调用完整 prompt/response |
| `/capabilities` | GET | A4 支持的场景 / 可固定版本 / 限制项 |

### 2.1 先调 capabilities 确认环境

```bash
curl -s -H "Authorization: Bearer $KEY" \
  http://localhost:3002/api/agent-execution/capabilities | jq
```

返回(实测):

```json
{
  "scenarios": ["matchResume"],
  "domains": ["RAAS-v1", "raas", "招聘-v1"],
  "ontologyVersions": [
    { "version": "rules_v0_1_002", "ruleCount": 248, "metadataVersion": "0.2" },
    { "version": "rules_v0_1_003", "ruleCount": 261, "metadataVersion": "0.3" }
  ],
  "agentVersion": "rule-check-agent@2026-06-11",
  "promptVersion": "match-rule-check@2026-06-11-mvp",
  "modes": ["shadow"],
  "limits": { "maxConcurrent": 4, "idempotencyWindowDays": 7, "resultRetentionDays": 7 },
  "notes": [ "...MVP 限制项..." ]
}
```

### 2.2 A1 发起执行

```bash
curl -s -X POST http://localhost:3002/api/agent-execution/executions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{
    "clientRequestId": "tr-xxx/tc-de5ec703",
    "correlation": { "runId": "tr-xxx", "testCaseId": "tc-de5ec703" },
    "ontology": { "domain": "RAAS-v1", "version": "rules_v0_1_002" },
    "scenario": "matchResume",
    "inputs": {
      "candidate": { "ref": { "store": "neo4j", "id": "C-20260424-001" } },
      "job":       { "ref": { "store": "neo4j", "id": "R2026031629581" } }
    },
    "mode": "shadow",
    "config": { "model": null, "timeoutMs": 120000, "traceLevel": "full" }
  }'
```

→ `202 { "executionId": "exec_...", "status": "pending", "correlation": {...} }`
重复同一 `clientRequestId` → `200` + 同一 `executionId`(不重复执行)。

### 2.3 A2 轮询取结果

```bash
curl -s -H "Authorization: Bearer $KEY" \
  http://localhost:3002/api/agent-execution/executions/$EID | jq
```

`status`:`pending|running|succeeded|failed|timeout|cancelled`。
- **业务"不匹配"是 `succeeded`**(decision=`not_matched`);只有模型/图谱/解析故障才是 `failed`(带结构化 `error`)。
- 成功响应的完整字段表见配套契约 [§4.2](./agent-execution-api-partner-guide.md)。关键字段:`result.decision`(matched/not_matched/needs_review)、`result.decisionDetail.hardRequirements[]`(含 pass 与 fail)、`trace.ruleEvaluations[]`(逐规则 5+1 态 + `aoStatus` + `ruleTextSnapshot.sha256` + interpretation/evidence)、`trace.retrievedRuleIds`、`meta.ontologyLoaded`、`meta.usage`、`meta.aoAuditId`、`meta.inputsResolved`。

### 2.4 A3 取某次 LLM 全文(归因深挖)

A2 里 `trace.llmCalls[].promptRef` 直接给的就是 A3 的 URL:

```bash
curl -s -H "Authorization: Bearer $KEY" \
  http://localhost:3002/api/agent-execution/executions/$EID/llm-calls/llm-001 | jq
# → { callId, model, inputTokens, outputTokens, prompt:{system,user}, response }
```

---

## 3. 错误码(`status=failed/timeout` 时 `error.code`)

| code | 含义 | retryable |
|---|---|---|
| `ONTOLOGY_VERSION_UNAVAILABLE` | 请求版本不在注册表(不静默回退) | 否 |
| `INPUT_REF_NOT_FOUND` | candidate/job 在 Neo4j 查无(candidate 无兜底) | 否 |
| `INPUT_INVALID` | body 不合法 / inline candidate(MVP 不支持)/ overrides 非 null | 否 |
| `SCENARIO_UNSUPPORTED` | scenario≠matchResume 或 entry.stepIds≠null | 否 |
| `MODEL_UNAVAILABLE` / `UPSTREAM_RATE_LIMITED` | LLM 网关故障/限流 | 是 |
| `ONTOLOGY_GRAPH_UNAVAILABLE` | Neo4j/Ontology API 不可达 | 是 |
| `EXECUTION_TIMEOUT` | 超 timeoutMs | 是 |
| `INTERNAL` | 其它 | 视情况 |

同步 4xx:`400 INPUT_INVALID`(body 错)、`401 UNAUTHORIZED`、`404 NOT_FOUND`(executionId 不存在)。

---

## 4. 联调前需要双方确认的 11 项(摘自契约 §10)

不影响开始联调,但冻结前要过一遍。最关键的几条:

| # | 事项 | 现状 |
|---|---|---|
| ① | `insufficient_info/pending/not_executed` 三类无你们 5 态对应 → AO 暂报 `evaluated_inconclusive`(aoStatus 区分) | 建议你们增设第 6 态 |
| ④ | `interpretation`/`evidence` 暂从 `reason` 派生(`interpretationSource` 已标);inline candidate schema | 拆 prompt(改生产口径)需你们签字后做 |
| ⑤ | `meta.usage.usd` = null(只给 token) | 需单价表或你们侧折算 |
| ⑥ | 版本固定:AO 引擎执行走 live Neo4j;请求版本=live 版本时结果忠实,否则 `meta.ontologyLoaded.liveConsistency` 申报差异 | 真·逐版本执行 pin 需版本登记流程 |
| ⑦ | 数据环境:`C-20260424-001` / `R2026031629581` 等 id 在 AO 所连 Neo4j 的存在性 | 联调前互查 |
| ⑨ | `retrieved_not_evaluated`:AO 语义=确定性前置过滤排除(非"路径未触达")→ 影响你们归因树第 2 步 | 需改写第 2 步 |
| ⑩ | `entry.stepIds`、`subPoint` 不支持(单轮评估架构) | 永久限制,需确认 |

全表(①–⑪)见契约 [§10](./agent-execution-api-partner-guide.md)。

---

## 5. 验收用例 tc-de5ec703 联调步骤

1. AO 提供 Base URL + API Key(安全渠道)。
2. 双方确认 `C-20260424-001` / `R2026031629581` 在 AO 所连 Neo4j 存在(§4-⑦)。
3. 你按 §2.2 发 A1(version=`rules_v0_1_002`)→ §2.3 轮询。
4. 核对:`status=succeeded`、`decision=not_matched`、硬性技能项 `verdict=fail` `byRuleId="10-5"`、`ruleEvaluations` 含 `10-5/evaluated_violated`、`retrievedRuleIds` 含 10-5 与红线类、`meta.ontologyLoaded.version=rules_v0_1_002`。
5. 用一个不存在的版本发一发 → 预期 `ONTOLOGY_VERSION_UNAVAILABLE`(已实测通过)。

走通后即可扇出基准跑(≤4 并发,30–60 用例)。

---

## 6. 给 AO 运维的备注(非交付给 partner)

- 实现入口:`app/api/agent-execution/*`(路由)+ `server/agent-execution/*`(服务/引擎调用/mapper/版本注册/鉴权)。
- 持久化:新增 `agent_execution` 表(additive,不动既有表)。
- 鉴权 Key:`.env.local` 的 `AGENT_EXECUTION_API_KEY`,仅本组端点校验。轮换=改这里 + 通知 partner。
- 加新可固定版本:把 `rules_v0_1_00X.json` 放进 `neo4j_data/招聘- v1/`,capabilities 自动列出。
- 零影响保证:执行只调 `runRuleCheck()`(读侧纯计算),不经 Inngest、不发事件、不写生产审计表。
