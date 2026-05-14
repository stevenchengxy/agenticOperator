# 完整事件链 — 从 REQUIREMENT_LOGGED 到 APPLICATION_SUBMITTED

> 端到端流程图:覆盖 7 个阶段、~25 个事件、3 方协作(AO + RAAS dashboard + Allmeta API)。
> 这是 [docs/architecture-corrected-event-chain.md](architecture-corrected-event-chain.md) 的具体展开 — 把每一阶段画细。

---

## 三方职责速览(再次强调)

| 层 | 谁 | 职责 |
|---|---|---|
| **L1 UI** | RAAS dashboard | HSM / recruiter / HSM 工作台 · 上传 · 任务展示 · 表单 |
| **L2 事件总线** | Shared Inngest @ `10.100.0.70:8288` | 三方共用,所有事件走这里 |
| **L3 业务 workers** | AO agents(:3002)+ partner workers(`10.100.0.70`) | 业务逻辑,触发 LLM / 调外部 API |
| **L4 实例数据网关** | **Allmeta API** @ `10.100.0.70:3500` | **唯一的 Neo4j 写入入口** |

**核心规则**:任何 `:Candidate / :Resume / :Job_Requisition / :Job_Posting / :Application / :Candidate_Match_Result / :Interview_Record / :Evaluation_Report / :Recommendation_Material / :Job_Offer` 等业务实例写入 → 经 Allmeta API,**不直连 Bolt**。

---

## API 速查表(每阶段会用到的)

### RAAS API Server endpoints(AO 调 partner)

> Base:`http://192.168.1.105:3001`(prod 同段网络);Auth:`Authorization: Bearer <AGENT_API_KEY>`
> 客户端封装:[lib/raas-api-client.ts](../lib/raas-api-client.ts)

| Method | Path | 用途 | AO 调用方 |
|---|---|---|---|
| GET | `/api/v1/requirements/agent-view?claimer_employee_id=X` | 列某 recruiter 名下所有可匹配 JR | matchResumeAgent |
| GET | `/api/v1/requirements/{job_requisition_id}` | 单 JR 完整详情(spec + siblings)| createJdAgent / matchResumeAgent 路径 A |
| POST | `/api/v1/generate-jd` | RoboHire JD 生成透传(LLM)| createJdAgent |
| POST | `/api/v1/jd/sync-generated` | 持久化生成的 JD 到 RAAS DB(将来可由 Allmeta 替代)| createJdAgent |
| GET | `/api/v1/resumes/uploads/{upload_id}/raw` | 拉简历原始 PDF 字节 | resumeParserAgent |
| POST | `/api/v1/parse-resume` | RoboHire 解析透传(multipart)| resumeParserAgent |
| POST | `/api/v1/candidates` | 持久化候选人到 RAAS DB(将来可由 Allmeta 替代)| resumeParserAgent |
| POST | `/api/v1/match-resume` | RoboHire 评分透传 | matchResumeAgent |
| POST | `/api/v1/match-results` | 持久化匹配结果到 RAAS DB(将来可由 Allmeta 替代)| matchResumeAgent |
| POST | `/api/v1/invite-interview` | 发面试邀约(当前 501)| 待 partner 实现 |
| POST | `/api/v1/events/ingest` | 通用事件 ingest(信号 / HITL 触发)| AO emit `RESUME_INFO_MISSING / MATCH_FAILED` 等用 |

### Allmeta Ontology API endpoints(AO 调 Allmeta 写 Neo4j)

> Base:`http://10.100.0.70:3500`(dev:`http://localhost:3500`);Auth:`Authorization: Bearer dev-ao-allmeta-2026`
> domain:`?domain=RAAS-v1`(query)+ `domainId: "RAAS-v1"`(body)
> 完整文档:`~/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md`

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/v1/ontology/actions/matchResume/rules?domain=RAAS-v1` | 拉 matchResume action 的全部规则(51 条)|
| POST | `/api/v1/ontology/instances/{label}?domain=RAAS-v1` | **创建 / upsert 实例**(MERGE 语义)|
| GET | `/api/v1/ontology/instances/{label}/{pk}?domain=RAAS-v1` | 读单个实例 |
| GET | `/api/v1/ontology/instances/{label}?domain=RAAS-v1&limit=50` | 列实例(可按字段过滤)|
| PATCH | `/api/v1/ontology/instances/{label}/{pk}?domain=RAAS-v1` | 部分更新实例(不替换其他字段)|
| PUT | `/api/v1/ontology/instances/{label}/{pk}?domain=RAAS-v1` | 完全替换实例 |
| DELETE | `/api/v1/ontology/instances/{label}/{pk}?domain=RAAS-v1` | 删实例 |
| POST | `/api/v1/ontology/links` | **创建实例间关系**(`:HAS_RESUME` 等)|
| **POST** | **`/api/v1/ontology/actions/matchResume/results`** | **特化端点:写 Candidate_Match_Result + 自动 MERGE Candidate/JR + 自动建关系**(★ 阶段 5 用)|

**实例写入通用 body 形态**:
```json
{
  "domainId": "RAAS-v1",
  "<pk_field>": "<unique-id>",     // pk_field 取自 DataObject.primary_key,例 candidate_id / resume_id
  "<其他字段>": "..."                // schema 里声明的字段,见 §validate
}
```

**关键注意**:
- 默认 strict 校验 — 字段必须在 `:DataObject.properties_json` 里声明(否则 400)
- 想 permissive(允许任意字段)→ 后端要改默认配置 / 加 `?validate=none`(目前未实测可用)

---

## 阶段 1 ─ 需求登记 + 分析(REQUIREMENT_LOGGED → ANALYSIS_COMPLETED)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ HSM 在 RAAS dashboard 录入需求 / 从客户系统同步                                       │
│   - 标准录入 → RAAS emit  REQUIREMENT_LOGGED                                          │
│   - 客户 RMS 同步 → RAAS emit  REQUIREMENT_SYNCED                                    │
└──────────────────────────────────┬──────────────────────────────────────────────────┘
                                   ▼ Shared Inngest
                       ┌──────────────────────────────┐
                       │ AO createJdAgent             │
                       │ (订阅 REQUIREMENT_LOGGED)    │
                       └──────────────┬───────────────┘
                                      ▼
                  跑 AI 需求深度分析(LLM 提取 must_have_skills / nice_to_have /
                  work_years / degree_requirement / 等结构化字段)
                                      │
                  ★ 写实例到 Neo4j(经 Allmeta API):
                  POST /api/v1/ontology/instances/Job_Requisition?domain=RAAS-v1
                    body: { job_requisition_id, client_id, client_department_id,
                            client_job_title, must_have_skills[], salary_range, ... }
                                      │
                          ┌───────────┴────────────┐
                          ▼                        ▼
                  字段全 / 逻辑无冲突        缺关键信息 / 逻辑冲突
                          │                        │
                          ▼                        ▼
                  emit ANALYSIS_         emit CLARIFICATION_
                  COMPLETED              INCOMPLETE  ★HITL
                                         (payload 带 clarify_questions[])
                                                   │
                                                   ▼ partner HITL consumer
                                            创建 requirement_clarification
                                            任务 → HSM 工作台显示
                                                   │
                                                   ▼ HSM 在 dashboard 填澄清
                                            RAAS emit CLARIFICATION_RETRY
                                                   │
                                                   └──► 回到 createJdAgent 顶部
                                                        (订阅了 CLARIFICATION_READY)
                                                        重跑分析
                                                        │
                                                        ▼
                                               emit CLARIFICATION_READY
                                               (实际上是 ANALYSIS_COMPLETED 的
                                                重命名版,触发下一阶段)
```

