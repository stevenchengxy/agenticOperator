# AO 架构 + Neo4j 集成审计 — 现状、问题、修复方案

> **日期**:2026-05-12
> **触发**:Q1 — "我们项目是否调 Neo4j 走 allmetaOntology?" + Q2 — "Candidate/Resume 实例数据没跟 Job_Requisition / Job_Posting 关联"
>
> 本文系统梳理 AO 的 env / Neo4j / Inngest / workflow agents / 当前 workflow,然后对照 allmetaOntology 设计文档([本地路径](/Users/yuhancheng/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md)),列出**5 个明确问题** + **修复方案** + **实施顺序**。

---

## 0. TL;DR

| 检查项 | 现状 | 评估 |
|---|---|---|
| **调 Neo4j 是否走 allmeta API** | ❌ **不走**。AO 直接用 `neo4j.driver()` 连本地 / partner Neo4j | 长期应切 allmeta(§3) |
| **Candidate / Resume 跟 Job_Requisition 是否关联** | ❌ **schema 分裂**。两个 writer 用不同 label,数据物理上分两个孤岛 | 本次修复重点(§4) |
| **Inngest 现状** | ✓ v1.19.2 升级完成,AO 3 个 function 已注册,事件链通畅 | 健康 |
| **Workflow agents 配套** | ✓ 3 个 agent(resumeParser / createJD / matchResume)正常 | 健康 |
| **env 配置** | ✓ 双 Neo4j(本地实例 + partner 共享)+ RAAS API + LLM gateway 全配齐 | 健康 |

---

## 1. AO 架构现状

### 1.1 Env 配置(`.env.local`)

```bash
# === LLM gateway ===
AI_BASE_URL=http://10.100.0.70:3010/v1
AI_MODEL=google/gemini-3-flash-preview

# === Inngest(本地 dev server) ===
INNGEST_BASE_URL=http://localhost:8288
INNGEST_DEV=http://localhost:8288
INNGEST_EVENT_KEY=dev
INNGEST_SERVE_HOST=http://host.docker.internal:3002
INNGEST_SERVE_PATH=/api/inngest
INNGEST_SIGNING_KEY=dev

# === RAAS 通讯 ===
RAAS_INTERNAL_API_URL=http://192.168.1.105:3001   # partner RAAS API
RAAS_AGENT_API_KEY=internal-agentic-agent
RAAS_INNGEST_URL=http://10.100.0.70:8288          # partner Inngest
RAAS_FORWARD_ENABLED=1                            # AO local → partner Inngest bridge
RAAS_BRIDGE_ENABLED=0                             # partner → AO inbound,关
RAAS_DEFAULT_EMPLOYEE_ID=0000199059

# === Neo4j(两个实例!)===
# 实例图:本地 Docker container e2e-test-neo4j,AO 写 audit / Candidate / Resume / JR 等
NEO4J_INSTANCE_URI=bolt://localhost:7688
NEO4J_INSTANCE_PASSWORD=testpassword123

# Allmeta Ontology + EM event def sync 用:partner 共享 Neo4j,陈洋维护
RAAS_LINKS_NEO4J_URI=neo4j://10.100.0.70:7687
RAAS_LINKS_NEO4J_PASSWORD=neo4j@321
NEO4J_SYNC_ENABLED=1                              # EM sync 每 5 分钟跑一次

# === MinIO(简历文件存储)===
MINIO_ENDPOINT=10.100.0.70:9000
```

### 1.2 Neo4j 架构 — **双实例,角色不同**

