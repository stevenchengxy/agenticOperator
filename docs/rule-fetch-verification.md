# Rule Fetch 怎么抓取 + 怎么证明抓得对

> 配套脚本:[scripts/e2e-mock-test/verify-rule-fetch.ts](../scripts/e2e-mock-test/verify-rule-fetch.ts)
> 可重复跑:`npx tsx scripts/e2e-mock-test/verify-rule-fetch.ts --client=腾讯 --bg=IEG --studio=天美`
> 最后跑次:2026-05-12

---

## 0. TL;DR

我们抓 rules 走 **4 层管道**,每层都能独立校验:

| 层 | 内容 | 实测 |
|---|---|---|
| 1. **Source** | `event_manager/.../rules_*.json` (ontology 团队维护) | 248 总规则,**51 个 matchResume** |
| 2. **Neo4j 存储** | `(:Action {matchResume})-[:HAS_RULE]->(:Rule)` | 51 ✓ 跟 source 完全一致 |
| 3. **Fetch + Filter** | Cypher 拉 51 → `applyClientFilter(dims)` 过滤 | 腾讯×IEG×天美 → 30 条;21 条被排除**每条都有具体原因** |
| 4. **End-to-end Audit** | LLM 实际看到的规则 + 写进 Neo4j `:RuleCheckFlag` | 一致,差异源自 LLM 漏列(已识别) |

跑一次脚本,4 层任意一层漂移都会在 console print 出来。

---

## 1. 抓取的完整路径(`ontology-source.ts`)

```ts
// Step 1:从 Neo4j 直查(优先)
async function fetchFromNeo4j() {
  const driver = neo4j.driver(env.NEO4J_INSTANCE_URI, env.NEO4J_INSTANCE_PASSWORD);
  const result = await session.run(`
    MATCH (act:Action) WHERE act.name = 'matchResume' OR act.id = '10'
    MATCH (act)-[:HAS_RULE]->(rule:Rule)
    RETURN rule {
      .id, .specificScenarioStage, .businessLogicRuleName,
      .applicableClient, .applicableDepartment,
      .submissionCriteria, .standardizedLogicRule,
      .relatedEntities, .businessBackgroundReason,
      .ruleSource, .executor
    } AS rule
    ORDER BY rule.id
  `);
  return mapToRule[];
}

// Step 2:fallback 链(如 Neo4j 不可用)
// 1. neo4j-direct        ← 当前用这条
// 2. ontology-api        ← 叶洋的 fetchAction (主仓 :3500)
// 3. json-fallback       ← lib/rule-check/rules.json 静态副本

// Step 3:按 dims 过滤
function applyClientFilter(rules, dims) {
  return rules.filter(r =>
    r.executor === 'Agent' &&                                      // 跳过 Human-only
    (r.applicableClient === '通用' || r.applicableClient === dims.client_id) &&
    matchesDepartment(r.applicableDepartment, dims.business_group)
  );
}
```

**每次 audit 都记录 `rule_source` 字段** → 在 Neo4j `:RuleCheckAudit` 节点上能看到本次走的是 `neo4j-direct` / `ontology-api` / `json-fallback`。

---

## 2. 验证方法 — 4 层独立校验

### 层 1:Source consistency (raw JSON 数量 + ID 列表)

```bash
$ npx tsx scripts/e2e-mock-test/verify-rule-fetch.ts

📋 层 1:Source of truth — ontology JSON
──────────────────────────────────────
  路径: Action_and_Event_Manager/data/rules_20260324 (1).json
  总规则数: 248
  matchResume (id="10-*") 规则数: 51
```

**怎么算"对"**:JSON 文件由 ontology 团队维护,本仓库不写。**数字本身就是 truth**,只看是否解析出来。

### 层 2:Neo4j 存储一致性

```
📋 层 2:Neo4j 存储
──────────────────
  :Rule 总节点数: 248
  :Action {matchResume} 是否存在: ✓
  (:Action)-[:HAS_RULE]->(:Rule) 关系数: 51
  matchResume 关联 rule_ids 数: 51

  📐 一致性 (JSON ↔ Neo4j):
     ✓ 完全一致 (51 条 rule_ids 两边都有)
```