错误分支:`ANALYSIS_BLOCKED`(★ HITL,数据源异常需运维) — partner 路由到 ops 群。

### 阶段 1 实际 API 调用细节

**(1) AO → RAAS API Server**(`server/inngest/agents/create-jd-agent.ts:120`)

```http
GET /api/v1/requirements/{job_requisition_id} HTTP/1.1
Host: 192.168.1.105:3001
Authorization: Bearer internal-agentic-agent
```

→ 返回:`{ requirement: {...完整 JR + spec...}, siblings: [...] }`(RAAS DB 现有数据)

**(2) AO → Allmeta API**(★ 新增,替换现在直连 Bolt 的 `lib/jd-sync/neo4j-jd-writer.ts`)

```http
POST /api/v1/ontology/instances/Job_Requisition?domain=RAAS-v1 HTTP/1.1
Host: 10.100.0.70:3500
Authorization: Bearer dev-ao-allmeta-2026
Content-Type: application/json

{
  "domainId": "RAAS-v1",
  "job_requisition_id": "JRQ-f592f8ce-...",
  "client_id": "...",
  "client_department_id": "...",
  "client_job_title": "文秘行政专员",
  "salary_range": "15k-16k",
  "must_have_skills": ["..."],
  "nice_to_have_skills": ["..."],
  "work_years": 3,
  "degree_requirement": "本科",
  "business_group": "WXG",
  "recruitment_type": "...",
  "first_seen_at": "..."
}
```

→ 返回:`{ upserted: ["JRQ-f592f8ce-..."], count: 1 }`(Idempotent MERGE)

**为什么 Allmeta**:这是 Job_Requisition 实例第一次写到共享 Neo4j。陈洋的 Allmeta `:DataObject {id:"Job_Requisition", primary_key:"job_requisition_id"}` 定义这里的字段;strict 校验会拒未声明字段(可能要先跟陈洋对齐 schema)。

**HITL 分支**:`CLARIFICATION_INCOMPLETE` / `ANALYSIS_BLOCKED` 都走 `POST /api/v1/events/ingest`(partner ingest 端点),partner HITL consumer 自动建任务,**不写 Allmeta**(还没确定信息,没必要持久化半成品)。

---

## 阶段 2 ─ JD 生成 + 审核(CLARIFICATION_READY → JD_APPROVED)

```
                    CLARIFICATION_READY  或  ANALYSIS_COMPLETED
                                │
                                ▼ Shared Inngest
                  ┌──────────────────────────────┐
                  │ AO createJdAgent             │
                  │ (订阅 CLARIFICATION_READY)   │
                  └──────────────┬───────────────┘
                                 ▼
                  生成标准化 JD(LLM,标题 + 职责 + 要求 + 福利 + 客户信息)
                                 │
                  ★ 写实例(经 Allmeta API):
                  POST /api/v1/ontology/instances/Job_Posting?domain=RAAS-v1
                    body: { job_posting_id, job_requisition_id, title,
                            description, requirements, benefits, ... }
                                 │
                                 ▼
                       emit  JD_GENERATED   ★HITL
                       (payload: job_posting_id, title, ai_summary)
                                 │
                                 ▼ partner HITL consumer
                       创建 jd_review 任务(P0)→ HSM 工作台
                                 │
                       HSM 审核 →
                  ┌─────────────┼─────────────┐
                  ▼             │             ▼
            JD_APPROVED    HSM 改文案     JD_REJECTED
            (走下游         (改完直接      (退回 createJdAgent,
             发布)         partner emit    `triggers` 也订阅了
                           JD_APPROVED)    JD_REJECTED 重跑)
```

### 阶段 2 实际 API 调用细节

**(1) AO → RAAS API Server: 调 RoboHire 生成 JD**(`create-jd-agent.ts:163`)

```http
POST /api/v1/generate-jd HTTP/1.1
Authorization: Bearer internal-agentic-agent
Content-Type: application/json

{
  "job_requisition_id": "...",
  "requirement_summary": "...",     // 从阶段 1 GET /requirements/:id 拿到的字段
  "must_have_skills": [...],
  "nice_to_have_skills": [...],
  ...
}
```

→ 返回:`{ data: { title, posting_title, description, requirements, benefits, ... }, requestId }`(RoboHire 生成的 JD 全字段)

**(2) AO → RAAS API Server: 持久化 JD 到 RAAS DB**(`create-jd-agent.ts:196`)

```http
POST /api/v1/jd/sync-generated HTTP/1.1
Authorization: Bearer internal-agentic-agent
Content-Type: application/json

{
  "job_requisition_id": "...",
  "client_id": "...",
  ...generateJdResult.data,         // RoboHire 输出 spread
  "must_have_skills": [...],        // 补 raas snake_case 增强字段
  "generator_model": "raas-api/generate-jd"
}
```

→ 返回:`{ job_posting_id: "JP-...", requestId, ... }`

**(3) AO → Allmeta API: 写 Job_Posting 实例**(★ 新增,替换现在 `lib/jd-sync/neo4j-jd-writer.ts` 的 Bolt 直连)

```http
POST /api/v1/ontology/instances/Job_Posting?domain=RAAS-v1 HTTP/1.1
Authorization: Bearer dev-ao-allmeta-2026
Content-Type: application/json

{
  "domainId": "RAAS-v1",
  "job_posting_id": "JP-...",
  "job_requisition_id": "JRQ-...",  // 外键
  "posting_title": "...",
  "posting_description": "...",
  "salary_text": "...",
  "generated_at": "..."
}
```

**(4) AO → Allmeta API: 建 Job_Posting ↔ Job_Requisition 关系**

```http
POST /api/v1/ontology/links HTTP/1.1
Content-Type: application/json

{
  "domainId": "RAAS-v1",
  "type": "REALIZES_REQUIREMENT",
  "fromId": "JP-...",                // Job_Posting pk
  "toId": "JRQ-..."                  // Job_Requisition pk
}
```