```
┌──────────────────────────────────────────────────────────────┐
│  本地 Neo4j (bolt://localhost:7688)                          │
│  - Docker container: e2e-test-neo4j                          │
│  - AO 端 instance writer 主要写入这里                         │
│  - 节点 label:                                                │
│      :RuleCheckAudit / :RuleCheckFlag (rule-check 决策审计)   │
│      :Action / :Rule / :Event / :DataObject (ontology 拷贝)   │
│      :Candidate / :Resume / :JobRequisition (rule-check 实例)│
│      :Job_Requisition / :Job_Posting (createJD 实例)         │
│      ↑ ⚠️ 命名分裂 — 见 §4.1                                 │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Partner Allmeta Neo4j (neo4j://10.100.0.70:7687)            │
│  - 陈洋 / 全 partner 共享                                     │
│  - 暴露 HTTP API :3500 (Studio app, /api/v1/ontology/*)      │
│  - 节点 label:同上 + 业务实体节点(:Client, :Employee...)    │
│  - AO 端**只读**(EM sync worker 拉 :Event schema)            │
└──────────────────────────────────────────────────────────────┘
```

### 1.3 Inngest 架构(2026-05-12 升级后)

| 组件 | 配置 | 状态 |
|---|---|---|
| Server | Docker `inngest/inngest:v1.19.2`(从 v1.4.0 升上来) | ✓ 跑在 `localhost:8288` |
| AO SDK | `inngest@4.3.0` | ✓ 跟 server v1.19.2 兼容 |
| AO 注册的 function | 3 个:`resume-parser-agent` / `create-jd-agent` / `match-resume-agent` | ✓ 通过 `host.docker.internal:3002/api/inngest` sync |
| Partner RAAS SDK | `inngest@^3.52.7` | ⚠️ **被 v1.19.2 server 拒绝**(CVE-2026-42047)— partner 需升 ≥3.54.0 |

### 1.4 Workflow Agents

```
[RAAS upload]
      │
      └─→ RESUME_DOWNLOADED ──► [① resumeParserAgent]
                                  ├ RAAS GET /api/v1/resumes/uploads/:id/raw
                                  ├ RAAS POST /api/v1/parse-resume (RAAS→Robohire 代理)
                                  ├ RAAS POST /api/v1/candidates(写 partner Postgres)
                                  └─→ RESUME_PROCESSED ──┐
                                                          │
[RAAS dashboard 录入需求]                                  │
      │                                                   │
      └─→ REQUIREMENT_LOGGED ──► [② createJdAgent]        │
                                  ├ RAAS GET /api/v1/requirements/:id
                                  ├ RAAS POST /api/v1/generate-jd
                                  ├ RAAS POST /api/v1/jd/sync-generated
                                  ├ **本地 Neo4j 写 :Job_Requisition + :Job_Posting** ★ neo4j-jd-writer
                                  └─→ JD_GENERATED
                                                          │
                                  ┌───────────────────────┘
                                  ▼
                             [③ matchResumeAgent]
                              ├ RAAS GET /api/v1/requirements/agent-view (拉候选 JR)
                              ├ 对每条 JR:
                              │   ├ runRuleCheck(parsed_resume, jr, rules) → LLM 评判
                              │   ├ **本地 Neo4j 写 :RuleCheckAudit + :RuleCheckFlag**
                              │   │   **+ :Candidate / :Resume / :JobRequisition** ★ neo4j-instance-writer
                              │   │       ↑ ⚠️ 这里用 :JobRequisition (无下划线)
                              │   │         跟 ② 写的 :Job_Requisition (有下划线) 分裂!
                              │   ├ IF missingFields → emit RESUME_INFO_MISSING
                              │   ├ IF FAIL → emit RULE_CHECK_FAILED
                              │   └ IF PASS → emit RULE_CHECK_PASSED + RAAS /match-resume
                              └─ emit MATCH_PASSED_NEED_INTERVIEW (cascade)
```

---

## 2. AO 是否走 allmetaOntology API?— **答案:部分走**

