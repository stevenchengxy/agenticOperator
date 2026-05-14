# RAAS Partner 集成手册 — 给 Claude Code 实施用

> 这份文档写给 **RAAS partner 的 AI / Claude Code 实施者** 看。完整描述:
> ① AO 这边是怎么做的(让 partner 理解全图)
> ② partner 这边要做什么(对接契约 + 实现建议)

- **状态**:AO 端就绪,等 partner 按 §6 改 2 处即可联调
- **0 个新事件**:`RESUME_INFO_MISSING` / `RESUME_PROCESSED` / `RULE_CHECK_FAILED` 都已在 partner ontology 白名单
- **0 个 schema 变更**:Neo4j 写入 partner 共享实例图,不动 ontology DataObject schema
- **总工作量**:1-2 小时(参照 ingest doc §5 现有 8 个 HITL 任务模式)

---

## 1. 这条流程要解决什么

partner 上传简历到 RAAS → RAAS 做 RoboHire 解析 → 应该开始走简历匹配 (matchResume)。**但**:简历有时缺关键字段(性别、婚育、利益冲突声明等),如果没补就硬走匹配,会拿到错误的结论。AO 端 rule-check LLM 负责发现这些缺失,然后让 partner 触发 recruiter 补全 → 补全后 retry。

**这就是补全闭环(resume info repair loop)**。

---

## 2. 完整流程图

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│   RAAS partner                      Shared Inngest                   AO           │
│   (10.100.0.70)                     (event bus :8288)                (port 3002) │
└──────────────────────────────────────────────────────────────────────────────────┘

(a) 简历首次上传
─────────────────────
RAAS 收简历
  └─ RoboHire 解析
  └─ 存 partner 本地 (parsed_resume.data)
  └─ outbox emit RESUME_PROCESSED ──────────────► Shared Inngest
                                                        │
                                                        ▼
                       ┌────────────────────────────────────────────────────────┐
                       │  AO  matchResumeAgent  (订阅 RESUME_PROCESSED)         │
                       │                                                        │
                       │  Step 1-3) fetch JR + 准备数据                          │
                       │  Step 4.0) rule-check LLM 预筛(看 51 条规则)           │
                       │  Step 4b)  三写:Prisma audit + Neo4j 实体 + Match_Result│
                       └──────────────────────┬─────────────────────────────────┘
                                              │
        ┌─────────────────────────────────────┼─────────────────────────────────┐
        │ rule-check PASS                     │ rule-check FAIL                  │
        ▼                                     ▼                                  │
   Step 4a:                          ┌────────────────────┐                     │
   AO 调 RAAS API Server              │ 有 missing 字段?    │                     │
   POST /api/v1/match-resume          └─────────┬──────────┘                     │
   (RAAS 内部 proxy 到 Robohire,                ┌─────────┴─────────┐            │
    AO 不直接调 Robohire)                      │ 是                │ 否          │
        │                                       ▼                  ▼            │
        ├─► emit MATCH_RESUME_PASSED     ① emit                ② emit          │
        │  (happy path 终)              RESUME_INFO_MISSING  RULE_CHECK_FAILED  │
        │                                (recruiter 补全)    (硬性失败,关任务)  │
        ▼                                       │                  │            │
   写 Match_Result (PASS,带 match_score)        │                  │            │
                                                ▼                  │            │
(b) 补全闭环                        partner ingest 收到 ① ────────┐ │            │
─────────────────────                                              │ │            │
                                    HITL mapping 触发 ─► hitl_task │ │            │
                                    (★ R1:partner 要加)            │ │            │
                                                                   │ │            │
                                    recruiter 工作台看到任务          │ │            │
                                    打开表单(★ R2:partner 实现)    │ │            │
                                                                   │ │            │
                                    填字段提交                        │ │            │
                                       ▼                              │ │            │
                                    merge 到本地 parsed_resume         │ │            │
                                    appendOntologyEvent(              │ │            │
                                      RESUME_PROCESSED,               │ │            │
                                      enrichment_applied.             │ │            │
                                       parent_audit_id ←★)            │ │            │
                                       │                              │ │            │
                                       ▼                              │ │            │
                                   outbox → Shared Inngest            │ │            │
                                       │                              │ │            │
                                       └──────────────────────────────┘ │            │
                                       ▼                                │            │
                              回到顶部 matchResumeAgent 重跑              │            │
                              (rule-check + Robohire,自动串谱系)         │            │
                                                                        │            │
                                       partner 收到 ② ──────────────────┘            │
                                       关闭 matching task,流程终止 ─────────────────┘