**HITL 分支**:`JD_GENERATED` 经 `POST /api/v1/events/ingest` 发给 partner,partner HITL consumer 自动建 `jd_review` 任务(已在 ingest §5 mapping)。

`JD_REJECTED` 不写 Allmeta(待 HSM 改完通过后,再走 (3)(4)更新 Job_Posting)。

---

## 阶段 3 ─ JD 发布到渠道(JD_APPROVED → CHANNEL_PUBLISHED)

```
                              JD_APPROVED
                                  │
                                  ▼ Shared Inngest
                      ┌────────────────────────────────┐
                      │ partner channel publisher      │
                      │ (RAAS-side worker,partner 已实现)│
                      └────────────────┬───────────────┘
                                       │ 调拉勾 / BOSS / 内推平台 API
                                       │
                          ┌────────────┴───────────┐
                          ▼                        ▼
                       发布成功                  发布失败
                          │                        │
                  ┌───────┴──────┐                 ▼
                  ▼              ▼          emit CHANNEL_PUBLISHED_FAILED  ★HITL
            CHANNEL_         CHANNEL_              (payload: job_posting_id, reason)
            PUBLISHED        PUBLISHED                     │
            (自动)           _MANUAL                       ▼ partner HITL consumer
                            (recruiter                创建 manual_publish_fallback
                             已手工发)                任务 → recruiter 工作台
                                                            │
                                                            ▼ recruiter 手工发到渠道
                                                     RAAS emit CHANNEL_PUBLISHED_MANUAL
```

### 阶段 3 实际 API 调用细节

**这阶段 AO 不参与**。partner channel publisher 负责调拉勾 / BOSS / 内推平台 API。

**AO → Allmeta API**(可选,partner 也可以做):**更新 Job_Posting 实例状态**

```http
PATCH /api/v1/ontology/instances/Job_Posting/{job_posting_id}?domain=RAAS-v1 HTTP/1.1
Content-Type: application/json

{
  "domainId": "RAAS-v1",
  "channel_status": "published",   // or "published_manual" / "failed"
  "channel_published_at": "...",
  "channel_id": "lagou-12345"      // 第三方渠道 ID
}
```

---

## 阶段 4 ─ 简历采集 + 解析(RESUME_DOWNLOADED → RESUME_PROCESSED)

```
渠道有候选人投递 / recruiter 手工上传 / 内推简历
            │
            ▼ 文件落 MinIO (10.100.0.70:9000)
            │
            ▼ RAAS dashboard / 渠道适配器 emit
   RESUME_DOWNLOADED ──► Shared Inngest
                              │
                              ▼
              ┌────────────────────────────────────┐
              │ AO resumeParserAgent               │
              │ (订阅 RESUME_DOWNLOADED)           │
              └────────────────┬───────────────────┘
                               ▼
                调 RAAS API Server POST /api/v1/parse-resume
                (RAAS 内部 proxy 到 RoboHire)
                               │
                  ┌────────────┴───────────┐
                  ▼                        ▼
              解析成功                  解析失败
                  │                        │
                  ▼                        ▼
   ★ 写实例(经 Allmeta API):        emit RESUME_PARSE_ERROR  ★HITL
   POST /instances/Candidate         (payload: candidate_id, error_detail, confidence)
     body: { candidate_id, name,            │
             gender, marital_status,        ▼ partner HITL consumer
             nationality, birth_date, ... } 创建 resume_fix 任务 → recruiter 工作台
                                            │
   POST /instances/Resume                   ▼ recruiter 修正(改简历 / 重 upload)
     body: { resume_id, candidate_id,   RAAS emit RESUME_DOWNLOADED 再来一遍
             parsed_resume_json,
             work_experience,
             education_experience, ... }
                  │
                  ▼ emit RESUME_PROCESSED
                  (payload: { upload_id, candidate_id, resume_id,
                              parsed: { data: <parsed.data> },
                              employee_id, job_requisition_id?,
                              enrichment_applied?: { parent_audit_id }  // 补全后重跑时)
                  │
                  └──► 进入阶段 5 (匹配)
```

错误:`RESUME_LOCKED_CONFLICT`(候选人锁定 / 内推冲突)— 流程中止。

### 阶段 4 实际 API 调用细节

**(1) AO → RAAS API Server: 拉简历 PDF 字节**(`resume-parser-agent.ts:98`)

```http
GET /api/v1/resumes/uploads/{upload_id}/raw HTTP/1.1
Authorization: Bearer internal-agentic-agent
```

→ 返回:PDF 二进制(`Buffer`)

**(2) AO → RAAS API Server: RoboHire 解析透传**(`resume-parser-agent.ts:117`)

```http
POST /api/v1/parse-resume HTTP/1.1
Authorization: Bearer internal-agentic-agent
Content-Type: multipart/form-data

file: <PDF bytes>
filename: "candidate.pdf"
```

→ 返回:`{ data: { name, gender, marital_status, birth_date, nationality, education[], experience[], skills, expected_salary_range, ... }, requestId }`

**(3) AO → RAAS API Server: 持久化 candidate 到 RAAS DB**(`resume-parser-agent.ts:155`)

```http
POST /api/v1/candidates HTTP/1.1
Content-Type: application/json

{ candidate_id, name, ...parsed.data, source: "auto_parsed", upload_id, employee_id }
```

→ 返回:`{ candidate_id, resume_id, is_new_candidate, is_new_resume }`

**(4) AO → Allmeta API: 写 Candidate 实例**(★ 新增,替换 `lib/rule-check/neo4j-instance-writer.ts` 的 `buildCandidateSnapshot` Bolt 直连)

```http
POST /api/v1/ontology/instances/Candidate?domain=RAAS-v1 HTTP/1.1
Content-Type: application/json

{
  "domainId": "RAAS-v1",
  "candidate_id": "04bcaedb-...",
  "name": "江银行",
  "gender": "男",
  "marital_status": "未婚",
  "nationality": "中国",
  "birth_date": "1996-05-12",
  "id_number": "...",
  "is_locked": false
}
```

**(5) AO → Allmeta API: 写 Resume 实例**

```http
POST /api/v1/ontology/instances/Resume?domain=RAAS-v1 HTTP/1.1
Content-Type: application/json

{
  "domainId": "RAAS-v1",
  "resume_id": "1e319239-...",
  "candidate_id": "04bcaedb-...",
  "work_experience": "...",
  "project_experience": "...",
  "education_experience": "...",
  "language_skills": "...",
  "file_path": "minio://recruit-resume-raw/...",
  "is_original": true
}
```

**(6) AO → Allmeta API: 写 Candidate_Expectation 实例**(从 parsed_resume 抽期望字段)

