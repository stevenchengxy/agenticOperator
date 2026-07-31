# matchResume Rule Check 测试指南

> 本文档说明如何用 `scripts/run-match-resume-rule-check.ts` 在本地对 `runRuleCheck()` 进行端到端冒烟测试。包括数据准备、环境配置、执行步骤、输出解读和常见问题排查。

`runRuleCheck()` 是 `lib/rule-check/` 提供的库函数。它会做四件事：

1. 调 Ontology API 拿 `matchResume` 的规则集（按 Set 分组）；
2. 从 neo4j 预拉取一组"图上下文"（候选人本身、简历、JD、历史投递、黑名单命中、就职关系）；
3. 把上述数据 + 规则塞进 prompt，调共享 LLM 网关（带 tool-use）让模型逐条评估；
4. 收上 LLM 的 `rule_results[]`，重新计算 `stats` 和 `decision`，返回 `MatchResumeCheckResult`。

测试脚本是上面这整条链路的最小驱动器：你给一个 `candidate_id` + `job_requisition_id`，它跑一遍并把结果打印出来。

---

## 1. 前置条件

### 1.1 服务

| 服务 | 用途 | 默认地址 |
|---|---|---|
| Ontology API (Studio app) | 提供 `/api/v1/ontology/*` 接口，包括规则获取和实例 CRUD | `http://localhost:3500` |
| Neo4j | Studio 的后端图数据库；存 Candidate / Resume / JD / Application / Blacklist 等实例 | `bolt://localhost:7687`（或 `.env.local` 配置的地址） |
| LLM 网关 | 跑 prompt；支持 OpenAI 兼容的 `chat.completions` 接口（含 tool-calling） | 内部网关或 OpenAI 官方 |

确保上面三个服务都已经能访问。Studio 一般包装了 neo4j；只要 Studio 起来了，`/api/v1/ontology/*` 能正常返回 200，就足够了——脚本不直接连 neo4j，全部走 HTTP。

### 1.2 环境变量（`.env.local`）

```bash
# Ontology API
ONTOLOGY_API_BASE=http://localhost:3500
ONTOLOGY_API_TOKEN=<your-token>

# LLM 网关二选一：
# (优先) 内部网关
AI_BASE_URL=<gateway-url>
AI_API_KEY=<gateway-key>
AI_MODEL=<可选，默认 google/gemini-3-flash-preview>
# (退化) 直连 OpenAI
OPENAI_API_KEY=<openai-key>
```

如果两组都没配，脚本会报 `LLM gateway not configured`。

---

## 2. 数据准备（在 neo4j 中通过 Ontology API 写入）

脚本里默认用的两个 ID：

| 参数 | 默认值 |
|---|---|
| `candidate_id` | `C-100023` |
| `job_requisition_id` | `JR-2026-001` |

你可以改成已经存在的 ID，或者按下面的步骤新建一组。所有实例都写在 `RAAS-v1` 域下，使用 Ontology API 的 instance CRUD 接口（详见 `ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md` §5）。

### 2.1 Candidate（必备）

```bash
curl -X POST http://localhost:3500/api/v1/ontology/instances/Candidate \
  -H "Authorization: Bearer $ONTOLOGY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domainId": "RAAS-v1",
    "candidate_id": "C-100023",
    "name": "张三",
    "gender": "男",
    "date_of_birth": "1990-05-12",
    "candidate_status": "active",
    "highest_education_school": "复旦大学",
    "highest_education_degree": "本科",
    "highest_education_major": "计算机科学与技术",
    "highest_education_is_full_time": true,
    "highest_education_graduation_year": 2012
  }'
```

> **注意**：每个 property 字段必须在 `:DataObject{id:"Candidate"}` schema 里已经声明，否则会被拒（`400 validation-failed` + `details.unknown`）。Schema 是 Ontology 平台维护的；如果你的字段在 schema 里没有，先用 §1 的 `/api/v1/ontology/objects/Candidate` PATCH 加上 property 声明，再来写实例。

### 2.2 Resume（必备 — `runRuleCheck` 通过 `candidate_id` 拉取）

```bash
curl -X POST http://localhost:3500/api/v1/ontology/instances/Resume \
  -H "Authorization: Bearer $ONTOLOGY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domainId": "RAAS-v1",
    "resume_id": "R-100023",
    "candidate_id": "C-100023",
    "skills": ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
    "language_certifications": [],
    "conflict_of_interest_declaration": "无亲属在腾讯任职。",
    "work_experience_summary": "2014-2021 华为终端业务后端开发；2022-2025 字节跳动广告投放系统后端开发。",
    "education_summary": "复旦大学 计算机科学与技术 本科 2012 毕业"
  }'
```