```

---

## 3. AO 端事件 emit 语义(供 partner consume 时参考)

| AO 发的事件 | 何时发 | partner 应做什么 |
|---|---|---|
| `RESUME_INFO_MISSING` | rule-check **FAIL** 且 evidence 含"未提供 <字段>"模式 | 创建 recruiter 补全任务(详见 §6 R1+R2)|
| `MATCH_FAILED` | rule-check **FAIL** 且**无** missing 字段(候选人确实没通过硬性门槛:学历不符 / 黑名单 / 婚育风险等)。payload `match_failed_source='rule_check_terminal'` 区分跟 Robohire matchResume 后的 MATCH_FAILED | 关闭该 candidate-on-jr 的 matching 任务(用 partner 现有 MATCH_FAILED 处理流程,无需新逻辑)|
| `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_RESUME_PASSED` | rule-check **PASS** 后 AO 调 RAAS API Server `/api/v1/match-resume`(RAAS 内部 proxy 到 Robohire),score 达标 | partner 按现有 matchResume 流程处理 |

**关键互斥规则(重要)**:

- AO 在 rule-check FAIL 时**只发一个**事件:`RESUME_INFO_MISSING` **或** `MATCH_FAILED`,不会同时发
- AO 在 rule-check PASS 时**不发**任何"问题"事件,直接走 RAAS API Server → Robohire 链路
- partner 收到 `MATCH_FAILED` 时,可以看 payload `match_failed_source` 字段区分来源:
  - `'rule_check_terminal'` — AO rule-check 硬性失败(还没跑 Robohire)
  - 未设 / 其他值 — Robohire matchResume 评分失败(已跑过 Robohire)

---

## 4. AO 写入 Neo4j 的实例数据(partner 可查)

AO 每次 matchResumeAgent 跑完,会在 **共享 Neo4j**(URI `bolt://10.100.0.70:7687` 或本地 `bolt://localhost:7688`)写如下节点:

### 4.1 何时写什么(关键)

| 流程阶段 | 写哪些 |
|---|---|
| **rule-check 跑完(无论 PASS / FAIL)** | `Candidate` + `Resume` + `Job_Requisition` 实体锚节点 + 关系 |
| **rule-check FAIL**(emit RESUME_INFO_MISSING 或 MATCH_FAILED) | **不写** `Candidate_Match_Result` — 因为还没真正跑匹配,只是 rule-check 推理结论。审计数据在 AO Prisma 的 `RuleCheckAudit` + `RuleCheckFlag`(rule-check 阶段不属于 ontology 的 Candidate_Match_Result 实例) |
| **rule-check PASS** → AO 调 RAAS `/api/v1/match-resume` → 拿到 score | **写** `Candidate_Match_Result`(含 rule-check + match 维度) |

### 4.2 实体锚节点

```
(Candidate {candidate_id, name, gender, marital_status, nationality, birth_date, ...})
   │
   ├─[:HAS_RESUME]─► (Resume {resume_id, education_count, experience_count, skills, companies, ...})
   │
   ├─[:EVALUATED_FOR]─► (Job_Requisition {job_requisition_id, client_job_title, salary_range, ...})
   │
   └─[:HAS_MATCH_RESULT]─► (Candidate_Match_Result) ─[:FOR_JOB_REQUISITION]─► (Job_Requisition)
       (仅 rule-check PASS + RAAS match 完成后才有此节点)
```

### 4.3 `Candidate_Match_Result` 节点 schema(partner 后读)

