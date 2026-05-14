# AO ↔ RAAS ↔ Allmeta 完整事件链 — 架构纠正版

> 2026-05-13:发现一个之前画错的架构假设 — RAAS partner 不是数据存储层,它是 **dashboard 层**(recruiter / HSM UI)。**所有 Neo4j 实例数据写入必须经 Allmeta Ontology API**(`http://10.100.0.70:3500`),不能直连 Bolt。
>
> 本文给出纠正后的完整事件链 + 三方职责划分 + AO 端要改的事。

---

## 1. 三层架构(纠正后)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Layer 1 — UI / Dashboard                                                              │
│ ────────────────────────────────────────                                              │
│ RAAS dashboard (recruiter / HSM 工作台)                                                │
│   - 简历上传入口(文件 → MinIO)                                                        │
│   - 候选人 / 任务 / 匹配结果展示(从 Allmeta API 读)                                    │
│   - HITL 任务表单(recruiter 补全字段、HSM 审核 JD 等)                                  │
│   - 不直接持有任何业务实体数据                                                          │
└────────────────────┬─────────────────────────────────────────────────────────────────┘
                     │ emit / consume events
                     ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Layer 2 — Event Bus(共享 Inngest @ 10.100.0.70:8288)                                 │
│ ────────────────────────────────────────                                              │
│ 三方都连同一个 Inngest stack。所有跨服务消息走这里。                                    │
│ 例:RESUME_DOWNLOADED · RESUME_PROCESSED · RESUME_INFO_MISSING · MATCH_FAILED ·       │
│     MATCH_PASSED_NEED_INTERVIEW · JD_GENERATED · CLARIFICATION_INCOMPLETE · ...        │
└────────────────────┬─────────────────────────────────────────────────────────────────┘
                     │
       ┌─────────────┴───────────────┬─────────────────────────┐
       ▼                             ▼                         ▼
┌──────────────────┐    ┌────────────────────────┐  ┌─────────────────────────────────┐
│ Layer 3a — AO    │    │ Layer 3b — RAAS workers│  │ Layer 3c — Allmeta workers       │
│ workers          │    │ (partner @ 10.100.0.70)│  │ (Studio @ 10.100.0.70:3500)     │
│ (192.168.1.106:  │    │                        │  │                                  │
│  3002)           │    │ - hitl-event.consumer  │  │ - REST API 写 Neo4j(本文核心)   │
│                  │    │   (HITL 任务建表)       │  │ - schema-agnostic property bag  │
│ - resumeParser   │    │ - outbox-dispatcher    │  │ - 5 类 endpoint:                 │
│ - createJD       │    │   (RAAS-side event 转  │  │   /instances/{label}              │
│ - matchResume    │    │    Inngest)            │  │   /actions/{ref}/rules           │
│                  │    │ - HMAC auth gate       │  │   /actions/matchResume/results   │
└────────┬─────────┘    └────────────────────────┘  └─────────────────────────────────┘
         │                                                       ▲
         │ HTTP                                                  │
         │ Authorization: Bearer dev-ao-allmeta-2026             │
         │ POST /api/v1/ontology/instances/{Candidate|Resume|    │
         │      Job_Requisition|Candidate_Match_Result}          │
         │ POST /api/v1/ontology/actions/matchResume/results     │
         └──────────────────────────────────────────────────────┘
                                                                 ▼
                                                  ┌────────────────────────────────────┐
                                                  │ Layer 4 — Stores                    │
                                                  │ ────────────────────────────────    │
                                                  │ Neo4j(实例图 — 由 Allmeta 写入)    │
                                                  │   :Candidate / :Resume / :JR /      │
                                                  │   :Candidate_Match_Result / ...     │
                                                  │                                      │
                                                  │ AO Prisma SQLite(本地审计)         │
                                                  │   RuleCheckAudit + RuleCheckFlag    │
                                                  │   (LLM prompt/raw/flags — AO 私有,   │
                                                  │    不在 ontology,不进 Neo4j)        │
                                                  │                                      │
                                                  │ RAAS Postgres(partner 私有)        │
                                                  │   hitl_task + event_outbox          │
                                                  │                                      │
                                                  │ MinIO(简历文件)                     │
                                                  └────────────────────────────────────┘