| 调用场景 | 现状 | 通过什么 |
|---|---|---|
| **读 ontology Rule**(rule-check 抓 51 条规则) | 多路径 fallback | ① **直连本地 Neo4j**(优先,当前实际用)— `lib/rule-check/ontology-source.ts:fetchFromNeo4j()` <br/> ② Allmeta API `:3500/api/v1/ontology/actions/{ref}/rules`(env 缺 token 时跳)— `lib/ontology-gen/fetch.ts` <br/> ③ 静态 JSON fallback |
| **读 ontology Event schema**(EM event def sync) | ✓ 走 Allmeta Neo4j | `server/em/sync/event-definition-sync.ts` 直连 `RAAS_LINKS_NEO4J_URI`(partner 共享 Neo4j,Allmeta 主体) |
| **写 RuleCheck audit / Candidate / Resume / JR instance** | ❌ **不走 Allmeta** | 直接 `neo4j.driver()` 连本地 `bolt://localhost:7688`,绕过 Allmeta Studio app 的 `/instances/{label}` 端点 |
| **写 Action / Rule 节点(ontology 定义)** | N/A | AO 不写 ontology,只读 |

### 2.1 AO 直连 vs Allmeta API 路径对比

**当前 AO 写一条 Candidate**:
```ts
// lib/rule-check/neo4j-instance-writer.ts:200
session.run(`MERGE (c:Candidate {candidate_id: $candidate_id}) SET c += $props`, ...)
```

**Allmeta API 推荐路径**:
```http
POST http://localhost:3500/api/v1/ontology/instances/Candidate
Authorization: Bearer <ONTOLOGY_API_TOKEN>
{
  "domainId": "RAAS-v1",
  "candidate_id": "04bcaedb-...",
  "name": "江银行",
  ...
}
```

### 2.2 为什么 AO 没走 Allmeta API?

3 个客观原因:

1. **`ONTOLOGY_API_TOKEN` env 未配**(`.env.local` 里没有)
2. **`ONTOLOGY_API_BASE` env 未配**(应该是 `http://10.100.0.70:3500`)
3. **本地开发时延要求**:rule-check 跑得快,直连 Neo4j < 50ms;走 Allmeta HTTP API 多一跳 ~100-200ms

### 2.3 长期方向

| 时期 | 写 Neo4j 的方式 |
|---|---|
| **当前** | AO 直连本地 Neo4j(快,但跟 partner 数据隔离) |
| **过渡**(本次修复后) | 统一 label 命名 + AO 直连(同 Neo4j 实例,partner 也能 join 查询) |
| **长期** | 切 Allmeta API(`domainId="RAAS-v1"` + Bearer auth) — `:DataObject` schema 强制校验,跨系统一致性保障 |

---

## 3. 当前 Inngest event 流转

```
事件名                           AO 角色          partner 角色
──────────────────────────────────────────────────────────────────
RESUME_DOWNLOADED                ← (订阅)          publish (上传后)
RESUME_PROCESSED                 publish + 订阅    订阅(他们自己 matcher)
REQUIREMENT_LOGGED               ← (订阅)          publish (录入需求后)
JD_GENERATED                     publish           ← (订阅,审核)
RULE_CHECK_PASSED                publish           ← (订阅)
RULE_CHECK_FAILED                publish           ← (订阅)
RESUME_INFO_MISSING              publish           ← (订阅,触发 resume_info_repair)
MATCH_PASSED_NEED_INTERVIEW      publish           ← (订阅)
INFO_MISSING_FILLED              ← (订阅,待实现)   publish(待实现)
```

---

## 4. ⚠️ 发现的 5 个核心问题

### 4.1 ★★★ **Schema 分裂:同一类实体被写成两个 label**

**问题**:AO 端两个 writer 用了不同的 label 命名,导致同一类实体在 Neo4j 里被拆成两个孤岛节点。

