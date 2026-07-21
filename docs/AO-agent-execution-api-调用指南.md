# AO Agent 执行 API — 调用指南

> 给:付卓新(eval-test-builder · 测试与评估)
> 由:Agentic Operator(AO)团队 · 2026-06-11
> 用途:你把单条业务用例(候选人 + 岗位 + 场景)发给 AO,AO 用生产同款 Agent 真实执行简历规则校验,把**结构化结论 + 逐规则过程数据 + 元数据**回给你,供你做一致性/覆盖率/归因。
>
> 这份文档是**自包含**的——照着它就能完成对接,不需要其它文档。

---

## 0. 你需要从我这里拿到的三样

| # | 东西 | 说明 |
|---|---|---|
| 1 | **Base URL** | 联调内网地址,形如 `http://<AO-IP>:3002`。我现场给你 |
| 2 | **API Key** | 我通过 WeLink 安全发你。每个请求都要带(见 §2) |
| 3 | **数据环境对齐** | 你的用例锚定的候选人/岗位 id 必须存在于我连接的 Neo4j。联调前我们各自连同一环境互查一次 |

所有接口都在 Base path:`{Base URL}/api/agent-execution`

---

## 1. 整体流程

```
你(测试侧)                                  AO(我)
─────────                                   ──────
1. POST /executions  ───────────────────►   受理,返回 executionId(202)
   (只含业务输入,不含真值/预期)               后台用生产同款引擎真实执行(shadow:决策真跑、副作用全抑制)
2. GET /executions/{id} 轮询(2–5s)  ◄─────   完成 → 返回 结论 + trace + meta
3. (可选)GET .../llm-calls/{callId}  ◄─────   取某次 LLM 完整 prompt/response
```

要点:
- **异步**:A1 立即返回 `executionId`,执行在后台跑;你轮询 A2 拿结果。单用例端到端 ≤ 3 分钟。
- **shadow 模式**:决策逻辑真实执行,但所有外部副作用(发事件、写客户系统、发通知)一律抑制,并在响应里申报。这是唯一支持的模式,你不用传别的。
- **业务"不匹配"是成功**:`status=succeeded` 且 `decision=not_matched`。只有模型/数据/系统故障才是 `failed`。两者绝不混淆。

---

## 2. 鉴权

每个请求带下面任一 header(二选一):

```
Authorization: Bearer <API_KEY>
```
```
x-api-key: <API_KEY>
```

- 缺 Key → `401 { "error": { "code": "UNAUTHORIZED", "message": "...", "retryable": false } }`
- Key 错 → `401 { "error": { "code": "UNAUTHORIZED", "message": "invalid api key", "retryable": false } }`
- 服务端未配置 Key(联调初期我若没配好)→ `500 { "error": { "code": "SERVER_MISCONFIGURED", ... } }`。这是**我**侧的问题,不是你的 Key 错,告诉我即可

---

## 3. 先调 capabilities 确认环境

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/agent-execution/capabilities"
```

返回(实测样例):

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
  "notes": [
    "inline candidate not supported in MVP (use candidate.ref) — guide §10-④",
    "entry.stepIds not supported (single-pass evaluation) — guide §10-⑩",
    "meta.usage.usd is null (token-only metering) — guide §10-⑤",
    "interpretation/evidence are derived-from-reason until the prompt split lands — guide §10-④"
  ]
}
```

`ontologyVersions` 就是你可以固定(pin)的本体版本。请求时用 `version` 字段指定其中之一;指定一个不在列表里的版本会**硬报错**,绝不静默回退到别的版本。

---

## 4. A1 — 发起执行 `POST /executions`

### 请求体