每次 rule-check 跑完都写一条,**partner 可以从 Neo4j 直接查任意 candidate-on-jr 的决策历史 + 谱系**(不需要 AO 暴露新 API):

```cypher
// Properties 示例
{
  candidate_match_result_id: "cmr_<rule_check_audit_id>",  // 跟 Prisma audit 一对一
  candidate_id:              "04bcaedb-...",
  job_requisition_id:        "JRQ-...",
  client_id:                 "f592f8ce-...",

  // rule-check 维度(总是有)
  rule_check_audit_id:       "rca_...",
  rule_check_decision:       "PASS" | "FAIL",
  failure_reason_codes:      ["10-5:DEGREE_MISMATCH", "10-7:SALARY_OVER"],
  rules_evaluated_count:     27,
  terminal_rule_hits:        ["10-5", "10-7"],

  // match 维度(rule-check FAIL 时为 null)
  match_score:               78.5,                  // 来自 RAAS /api/v1/match-resume.data.matchScore
  match_recommendation:      "consider",            // 来自 RAAS data.recommendation
  match_breakdown_json:      "{\"skillMatch\":65,...}",  // 整段 RAAS match data
  raas_match_request_id:     "raas_req_xxx",

  // 决策合并
  final_decision:            "PASS" | "FAIL",
  final_decision_reason:     "rule-check PASS + RAAS matchResume score=78.5 ...",
  decided_at:                "2026-05-13T10:00:00Z",

  // 谱系(补全后重判时指向上次)
  parent_match_result_id:    "cmr_rca_xxx_前一次"
}
```

### 4.4 partner 查询示例

```cypher
// 查某候选人在某 JR 上的所有决策历史
MATCH (c:Candidate {candidate_id: $cid})
      -[:HAS_MATCH_RESULT]->(m:Candidate_Match_Result)
      -[:FOR_JOB_REQUISITION]->(jr:Job_Requisition {job_requisition_id: $jrid})
RETURN m.final_decision, m.failure_reason_codes, m.match_score,
       m.match_recommendation, m.decided_at
ORDER BY m.decided_at DESC

// 查补全谱系
MATCH (m:Candidate_Match_Result)-[:REPLAY_OF]->(parent:Candidate_Match_Result)
WHERE m.candidate_id = $cid AND m.job_requisition_id = $jrid
RETURN parent.failure_reason_codes AS before_failures,
       m.failure_reason_codes AS after_failures,
       m.match_score AS after_score
```

---

## 5. partner ↔ AO 的对接契约

> partner 完全自主决定**内部怎么处理** `RESUME_INFO_MISSING`(任务 UI / 表单 / 通知方式)。AO 不规定细节。AO 只看一件事:**partner 重发的 `RESUME_PROCESSED` payload 必须含 `enrichment_applied.parent_audit_id`**。

### 5.1 partner 收 `RESUME_INFO_MISSING` 的 payload

(AO 发出去的,partner ingest 端点收)

```json
{
  "event_name": "RESUME_INFO_MISSING",
  "entity_type": "Resume",
  "entity_id": "<resume_id>",
  "payload": {
    "audit_id":            "rca_...",         // ★ partner 提交时必须原样回传到 enrichment_applied.parent_audit_id
    "candidate_id":        "04bcaedb-...",
    "resume_id":           "...",
    "job_requisition_id":  "JRQ-...",
    "client_id":           "f592f8ce-...",
    "upload_id":           "...",
    "missing_fields": [
      {
        "field": "性别",                       // recruiter 在表单看到的字段名(中文)
        "rule_ids": ["10-47"],                // 触发缺字段判定的规则 id
        "rule_names": ["腾讯婚育风险审视与推荐要点"],
        "evidence_excerpt": "简历中未提供候选人性别信息,无法评估腾讯婚育风险规则"
      },
      {
        "field": "利益冲突声明",
        "rule_ids": ["10-27"],
        "rule_names": ["腾讯亲属关系回避规则"],
        "evidence_excerpt": "简历中未提供利益冲突声明,无法判定是否触发亲属回避"
      }
    ],
    "occurred_at": "2026-05-13T10:00:00.000Z"
  }
}
```

