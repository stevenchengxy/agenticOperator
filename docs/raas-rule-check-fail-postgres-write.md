# Rule Check 失败后写入 Postgres 的位置与方式（致 RAAS partner）

**日期：** 2026-05-26
**适用：** AO（Agentic Operator）`ruleCheckAgent` → partner Postgres
**一句话：** rule-check **失败（未通过）** 时，AO 会往 partner-pg 的 **`candidate_match_result`** 表写/更新一行，结果落在 **`match_status='未通过'` + `match_reason`** 两个**已有列**上（partner-pg 没有独立的 rule_check 列）。**通过（PASS）则不在 rule-check 阶段写**。

---

## 1. 写哪张表

| 项 | 值 |
|---|---|
| 库 | partner Postgres（RAAS 侧）|
| 表 | **`candidate_match_result`**（主表）|
| 不写 | `candidate_match_result_runtime_state`（评分/技能分析表，rule-check 失败不涉及）|
| 主键 PK | `candidate_match_result_id` = **`cmr_<candidate_id>_<job_requisition_id>`**（一对 (候选人, JR) 一行）|

> 注意：partner-pg `candidate_match_result` 表**没有** `rule_check_result` / `rule_check_reason` 列。那两个字段只存在于 **Allmeta / Neo4j 的 `Candidate_Match_Result` 节点**上（见 §6）。在 Postgres 这边，rule-check 的"未通过 + 原因"被映射到表里已有的 `match_status` / `match_reason`。

## 2. 触发条件

仅当**整体 `decision = FAIL`**（至少一条 mandatory 规则 `status=fail`）时写。且需要：
- `candidate_id` 非空；
- AO 已配置 partner-pg 连接（`RAAS_POSTGRES_URL`）。

`decision = PASS`（含原 REVIEW，现已折成 PASS）→ **rule-check 阶段不写 `candidate_match_result`**，直接 emit `MATCH_RULE_CHECK_PASSED`，由下游 `matchResumeAgent` 调完 RoboHire 后再写整行（含真实 `match_score`）。

## 3. 写入的列（FAIL 时）

| 列 | 值 | 说明 |
|---|---|---|
| `candidate_match_result_id` | `cmr_<candidate_id>_<jr_id>` | PK |
| `candidate_id` | 候选人 ID | |
| `job_requisition_id` | JR ID | |
| `job_posting_id` | 该 JR 最近一条 posting（best-effort，可能为 `NULL`）| 只为把行链进 MatchPool；**解析不到也照常写**，不阻塞 |
| `match_score` | **`NULL`** | rule-check 阶段无匹配分 |
| `match_status` | **`'未通过'`** | ★ rule-check 失败的落点 |
| `match_reason` | 失败规则拼接串（见 §5）| ★ 失败原因 |
| `stage` | **`'rule_check'`** | ★ 用于区分"rule-check 失败" vs "匹配失败"（见 §7）|
| `created_by` | `'ai_engine.ruleCheck'` | ★ 来源标记 |
| `created_at` / `updated_at` | `NOW()` | |

## 4. 怎么写入（upsert 机制）

代码：[lib/partner-pg/rule-check-result.ts](../lib/partner-pg/rule-check-result.ts) `saveRuleCheckFailToPartnerPg()`，由 [server/inngest/agents/rule-check-agent.ts](../server/inngest/agents/rule-check-agent.ts) 的 FAIL 分支调用。

一个事务（`withTx`）内三步：

**① best-effort 解析 posting（不 gate 写入）**
```sql
SELECT job_posting_id FROM job_posting
 WHERE job_requisition_id = $1
 ORDER BY published_at DESC NULLS LAST, created_at DESC
 LIMIT 1;
```

**② 看 PK 是否已存在**
```sql
SELECT candidate_match_result_id FROM candidate_match_result
 WHERE candidate_match_result_id = $1 LIMIT 1;
```

**③a 存在 → UPDATE**
```sql
UPDATE candidate_match_result SET
    match_score    = NULL,
    match_reason   = $2,            -- 失败原因
    match_status   = $3,            -- '未通过'
    job_posting_id = COALESCE($4, job_posting_id),
    updated_at     = NOW()
 WHERE candidate_match_result_id = $1;
```

**③b 不存在 → INSERT**
```sql
INSERT INTO candidate_match_result (
    candidate_match_result_id, candidate_id, job_requisition_id,
    job_posting_id, match_score, match_reason, match_status,
    stage, created_by, created_at, updated_at
) VALUES (
    $1, $2, $3,
    $4, NULL, $5, '未通过',
    'rule_check', 'ai_engine.ruleCheck', NOW(), NOW()
);
```

**关键点**
- **无条件写主表** —— 不像通用匹配写入器那样要求"必须先有 job_posting"才写主表。没 posting 的 JR（如 reassign 路径）rule-check 失败也会落行（`job_posting_id` 为 `NULL`）。
- **不写 `runtime_state`**、**没有 sparser 守卫**（那些是匹配评分专用逻辑）。
- **Soft-fail**：写库报错只 `logger.warn`，**不阻塞** AO 继续 emit `MATCH_RULE_CHECK_FAILED` 事件。

## 5. `match_reason` 格式

由所有 `status=fail` 的规则拼成，用 ` | ` 分隔，截断到 1000 字符：
```
[<rule_id>] <rule_name>: <reason> | [<rule_id>] <rule_name>: <reason> | ...
```
例：
```
[10-45] 腾讯正编转外包回流标记: 简历显示曾任职腾讯CDG行政专员，命中正编转外包受控状态。
```

## 6. 与 Allmeta / Neo4j 的关系（双写）

同一次 rule-check FAIL，AO 还会写 **Allmeta / Neo4j 的 `Candidate_Match_Result` 节点**（同一 PK `cmr_<cand>_<jr>`），那边有专门的字段：
- `rule_check_result = '未通过'`
- `rule_check_reason = <同上原因>`

即：**Neo4j 侧有 `rule_check_*` 一等字段；Postgres 侧没有，用 `match_status/match_reason` 承载。** 如果 RAAS 想要"语义最干净"的 rule-check 结论，读 Neo4j 的 `rule_check_result`；如果读关系库 `candidate_match_result`，按 §7 区分。

## 7. RAAS 端怎么识别"这是 rule-check 失败"（而非匹配失败）

因为 Postgres 把两类都映射到 `match_status='未通过'`，请用下列特征区分一条 `candidate_match_result` 是 **rule-check 阶段的失败**：

```sql
SELECT * FROM candidate_match_result
 WHERE match_status = '未通过'
   AND stage        = 'rule_check'      -- rule-check 阶段写的
   AND match_score  IS NULL             -- 还没跑匹配评分
   AND created_by   = 'ai_engine.ruleCheck';
```

后续若该候选人在别的 JR 上通过 rule-check 并跑完匹配，`matchResumeAgent` 会以**同一 PK** 把行更新成真实匹配结果（`match_score` 填值、`stage` 变 `'draft'`、`created_by='ai_engine'`）—— 届时它就不再是"rule-check 失败行"。

## 8. 给 RAAS 的 schema 建议（可选）

当前是把 rule-check 结论塞进 `match_status/match_reason`（语义上和"匹配未通过"重叠，靠 `stage`/`match_score`/`created_by` 区分）。如果希望两边 schema 对齐、语义更清晰，可在 `candidate_match_result` 上**新增 `rule_check_result` / `rule_check_reason` 两列**（与 Allmeta 节点对齐）；AO 这边只需把写入从 `match_status/match_reason` 改到这两列即可，改动很小。**此为可选优化，当前方案无需 RAAS 改 schema。**