> 库函数通过 `listInstances("Resume", { candidate_id: "C-100023" })` 取第一条作为 `graph.resume`。所以**只要有一条 Resume 节点的 `candidate_id` 等于 Candidate 的 `candidate_id`**，就能关联起来。Studio 平台一般通过 PROPERTY 而不是显式 HAS_RESUME 关系来连——但如果你的部署用显式 link，仍需要 `candidate_id` property 才能被 `listInstances` filter 取到。

### 2.3 Job_Requisition（必备）

```bash
curl -X POST http://localhost:3500/api/v1/ontology/instances/Job_Requisition \
  -H "Authorization: Bearer $ONTOLOGY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domainId": "RAAS-v1",
    "job_requisition_id": "JR-2026-001",
    "client_id": "CLI_TENCENT_PCG",
    "client_department_id": "CLI_TENCENT_IEG_TIANMEI",
    "title": "高级后端工程师",
    "job_responsibility": "负责广告投放系统服务端开发，主导亿级 QPS 接口的性能优化。",
    "min_years_experience": 5,
    "education": "本科及以上",
    "age_max": 40,
    "hc_status": "open"
  }'
```

> 注意 `hc_status` 必须不是 `"已关闭"`（这是 RAAS 上游过滤的常用条件，虽然 `runRuleCheck` 不强制要求，但和 production 行为一致比较好）。

### 2.4 Application（可选，用于"岗位冷冻期"等规则）

```bash
curl -X POST http://localhost:3500/api/v1/ontology/instances/Application \
  -H "Authorization: Bearer $ONTOLOGY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domainId": "RAAS-v1",
    "items": [
      {
        "application_id": "A-100023-1",
        "candidate_id": "C-100023",
        "job_requisition_id": "JR-2025-088",
        "status": "筛选淘汰",
        "created_at": "2025-10-15"
      },
      {
        "application_id": "A-100023-2",
        "candidate_id": "C-100023",
        "job_requisition_id": "JR-2025-200",
        "status": "面试淘汰",
        "created_at": "2025-11-20"
      }
    ]
  }'
```

> 如果候选人没有历史投递记录，整条略过。`applications` slot 会是 `[]`，不影响规则评估，但"岗位冷冻期"类规则会标 `not_triggered`。

### 2.5 Blacklist（可选，用于黑名单类规则）

```bash
curl -X POST http://localhost:3500/api/v1/ontology/instances/Blacklist \
  -H "Authorization: Bearer $ONTOLOGY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domainId": "RAAS-v1",
    "blacklist_id": "BL-100023-1",
    "candidate_id": "C-100023",
    "reason_code": "A13(1)",
    "reason_text": "EHS 风险",
    "created_at": "2024-03-01"
  }'
```

> 如果候选人没有黑名单命中，整条略过。`blacklist_hits` slot 为 `[]`。

### 2.6 EMPLOYED_BY 链接（可选，用于回流 / 竞对类规则）

如果你的 schema 用显式 link 表示候选人的就职历史，需要先有 Employer 节点，然后建一条 `EMPLOYED_BY` link：

```bash
# 1. Employer 节点（如果 schema 里有 Employer DataObject）
curl -X POST http://localhost:3500/api/v1/ontology/instances/Employer \
  -H "Authorization: Bearer $ONTOLOGY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domainId": "RAAS-v1",
    "employer_id": "E-HUAWEI",
    "name": "华为"
  }'

# 2. EMPLOYED_BY 链接
curl -X POST http://localhost:3500/api/v1/ontology/links \
  -H "Authorization: Bearer $ONTOLOGY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "domainId": "RAAS-v1",
    "type": "EMPLOYED_BY",
    "fromId": "C-100023",
    "toId": "E-HUAWEI",
    "start_date": "2014-07",
    "end_date": "2021-12"
  }'
```

> 如果就职历史只在 Resume 的 property（如 `work_experience_summary`）里，可以跳过这步——LLM 仍能从 Resume 内容里读出来，只是没法用 link 推理。

### 2.7 数据准备清单

| 数据 | 是否必备 | 用途 |
|---|---|---|
| Candidate 节点 | ✅ 必备 | 图上下文 §3.1，缺失 → 大量 rule 走 `insufficient_info` |
| Resume 节点（属性 `candidate_id` 与上一行匹配） | ✅ 必备 | 图上下文 §3.2，LLM 评估的主要信息源 |
| Job_Requisition 节点 | ✅ 必备 | 图上下文 §3.3，缺失 → 同样大量 `insufficient_info` |
| Application 节点 | ⚪ 可选 | 图上下文 §3.4，岗位冷冻期类规则 |
| Blacklist 节点 | ⚪ 可选 | 图上下文 §3.5，黑名单 / EHS 风险类规则 |
| EMPLOYED_BY 链接 | ⚪ 可选 | 图上下文 §3.6，竞对 / 回流类规则 |