```jsonc
{
  // ── 关联标识(我原样回显,不解释)──────────────────────
  "clientRequestId": "tr-mq8xd0ri/tc-de5ec703",   // 幂等键(必填)。相同 id 重复提交返回同一 executionId,不重复执行
  "correlation": { "runId": "tr-mq8xd0ri", "testCaseId": "tc-de5ec703" },

  // ── 本体定位 ──────────────────────────────────────
  "ontology": {
    "domain": "RAAS-v1",                 // RAAS-v1 / raas / 招聘-v1 任一(我内部同义解析)
    "version": "rules_v0_1_002"          // 必填,见 capabilities;不可用 → ONTOLOGY_VERSION_UNAVAILABLE
  },

  // ── 业务场景 ──────────────────────────────────────
  "scenario": "matchResume",             // 目前只支持 matchResume
  "entry": { "actionId": "10", "stepIds": null },   // 可选;stepIds 必须为 null(见 §8)

  // ── 业务输入(只有输入,没有任何预期/真值)────────────
  "inputs": {
    "candidate": { "ref": { "store": "neo4j", "id": "C-20260424-001" }, "inline": null },
    "job":       { "ref": { "store": "neo4j", "id": "R2026031629581" }, "inline": null },
    "overrides": null
  },

  // ── 执行配置 ──────────────────────────────────────
  "mode": "shadow",                      // 只支持 shadow(可省略,默认 shadow)
  "config": { "model": null, "timeoutMs": 120000, "traceLevel": "full" }
}
```

**字段说明**

| 字段 | 必填 | 说明 |
|---|---|---|
| `clientRequestId` | ✅ | 幂等键。按此 id 长期去重(≥7 天,满足你 ≥24h 的要求);相同 id 永远返回同一次执行,不重跑 |
| `ontology.domain` | ✅ | `RAAS-v1` / `raas` / `招聘-v1` |
| `ontology.version` | ✅ | 见 capabilities 的 `ontologyVersions` |
| `scenario` | ✅ | `matchResume` |
| `inputs.candidate.ref.id` | ✅ | Neo4j 候选人 id。**候选人只走 Neo4j,查无即报错,无兜底** |
| `inputs.job.ref.id` | ✅(或 inline) | Neo4j 岗位 id |
| `correlation` / `entry` / `mode` / `config` | 可选 | 见上注释 |

> **inline 模式**:MVP 暂只支持 `candidate.ref`(用 id 从 Neo4j 取数);`candidate.inline`(直接内联对象)会返回 `INPUT_INVALID`,等 schema 线下对齐后开放(§8)。`job.inline` 可用。

### 响应

- **新受理** → `202`:
  ```json
  { "executionId": "exec_a446889bc02d4f86a01be5aed8b7ec1d", "status": "pending",
    "correlation": { "runId": "tr-mq8xd0ri", "testCaseId": "tc-de5ec703" } }
  ```
- **重复 clientRequestId** → `200`,返回同一 `executionId`(不重复执行)。
- **同步 400**:只在 JSON 不可解析、或缺顶层 `clientRequestId` / `ontology.domain` / `ontology.version` / `scenario` / `inputs` 时立即返回 `400 { "error": { "code": "INPUT_INVALID", ... } }`。
- **其余校验是异步的**:`candidate.ref.id` 缺失、版本不可用、scenario 不支持、stepIds≠null、inline candidate、overrides≠null 等,A1 仍**先返回 202 受理**,然后在 A2 轮询里以 `status=failed` + 对应 `error.code` 报出来(不是同步 400)。请把这些当作"轮询到 failed"处理,而不是 POST 的 400。
- **超并发** → `429` + `Retry-After` 头,body `{ "error": { "code": "RATE_LIMITED", "retryable": true } }`。按 `Retry-After`(秒)退避重试即可。

```bash
curl -s -X POST "$BASE/api/agent-execution/executions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "clientRequestId":"tr-1/tc-de5ec703",
        "correlation":{"runId":"tr-1","testCaseId":"tc-de5ec703"},
        "ontology":{"domain":"RAAS-v1","version":"rules_v0_1_002"},
        "scenario":"matchResume",
        "inputs":{"candidate":{"ref":{"store":"neo4j","id":"C-20260424-001"}},
                  "job":{"ref":{"store":"neo4j","id":"R2026031629581"}}},
        "mode":"shadow" }'
```