### 5.2 partner 重发 `RESUME_PROCESSED` 的 payload(★ 核心契约)

(recruiter 填完表 partner 内部发,AO consume)

```typescript
await outboxService.appendOntologyEvent({
  event_name: 'RESUME_PROCESSED',           // ← 已有事件,不是新的
  entity_type: 'Resume',
  entity_id: resume_id,
  payload: {
    // === (1) 跟 RAAS 第一次发 RESUME_PROCESSED 一样的标准字段 ===
    upload_id, candidate_id, resume_id, job_requisition_id, employee_id,

    // === (2) 合并后的 parsed_resume(关键) ===
    parsed: {
      data: {
        // ... partner 本地存的 parsed_resume.data 全部字段 ...
        // + recruiter 在表单填的新字段,按 §7 中→英 key 翻译
        gender: "男",                        // 从中文"性别"翻译过来
        marital_status: "未婚",              // 从"婚育情况"翻译
        conflict_of_interest_summary: "已声明无亲属冲突",
      },
    },

    // === (3) ★ AO 串谱系的唯一依据 ===
    enrichment_applied: {
      parent_audit_id: "rca_...",            // 原 RESUME_INFO_MISSING.payload.audit_id 原样回传
      filled_fields_delta: { gender: "男", marital_status: "未婚" },  // 可选审计
      filled_at: "2026-05-13T11:00:00Z",      // 可选
      filled_by_employee_id: "0000199059",   // 可选
    },

    // === (4) 可选标识(AO 前端可据此标"补全后重判"图标)===
    source_channel: "raas_recruiter_repair_replay",
  },
});
```

### 5.3 AO 收到 RESUME_PROCESSED 后做的事(partner 不用管,但要知道)

- 走的还是 `matchResumeAgent`(同一函数,无新 handler)
- 重跑 rule-check + 如果 PASS 调 RAAS API Server `/api/v1/match-resume`
- 新 audit 写 Prisma 时 `parent_audit_id` = 原 audit_id → AO 前端 drawer 可见"补全前 vs 补全后"
- Neo4j 新 `Candidate_Match_Result` 节点 `REPLAY_OF` 链回旧节点
- 还缺字段?→ AO 再次发 `RESUME_INFO_MISSING`(新 `audit_id`),自然进入下一轮循环
- 补完真硬性失败?→ AO 发 `RULE_CHECK_FAILED`,partner 关任务

---

## 6. partner 要改的 2 处

### R1 — 在 HITL mapping 加一行(5 分钟)

ingest 文档 §4 白名单里已经有 `RESUME_INFO_MISSING`,但 §5 HITL 触发表没配,所以现在 AO emit 后 consumer 直接 skip → recruiter 看不到任务。

按 §5 现有 mapping 的格式补一条:

```typescript
// raas_v4/backend/packages/domain/src/hitl/hitl-event.mapping.ts
RESUME_INFO_MISSING: {
  task_type: 'resume_info_repair',         // task_type 名 partner 自己定,AO 不关心
  owner_role: 'recruiter',
  priority: 'P1',
  blocking_scope: 'candidate',
  required_payload_fields: [
    'candidate_id',
    'resume_id',
    'job_requisition_id',
    'missing_fields',
    'audit_id',          // ★ 必须 — partner 提交补全时要原样回传到 enrichment_applied.parent_audit_id
  ],
},
```

完成后 partner HITL consumer 自动:
- INSERT hitl_task(task_type=`resume_info_repair`,owner=recruiter)
- recruiter 工作台 `工作台 → 待办` 立刻看到任务

跟 ingest 文档 §5 其他 8 个事件**完全一样的机制**,不需要写新 Inngest function。

---

### R2 — 给新 task_type 加 UI + submit 逻辑(参照现有 task_type 模式)