| Writer | 文件 | 写入 label | 关系 |
|---|---|---|---|
| **rule-check writer** | `lib/rule-check/neo4j-instance-writer.ts` | `:Candidate` / `:Resume` / **`:JobRequisition`**(无下划线) | `Candidate -[:EVALUATED_FOR]-> JobRequisition` |
| **JD sync writer** | `lib/jd-sync/neo4j-jd-writer.ts` | **`:Job_Requisition`**(下划线) / `:Job_Posting` | `Job_Requisition -[:HAS_POSTING]-> Job_Posting` |

**Neo4j 实测(2026-05-12)**:
```
:Job_Requisition (下划线)    3 nodes  ← createJD 写的(对齐 partner ontology)
:JobRequisition  (无下划线)  5 nodes  ← rule-check 写的(自己造的命名)

:Candidate    11 nodes (跟 :JobRequisition 有 11 条 EVALUATED_FOR 关系)
:Resume       11 nodes (跟 :JobRequisition 通过 audit 间接关联,直接关系 0)

:Candidate -[*]- :Job_Requisition  =  0 关系  ❌
:Resume    -[*]- :Job_Posting      =  0 关系  ❌
```

**实际证据**:同一个真实 JR `R20260401429`(腾讯文秘行政专员)既被 rule-check 写成 `:JobRequisition` 节点,又被 createJD 写成 `:Job_Requisition` 节点 — **完全分裂**。

**Partner 标准**:partner ontology JSON(`raas_v4/ontology/dataobjects_*.json`)用**下划线**版 `Job_Requisition`,所以 createJD writer 是对的,**rule-check writer 是错的**。

### 4.2 ★★ Allmeta API 未启用 — AO 直连 Neo4j 写实例

**问题**:AO 写 `:Candidate` / `:Resume` / `:Job_Requisition` 时,绕过 Allmeta API 的 `/instances/{label}` 端点(`http://10.100.0.70:3500`),直接 `neo4j.driver()` 写本地 Neo4j。

**后果**:
- 没有 domain 隔离(应该 `domainId="RAAS-v1"`)
- 没有 `:DataObject` schema 强制字段校验(写错字段名不会报错)
- partner 那边的 Allmeta 看不到 AO 写的数据(物理上不同 Neo4j 实例,localhost:7688 vs 10.100.0.70:7687)

**好处**(目前为什么不切):快、自主可控、partner 没要求

### 4.3 ★★ 老 Allmeta(partner Neo4j)拉规则路径未启用

**问题**:`lib/rule-check/ontology-source.ts` 有 3 路径 fallback,但 ENV `ONTOLOGY_API_BASE` / `ONTOLOGY_API_TOKEN` 都没配,**当前实际只走本地 Neo4j 直查**(本地拷贝)。

**后果**:陈洋在 Allmeta 上加新规则 / 改 severity,AO 不会自动同步,要 manually 重新灌 ontology 到本地 7688。

### 4.4 ★ Partner RAAS SDK 版本被 server 拒绝同步

**问题**:Partner RAAS 用 `inngest@^3.52.7`(CVE-2026-42047),新升级的 `inngest/inngest:v1.19.2` server 拒绝同步,partner 10 个 function 没注册过来。

**后果**:partner 那边的 Inngest function 在 AO 这边看不到;partner 也收不到 AO emit 的事件(需要 partner 升 SDK ≥3.54.0)。

**详情见**:[memory/reference_inngest_opcode_mismatch.md](/Users/yuhancheng/.claude/projects/-Users-yuhancheng-Desktop-agenticOperator/memory/reference_inngest_opcode_mismatch.md)

### 4.5 ★ inferSeverity 启发式推断仍未由 ontology 显式字段替换

**问题**:rule severity(terminal / needs_human / flag_only)由 `lib/rule-check/ontology.ts:inferSeverity()` 从规则文本启发式推断,实测有误判(如规则 10-5 本应 terminal 被推成 flag_only,已在前轮修复)。

**后果**:推断不可靠,LLM 输出有时跟 ontology 真实意图不一致。

**长期方案**:陈洋在 Allmeta `:Rule` 节点加显式 `gating_severity` 字段,AO 直接读不再推断。