---

## 5. A2 — 轮询取结果 `GET /executions/{executionId}`

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/agent-execution/executions/$EID"
```

- 未完成 → `200`,只有状态信封:`{ executionId, status, correlation, result:null, trace:null, meta:null, error:null }`
- executionId 不存在 → `404 { "error": { "code":"NOT_FOUND", ... } }`
- 完成 → `200`,完整响应(下面是 not_matched 的样例):

```jsonc
{
  "executionId": "exec_...",
  "status": "succeeded",          // pending | running | succeeded | failed | timeout | cancelled
  "correlation": { "runId": "tr-1", "testCaseId": "tc-de5ec703" },

  // ── ① 业务结论(你做一致性比对的输入)────────────────
  "result": {
    "scenario": "matchResume",
    "decision": "not_matched",    // matched | not_matched | needs_review(语义见 §7.1)
    "decisionDetail": {
      "hardRequirements": [       // 逐项硬性要求判定,pass 与 fail 都给
        { "requirement": "必备技能一票否决", "verdict": "fail", "byRuleId": "10-5", "reason": "必备技能字面比对未命中" },
        { "requirement": "学历要求",         "verdict": "pass", "byRuleId": "10-16", "reason": "大专,满足" }
      ],
      "score": null,              // 恒 null:数值评分在下游环节,不属规则校验
      "vetoedBy": ["10-5"]        // 触发否决的规则 id
    },
    "summary": "因以下规则未通过,判定不匹配:[10-5] 必备技能一票否决。",
    "emittedEvents": ["MATCH_RULE_CHECK_FAILED"]   // 应发未发申报(shadow);matched→MATCH_RULE_CHECK_PASSED
  },

  // ── ② 执行过程数据(你做覆盖率 + 归因的输入)──────────
  "trace": {
    "steps": [
      { "seq": 1, "actionId": "10", "stepId": "10-1", "title": "10-1", "status": "completed",
        "startedAt": "...Z", "endedAt": "...Z",
        "ruleIds": ["10-16","10-25"], "llmCallIds": ["llm-001"], "toolCalls": [],
        "suppressedSideEffects": [], "note": null }
      // ... 末步骤的 suppressedSideEffects 列出 shadow 下被抑制的写动作
    ],
    "ruleEvaluations": [          // ★ 逐规则评估(语义见 §7.2)
      {
        "ruleId": "10-5",                       // = 本体规则原始 id,无改写无后缀
        "subPoint": null,
        "stepId": "10-2",
        "status": "evaluated_violated",         // 见 §7.2 状态映射
        "aoStatus": "fail",                     // AO 引擎原生 6 态(供你核对)
        "ruleTextSnapshot": { "field": "standardizedLogicRule", "sha256": "ab12…", "version": "rules_v0_1_002" },
        "interpretation": "必备技能字面比对未命中",  // ⚠️ MVP 暂与 evidence 同源,见 interpretationSource
        "evidence": "必备技能字面比对未命中",
        "verdictReason": "必备技能字面比对未命中",
        "interpretationSource": "derived-from-reason"   // MVP 标记:解读/证据暂从 reason 派生(§8)
      }
      // ... 被前置过滤排除的规则也各一条,status=retrieved_not_evaluated
    ],
    "retrievedRuleIds": ["10-5","10-16","10-25","10-42"],   // 本次加载到 Agent 侧的规则 id 全集(含被排除的)
    "llmCalls": [
      { "callId": "llm-001", "stepId": null, "model": "...", "purpose": "规则评估(全规则单轮)",
        "inputTokens": 8211, "outputTokens": 902, "latencyMs": 4210,
        "promptRef": "/api/agent-execution/executions/exec_.../llm-calls/llm-001" }  // 直接给的就是 A3 的 URL
    ]
  },

  // ── ③ 执行元数据(可复现性)──────────────────────────
  "meta": {
    "agentVersion": "rule-check-agent@2026-06-11",
    "promptVersion": "match-rule-check@2026-06-11-mvp",
    "model": "...实际使用模型...",
    "ontologyLoaded": { "domain": "RAAS-v1", "version": "rules_v0_1_002", "ruleCount": 248, "liveConsistency": null },
    "inputsResolved": { "candidate": { "store": "neo4j" }, "job": { "store": "neo4j" } },  // 各输入实际命中的数据源
    "aoAuditId": null,
    "mode": "shadow",
    "usage": { "inputTokens": 21611, "outputTokens": 3754, "usd": null },   // usd 暂 null(§8)
    "startedAt": "...Z", "finishedAt": "...Z"
  },

  "error": null
}
```

时间统一 ISO-8601 UTC 字符串。轮询间隔建议 2–5s;并发上限 4,超限返回 `429` + `Retry-After`。

---

## 6. A3 — 取某次 LLM 全文 `GET /executions/{executionId}/llm-calls/{callId}`

A2 里 `trace.llmCalls[].promptRef` 给的就是这个 URL。MVP 引擎单轮评估,callId 固定 `llm-001`。

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/agent-execution/executions/$EID/llm-calls/llm-001"
```