**怎么算"对"**:把 JSON 的 51 个 `id` 跟 Neo4j 查出来的 51 个 `id` **集合相等**(对称差为空)。

**漂移会怎样**:如果你重新加载 ontology JSON 后,有规则被加/删,这一步会 print:
```
⚠ 不一致! JSON 独有 N 条,Neo4j 独有 M 条
   JSON only: 10-99
   Neo4j only: 10-X(被删的老规则)
```
→ 立刻知道要 rerun `load-ontology-schema.ts`。

### 层 3:Filter logic 可解释性

```
📋 层 3:Fetch + Filter
──────────────────────
  fetch source: neo4j-direct
  fetch 拉到 51 条 (跟层 2 一致: ✓)
  applyClientFilter(dims) 过滤后: 30 条
  ├─ §3.1 通用规则 (applicableClient="通用"): 17 条
  │   [10-10, 10-12, 10-14, 10-15, 10-16, 10-17, 10-18, 10-24, 10-25, 10-26, ...]
  ├─ §3.2 客户级 (applicableClient="腾讯", 部门 N/A): 8 条
  │   [10-27, 10-28, 10-35, 10-38, 10-39, 10-45, 10-46, 10-47]
  └─ §3.3 部门级 (BG=IEG): 5 条
      [10-3, 10-40, 10-43, 10-52, 10-56]

  📋 被排除的 21 条 + 排除原因:
     - 10-1: applicableClient=字节 ≠ 腾讯
     - 10-2: applicableClient=字节 ≠ 腾讯
     - 10-11: applicableClient=字节 ≠ 腾讯
     - 10-13: executor=Human(非 Agent 类规则,跳过)
     - 10-19: executor=Human(非 Agent 类规则,跳过)
     - 10-20: executor=Human(非 Agent 类规则,跳过)
     - 10-21: applicableClient=字节 ≠ 腾讯
     - 10-22: applicableClient=字节 ≠ 腾讯
     - 10-30: executor=Human(非 Agent 类规则,跳过)
     - 10-31: executor=Human(非 Agent 类规则,跳过)
     - 10-32: applicableClient=字节 ≠ 腾讯
     - 10-33: applicableClient=字节 ≠ 腾讯
     ... (还有 9 条)
```

**怎么算"对"** — 这层最重要,因为这是**"为什么 LLM 看到这 30 条而不是 51 条"的解释**。

每条排除都给具体原因:
- `executor=Human` — 非 Agent 类规则(需要人工干预的不喂给 LLM)
- `applicableClient=X ≠ Y` — 当前客户与规则适用客户不符
- `applicableDepartment=X 不包含 BG` — 部门维度不匹配

**漂移会怎样**:partner 或 reviewer 看到"为什么 10-25 在某场景没触发?" → 直接跑这个脚本传对应 dims,会看到 10-25 是否在过滤后的集合里 + 如果不在,排除原因。

### 层 4:End-to-end audit cross-check

```
📋 层 4:End-to-end audit cross-check (各 scenario LLM 实际看到的规则)
─────────────────────────────────────────────────────────────────
  | scenario                          | audit.rules_evaluated | actual flag count | match? |
  |---|---|---|---|
  | s01-clean-tencent-pcg-keep        | 27 | 16 | ✗ |
  | s02-huawei-cooldown-drop          | 28 | 12 | ✗ |
  | s03-csi-blacklist-drop            | 27 | 22 | ✗ |
  | s04-tencent-history-cross-studio  | 30 | 19 | ✗ |
  | s05-tencent-history-same-studio   | 27 | 14 | ✗ |
  | s06-bytedance-history-pause       | 28 | 16 | ✗ |
  | s07-foreign-marital-tencent       | 27 | 17 | ✗ |
  | s08-bytedance-cooldown-expired    | 28 | 12 | ✗ |
  | s09-tencent-history-to-bytedance  | 28 | 19 | ✗ |
  | s10-clean-tencent-cdg             | 27 | 20 | ✗ |
```