```

---

## 2. 关键原则(必须遵守)

| 原则 | 含义 |
|---|---|
| **RAAS = dashboard 层** | RAAS 不直接写 Neo4j。它读 Allmeta API 显示数据,emit/consume 事件协调流程 |
| **Allmeta = 唯一写入网关** | 所有 `:Candidate` / `:Resume` / `:Job_Requisition` / `:Candidate_Match_Result` 等**实例**节点的 MERGE 操作,**必须**经 `POST /api/v1/ontology/instances/{label}` |
| **AO 不能直连 Bolt 写 Neo4j** | 当前代码用 `neo4j-driver` 直连 `bolt://10.100.0.70:7687` 写实例 — **要改**。读可以暂时继续直连(rule-check 抓 Rule 节点),但写实例必须走 Allmeta |
| **AO 仍持有 RuleCheckAudit / Flag** | 这些是 AO LLM 推理的私有审计,不属于业务 ontology(不在 DataObject 清单),继续存 Prisma SQLite |
| **partner = recruiter UI + HITL** | partner 负责 HITL 任务 + 表单 + 通知 — 不负责数据存储 |

---

## 3. 完整事件链(纠正后)

### 3.1 简历首次入系统

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ (a) HSM 在 RAAS dashboard 上传简历文件                                                 │
│       │                                                                               │
│       ▼                                                                               │
│ 文件存 MinIO (10.100.0.70:9000)                                                        │
│       │                                                                               │
│       ▼                                                                               │
│ RAAS dashboard emit RESUME_DOWNLOADED ──► Shared Inngest                              │
│   payload: { upload_id, file_url, candidate_hint(可选)}                              │
│                                                                                       │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │
                                            ▼
                ┌──────────────────────────────────────────────────────────┐
                │  AO resumeParserAgent  (订阅 RESUME_DOWNLOADED)          │
                │  ─────────────────────────────────────────────────       │
                │  1) 调 RAAS API Server POST /api/v1/parse-resume         │
                │     (RAAS 内部 proxy 到 RoboHire,返回 parsed.data)        │
                │  2) ★ 经 Allmeta API 写实例(不直连 Bolt!):              │
                │     POST /api/v1/ontology/instances/Candidate            │
                │       body: { domainId: "RAAS-v1",                       │
                │               candidate_id: "...",                      │
                │               name, gender, marital_status, ... }        │
                │     POST /api/v1/ontology/instances/Resume               │
                │       body: { domainId: "RAAS-v1",                       │
                │               resume_id, candidate_id,                  │
                │               parsed_resume_json: "<full data>", ... }   │
                │  3) emit RESUME_PROCESSED ──► Shared Inngest             │
                │     payload: { upload_id, candidate_id, resume_id,       │
                │                parsed: { data: <parsed.data> },          │
                │                employee_id, job_requisition_id? }        │
                └──────────────────────────────────────────────────────────┘
```

### 3.2 简历匹配(核心)

```
                                            ┌──── RESUME_PROCESSED
                                            ▼
                ┌──────────────────────────────────────────────────────────┐
                │  AO matchResumeAgent  (订阅 RESUME_PROCESSED)            │
                │  ─────────────────────────────────────────────────       │
                │  Step 1-3) 准备数据                                       │
                │     - 调 RAAS API Server GET /requirements/agent-view    │
                │       拿 JR(authoritative)                              │
                │     - (可选)经 Allmeta GET /instances/Job_Requisition/  │
                │       {jrid} 反查 Neo4j 已有数据                          │
                │                                                           │
                │  Step 4.0) rule-check LLM 预筛                            │
                │     - 经 Allmeta GET /actions/matchResume/rules          │
                │       拿 51 条规则 (rule_source=ontology-api)            │
                │     - filter (client/department/executor) → 喂 LLM 27    │
                │     - LLM 输出 rule_flags 含 27 条评估 + decisions       │
                │                                                           │
                │  Step 4b) 双写审计                                        │
                │     - Prisma 写 RuleCheckAudit + 全部 RuleCheckFlag      │
                │       (AO 私有,不进 Neo4j)                              │
                │     - ★ 经 Allmeta API 写实例锚节点:                    │
                │       POST /instances/Candidate (refresh snapshot)       │
                │       POST /instances/Resume (refresh snapshot)          │
                │       POST /instances/Job_Requisition (refresh snapshot) │
                └──────────────────────┬───────────────────────────────────┘
                                       │
        ┌──────────────────────────────┼───────────────────────────────────┐
        │ rule-check PASS              │ rule-check FAIL                    │
        ▼                              ▼                                    │
   Step 4a:                  ┌─────────────────────┐                       │
   AO 调 RAAS API Server      │ 有 missing 字段?     │                       │
   POST /match-resume         └──────────┬──────────┘                       │
   (RAAS proxy 到 RoboHire,         ┌────┴────┐                            │
    返回 matchScore,                 │ 是      │ 否                         │
    requestId 等)                   ▼          ▼                            │
        │                  ① emit            ② emit                         │
        │                  RESUME_INFO       MATCH_FAILED                  │
        │                  _MISSING         (硬性失败)                      │
        │                  (可救:补全后再判) (关任务)                       │
        │                       │             │                             │
        │                       │             │                             │
        │  Step 4b.5) PASS 路径独有 — 写 Match_Result                       │
        ▼                                                                   │
   ★ 经 Allmeta API:                                                        │
   POST /api/v1/ontology/instances/Candidate_Match_Result                   │
     body: { domainId: "RAAS-v1",                                           │
             candidate_match_result_id: "cmr_<audit_id>",                  │
             candidate_id, job_requisition_id,                              │
             rule_check_decision: "PASS",                                  │
             match_score, match_recommendation,                            │
             final_decision: "PASS",                                       │
             parent_match_result_id?,                                      │
             ... }                                                          │
                                                                            │
   或用专用端点(若 Allmeta 提供):                                          │
   POST /api/v1/ontology/actions/matchResume/results                       │
                                                                            │
   emit MATCH_PASSED_NEED_INTERVIEW ──► Shared Inngest                     │
   (happy path 结束)                                                       │
                                                                            │
                                       ▼                                    │
                              partner ingest 收 ① ────┐ ──────────────────┘
                              hitl-event.consumer    │
                              → 建 hitl_task         │ partner 收 ②
                              (resume_info_repair)   │ 关 matching task
                                       │              │
                                       ▼              ▼
                              recruiter 工作台
                              填表 → submit
                                       │
                                       ▼
                              partner 重发 RESUME_PROCESSED
                              (含 enrichment_applied.parent_audit_id +
                               recruiter 补的字段 merge 进 parsed.data)
                                       │
                                       └──── 进入新一轮 matchResumeAgent