返回:

```jsonc
{
  "callId": "llm-001", "stepId": null, "model": "...", "purpose": "规则评估(全规则单轮)",
  "inputTokens": 8211, "outputTokens": 902, "latencyMs": 4210,
  "promptRef": "...",
  "prompt": { "system": "...完整 system prompt...", "user": "...完整 user prompt..." },
  "response": "...LLM 完整原始响应..."
}
```

executionId/callId 不存在 → `404`。

---

## 7. 字段语义(做归因前必读)

### 7.1 `result.decision` 三态

| decision | 含义 |
|---|---|
| `matched` | 全部在辖规则通过 |
| `not_matched` | 存在确认违反的规则(`vetoedBy` 列出) |
| `needs_review` | 无确认违反,但有底线规则无法自证达标(信息不足/需人工主观判断)→ 按 fail-closed 拦下,转人工复核 |

### 7.2 `ruleEvaluations[].status` 五(+一)态

| status | 含义 | 对应 `aoStatus` |
|---|---|---|
| `not_retrieved` | 在辖但没加载到(由你侧推导:在辖全集 − retrievedRuleIds) | —(不出现在本数组) |
| `retrieved_not_evaluated` | 检索到、但被**确定性前置过滤**排除,未进 LLM 上下文 | `excluded`(verdictReason=排除理由) |
| `evaluated_not_applicable` | 评估了,触发前提不成立 | `not_triggered` |
| `evaluated_passed` | 评估了,满足 | `pass` |
| `evaluated_violated` | 评估了,违反 | `fail` |
| `evaluated_inconclusive` | 评估了但无法定论(信息不足/需人工/上游断链) | `insufficient_info` / `pending` / `not_executed` |

> ⚠️ **`retrieved_not_evaluated` 与你文档里的定义不同**:你的定义是"进了上下文但路径没走到";AO 单轮全规则评估架构下那种情况不存在,AO 在此态上报的是"被适用性/executor 前置过滤排除、未进上下文"。这会影响你归因决策树第 2 步——见 §8 对齐项。最后一态 `evaluated_inconclusive` 是 AO 在你 5 态之外加的第 6 态(你那三类"评估了但无法定论"在 5 态里没有位置)。

### 7.3 `retrievedRuleIds`

= 本次加载到 Agent 侧的规则 id 全集(含被前置过滤排除的)。"进了 LLM 上下文"的子集 = ruleEvaluations 里 `status ≠ retrieved_not_evaluated` 的部分。`ruleId` 即本体原始 id(如 `10-5`),端到端不改写,你的 join 安全。

### 7.4 规则文本指纹

每条 `ruleEvaluations[].ruleTextSnapshot.sha256` 是 Agent 实际读到的 `standardizedLogicRule` 全文在**请求版本**下的 sha256,供你核对"看到的是哪个版本的规则"。

---

## 8. 错误码与状态码

### `error.code`(`status=failed/timeout` 时)