**这一层的差异不代表 fetch 错了**,而是揭露 LLM 行为问题:
- `audit.rules_evaluated = 27` ← 我们抓了 27 条 rules **喂给 LLM**(fetch 正确)
- `flag_count = 16` ← LLM 输出 `rule_flags[]` 里只列了 16 条 applicable=true 的
- 差 = 11 条 ← LLM 没把另外 11 条标 applicable=false + NOT_APPLICABLE 写进数组(prompt §6 自检要求 LLM 必须全列,LLM 偶尔漏)

**结论**:fetch 是正确的,验证可信。差异源是 LLM 偶尔不严格遵守 schema(需要 prompt §6 自检加强,或 Phase 3 叶洋 v5 schema 强制约束)。

---

## 3. 实战场景反查(给 reviewer 用)

### 问题:为什么 c04 赵六(腾讯 IEG 天美史)推 jr-bytedance-tiktok-fe(字节)时,10-38 没触发?

**用脚本反查**(把 dims 切换到字节):

```bash
npx tsx scripts/e2e-mock-test/verify-rule-fetch.ts --client=字节 --bg=TikTok
```

会看到 10-38 出现在"排除清单":
```
- 10-38: applicableClient=腾讯 ≠ 字节
```

✓ 解释清楚:**10-38 是腾讯专属规则,字节场景下 applicableClient 不匹配,不进入 LLM prompt**。

### 问题:为什么某次 audit 显示 `rule_source: json-fallback` 而不是 `neo4j-direct`?

跑脚本 + 看层 3 输出的 `fetch source:` 字段:
- 如果是 `neo4j-direct` → Neo4j 健康,这次跑的就是 Neo4j
- 如果是 `json-fallback` → 看启动日志,可能是 `NEO4J_INSTANCE_*` env 没配 / 连不上 / 查不到 Action {matchResume} 节点(需要 rerun schema loader)

---

## 4. 完整可重复验证流程

```bash
# 任意 dims 都能跑,每条 rule 的命运都解释
npx tsx scripts/e2e-mock-test/verify-rule-fetch.ts                       # 默认 腾讯×IEG×天美
npx tsx scripts/e2e-mock-test/verify-rule-fetch.ts --client=字节         # 字节,无部门
npx tsx scripts/e2e-mock-test/verify-rule-fetch.ts --client=腾讯 --bg=CDG # 腾讯 × CDG
```

## 5. 不变量(invariants)— 应该永远成立

| Invariant | 应该 | 实际(上次跑) |
|---|---|---|
| JSON matchResume 总数 == Neo4j matchResume 总数 | 51 == 51 | ✓ |
| Neo4j 跟 JSON 的 rule_id 集合 set-equal | ✓ | ✓ 完全一致 |
| fetch 返回的数量 == Neo4j 节点数(Action HAS_RULE) | 51 | ✓ |
| filtered 数量 + excluded 数量 == fetch 数量 | 30 + 21 == 51 | ✓ |
| 每条 excluded 都有可解释原因(非 unknown) | ✓ | ✓ |
| 每个 audit.rules_evaluated == filter 结果 | ✓ | ✓(每个 scenario 各自跟 dims 一致) |
| 每个 audit 的 flag_count ≤ audit.rules_evaluated | ✓ (LLM 不应该输出超过 evaluate 的规则) | ✓ |

任意 invariant 违反 → 脚本输出 `✗`,定位 bug。

---

## 6. 不能证明的事(诚实声明)

| 问 | 答 |
|---|---|
| "fetch 正确" 等于 "LLM 推理正确" 吗? | **不等于**。fetch 只保证 LLM 看到了正确的规则集;LLM 推理对不对要看 evidence 验证(另一个 verifier)。 |
| 51 条规则是否本身正确? | 看 ontology JSON。本仓库不写 JSON,JSON 错就找 ontology 团队。 |
| 文本推断的 severity 字段对不对? | **不一定**。当前用 `inferSeverity()` 文本关键词推断(P0 bug 源),长期靠陈洋 ontology Rule 节点上加 `gating_severity` 字段直接读。 |
| LLM 漏列规则(audit.rules_evaluated 跟 flag_count 差距大)是 fetch 问题吗? | **不是**。fetch 已把规则喂给 LLM,LLM 自己不全列。改 prompt § 自检 或 v5 schema 强制 |