---

## 5. 修复方案 + 实施顺序

### 5.1 ⭐ 本次立即修(P0,30 分钟)

**Problem 4.1 — Schema 分裂**:统一所有 writer 用 partner ontology 的下划线版 label。

| 改动 | 详情 |
|---|---|
| `lib/rule-check/neo4j-instance-writer.ts`:`:JobRequisition` → `:Job_Requisition` | 1 处 MERGE |
| 老数据迁移:`:JobRequisition` 节点 + EVALUATED_FOR 关系 → `:Job_Requisition` | 1 条 Cypher |
| 验证:`MATCH (c:Candidate)-[:EVALUATED_FOR]->(jr:Job_Requisition)<-[:HAS_POSTING]-(jp:Job_Posting)` 至少返回 1 行 | 查询 |

**预期**:同一个候选人 04bcaedb 经过这次跑后,在 Neo4j 上能 1 跳查到 JR + 2 跳查到 Job_Posting(JD 内容),全图打通。

### 5.2 ⭐⭐ 短期(P1,1-2h)

| 任务 | 阻塞? |
|---|---|
| **加 `Application` 实例节点**(候选人申请 JR 的历史)— rule-check 写 audit 时同时写 `:Application` | 无阻塞,可立即做 |
| **加 `parent_audit_id` Neo4j 关系** — `(child:RuleCheckAudit)-[:CHILD_OF]->(parent)` — 给 INFO_MISSING_FILLED 重判链路用 | 无阻塞 |
| **UI lineage 显示** — audit drawer 加"上一次评估 / 下一次评估" | 上面前置 |

### 5.3 ★★ 中期(P2,要 partner 配合)

| 任务 | 阻塞 |
|---|---|
| 4.4 — partner 升 inngest SDK ≥3.54.0 | partner team |
| 4.5 — partner 在 Allmeta `:Rule` 加 `gating_severity` 字段 | 陈洋 |
| INFO_MISSING_FILLED 闭环 — partner 注册 3 个新事件 + AO infoFilledHandler | partner ontology 团队 |

### 5.4 ★ 长期(P3,架构演进)

| 任务 | 触发条件 |
|---|---|
| 4.2 — AO 切 Allmeta API(`POST /api/v1/ontology/instances/{label}`)写实例 | partner Allmeta 加 `:Candidate` / `:Job_Requisition` 的 :DataObject schema · domain 隔离需求 |
| 4.3 — `ONTOLOGY_API_BASE/TOKEN` 配齐 + rule-check 切 ontology-api 路径 | 同上 |

---

## 6. 本次实施步骤(具体代码 + 验证)

### Step 1 — 改 rule-check writer 的 label

**文件**:`lib/rule-check/neo4j-instance-writer.ts`

**改动**:第 218-242 行的 `:Resume` 关系节点中,把 `:JobRequisition` 替换为 `:Job_Requisition`(注意保留下划线)。

```diff
- MERGE (j:JobRequisition {job_requisition_id: $jr_id})
+ MERGE (j:Job_Requisition {job_requisition_id: $jr_id})
```

### Step 2 — 老数据迁移

```cypher
// 把所有 :JobRequisition (无下划线) 节点的属性 + 关系迁到 :Job_Requisition (下划线)
MATCH (old:JobRequisition)
WITH old, old.job_requisition_id AS jrid, properties(old) AS props
MERGE (new:Job_Requisition {job_requisition_id: jrid})
SET new += props

// 迁 EVALUATED_FOR 关系:Candidate-[:EVALUATED_FOR]->JobRequisition → ->Job_Requisition
MATCH (c:Candidate)-[r:EVALUATED_FOR]->(old:JobRequisition)
MATCH (new:Job_Requisition {job_requisition_id: old.job_requisition_id})
MERGE (c)-[:EVALUATED_FOR]->(new)
DELETE r

// 迁 AGAINST_JOB:RuleCheckAudit-[:AGAINST_JOB]->JobRequisition → ->Job_Requisition
MATCH (a:RuleCheckAudit)-[r:AGAINST_JOB]->(old:JobRequisition)
MATCH (new:Job_Requisition {job_requisition_id: old.job_requisition_id})
MERGE (a)-[:AGAINST_JOB]->(new)
DELETE r

// 清掉空的 :JobRequisition (孤儿)
MATCH (old:JobRequisition)
WHERE NOT (old)-[]-()
DETACH DELETE old
```

