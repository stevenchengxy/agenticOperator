# AO Neo4j 本体 API — 接入卡(给付卓新)

> 这是 AO 的 **Neo4j 本体只读接口**(Allmeta Ontology API,直接背靠 Neo4j)。
> 你用它做:① 覆盖率分母(域内规则全集)② 核对规则原文/版本指纹 ③ 归因第 5 步核对候选人/岗位权威数据。
> 完整 endpoint 手册见同目录:[ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md](./action_object_prompt/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md)(本卡只给你联调最常用的几条 + 真实连接参数)。

---

## 1. 连接参数

| 项 | 值 |
|---|---|
| **Base URL** | `http://192.168.1.111:3500`(2026-06-23 实测纠正:旧卡写的 `.104` 已失效/不可达,现为 `.111`) |
| **鉴权** | `Authorization: Bearer abc123` 或 `x-api-key: abc123`(:3500 本体 API 的 token,**与 :3002 执行 API 的 `aek_live_...` 不是同一把**) |
| **域(domain)** | `招聘-v1`(请求都要带 `?domain=招聘-v1`;`RAAS-v1` / `raas` 是历史别名,以 `招聘-v1` 为准) |

> ⚠️ domain 含中文,URL 里要 percent-encode(curl 用 `--data-urlencode "domain=招聘-v1"`)。

---

## 2. 你联调最常用的 4 条

### ① 域内规则全集 —— 覆盖率分母的正确来源

```bash
curl -s -G "http://192.168.1.111:3500/api/v1/ontology/rules" \
  --data-urlencode "domain=招聘-v1" --data-urlencode "limit=1000" \
  -H "Authorization: Bearer $TOK"
# → { "items": [ {id, businessLogicRuleName, standardizedLogicRule, executor, enforcementLevel, failurePolicy, applicableClient, applicableDepartment, ...}, ... ] }
```
- 这是**不预过滤**的全集(含 `executor=Human` / `optional`)。算 Agent 覆盖率分母时,按 `executor='Agent'` 且 `enforcementLevel='mandatory'` 自行筛一遍(这是 AO 执行引擎的评估口径)。
- 支持 `?cursor=` 翻页;`?limit` 默认 100、最大 1000。

### ② 执行引擎同款规则面(matchResume 的 Action 规则,按步骤分组)

```bash
curl -s -G "http://192.168.1.111:3500/api/v1/ontology/actions/ruleCheckForMatchResume/rules" \
  --data-urlencode "domain=招聘-v1" -H "Authorization: Bearer $TOK"
# → { id, name, action_steps:[{id, order, name, rules:[...]}], rules:[...扁平去重...], ruleCount }
```
这是执行 API 评估时实际拉取规则的同一接口,适合和执行 API 返回的 `retrievedRuleIds` 对账。

### ③ 单条规则原文(核对 ruleTextSnapshot)

```bash
curl -s -G "http://192.168.1.111:3500/api/v1/ontology/rules/10-5" \
  --data-urlencode "domain=招聘-v1" -H "Authorization: Bearer $TOK"
```
`standardizedLogicRule` 就是执行 API `ruleEvaluations[].ruleTextSnapshot.sha256` 取哈希的那段全文。

### ④ 候选人/岗位实例读取(归因第 5 步核对权威数据)

```bash
curl -s -G "http://192.168.1.111:3500/api/v1/ontology/instances/Candidate/C_5eacb369" \
  --data-urlencode "domain=招聘-v1" -H "Authorization: Bearer $TOK"
curl -s -G "http://192.168.1.111:3500/api/v1/ontology/instances/Job_Requisition/mock_jr_v0_1_010_1778766302725" \
  --data-urlencode "domain=招聘-v1" -H "Authorization: Bearer $TOK"
# 列表查询(如某候选人名下简历):/api/v1/ontology/instances/Resume?domain=招聘-v1&candidate_id=C-...
```
Label 取值:`Candidate` / `Resume` / `Job_Requisition` / `Application` / `Blacklist`;链接查询走 `/api/v1/ontology/links?domain=招聘-v1&from=<id>&type=EMPLOYED_BY`。

---

## 3. 约定 & 错误

- 节点是 property-bag 语义:嵌套对象/数组以 JSON 字符串存储,读出后按需 `JSON.parse`。做 schema 校验请用"允许未知字段"模式。
- 错误形状:`{ "error": "<code>", "message": "..." }`。常见:`401 unauthorized`(token 缺/错)、`400 missing-domain`、`404 node-not-found` / `action-not-found`、`502 neo4j-unavailable`(Neo4j 不可达)。
- 字段全集/schema 自描述:`GET /api/v1/ontology/schema/rules?domain=招聘-v1`。

---

## 4. 与执行 API 的关系

- **执行 API**(`http://192.168.1.111:3002/api/agent-execution`,见《调用指南》):你发用例,AO 用生产引擎跑、回结论+trace。**AO 自己会用本 Neo4j API 取数**,你不必代取。
- **本 Neo4j API**:给你**旁路**核对用——覆盖率分母、规则原文指纹、归因第 5 步的数据核对。两者 domain 一致(`招聘-v1`)、规则 id 一致(`10-5` 这种本体原始 id),可直接 join。