```http
POST /api/v1/ontology/instances/Candidate_Expectation?domain=RAAS-v1 HTTP/1.1
Content-Type: application/json

{
  "domainId": "RAAS-v1",
  "candidate_expectation_id": "EXP_04bcaedb-...",
  "candidate_id": "04bcaedb-...",
  "expected_salary_range": "15k-18k",
  "outsourcing_acceptance": "accept",
  "expected_location": "深圳",
  "source": "resume_parsing"
}
```

**(7) AO → Allmeta API: 建关系**(`Candidate -[:HAS_RESUME]-> Resume`, `Candidate -[:HAS_EXPECTATION]-> Candidate_Expectation`)

```http
POST /api/v1/ontology/links HTTP/1.1
{ "domainId": "RAAS-v1", "type": "HAS_RESUME", "fromId": "04bcaedb-...", "toId": "1e319239-..." }

POST /api/v1/ontology/links HTTP/1.1
{ "domainId": "RAAS-v1", "type": "HAS_EXPECTATION", "fromId": "04bcaedb-...", "toId": "EXP_04bcaedb-..." }
```

**HITL 分支**:`RESUME_PARSE_ERROR` / `RESUME_LOCKED_CONFLICT` 走 `POST /api/v1/events/ingest`,partner HITL consumer 建 `resume_fix` 任务 → recruiter 工作台。

---

## 阶段 5 ─ 简历匹配(★ 核心:rule-check + Robohire)

```
                   RESUME_PROCESSED
                          │
                          ▼ Shared Inngest
              ┌────────────────────────────────────────┐
              │ AO matchResumeAgent (订阅 RESUME_PROCESSED) │
              │                                            │
              │ Step 1-3) 准备数据                          │
              │   - 调 RAAS API GET /requirements/         │
              │     agent-view 拿候选 JR 列表               │
              │   - (可选) Allmeta GET /instances/         │
              │     Job_Requisition 校验                    │
              │                                            │
              │ Step 4.0) rule-check LLM 预筛               │
              │   - Allmeta GET /actions/matchResume/rules │
              │     拿 51 条规则                            │
              │   - filter (client × business_group ×       │
              │     executor) → 27 条进 LLM                 │
              │   - LLM 评估,产出 rule_flags + decision     │
              │                                            │
              │ Step 4b) 双写审计                           │
              │   - Prisma 写 RuleCheckAudit + Flag(私有)  │
              │   - ★ Allmeta API 写实例锚节点:            │
              │     POST /instances/Candidate(refresh)     │
              │     POST /instances/Resume(refresh)        │
              │     POST /instances/Job_Requisition(refresh)│
              └────────────────┬───────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────────────┐
        ▼ PASS                 ▼ FAIL                          │
   Step 4a:           ┌──────────────────────┐                │
   调 RAAS API        │ FAIL 有缺字段吗?      │                │
   POST /api/v1/      └──────────┬───────────┘                │
   match-resume          ┌───────┴────────┐                   │
   (RAAS proxy           ▼                ▼                   │
    到 RoboHire)     ① emit            ② emit                 │
        │            RESUME_INFO       MATCH_FAILED ★HITL    │
        │            _MISSING ★HITL    (payload:              │
        │            (payload:          match_failed_source:  │
        ▼            missing_fields[],  'rule_check_terminal',│
   拿到 matchScore   audit_id,...)      failure_reasons[],...) │
   recommendation         │                   │                │
        │                 ▼                   ▼                │
        │           partner HITL         partner consumer      │
        │           创建 resume_info     按现有 MATCH_FAILED   │
        │           _repair 任务         流程关 candidate-on-jr │
        │           → recruiter 表单      matching 任务         │
        │                                                       │
        ▼                                                       │
   match_score >= threshold?                                    │
        ├─ 是 + 客户要面试 ──► emit MATCH_PASSED_NEED_INTERVIEW │
        ├─ 是 + 客户免面试 ──► emit MATCH_PASSED_NO_INTERVIEW   │
        └─ 否 (score 太低) ──► emit MATCH_FAILED ★HITL          │
                              (match_failed_source:             │
                               'robohire_threshold')             │
        │                                                       │
        ▼ (PASS 路径独有)                                       │
   ★ 写 Match_Result 经 Allmeta API:                          │
   POST /instances/Candidate_Match_Result                       │
     body: { candidate_match_result_id: "cmr_<audit_id>",      │
             candidate_id, job_requisition_id, client_id,       │
             rule_check_decision: "PASS",                       │
             rule_check_audit_id,                              │
             match_score, match_recommendation,                 │
             match_breakdown_json,                              │
             raas_match_request_id,                             │
             final_decision: "PASS",                            │
             decided_at, parent_match_result_id? }              │
        │                                                       │
        ▼                                                       │
   ★ 写 Application(投递记录)经 Allmeta API:                │
   POST /instances/Application                                  │
     body: { application_id, candidate_id, job_requisition_id, │
             match_score, status: "submitted" }                  │
        │                                                       │
        ▼ emit APPLICATION_SUBMITTED ── 进入阶段 6              │
                                                                │
                              recruiter 填表 → partner emit ───┤
                              RESUME_INFO_MISSING_FILLED       │
                              (含 parent_audit_id + delta)     │
                              → AO 经 Allmeta 读 Resume merge   │
                              → AO 写回 Allmeta + emit          │
                              RESUME_PROCESSED → 重跑          │
                              (回阶段 5 顶部)                  ─┘
```

### 阶段 5 实际 API 调用细节

**(1) AO → RAAS API Server: 拉候选 JR 列表(路径 B)**(`match-resume-agent.ts:160`)

```http
GET /api/v1/requirements/agent-view?claimer_employee_id=0000199059 HTTP/1.1
Authorization: Bearer internal-agentic-agent
```

→ 返回:`{ items: [{ job_requisition_id, recruitment_status, ... }, ...], total }`

**(2)(可选)路径 A — RESUME_PROCESSED.payload 已有 linked_job_requisition_id**

```http
GET /api/v1/requirements/{job_requisition_id} HTTP/1.1
```

→ 单 JR 精准匹配,跳过 agent-view 列举。

**(3) AO → Allmeta API: 拉 51 条 matchResume 规则**(`lib/rule-check/ontology-source.ts` Path 2)

```http
GET /api/v1/ontology/actions/matchResume/rules?domain=RAAS-v1 HTTP/1.1
Authorization: Bearer dev-ao-allmeta-2026
```

→ 返回:`{ action: { id: "matchResume", actionSteps: [{ rules: [{ id: "10-1", ...}, ...] }] } }`

(现阶段 AO `ontology-source.ts` 路径 1 是直连 Neo4j Cypher 抓的,后期切到 Path 2 经 Allmeta)

**(4) AO 内部: rule-check LLM 跑 27 条规则**(不调外部)