> 没有可选数据也能跑通，只是对应规则会被标记 `not_triggered` 或 `insufficient_info`，最终 `decision` 容易变成 `REVIEW`。如果想看到完整的 PASS 流，把可选数据也准备齐全。

---

## 3. 执行

### 3.1 修改脚本参数（可选）

打开 `scripts/run-match-resume-rule-check.ts`，把顶部的常量改成你准备的 ID：

```ts
const candidate_id = "C-100023";       // ← 改成你的
const job_requisition_id = "JR-2026-001";  // ← 改成你的

const job_requisition = {
  job_requisition_id,
  client_id: "CLI_TENCENT_PCG",                  // ← 决定规则过滤的客户维度
  client_department_id: "CLI_TENCENT_IEG_TIANMEI", // ← 决定部门维度（business_group）
  // 其余 prompt 信息可以保留默认或者按 JD 改
};
```

`client_id` / `client_department_id` 影响 `applyClientFilter` 的结果：只有 `executor=Agent` 且（`applicableClient=通用` 或 `applicableClient` 匹配 `client_id` 且 department 维度兼容）的规则才会被丢给 LLM。

### 3.2 跑

```bash
npx tsx scripts/run-match-resume-rule-check.ts
```

> 不需要先编译，`tsx` 直接跑 TS。整个调用通常需要 10–30 秒（取决于 LLM 网关延迟和 tool-use 轮数）。

### 3.3 期望输出

```
→ runRuleCheck candidate_id=C-100023 job_requisition_id=JR-2026-001

========== MatchResumeCheckResult ==========

{
  "decision": "PASS",   // 或 "FAIL" / "REVIEW"
  "stats": {
    "total": 25,
    "pass": 22,
    "fail": 0,
    "pending": 1,
    "insufficient_info": 2,
    "not_triggered": 0,
    "not_executed": 0
  },
  "rule_results": [
    {
      "rule_id": "10-25",
      "rule_name": "华为荣耀竞对与客户互不挖角红线",
      "step_id": "10::validateRedlineAndBlacklist",
      "status": "pass"
    },
    ...每条规则一条
  ],
  "explanations": [
    {
      "rule_id": "10-27",
      "rule_name": "腾讯亲属关系回避规则",
      "step_id": "10::evaluateBonusAndCheckReflux",
      "status": "pending",
      "reason": "..."
    }
    // 只列 fail / pending / insufficient_info / not_executed
  ],
  "audit": {
    "rules_evaluated": 25,
    "graph_calls": 6,
    "llm_model": "google/gemini-3-flash-preview",
    "llm_duration_ms": 18000,
    "llm_round_trips": 1,
    "llm_prompt_tokens": 8200,
    "llm_completion_tokens": 1100,
    "rule_source": "ontology-api"
  }
}

========== summary ==========
decision      : PASS
stats         : pass=22 fail=0 pending=1 info=2 not_triggered=0 not_executed=0 (total=25)
rule_results  : 25 entries
explanations  : 3 entries
audit         : rules_evaluated=25 graph_calls=6 model=google/gemini-3-flash-preview tool_rounds=1 llm_ms=18000
wall          : 18432ms
```

---

## 4. 输出解读

### 4.1 `decision`
- `PASS` — 没有规则 fail，也没有 pending / insufficient_info。
- `REVIEW` — 有 pending 或 insufficient_info，需要人工复核。
- `FAIL` — 至少一条规则 fail。

### 4.2 `stats`
| 字段 | 含义 |
|---|---|
| `total` | LLM 实际评估的规则数（= 经过 client/department 过滤后的规则总数） |
| `pass` | 规则通过 |
| `fail` | 规则命中且 action = "终止匹配" |
| `pending` | 规则命中且 action = "挂起待人工" / "标记风险继续" |
| `insufficient_info` | 缺关键字段 / 信息不全 |
| `not_triggered` | `submissionCriteria` 不成立，规则未被评估 |
| `not_executed` | 前序 fail 导致后续规则被短路 |

stats 是 runner 从 `rule_results` 重新算的，**忽略 LLM 自己报的 stats**。这是为了防止 LLM 幻觉。

### 4.3 `rule_results` vs `explanations`
- `rule_results` 包含**所有规则**的逐条结果，按 Set + Set 内顺序输出。用于 debug、审计、回放。
- `explanations` 只包含**需要解释的规则**（非 pass、非 not_triggered），是 `match-resume-agent` 和 Inngest 事件 payload 实际读取的字段。