partner 现有 8 个 task_type(`resume_fix` / `jd_review` 等)每个都有对应的 recruiter 工作台 UI + submit handler。给新的 `resume_info_repair` 加同样的 2 件事:

**(a) UI** — 渲染 `payload.missing_fields[]` 数组,每个 field 渲染一个输入框:
- `field`:中文 label
- `rule_names[]`:hint 显示("规则 N 要求此字段")
- `evidence_excerpt`:hint 显示具体原因

**(b) submit handler** — 提交时执行:

```typescript
// pseudocode
async function submitResumeRepair(taskId, formInputs) {
  // 1. 读 task + 它对应的 partner 本地 parsed_resume 副本
  const task = await getHitlTask(taskId);
  const resumeRecord = await getResume(task.payload.resume_id);
  const originalParsed = JSON.parse(resumeRecord.parsed_resume_json);

  // 2. 把 recruiter 填的中文字段翻译成英文 key,merge 到 parsed_resume
  const filledDeltaEnglish: Record<string, any> = {};
  for (const [chineseKey, value] of Object.entries(formInputs)) {
    if (value === '' || value == null) continue;
    const englishKey = AO_FIELD_MAP[chineseKey] ?? chineseKey;  // §7 表
    filledDeltaEnglish[englishKey] = value;
  }
  const mergedParsed = { ...originalParsed, ...filledDeltaEnglish };

  // 3. 更新本地 parsed_resume + 关任务(用 partner 现有机制)
  await updateResumeParsedJson(task.payload.resume_id, mergedParsed);
  await completeHitlTask(taskId);

  // 4. ★ 重发 RESUME_PROCESSED 给 AO(走 partner 自己的 outboxService)
  await outboxService.appendOntologyEvent({
    event_name: 'RESUME_PROCESSED',
    entity_type: 'Resume',
    entity_id: task.payload.resume_id,
    payload: {
      upload_id:           resumeRecord.upload_id,
      candidate_id:        task.payload.candidate_id,
      resume_id:           task.payload.resume_id,
      job_requisition_id:  task.payload.job_requisition_id,
      employee_id:         currentUser.employee_id,
      parsed: { data: mergedParsed },

      enrichment_applied: {
        parent_audit_id:         task.payload.audit_id,    // ★ 必须原样回传
        filled_fields_delta:     filledDeltaEnglish,
        filled_at:               new Date().toISOString(),
        filled_by_employee_id:   currentUser.employee_id,
      },
      source_channel: 'raas_recruiter_repair_replay',
    },
  });
}
```

**总工作量 R1 + R2 ≈ 1-2 小时**(主要是 R2 的 UI;mapping 5 分钟)。

---

## 7. AO 字段映射表(给 R2 submit handler 用)

recruiter 在表单看到中文字段名,partner submit handler 翻译为 AO `parsed_resume` 的英文 key:

| 中文(表单输入) | 英文(parsed_resume key) | 例值 |
|---|---|---|
| 性别 | `gender` | "男" |
| 婚育情况 | `marital_status` | "未婚" / "已婚未育" / "已婚已育" / "离异" |
| 国籍 | `nationality` | "中国" |
| 出生年份 | `birth_year` | "1996" |
| 出生日期 | `birth_date` | "1996-05-12" |
| 期望薪资 / 期望薪资范围 | `expected_salary_range` | "15k-18k" |
| 利益冲突声明 / 利益冲突声明数据 | `conflict_of_interest_summary` | "已声明无亲属冲突" |

**复杂结构**(如完整 conflict_of_interest_declaration 对象)直接用英文 key 发:

```json
"parsed": {
  "data": {
    // ... 原有 28 个字段
    "conflict_of_interest_declaration": {
      "has_relatives_in_client_company": false,
      "declared": true,
      "declared_at": "2026-05-13T10:30:00Z",
      "source": "recruiter_form"
    }
  }
}
```

**partner 端 const 表**:

```typescript
export const AO_FIELD_MAP: Record<string, string> = {
  '性别': 'gender',
  '婚育情况': 'marital_status',
  '国籍': 'nationality',
  '出生年份': 'birth_year',
  '出生日期': 'birth_date',
  '期望薪资': 'expected_salary_range',
  '期望薪资范围': 'expected_salary_range',
  '利益冲突声明': 'conflict_of_interest_summary',
  '利益冲突声明数据': 'conflict_of_interest_summary',
};
```

---

## 8. 联调 checklist

| # | 步骤 | 期望结果 | 是否对接面 |
|---|---|---|---|
| 1 | AO mock 一条 rule-check FAIL with missing fields | AO 日志 `📋 RESUME_INFO_MISSING · missing=性别,利益冲突声明` | AO 内部 |
| 2 | partner ingest 收到 `RESUME_INFO_MISSING` | partner `event_outbox` 看到一条 `status=published`,payload 含 `audit_id` | 对接面 ① |
| 3 | partner hitl-event.consumer 处理 | partner `hitl_task` 表看到 `task_type=resume_info_repair`, `owner_role=recruiter` | partner 内部 |
| 4 | recruiter 工作台显示任务 | 任务标题 `需要补全简历信息 — N 项缺失` | partner 内部 |
| 5 | recruiter 填字段提交 | partner `hitl_task.status=completed`,本地 `parsed_resume` 已 merge | partner 内部 |
| 6 | **partner 重发 `RESUME_PROCESSED`** | partner `event_outbox` 新一条 `RESUME_PROCESSED`,**payload 必须含 `enrichment_applied.parent_audit_id`(=步骤 2 的 audit_id)** | **★ 对接面 ②** |
| 7 | Shared Inngest 投递 | AO matchResumeAgent 触发 | AO 内部 |
| 8 | AO 重跑 | AO Prisma 新 `RuleCheckAudit`,`parent_audit_id` 指向原 audit | AO 内部 |
| 9 | AO 写新 `Candidate_Match_Result` | Neo4j 新节点,`parent_match_result_id` 链回上次 | partner 可查 |
| 10 | 补全后 rule-check PASS | AO 调 RAAS `/api/v1/match-resume` → emit `MATCH_PASSED_NEED_INTERVIEW` | 走原 matchResume 流程 |
| 11 | 补全后 rule-check 还缺 | AO 再次 emit `RESUME_INFO_MISSING`(新 audit_id)| 下一轮循环 |
| 12 | 补完后 rule-check 硬失败 | AO emit `RULE_CHECK_FAILED`,partner 关任务 | 对接面 ③ |

**只有第 2 / 6 / 12 是 AO 跟 partner 的对接面**。其他都是各自内部细节。

---

## 9. AO 端代码索引(给 partner 实施者参考,无需读懂)

| AO 文件 | 作用 |
|---|---|
| `server/inngest/agents/match-resume-agent.ts:290-358` | emit `RESUME_INFO_MISSING` / `RULE_CHECK_FAILED`(互斥)|
| `server/inngest/agents/match-resume-agent.ts:601-643` | 写 `Candidate_Match_Result` (PASS 路径) |
| `lib/rule-check/neo4j-match-result-writer.ts` | Neo4j Match_Result writer |
| `lib/rule-check/prompt.ts:55-90` | rule-check LLM prompt(evidence 三段式硬约束) |
| `prisma/schema.prisma` | `RuleCheckAudit.parent_audit_id` 谱系字段 |

---

## 10. partner Inngest SDK 版本

AO 端 Inngest server v1.19.2,SDK v4.3.0。partner 端建议 SDK **≥ v4.3.0** 避免 opcode 不兼容。

```bash
cd raas_v4/backend
npm install inngest@^4.3.0
```

---

## 11. 联系人

- AO 端:`agenticOperator` 仓库 `Steven` 分支
- 联调 staging:partner staging Inngest + AO localhost:3002(LAN IP 桥)
- ingest 文档参考:`raas_v4/docs/integration/events-ingest-api.md`(本文 §6 R1 对应这份的 §5 HITL mapping)
- AO 流程完整文档:`docs/resume-info-repair-flow.md`(跟本文配对)