→ 产出 `rule_flags[]` + `decision: PASS/FAIL` + `failure_reasons[]`

**(5) AO → Prisma SQLite: 写 RuleCheckAudit + RuleCheckFlag**(本地,**不进 Neo4j**)

→ AO 私有审计数据,跟 ontology 解耦。

**(6) AO → Allmeta API: refresh 实例锚节点**(★ 替换现在 `neo4j-instance-writer.ts` 的 Bolt 直连)

```http
POST /api/v1/ontology/instances/Candidate?domain=RAAS-v1
POST /api/v1/ontology/instances/Resume?domain=RAAS-v1
POST /api/v1/ontology/instances/Job_Requisition?domain=RAAS-v1
```

MERGE 语义,重复跑只更新字段,不建新节点。

**(7) rule-check PASS 路径:AO → RAAS API Server: 调 RoboHire match**(`match-resume-agent.ts:474`)

```http
POST /api/v1/match-resume HTTP/1.1
Content-Type: application/json

{
  "resume": "<augmented resume text>",   // 含 rule-check augmentation 段
  "jd": "<flattened JR text>"
}
```

→ 返回:`{ data: { matchScore, recommendation, skillMatch, experienceMatch, ... }, requestId }`

**(8) AO → RAAS API Server: 持久化 match 到 RAAS DB**(`match-resume-agent.ts:515`)

```http
POST /api/v1/match-results HTTP/1.1
{ source: "need_interview", candidate_id, upload_id, job_requisition_id, client_id, ...matchResult.data }
```

**(9) AO → Allmeta API: 写 Candidate_Match_Result**(★ 用特化端点 `actions/matchResume/results`,替换 `neo4j-match-result-writer.ts`)

```http
POST /api/v1/ontology/actions/matchResume/results HTTP/1.1
Authorization: Bearer dev-ao-allmeta-2026
Content-Type: application/json

{
  "candidateId":   "04bcaedb-...",
  "jobPositionId": "JRQ-...",            // 注:Allmeta 这个端点字段名是 jobPositionId,不是 job_requisition_id
  "result":        "匹配",                // or "不匹配" / "待定"
  "reason":        "rule-check PASS + RAAS matchResume score=78.5 rec=consider"
}
```

→ 返回:`{ candidateMatchResultId: "f3d1c8e2-...", createdAt: "..." }`

**该端点的特殊行为**:
- **每次都新建**一条 history 记录(不 MERGE,可保留多次重判历史)
- 自动 MERGE `:Candidate` / `:Job_Requisition` stub 节点(如果不存在)
- 自动建 2 个关系:
  - `(:Candidate_Match_Result)-[:candidate_match_result_refers_to_candidate]->(:Candidate)`
  - `(:Candidate_Match_Result)-[:candidate_match_result_refers_to_job_requisition]->(:Job_Requisition)`

**(10) AO → Allmeta API: 写 Application 实例**(新增,投递记录)

```http
POST /api/v1/ontology/instances/Application?domain=RAAS-v1 HTTP/1.1

{
  "domainId": "RAAS-v1",
  "application_id": "APP_<audit_id>",
  "candidate_id": "...",
  "job_requisition_id": "...",
  "match_score": 78.5,
  "status": "submitted"
}
```

**(11) AO → Allmeta API: 写补 Match_Result 额外字段**(因为 §645 特化端点 schema 偏窄,只能写 4 字段;rule-check 维度要补)

```http
PATCH /api/v1/ontology/instances/Candidate_Match_Result/{candidateMatchResultId}?domain=RAAS-v1
{
  "domainId": "RAAS-v1",
  "rule_check_audit_id": "rca_...",
  "rule_check_decision": "PASS",
  "failure_reason_codes": [],
  "match_score": 78.5,
  "match_recommendation": "consider",
  "raas_match_request_id": "raas_req_...",
  "final_decision": "PASS"
}
```

**FAIL 分支(无 Match_Result 写)**:
- `RESUME_INFO_MISSING` → `POST /api/v1/events/ingest`(partner HITL)
- `MATCH_FAILED` → `POST /api/v1/events/ingest`(partner consumer 关任务)
- 只写 Prisma audit + (6) refresh 实体,**不调 §9 特化端点**

---

## 阶段 6 ─ 面试邀约 + 执行(MATCH_PASSED_NEED_INTERVIEW → AI_INTERVIEW_COMPLETED)

```
                    MATCH_PASSED_NEED_INTERVIEW
                              │
                              ▼ Shared Inngest
                  ┌─────────────────────────────────┐
                  │ partner interview-scheduler      │
                  │ (RAAS-side worker)               │
                  └────────────────┬────────────────┘
                                   ▼
                  调 RAAS API POST /api/v1/invite-interview
                  (发短信 / 微信 / 邮件邀约,带 AI 面试链接)
                                   │
                                   ▼ emit INTERVIEW_INVITATION_SENT
                                   │
                                   ▼
                  ★ 写实例(经 Allmeta API):
                  POST /instances/Interview_Record
                    body: { interview_id, application_id, candidate_id,
                            invitation_sent_at, channel: "AI" }
                                   │
                  候选人点链接,跳到 AI 面试系统
                                   │
                                   ▼ 完成面试(语音 / 视频 / 文字)
                                   │
                                   ▼ AI 面试系统回写
                                   │
                                   ▼ partner emit AI_INTERVIEW_COMPLETED
                                   │
                  ★ 写实例(经 Allmeta API):
                  PATCH /instances/Interview_Record/{interview_id}
                    body: { transcript_url, audio_url, score,
                            completed_at, duration_ms }
                                   │
                                   └──► 进入阶段 6.5 评估
```

`MATCH_PASSED_NO_INTERVIEW` 路径:跳过本阶段,直接进阶段 7(打包推荐)。

### 阶段 6 实际 API 调用细节

**(1) AO 或 partner → RAAS API Server: 发面试邀约**(目前 partner-side 实现;`lib/raas-api-client.ts:376` 有客户端)

```http
POST /api/v1/invite-interview HTTP/1.1
Authorization: Bearer internal-agentic-agent
Content-Type: application/json

{
  "candidate_id": "...",
  "job_requisition_id": "...",
  "interview_type": "ai",
  "channel": "wechat" | "sms" | "email"
}
```

→ 当前返回 **HTTP 501**(partner 未实现)。**partner 待办**:实现该端点 + 触发 AI 面试链接生成。

**(2) AO → Allmeta API: 写 Interview_Record 实例**(★ 新增,目前无 writer)

```http
POST /api/v1/ontology/instances/Interview_Record?domain=RAAS-v1 HTTP/1.1
Content-Type: application/json

{
  "domainId": "RAAS-v1",
  "interview_id": "INT_<application_id>_<n>",
  "application_id": "APP_...",
  "candidate_id": "...",
  "invitation_sent_at": "...",
  "channel": "AI",
  "status": "pending"
}
```