```

### 3.3 数据所有权 + 写入端表

| 实体 | 谁写到 Neo4j? | 经哪条 Allmeta endpoint? | 何时 |
|---|---|---|---|
| `:Candidate` | **AO resumeParserAgent** | `POST /instances/Candidate` | RESUME_DOWNLOADED → RoboHire parse 完成后 |
| `:Resume` | **AO resumeParserAgent** | `POST /instances/Resume` | 同上 |
| `:Job_Requisition` | **AO createJdAgent** | `POST /instances/Job_Requisition` | REQUIREMENT_LOGGED + JD 生成完成后 |
| `:Candidate_Match_Result` | **AO matchResumeAgent** | `POST /instances/Candidate_Match_Result` 或 `POST /actions/matchResume/results` | rule-check PASS + RAAS match 跑完后(FAIL 不写)|
| `:Job_Posting` | **AO createJdAgent** | `POST /instances/Job_Posting` | JD 生成后 |
| `:RuleCheckAudit` / `:RuleCheckFlag` | **不写 Neo4j** | — | AO 私有,只在 Prisma SQLite |

partner / RAAS dashboard 完全不写 Neo4j,只读。

---

## 4. AO 端要改什么(纠正现有代码)

AO 现在三个 writer **直连 Bolt 写 Neo4j**,需要全部改成调 Allmeta API:

| 当前代码 | 现在的实现 | 要改成 |
|---|---|---|
| [lib/rule-check/neo4j-instance-writer.ts](lib/rule-check/neo4j-instance-writer.ts) `writeInstanceAnchorsOnly` | `neo4j.driver(bolt://10.100.0.70:7687)` 直连 + Cypher `MERGE (c:Candidate)` | `fetch(POST /api/v1/ontology/instances/Candidate)` + Bearer token |
| [lib/rule-check/neo4j-match-result-writer.ts](lib/rule-check/neo4j-match-result-writer.ts) `writeCandidateMatchResult` | 直连 + `MERGE (m:Candidate_Match_Result)` | `fetch(POST /api/v1/ontology/instances/Candidate_Match_Result)` |
| [lib/jd-sync/neo4j-jd-writer.ts](lib/jd-sync/neo4j-jd-writer.ts) | 直连 + `MERGE (jr:Job_Requisition)` | `fetch(POST /api/v1/ontology/instances/Job_Requisition + Job_Posting)` |

**关系也要通过 Allmeta API**:
- `(Candidate)-[:HAS_RESUME]->(Resume)` 等关系经 `POST /api/v1/ontology/links` 写入
- 不直接发 Cypher `MERGE (c)-[:HAS_RESUME]->(r)`

新建一个统一的 `lib/allmeta-client.ts`(替换 3 个 writer 的 Bolt 直连)。

---

## 5. 当前的 blocker

| # | 阻塞点 | 解决方 |
|---|---|---|
| 1 | Allmeta 上的 `:DataObject {id:"Candidate"}` 等节点 `domainId=None`,API `?domain=RAAS-v1` 找不到 schema | **陈洋**:给所有 DataObject 设 `domainId: "RAAS-v1"`(单条 `PATCH /api/v1/ontology/objects/Candidate` body: `{"domainId":"RAAS-v1"}`)|
| 2 | AO 三个 writer 还在直连 Bolt | **Steven**:按 §4 重构成调 Allmeta API |
| 3 | partner RAAS API server `192.168.1.105:3001` 当前不可达 | partner 端确认服务状态 |
| 4 | partner 端 `hitl-event.mapping` 缺 `RESUME_INFO_MISSING → resume_info_repair` 映射 | **partner Claude Code**:照 [docs/raas-partner-integration-spec-for-claude-code.md](raas-partner-integration-spec-for-claude-code.md) §6 R1 加 |

---

## 6. 给 partner 的修正后承诺(关键变化)

之前给 partner 的承诺(基于错误架构):
- ❌ "partner submit handler 要 merge filled_fields 到 partner 本地 parsed_resume 副本"

**纠正后**(partner 不持有数据):
- ✅ partner submit handler **不需要持有 parsed_resume**
- ✅ submit 时直接 emit `RESUME_INFO_MISSING_FILLED`(只发 delta + parent_audit_id),让 AO `infoFilledHandler` 经 Allmeta API 读 Resume → merge → 写回 Allmeta API → emit RESUME_PROCESSED

等等 — 这条要再讨论。重新简化:

### 选项 A:partner 仍重发 RESUME_PROCESSED(数据集中在 AO 端 merge,经 Allmeta 写)

```
recruiter 提交表单
    ↓
partner emit RESUME_INFO_MISSING_FILLED(只带 delta + parent_audit_id)
    ↓
AO infoFilledHandler:
  1. 经 Allmeta GET /instances/Resume/{resume_id}?domain=RAAS-v1 拿现存 parsed_resume_json
  2. merge filled_fields(中→英 key)
  3. 经 Allmeta POST /instances/Resume(覆盖 parsed_resume_json)
  4. emit RESUME_PROCESSED(payload.parsed.data = 合并后的)
    ↓
matchResumeAgent 重跑
```

这样**恢复**了 `RESUME_INFO_MISSING_FILLED` 这个事件 — 但语义更对了(partner 不持有 parsed_resume,merge 在 AO 经 Allmeta 做)。

### 选项 B:partner 直接调 Allmeta API merge,然后发 RESUME_PROCESSED(快但耦合)

```
recruiter 提交表单
    ↓
partner submit handler:
  1. 经 Allmeta GET /instances/Resume/{resume_id} 拿现存
  2. merge + 中英翻译
  3. 经 Allmeta POST /instances/Resume 写回
  4. emit RESUME_PROCESSED(payload.parsed.data = 合并后)
    ↓
matchResumeAgent 重跑
```

partner 要会调 Allmeta API + 知道字段映射,耦合度高。

**推荐选项 A**:partner 只发事件 + delta,AO 负责跟 Allmeta 交互。partner 责任单一(dashboard + 事件)。

---

## 7. 下一步

1. **陈洋**:给 4 个 DataObject 设 `domainId: "RAAS-v1"`(5 分钟)
2. **Steven (AO)**:写 `lib/allmeta-client.ts` 替换 3 个 Bolt writer(约半天)
3. **partner**:照 [raas-partner-integration-spec-for-claude-code.md](raas-partner-integration-spec-for-claude-code.md) §6 R1 + R2 实施,但 submit handler 简化成"emit RESUME_INFO_MISSING_FILLED 即可,不 merge"(选项 A)— 我会更新 partner 文档反映这一点
4. 联调:Allmeta 起 RAAS-v1 domain → AO 跑一条 audit → 验证 Allmeta 上有新 `:Candidate` `:Resume` `:Candidate_Match_Result` 实例

---

## 8. 文档关系图

| 文档 | 给谁 | 状态 |
|---|---|---|
| 本文 [docs/architecture-corrected-event-chain.md](architecture-corrected-event-chain.md) | AO + RAAS + Allmeta 三方共同参考 | 新建,纠正架构 |
| [docs/raas-partner-integration-spec-for-claude-code.md](raas-partner-integration-spec-for-claude-code.md) | RAAS partner AI / Claude Code | 需更新 §3/§4,partner 不写 Neo4j,数据流改走 Allmeta |
| [docs/ontology-schema-changes-for-chenyang.md](ontology-schema-changes-for-chenyang.md) | 陈洋(Allmeta ontology) | 需补充:DataObject `domainId="RAAS-v1"` 配置 |
| [docs/resume-info-repair-flow.md](resume-info-repair-flow.md) | AO 团队内部设计 | 需更新:补全 merge 经 Allmeta API |
| [Allmeta 文档](file:///Users/yuhancheng/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md) | 所有 API 消费者 | 已有(陈洋写的)|