### 4.4 `audit.fail_reason`
正常情况下不出现。出现时的常见值：
| 值 | 含义 |
|---|---|
| `ontology-graph-unavailable` | neo4j / Studio 接口返回 401 / 5xx |
| `llm-call-error` | LLM 网关调不通 / 抛错 |
| `tool-use-loop-exceeded` | LLM 反复 tool call 超过 5 轮（极少见） |
| `parse-error` | LLM 输出不是合法 JSON，或 `rule_results` 数量与期望不符 |

---

## 5. 常见问题排查

### 5.1 `decision=FAIL`，`audit.fail_reason=ontology-graph-unavailable`
- 检查 Studio (`http://localhost:3500`) 起来了没。
- 检查 `ONTOLOGY_API_TOKEN` 跟 Studio 启动时的 token 一致。`curl -H "Authorization: Bearer $ONTOLOGY_API_TOKEN" http://localhost:3500/api/v1/ontology/instances/Candidate/<id>?domain=RAAS-v1` 看返回。

### 5.2 `decision=FAIL`，`audit.fail_reason=llm-call-error`
- `AI_BASE_URL`/`AI_API_KEY`（或 `OPENAI_API_KEY`）配了吗？
- 网关本身能 ping 通吗？拿 curl 手动调一次 `/v1/chat/completions` 看响应。
- 用了内部网关的话，确认 `AI_MODEL` 是网关支持的模型名。

### 5.3 `decision=FAIL`，`audit.fail_reason=parse-error`
- LLM 没按 schema 输出 `rule_results`，或者条数和过滤后的规则数对不上。
- 把 prompt 单独拉出来人工跑一遍（参考 `scripts/run-match-resume-prompt.ts`，它只生成 prompt 不调 LLM），看模型回了啥。
- 也可能是模型 token 上限不够；在脚本里调 `runRuleCheck` 之前可以临时把 `chatComplete` 的 `maxTokens` 调大（默认 800 对全量 rule_results 输出可能太小）。
  - 永久方案：把 `lib/rule-check/runner.ts` 里 `chatComplete({...})` 调用加上 `maxTokens: 8000` 之类。

### 5.4 大量规则 `status=insufficient_info`
- 图上下文 slot 为空。打印一下 `result.audit.graph_calls`：如果是 6，至少调了；但如果某个 slot 是 null/[]，对应规则就会信息不全。
- 临时在脚本里加几行 console.log，或者直接调 `buildGraphContext({ candidate_id, job_requisition_id })` 看返回。

### 5.5 `total = 0`，规则全没跑
- `applyClientFilter` 把所有规则都过滤掉了，意味着 `client_id` / `client_department_id` 没匹配上任何规则（或者 ontology 里就没规则）。
- 检查 `audit.rule_source`：
  - `ontology-api` → 真从 Studio 拿到了规则，但全被 client/department filter 干掉。试试改成 `client_id = "CLI_TENCENT_PCG"`（默认就有 `applicableClient="通用"` 的规则）。
  - `json-fallback` → Studio 接口挂了或 token 错；走的是 `lib/rule-check/rules.json` 的静态备份。

---

## 6. 进阶：扫描多个候选人

脚本目前是单候选人。要批量跑，最简单的办法是在 `main()` 里包一层 for 循环：

```ts
const candidates = ["C-100023", "C-100024", "C-100025"];
for (const id of candidates) {
  const input = buildRuleCheckInput({
    runtime_context: { ...runtime_context, candidate_id: id },
    parsed_resume: null,
    job_requisition,
  });
  const result = await runRuleCheck(input);
  console.log(`${id} → ${result.decision} (fail=${result.stats.fail} pending=${result.stats.pending})`);
}
```

每个候选人的 `buildGraphContext` 是独立的，不会跨候选人复用缓存——这是设计上故意的（缓存是 per-invocation）。如果想测大批量，注意 LLM 网关的 rate limit。

---

## 7. 相关文件

| 文件 | 作用 |
|---|---|
| `scripts/run-match-resume-rule-check.ts` | 本指南讲的测试脚本 |
| `lib/rule-check/runner.ts` | `runRuleCheck` 实现 |
| `lib/rule-check/graph-context.ts` | 图上下文预取（候选人 / 简历 / JD / 投递史 / 黑名单 / 就职关系） |
| `lib/rule-check/prompt.ts` | prompt 模板（§2 Inputs + §3 Graph Context + §4 Rules + §6 Output schema） |
| `lib/rule-check/types.ts` | `MatchResumeCheckResult` / `RuleResult` 等类型 |
| `docs/action_object_prompt/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md` | Ontology API 完整参考（实例 CRUD / link CRUD / 错误码） |
| `docs/superpowers/specs/2026-05-12-match-resume-per-rule-results-design.md` | 最近一次设计文档（per-rule + neo4j resume） |