**(3) 面试完成后(partner-side AI 面试系统回调)→ Allmeta API: 更新 Interview_Record**

```http
PATCH /api/v1/ontology/instances/Interview_Record/{interview_id}?domain=RAAS-v1
{
  "domainId": "RAAS-v1",
  "transcript_url": "minio://.../transcript.json",
  "audio_url": "minio://.../audio.mp3",
  "score": 78,
  "duration_ms": 1234567,
  "completed_at": "...",
  "status": "completed"
}
```

**(4) AO → Allmeta API: 建 Application -[:HAS_INTERVIEW]-> Interview_Record 关系**

```http
POST /api/v1/ontology/links HTTP/1.1
{ "domainId": "RAAS-v1", "type": "HAS_INTERVIEW", "fromId": "APP_...", "toId": "INT_..." }
```

---

## 阶段 6.5 ─ AI 面试评估(AI_INTERVIEW_COMPLETED → EVALUATION_PASSED)

```
                    AI_INTERVIEW_COMPLETED
                              │
                              ▼ Shared Inngest
                  ┌─────────────────────────────────┐
                  │ AO evaluationAgent(待建)        │
                  │ 或 partner evaluation worker     │
                  └────────────────┬────────────────┘
                                   ▼
                  跑 evaluation LLM(综合岗位能力模型 + 面试转写 +
                  rule-check 结果,产出综合评估报告 + 评分)
                                   │
                  ★ 写实例(经 Allmeta API):
                  POST /instances/Evaluation_Report
                    body: { report_id, application_id, candidate_id,
                            interview_id, capability_scores: {...},
                            overall_score, recommendations[],
                            risks[], generated_by: "evaluationAgent",
                            generated_at }
                                   │
                  ┌────────────────┴───────────────┐
                  ▼ 评分达标                       ▼ 评分不达标 / 严重不符
            emit EVALUATION_PASSED          emit EVALUATION_FAILED ★HITL
                  │                          (payload: application_id,
                  ▼                                  failure_reason)
            进入阶段 7                              │
            (打包推荐)                              ▼ partner HITL consumer
                                            创建 evaluation_recheck 任务
                                            → HSM 工作台
                                                    │
                                            HSM 复核 →
                                            ├─ 强制通过 → 进阶段 7
                                            └─ 维持不通过 → 流程终止
```

### 阶段 6.5 实际 API 调用细节

**(1) AO evaluationAgent(待建)运行 evaluation LLM**(不调外部 API)

→ LLM 输入:Interview_Record.transcript_url + JD spec + rule-check 历史
→ LLM 输出:综合评估报告 + 评分 + 风险

**(2) AO → Allmeta API: 写 Evaluation_Report 实例**

```http
POST /api/v1/ontology/instances/Evaluation_Report?domain=RAAS-v1 HTTP/1.1

{
  "domainId": "RAAS-v1",
  "report_id": "EVAL_<application_id>",
  "application_id": "APP_...",
  "candidate_id": "...",
  "interview_id": "INT_...",
  "capability_scores_json": "{...}",   // 各维度评分
  "overall_score": 82.5,
  "recommendations_json": "[...]",
  "risks_json": "[...]",
  "generated_by": "evaluationAgent",
  "llm_model": "google/gemini-3-flash-preview",
  "generated_at": "..."
}
```

**(3) AO → Allmeta API: 建 Application -[:HAS_EVALUATION]-> Evaluation_Report 关系**

```http
POST /api/v1/ontology/links HTTP/1.1
{ "domainId": "RAAS-v1", "type": "HAS_EVALUATION", "fromId": "APP_...", "toId": "EVAL_..." }
```

**HITL 分支**:`EVALUATION_FAILED` 走 `POST /api/v1/events/ingest`,partner HITL consumer 建 `evaluation_recheck` 任务(已在 ingest §5 mapping)→ HSM 复核。

---

## 阶段 7 ─ 推荐包生成 + 提交(EVALUATION_PASSED → APPLICATION_SUBMITTED)

```
        EVALUATION_PASSED  或  MATCH_PASSED_NO_INTERVIEW
                              │
                              ▼ Shared Inngest
                  ┌─────────────────────────────────┐
                  │ AO packageAgent(待建)           │
                  │ 或 partner package worker        │
                  └────────────────┬────────────────┘
                                   ▼
                  生成推荐包(优化简历版 + 评估报告摘要 + 卖点提炼)
                                   │
                  ★ 写实例(经 Allmeta API):
                  POST /instances/Recommendation_Material
                    body: { recommendation_material_id, application_id,
                            candidate_id, optimized_resume_text,
                            evaluation_summary, selling_points[],
                            risk_disclosures[], generated_at }
                                   │
                  ┌────────────────┴────────────────┐
                  ▼ 数据齐全                        ▼ 缺料(项目细节 / 薪资期望)
            emit PACKAGE_GENERATED ★HITL    emit PACKAGE_MISSING_INFO ★HITL
            (payload:                       (payload: recommendation_material_id,
             recommendation_material_id,                ai_summary 描述缺什么)
             candidate_name,                       │
             ai_summary)                           ▼ partner HITL consumer
                  │                          创建 package_supplement 任务
                  ▼ partner HITL consumer    → recruiter 工作台补料
            创建 package_review 任务                │
            → HSM 工作台                            ▼ recruiter 补完
                  │                          partner 重发 PACKAGE_GENERATED
            HSM 审核 →                              (走主线 ↓)
            ├─ 通过 ──► emit PACKAGE_APPROVED
            └─ 退回 ──► 走 package_supplement 再来

                              │
                              ▼ PACKAGE_APPROVED
                              │
                              ▼ Shared Inngest
                  ┌─────────────────────────────────┐
                  │ partner client-submission worker│
                  │ 或 AO submitterAgent             │
                  └────────────────┬────────────────┘
                                   ▼
                  调客户 RMS API 提交推荐包
                                   │
                  ┌────────────────┴───────────────┐
                  ▼ 提交成功                       ▼ 失败
            emit APPLICATION_SUBMITTED       emit SUBMISSION_FAILED ★HITL
                  │                          (payload: application_id, failure_reason)
                  ▼                                  │
            ★ 经 Allmeta API:                      ▼ partner HITL consumer
            PATCH /instances/Application/      创建 client_submission_fallback
                  {application_id}              任务 (P0) → recruiter 工作台
                  body: { status: "submitted_   → recruiter 手工提交
                          to_client",                │
                          submitted_at }             ▼ 成功后 partner emit
                  │                            APPLICATION_SUBMITTED 主线
                  ▼
            🎉 终态 — 等客户面试 / Offer
```

### 阶段 7 实际 API 调用细节