### Step 3 — 验证

```cypher
// 应该有 ≥1 行结果(同一候选人 → JR → Posting 全图打通)
MATCH (c:Candidate {candidate_id: "04bcaedb-b1e8-4863-bee9-3e5c16e0caa3"})
      -[:EVALUATED_FOR]->(jr:Job_Requisition)
      <-[:HAS_POSTING]-(jp:Job_Posting)
RETURN c.candidate_id, jr.job_requisition_id, jp.jd_id

// 应该返回 0(没有遗留 :JobRequisition 无下划线节点)
MATCH (n:JobRequisition) RETURN count(n)
```

### Step 4 — UI 验证

刷 [/rule-check](http://localhost:3002/rule-check),点开 04bcaedb 的 audit,"实例数据" tab 应该能在新统一 label 下看到 JR + Posting 关联。

---

## 7. 后续 backlog(从本次审计看到但不在本次实施范围)

| 项 | 优先级 | 描述 |
|---|---|---|
| AO 写实例 → Allmeta API | P3 | 长期架构演进,涉及 domain 隔离 + schema 强校验 |
| 加 `:Application` 节点 | P2 | candidate 申请 JR 历史 + 跨 JR 反查 |
| `:RuleCheckAudit` 加 `(child)-[:CHILD_OF]->(parent)` 关系 | P1 | INFO_MISSING_FILLED 重判链路需要 |
| partner 升 inngest SDK | P1 | partner 那 10 个 function 才能注册过来 |
| 陈洋加 `gating_severity` | P2 | 退役 inferSeverity 文本推断 |
| INFO_MISSING_FILLED handler | P1 | 已设计,等 partner 注册新事件后实施 |

---

## 8. 验证 checklist(执行修复后跑一遍)

- [ ] `MATCH (n:JobRequisition) RETURN count(n)` 返回 0
- [ ] `MATCH (n:Job_Requisition) RETURN count(n)` 返回 ≥ 8(原 3 + 迁移的 5)
- [ ] `MATCH (c:Candidate)-[:EVALUATED_FOR]->(jr:Job_Requisition)` 返回 ≥ 11
- [ ] `MATCH (a:RuleCheckAudit)-[:AGAINST_JOB]->(jr:Job_Requisition)` 返回 ≥ 9(原 audit 数)
- [ ] AO 重发一次 RESUME_PROCESSED → 新 audit 的 `:Job_Requisition` 关系是下划线版,跟老的 `:Job_Posting` 节点同名
- [ ] UI 刷新 — 实例数据 tab 显示 anchor 节点跟下划线版 JR 关联

---

## 9. 关键洞察 / 给 leader 的一句话总结

> AO 当前 Neo4j 写入**不走 Allmeta API**(直连 driver),且因为两个 writer 用了不同 label,**Candidate-Resume-JD 数据在 Neo4j 上物理分裂为两个孤岛**。本次修复用 30 分钟把 label 统一(对齐 partner ontology 下划线版)+ 1 条 Cypher 迁移老数据,**做完后同一个候选人就能在 Neo4j 上 1 跳查到 JR + 2 跳查到 Robohire 生成的 JD 全文**,这是给 leader / 客户 demo "candidate × JR × JD 全链路" 的必要前提。长期演进切 Allmeta API 是 P3,不在本次。