| code | 含义 | retryable |
|---|---|---|
| `ONTOLOGY_VERSION_UNAVAILABLE` | 请求版本不在可固定列表(不静默回退) | 否 |
| `INPUT_REF_NOT_FOUND` | 候选人/岗位在 Neo4j 查无(候选人无兜底) | 否 |
| `INPUT_INVALID` | body 不合法 / inline candidate(MVP 不支持)/ overrides 非 null | 否 |
| `SCENARIO_UNSUPPORTED` | scenario≠matchResume 或 entry.stepIds≠null | 否 |
| `MODEL_UNAVAILABLE` | LLM 网关故障/不可用 | 是 |
| `UPSTREAM_RATE_LIMITED` | LLM 网关限流(429/too-many-requests) | 是 |
| `ONTOLOGY_GRAPH_UNAVAILABLE` | Neo4j / 本体 API 不可达 | 是 |
| `EXECUTION_TIMEOUT` | 超 timeoutMs | 是 |
| `INTERNAL` | 其它 | 视情况 |

### HTTP 状态码

| 场景 | 码 |
|---|---|
| A1 新受理 | 202 |
| A1 重复 clientRequestId / A2 / A3 / A4 成功 | 200 |
| A1 缺顶层必填字段 / JSON 不可解析 | 400(其余校验走异步 failed,见 §4) |
| 鉴权失败(你的 Key 缺/错) | 401 |
| 服务端未配置 Key | 500(`SERVER_MISCONFIGURED`) |
| executionId / callId 不存在 | 404 |
| 超并发 | 429 + `Retry-After`(body code=`RATE_LIMITED`) |

> 再强调:业务"不匹配"是 `200` + `status=succeeded` + `decision=not_matched`,**不是** error。把业务否决当失败会污染你的一致性统计。

---

## 9. MVP 已知边界 / 需要我们线下确认的事

不挡联调,但冻结前过一遍。最关键的几条:

| # | 事项 | 现状 / 你需要做的决定 |
|---|---|---|
| ① | `evaluated_inconclusive`(你 5 态外的第 6 态) | 建议你正式增设此态;它正是 `needs_review` 的成因,折进别的态会失真 |
| ② | `retrieved_not_evaluated` 语义差异(§7.2) | 你归因树第 2 步需改写:此态归类为"适用范围裁定"而非"Agent 编排问题" |
| ③ | 覆盖率分母口径 | AO 评估面只含 `executor=Agent` 且 `enforcementLevel=mandatory` 的规则,分母请同口径 |
| ④ | `interpretation`/`evidence` 暂从 `reason` 派生(`interpretationSource:"derived-from-reason"` 已标) | 真正拆分要改生产 prompt,需你确认口径后做 |
| ⑤ | `meta.usage.usd` = null | 我只回 token;预算闸用 token,或你给单价表我折算 |
| ⑥ | inline candidate、entry.stepIds 子链 | MVP 不支持(stepIds 是架构限制);需要的话另议 |
| ⑦ | 数据环境:用例 id 在我 Neo4j 的存在性 | 联调前互查 |

---

## 10. 联调步骤(验收用例 tc-de5ec703)

1. 我给你 Base URL + API Key(安全渠道)。
2. 我们确认 `C-20260424-001` / `R2026031629581` 在我连的 Neo4j 存在(§9-⑦)。
3. 你按 §3 调 capabilities → §4 发 A1(version=`rules_v0_1_002`)→ §5 轮询。
4. 核对:`status=succeeded`、`decision=not_matched`、硬性技能项 `verdict=fail` `byRuleId="10-5"`、`ruleEvaluations` 含 `10-5/evaluated_violated`、`retrievedRuleIds` 含 10-5、`meta.ontologyLoaded.version=rules_v0_1_002`。
5. 用一个不存在的版本发一次 → 预期 `ONTOLOGY_VERSION_UNAVAILABLE`。

走通后即可扇出基准跑(≤4 并发,30–60 用例)。有任何字段对不齐,直接找我。