**(1) AO packageAgent(待建)生成推荐包**(可调 LLM 优化简历文案)

**(2) AO → Allmeta API: 写 Recommendation_Material 实例**

```http
POST /api/v1/ontology/instances/Recommendation_Material?domain=RAAS-v1 HTTP/1.1

{
  "domainId": "RAAS-v1",
  "recommendation_material_id": "REC_<application_id>",
  "application_id": "APP_...",
  "candidate_id": "...",
  "optimized_resume_text": "<LLM 优化的简历文本>",
  "evaluation_summary": "<从 Evaluation_Report 提炼>",
  "selling_points_json": "[...]",
  "risk_disclosures_json": "[...]",
  "generated_at": "...",
  "status": "pending_review"
}
```

**(3) AO → Allmeta API: 建 Application -[:HAS_PACKAGE]-> Recommendation_Material 关系**

```http
POST /api/v1/ontology/links HTTP/1.1
{ "domainId": "RAAS-v1", "type": "HAS_PACKAGE", "fromId": "APP_...", "toId": "REC_..." }
```

**(4) HITL: emit PACKAGE_GENERATED 到 partner**(走 `POST /api/v1/events/ingest`)

partner HITL consumer 建 `package_review` 任务 → HSM 审核(已在 ingest §5 mapping)。

**(5) PACKAGE_APPROVED 后:partner / AO → 客户 RMS API: 提交推荐包**

partner-side 实现,具体客户 API 不在本文范围。

**(6) AO → Allmeta API: 更新 Application 状态**

```http
PATCH /api/v1/ontology/instances/Application/{application_id}?domain=RAAS-v1
{
  "domainId": "RAAS-v1",
  "status": "submitted_to_client",
  "submitted_at": "...",
  "client_rms_application_id": "..."   // 客户系统返回的 ID
}
```

**HITL 分支**:
- `PACKAGE_MISSING_INFO` → partner 建 `package_supplement` 任务,recruiter 补料
- `SUBMISSION_FAILED` → partner 建 `client_submission_fallback` 任务,recruiter 手提

---

## 阶段 8 ─ 客户侧面试 + Offer(简化,出本文核心范围)

```
APPLICATION_SUBMITTED → 客户 RMS 通知 HSM 安排客户面试
                     → 候选人客户面试通过
                     → partner emit OFFER_GENERATED (本文未细化的事件)
                     → 写 Job_Offer 实例 经 Allmeta API
                     → 候选人签 offer / 拒 offer
                     → 写 Assignment 实例(外包派驻)
```

---

## 总事件清单(按阶段)

| 阶段 | 事件 | 方向 | HITL? | 写哪个 Allmeta 实例 |
|---|---|---|---|---|
| 1 | `REQUIREMENT_LOGGED` | RAAS → AO | ❌ | (createJdAgent 触发)|
| 1 | `REQUIREMENT_SYNCED` | 同上 | ❌ | 同上 |
| 1 | `ANALYSIS_COMPLETED` | AO → 下游 | ❌ | Job_Requisition (refresh)|
| 1 | `ANALYSIS_BLOCKED` | AO → partner | ★ ops 告警 | — |
| 1 | `CLARIFICATION_INCOMPLETE` | AO → partner | ★ HSM 澄清 | — |
| 1 | `CLARIFICATION_READY` | RAAS → AO | ❌ | — |
| 1 | `CLARIFICATION_RETRY` | RAAS → AO | ❌ | Job_Requisition (refresh) |
| 2 | `JD_GENERATED` | AO → partner | ★ HSM 审核 | Job_Posting |
| 2 | `JD_APPROVED` | RAAS → 下游 | ❌ | Job_Posting (PATCH status) |
| 2 | `JD_REJECTED` | RAAS → AO | ❌ | — |
| 3 | `CHANNEL_PUBLISHED` | partner → AO | ❌ | Job_Posting (PATCH) |
| 3 | `CHANNEL_PUBLISHED_MANUAL` | RAAS → AO | ❌ | Job_Posting (PATCH) |
| 3 | `CHANNEL_PUBLISHED_FAILED` | partner → partner | ★ recruiter 手发 | — |
| 4 | `RESUME_DOWNLOADED` | RAAS → AO | ❌ | (resumeParserAgent 触发)|
| 4 | `RESUME_PROCESSED` | AO → AO matcher | ❌ | Candidate + Resume |
| 4 | `RESUME_PARSE_ERROR` | AO → partner | ★ recruiter 修正 | — |
| 4 | `RESUME_LOCKED_CONFLICT` | AO → partner | ★ recruiter 调解 | — |
| 5 | `RESUME_INFO_MISSING` | AO → partner | ★ recruiter 补全 | — |
| 5 | `MATCH_FAILED` | AO → partner | (partner 关任务)| Candidate_Match_Result (FAIL,可选) |
| 5 | `MATCH_PASSED_NEED_INTERVIEW` | AO → partner | ❌ | Candidate_Match_Result (PASS) + Application |
| 5 | `MATCH_PASSED_NO_INTERVIEW` | AO → partner | ❌ | 同上 |
| 5 | `APPLICATION_SUBMITTED` | partner / AO | ❌ | Application (PATCH) |
| 6 | `INTERVIEW_INVITATION_SENT` | partner → AO | ❌ | Interview_Record |
| 6 | `AI_INTERVIEW_COMPLETED` | partner → AO | ❌ | Interview_Record (PATCH 加 transcript / score)|
| 6.5 | `EVALUATION_PASSED` | AO → 下游 | ❌ | Evaluation_Report |
| 6.5 | `EVALUATION_FAILED` | AO → partner | ★ HSM 复核 | Evaluation_Report |
| 7 | `PACKAGE_GENERATED` | AO → partner | ★ HSM 审核 | Recommendation_Material |
| 7 | `PACKAGE_MISSING_INFO` | AO → partner | ★ recruiter 补料 | — |
| 7 | `PACKAGE_APPROVED` | RAAS → 下游 | ❌ | Recommendation_Material (PATCH) |
| 7 | `SUBMISSION_FAILED` | partner → partner | ★ recruiter 手提 | — |

★ = 触发 partner HITL 任务(共 12 个 — partner 工作台主要任务源)。

---

## 当前 AO 实施状态

| 阶段 | AO agent | 已调用 RAAS API | 已调用 Allmeta API | 缺什么 |
|---|---|---|---|---|
| 1+2 | `createJdAgent` ✅ | GET /requirements/:id · POST /generate-jd · POST /jd/sync-generated | ❌ 写 JR/JP 走 Bolt 直连 | 改 [lib/jd-sync/neo4j-jd-writer.ts](../lib/jd-sync/neo4j-jd-writer.ts) → 调 Allmeta POST /instances |
| 3 | partner-only | — | — | partner 决定 |
| 4 | `resumeParserAgent` ✅ | GET /resumes/uploads/:id/raw · POST /parse-resume · POST /candidates | ❌ 没写实例(目前没 writer) | **新建** resumeParserAgent 末尾调 Allmeta POST /instances/Candidate + Resume + Candidate_Expectation |
| 5 | `matchResumeAgent` ✅ | GET /requirements/agent-view · POST /match-resume · POST /match-results | ✅ 读规则 GET /actions/matchResume/rules(Path 2) · ❌ 写 Match_Result 走 Bolt | 改 [neo4j-instance-writer.ts](../lib/rule-check/neo4j-instance-writer.ts) + [neo4j-match-result-writer.ts](../lib/rule-check/neo4j-match-result-writer.ts) → 调 Allmeta(用 `actions/matchResume/results` 特化端点写 Match_Result)|
| 6 | ❌ 不存在 | (partner 应调 POST /invite-interview,**当前 501**) | — | partner 实现 invite + AI 面试系统;AO 不参与 |
| 6.5 | ❌ 不存在 | — | — | **待建 `evaluationAgent`**:订阅 AI_INTERVIEW_COMPLETED → 跑 evaluation LLM → 调 Allmeta POST /instances/Evaluation_Report |
| 7 | ❌ 不存在 | — | — | **待建 `packageAgent`**:订阅 EVALUATION_PASSED → 调 Allmeta POST /instances/Recommendation_Material |

### 🔥 优先级排序(AO 端改造)

| # | 任务 | 影响 | 工作量 |
|---|---|---|---|
| **P0** | 写 [lib/allmeta-client.ts](../lib/allmeta-client.ts):统一封装 Allmeta API 调用(`postInstance` / `getInstance` / `postLink` / `postMatchResult` 等)| 是后续所有重构的基础 | 2 小时 |
| P1 | 重构 [lib/rule-check/neo4j-instance-writer.ts](../lib/rule-check/neo4j-instance-writer.ts):Bolt → Allmeta | 阶段 5 实体锚改用 Allmeta | 2 小时 |
| P1 | 重构 [lib/rule-check/neo4j-match-result-writer.ts](../lib/rule-check/neo4j-match-result-writer.ts):Bolt → Allmeta `actions/matchResume/results` | 阶段 5 Match_Result | 1 小时 |
| P1 | 重构 [lib/jd-sync/neo4j-jd-writer.ts](../lib/jd-sync/neo4j-jd-writer.ts):Bolt → Allmeta | 阶段 1+2 JR/JP | 2 小时 |
| P2 | resumeParserAgent 末尾加 Allmeta 写 Candidate / Resume / Candidate_Expectation | 阶段 4(目前 AO 完全不写这 3 类节点) | 2 小时 |
| P3 | 新建 evaluationAgent | 阶段 6.5(本来就缺,partner 也没人写) | 4 小时 |
| P3 | 新建 packageAgent | 阶段 7(同上) | 4 小时 |

**总共 ~17 小时**(约 2-3 个工作日),分阶段交付。

### Allmeta 端的前置依赖

- ✅ DataObject `domainId="RAAS-v1"` 已批量设好(44 条)
- ⚠️ **strict 校验问题**:经测 POST /instances 报 `Unknown fields name/gender` — 跟陈洋对齐字段声明,或临时改 Allmeta 默认走 permissive 模式
- ⚠️ partner ingest 端的 HITL mapping 缺 `RESUME_INFO_MISSING → resume_info_repair`(partner 端补一行)

---

## 共享 Neo4j 实例图(经 Allmeta API 写出来的)

```
(Client)
   │
   └─ owns ─► (Job_Requisition) ─ has ─► (Job_Posting) ─ via ─► (Sourcing_Channel)
                  │
                  │ evaluated for
                  ▼
              (Candidate) ─ has ─► (Resume) ─ has expectation ─► (Candidate_Expectation)
                  │
                  ├─ has_match_result ─► (Candidate_Match_Result)
                  │
                  ├─ has_application ─► (Application)
                  │                         │
                  │                         ├─ has_interview ─► (Interview_Record)
                  │                         ├─ has_evaluation ─► (Evaluation_Report)
                  │                         └─ has_package ─► (Recommendation_Material)
                  │
                  └─ has_offer ─► (Job_Offer) ─ leads to ─► (Assignment)
```

partner dashboard 通过查 Neo4j 这张图,呈现 HSM / recruiter 工作台。AO 经 Allmeta API 写,partner 经 Allmeta API 读。**Neo4j 是三方共享的事实层**。

---

## 关键收敛点(出错时回到哪里)

| 失败 | 回到哪 | 怎么回去 |
|---|---|---|
| 需求信息缺 | 阶段 1 createJdAgent | HSM 澄清 → CLARIFICATION_RETRY → 重新分析 |
| JD 被拒 | 阶段 2 createJdAgent | JD_REJECTED 自动触发重跑(已订阅)|
| 渠道发布失败 | 阶段 3 recruiter | HITL 任务,recruiter 手发 |
| 简历解析失败 | 阶段 4 recruiter | HITL 任务,改简历重传 |
| 简历缺字段 | 阶段 4 recruiter | RESUME_INFO_MISSING → 补全 → 重发 RESUME_PROCESSED → 阶段 5 重跑 |
| rule-check 硬失败 | 流程终止 | MATCH_FAILED → partner 关任务 |
| Robohire 评分太低 | 流程终止 | MATCH_FAILED → partner 关任务 |
| AI 评估不达标 | 阶段 6.5 HSM | HITL 任务,HSM 强推 or 终止 |
| 推荐包缺料 | 阶段 7 recruiter | HITL 任务,补料后重跑 |
| 客户提交失败 | 阶段 7 recruiter | HITL 任务,recruiter 手提 |

---

## 文档关系

| 文档 | 作用 |
|---|---|
| **本文** [docs/full-event-chain-end-to-end.md](full-event-chain-end-to-end.md) | **全链路端到端流程图**(本文) |
| [docs/architecture-corrected-event-chain.md](architecture-corrected-event-chain.md) | 三层架构 + AO 写实例必走 Allmeta API 的原则 |
| [docs/raas-partner-integration-spec-for-claude-code.md](raas-partner-integration-spec-for-claude-code.md) | partner 端实施手册(给 partner Claude Code)|
| [docs/resume-info-repair-flow.md](resume-info-repair-flow.md) | 阶段 5 的子流程:RESUME_INFO_MISSING 闭环 |
| [docs/ontology-schema-changes-for-chenyang.md](ontology-schema-changes-for-chenyang.md) | 给陈洋的 ontology DataObject 补字段建议 |
| Allmeta API doc | `~/allmetaOntology/docs/ONTOLOGY-API-USER-GUIDE-BASED-ON-NEO4J.md` |
