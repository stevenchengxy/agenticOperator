# REQUIREMENT_LOGGED E2E Trace — 2026-05-12

第一次跑通真实 partner RAAS + AO createJdAgent 全链路的完整 trace,记录:
1. **入参** — RAAS 触发的 `REQUIREMENT_LOGGED` 事件原始 payload
2. **逐 step 输入/输出** — fetch / generate / sync / neo4j / emit
3. **出参** — `JD_GENERATED` 事件、Neo4j 节点、RAAS Postgres 状态
4. **环境配置** — env / 服务版本

—— 用于复盘 + 给 partner 同步真实数据形状 + 后续 e2e 测试基准。

---

## 0. TL;DR

```
trace_id:                  cd2c0c75-af72-45b1-a26a-8eacf2df532b
job_requisition_id:        JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R2026040142
business:                  腾讯 / WXG 微信事业群 / 文秘行政专员 / 深圳 / 12k-15k
trigger:                   REQUIREMENT_LOGGED  (source_channel=dashboard_manual)
inngest event id:          01KRDGSVMFDRG9H4JW4SEJ2YQV
function run id:           01KRDGSVWC4CA5RVQKM75ND995
status:                    COMPLETED
duration:                  37s (07:18:13 → 07:18:50 UTC)
generated jd_id:           jd_f3b17e21_mp2aupnw
generated job_posting_id:  fb378612-31cb-43ca-a993-00001be7b2c5
landed in:
  - partner RAAS Postgres   ✓  status=pending_publish
  - local Neo4j (Bolt 7688) ✓  :Job_Requisition + :Job_Posting + HAS_POSTING
emitted downstream:        JD_GENERATED (id 01KRDGTZZP6811ZJXF7YJRYXG6)
```

---

## 1. 环境配置(本次 run 用的)

| 项 | 值 |
|---|---|
| AO 进程 | `next-server v16.2.4` on `:3002` (PID 49749) |
| Inngest server | `inngest/inngest:v1.19.2` (host bridged `localhost:8288`) |
| AO Inngest SDK | `4.3.0` |
| LLM gateway | `http://10.100.0.70:3010/v1` · `google/gemini-3-flash-preview` |
| Partner RAAS API | `http://192.168.1.105:3001` · Bearer `internal-agentic-agent` |
| 本地 Neo4j | `bolt://localhost:7688` · DB `neo4j` · pw `testpassword123` · 容器 `e2e-test-neo4j` |
| Partner Neo4j | `neo4j://10.100.0.70:7687` (本次走的本地不走 partner) |
| MinIO | `10.100.0.70:9000` |
| Rule check | `RULE_CHECK_ENABLED=true`(本 run 是 createJD,跟 rule-check 不交叉) |

`.env.local` 关键覆盖:
```bash
NEO4J_INSTANCE_URI=bolt://localhost:7688
NEO4J_INSTANCE_USER=neo4j
NEO4J_INSTANCE_PASSWORD=testpassword123
RAAS_INTERNAL_API_URL=http://192.168.1.105:3001
RAAS_AGENT_API_KEY=internal-agentic-agent
RULE_CHECK_ENABLED=true
```

---

## 2. 入参 — REQUIREMENT_LOGGED 事件原 payload

`source_channel: dashboard_manual` —— 由 RAAS 前端"录入需求"页面触发,转发到 AO 这边的 Inngest。

```json
{
  "name": "REQUIREMENT_LOGGED",
  "data": {
    "entity_id": "JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R2026040142",
    "entity_type": "Job_Requisition",
    "event_id": "f47bf7cf-7a86-4cda-897d-16d9608607a1",
    "payload": {
      "client_id": "f592f8ce-6ceb-4b73-9b64-e61a87f3399f",
      "hro_service_contract_id": "4cff3ed8-5e04-4c73-8898-8d708c357361",
      "is_urgent": false,
      "job_requisition_id": "JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R2026040142",
      "job_requisition_specification_id": "2a973a2c-9f96-42be-8774-b6fb64fe6efb",
      "raw_input_data": {
        "city": "深圳",
        "city_id": "96a36f68-ebfe-47b9-bbb6-40ae3db58d7c",
        "client_department_id": "654aa45b-8a95-478c-ad42-0a2710d3154b",
        "client_id": "f592f8ce-6ceb-4b73-9b64-e61a87f3399f",
        "client_job_id": "R2026040142",
        "client_job_title": "文秘行政专员",
        "client_job_type": "产品/内容类运营",
        "client_published_at": "2026-05-12T00:00:00.000Z",
        "create_by": "0000199059",
        "csi_department_id": "4350c85c-d661-4040-874f-c5f1014c6eac",
        "deadline": "2026-05-30",
        "expected_level": "高级1等",
        "final_interview_format": "现场面试",
        "final_interviewer_name": "bbb",
        "first_interview_format": "现场面试",
        "first_interviewer_name": "aaa",
        "headcount": 1,
        "hro_service_contract_id": "4cff3ed8-5e04-4c73-8898-8d708c357361",
        "hsm_employee_id": "0000199059",
        "is_exclusive": false,
        "job_requirement": "1、本科及以上学历...(完整文本见原 payload,共 ~ 700 字)",
        "job_requisition_id": "JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R2026040142",
        "job_responsibility": "1、负责外部对接相关工作...(完整文本见原 payload)",
        "job_type": "产品/内容类运营",
        "number_of_competitors": null,
        "priority": "中",
        "recruitment_type": "社会全职",
        "require_foreigner": false,
        "required_arrival_time": "2026-05-11",
        "salary_range": "12k-15k",
        "sd_org_name": "腾讯综合事业部",
        "sd_owner_id": "0000199059",
        "standard_job_role_id": "std-d2bbaf4a2a248760",
        "start_date": "2026-05-12",
        "work_address": ["其他大厦"]
      },
      "source_channel": "dashboard_manual"
    },
    "source_action": null,
    "trace": {
      "city": "深圳",
      "client_job_title": "文秘行政专员",
      "event_id": "f47bf7cf-7a86-4cda-897d-16d9608607a1",
      "headcount": 1,
      "parent_trace_id": null,
      "scope_type": "user_action",
      "status": "success",
      "trace_id": "cd2c0c75-af72-45b1-a26a-8eacf2df532b",
      "workflow_id": null
    }
  }
}
```

完整原 payload(含 `job_requirement` 和 `job_responsibility` 全文):见仓库历史的 `01KRDCZ6VG3HKA6CV4PX69SX19` 事件,或 [docs/requirement-logged-raw-payload.json](./requirement-logged-raw-payload.json)(下方另存)。

---

## 3. 运行时间线(Inngest run history)

```
07:18:13.132Z  FunctionScheduled    createJdAgent 入队
07:18:13       FunctionStarted
07:18:13       StepStarted          step=step (fetch-requirement)
07:18:49       StepCompleted        ─ 36s 后这段才结束
07:18:49       StepScheduled        sync-jd-JRQ-f592f8ce-...
07:18:49       StepStarted
07:18:49       StepCompleted        ─ sync-jd 完成
07:18:49       StepScheduled        neo4j-jd-JRQ-f592f8ce-...
07:18:49       StepStarted
07:18:50       StepCompleted        ─ Neo4j 写入完成
07:18:50       FunctionCompleted    总耗时 ~37s
```

> Inngest 把 `fetch-requirement` + `generate-jd` 两步合并显示为一个 step("step")— 这是 v1.19.2 dashboard 的展示,实际跑了两个 RAAS API 调用,详见 step 输入/输出。

---

## 4. 逐 Step 输入/输出

### Step 1 — `fetch-requirement-<jrid>`

**做什么**:从 RAAS API 拉单条 JR 的完整详情。

**调用**:
```http
GET http://192.168.1.105:3001/api/v1/requirements/JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R2026040142
Authorization: Bearer internal-agentic-agent
```

**响应**(`RaasRequirement` 详情 + `RaasRequirementSpecification` + siblings):

```json
{
  "requirement": {
    "job_requisition_id": "JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R2026040142",
    "client_id": "f592f8ce-6ceb-4b73-9b64-e61a87f3399f",
    "client_name": "腾讯",
    "client_department_id": "654aa45b-8a95-478c-ad42-0a2710d3154b",
    "first_level_department": "WXG 微信事业群",
    "second_level_department": null,
    "client_job_id": "R2026040142",
    "client_job_title": "文秘行政专员",
    "requirement_name": "文秘行政专员",
    "work_city": "深圳",
    "salary_range": "12k-15k",
    "headcount": 1,
    "expected_level": "高级1等",
    "recruitment_type": "社会全职",
    "must_have_skills": [],
    "nice_to_have_skills": [],
    // 共 50 个字段
  },
  "specification": {
    "job_requisition_specification_id": "2a973a2c-9f96-42be-8774-b6fb64fe6efb",
    "status": "pending_publish",
    "priority": "中",
    "is_exclusive": false,
    "hsm_employee_id": "0000199059",
    "deadline": "2026-05-30T00:00:00.000Z",
    "start_date": "2026-05-12T00:00:00.000Z"
    // 共 20 个字段
  },
  "siblings": [],
  "latest_task": null
}
```

### Step 2 — `generate-<jrid>`

**做什么**:把 JR 详情拼成 prompt 喂给 RAAS `/generate-jd`(RAAS 内部走 Robohire LLM)。

**调用**:
```http
POST http://192.168.1.105:3001/api/v1/generate-jd
Authorization: Bearer internal-agentic-agent
Content-Type: application/json

{
  "prompt": "<从 requirement 拼的 1-2KB markdown 描述,含职位、地点、薪资、职责、要求等>",
  "language": "zh",
  "companyName": "腾讯综合事业部",
  "department": "654aa45b-8a95-478c-ad42-0a2710d3154b"
}
```

**响应**:Robohire 返回的完整 JD,50 字段。关键字段:

```
title:                    文秘行政专员
description (~ 400 字):   作为腾讯核心业务部门的文秘行政专员,你将负责部门内外部综合事务的统筹与落地...
qualifications (~ 500 字): ## 教育背景 - 本科及以上学历...
hardRequirements (~ 300 字): 1. 本科及以上学历,具备 2 年及以上相关工作经验...
niceToHave (~ 200 字):    - 有政府部门、事业单位或大型企业派驻经验者优先...
benefits (~ 200 字):       - 薪资待遇:月薪 12k-15k,提供竞争力的年终奖金...
evaluationRules (~ 600 字): ### 评价维度与权重 - 语言表达与公文写作 (35%)...
interviewRequirements (~ 500 字): - 公文实操考察:现场或远程给定主题...
salaryMin/Max/Currency:   12000 / 15000 / CNY
salaryText:               12k-15k
location:                 前海科兴科学园
experienceLevel:          senior
employmentType:           full-time
workType:                 onsite
```

完整 JD 文本见 [docs/sample-generated-jd.md](./sample-generated-jd.md)。

### Step 3 — `sync-jd-<jrid>`

**做什么**:把生成的 JD 持久化到 RAAS Postgres(写 `JobPosting` 表 + 回填 `JobRequisition` + 推进 spec.status → `pending_publish`)。

**调用**:
```http
POST http://192.168.1.105:3001/api/v1/jd/sync-generated
Authorization: Bearer internal-agentic-agent
Content-Type: application/json

{
  "job_requisition_id": "JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R2026040142",
  "client_id": "f592f8ce-6ceb-4b73-9b64-e61a87f3399f",
  // Robohire camelCase 数据 spread(title/description/qualifications/.../50 字段)
  ...generated_data,
  // 增强字段(JR 详情里的,RAAS 端持久化需要)
  "must_have_skills": [],
  "nice_to_have_skills": [],
  "expected_level": "高级1等",
  "work_years": 0,
  "interview_mode": null,
  "recruitment_type": "社会全职",
  "city": ["前海科兴科学园"]
}
```

**响应**:
```json
{
  "synced": true,
  "job_posting_id": "fb378612-31cb-43ca-a993-00001be7b2c5",
  "requestId": "<raas request id>",
  "traceId": "cd2c0c75-af72-45b1-a26a-8eacf2df532b"
}
```

### Step 4(新增)— `neo4j-jd-<jrid>`

**做什么**:Best-effort 写本地 Neo4j(`:Job_Requisition` + `:Job_Posting` + `HAS_POSTING`)。失败不阻断主流程。

**写入 Cypher**:
```cypher
MERGE (jr:Job_Requisition {job_requisition_id: $jrid})
SET jr += $jrProps, jr.last_seen_at = datetime($now)

MERGE (jp:Job_Posting {job_posting_id: $pid})
SET jp += $postingProps, jp.last_seen_at = datetime($now)

MERGE (jr)-[r:HAS_POSTING]->(jp)
SET r.last_seen_at = datetime($now), r.jd_id = $jdId
```

**输入 context**:
```ts
{
  job_requisition_id: 'JRQ-...-R2026040142',
  job_posting_id: 'fb378612-31cb-43ca-a993-00001be7b2c5',
  jd_id: 'jd_f3b17e21_mp2aupnw',
  client_id: 'f592f8ce-6ceb-4b73-9b64-e61a87f3399f',
  trace_id: 'cd2c0c75-af72-45b1-a26a-8eacf2df532b',
  requirement: { /* RAAS requirement 详情,50 字段 */ },
  specification: { /* RAAS specification,20 字段 */ },
  generated: { /* Robohire 生成的 JD,50 字段 */ },
  generator_model: 'raas-api/generate-jd',
  generator_version: 'workflow-a@2026-05-08',
}
```

**输出**:
```ts
{ wrote: true, jr_id: 'JRQ-...-R2026040142', posting_id: 'fb378612-...' }
```

### Step 5 — emit `JD_GENERATED`

**做什么**:发下游事件,触发后续 workflow(JD 审核 / 分发等)。

**Event id**: `01KRDGTZZP6811ZJXF7YJRYXG6` · received `2026-05-12T07:18:50.200Z`

**Payload**(50 字段):
- 上半段 = Robohire 生成的 camelCase 字段原样 spread
- 下半段 = partner-canonical snake_case 字段(JR 增强)
- bookkeeping: `jd_id`, `claimer_employee_id`, `hsm_employee_id`, `client_job_id`
- 诊断字段: `search_keywords`, `quality_score`, `quality_suggestions`, `market_competitiveness`
- 生成元数据: `generator_version`, `generator_model`, `generated_at`

---

## 5. 出参 — 本地 Neo4j 最终落地数据

### `:Job_Requisition` 节点(MERGE 主键 `job_requisition_id`,25 属性)

```json
{
  "job_requisition_id": "JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R2026040142",
  "job_requisition_specification_id": "2a973a2c-9f96-42be-8774-b6fb64fe6efb",
  "client_id": "f592f8ce-6ceb-4b73-9b64-e61a87f3399f",
  "client_name": "腾讯",
  "client_department_id": "654aa45b-8a95-478c-ad42-0a2710d3154b",
  "first_level_department": "WXG 微信事业群",
  "client_job_id": "R2026040142",
  "client_job_title": "文秘行政专员",
  "requirement_name": "文秘行政专员",
  "work_city": "深圳",
  "salary_range": "12k-15k",
  "headcount": 1.0,
  "expected_level": "高级1等",
  "recruitment_type": "社会全职",
  "is_exclusive": false,
  "must_have_skills": [],
  "nice_to_have_skills": [],
  "status": "pending_publish",
  "priority": "中",
  "hsm_employee_id": "0000199059",
  "deadline": "2026-05-30T00:00:00.000Z",
  "start_date": "2026-05-12T00:00:00.000Z",
  "trace_id": "cd2c0c75-af72-45b1-a26a-8eacf2df532b",
  "first_seen_at": "2026-05-12T07:18:49.965Z",
  "last_seen_at": "2026-05-12T07:18:49.965Z"
}
```

### `:Job_Posting` 节点(MERGE 主键 `job_posting_id`)

```json
{
  "job_posting_id": "fb378612-31cb-43ca-a993-00001be7b2c5",
  "jd_id": "jd_f3b17e21_mp2aupnw",
  "job_requisition_id": "JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R2026040142",
  "title": "文秘行政专员",
  "description": "<8K 截断,完整描述>",
  "qualifications": "<...>",
  "hard_requirements": "<...>",
  "nice_to_have": "<...>",
  "benefits": "<...>",
  "evaluation_rules": "<...>",
  "interview_requirements": "<...>",
  "salary_text": "12k-15k",
  "salary_min": 12000,
  "salary_max": 15000,
  "salary_currency": "CNY",
  "salary_period": "monthly",
  "location": "前海科兴科学园",
  "employment_type": "full-time",
  "work_type": "onsite",
  "experience_level": "senior",
  "education": "bachelor",
  "generator_model": "raas-api/generate-jd",
  "generator_version": "workflow-a@2026-05-08",
  "generated_at": "2026-05-12T07:18:49.965Z",
  "trace_id": "cd2c0c75-af72-45b1-a26a-8eacf2df532b"
}
```

### 关系 `(:Job_Requisition)-[:HAS_POSTING]->(:Job_Posting)`

```json
{ "jd_id": "jd_f3b17e21_mp2aupnw", "last_seen_at": "2026-05-12T07:18:49.965Z" }
```

---

## 6. RAAS Postgres 最终状态(partner 端)

通过 `GET /api/v1/requirements/:id` 验证(注意是真实 partner 数据,跨 LAN):

```
job_requisition_id:        JRQ-...-R2026040142
status:                    pending_publish      ← 之前是 logged,sync-generated 推到 pending_publish
client_name:               腾讯
first_level_department:    WXG 微信事业群
client_job_title:          文秘行政专员
latest_task:               null
requirement keys:          50
specification keys:        20
```

**partner 同步执行**(我们这边 sync-generated 之后,partner 内部):
- 写 `JobPosting` 表新行(job_posting_id=`fb378612-...`)
- 回填 `JobRequisition` 的 `posting_*` 字段
- 推进 `JobRequisitionSpecification.status` 从 `logged` → `pending_publish`

---

## 7. 验证 Cypher(本地 Neo4j Browser `localhost:7475`)

```cypher
// 看 JR + 关联 Posting 的图
MATCH (jr:Job_Requisition)-[r:HAS_POSTING]->(jp:Job_Posting)
WHERE jr.job_requisition_id = 'JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R2026040142'
RETURN jr, r, jp

// 看 JR 完整属性
MATCH (jr:Job_Requisition {job_requisition_id: 'JRQ-f592f8ce-6ceb-4b73-9b64-e61a87f3399f-R2026040142'})
RETURN properties(jr)

// 按 trace_id 把这次 run 写的所有节点串起来(后续 RuleCheck 跑通后也会挂同 trace)
MATCH (n)
WHERE n.trace_id = 'cd2c0c75-af72-45b1-a26a-8eacf2df532b'
RETURN labels(n) AS labels, n.job_requisition_id, n.jd_id, n.first_seen_at
```

---

## 8. 关键发现(用于后续 e2e 测试 / partner 同步)

### A. RAAS agent-view 真实字段 shape

不是用 ID 字符串(`CLI_TENCENT_IEG_TIANMEI` 这种),而是:
- `client_name` = `"腾讯"`(中文,直接可用)
- `first_level_department` = `"WXG 微信事业群"`(BG 在文本前缀)
- `client_id` / `client_department_id` = UUID

→ `lib/rule-check/ontology.ts:extractDims` 已经按这个 shape 重写,从 `client_name` + `first_level_department` 抠 dims。

### B. createJdAgent 链路总耗时 37s

主要耗在 `generate-jd`(Robohire LLM 调用,~30s+)。其他 step 都是 < 1s。

### C. 触发 source

`source_channel = "dashboard_manual"` — 这条 JR 是从 RAAS 前端"录入需求"页面手动创建的,不是 webhook / 集成。后续真实流量大概率也是这条。

### D. RAAS Postgres `status` 的状态机

`logged`(REQUIREMENT_LOGGED 时)→ AO createJD 跑完 sync-jd 后 → `pending_publish`(等审核 / 发布)。再往后的状态变化由 partner 端决定。

---

## 9. 待验证 / 后续 trace

- [ ] `RESUME_PROCESSED` 触发 matchResumeAgent → rule-check LLM 真实调用 → `:RuleCheckAudit` + `:RuleCheckFlag` 落本地 Neo4j
- [ ] `MATCH_PASSED_NEED_INTERVIEW` cascade 后续事件
- [ ] partner 端 SDK 升 ≥3.54.0 后 RAAS 10 个 function 注册进我们 Inngest

—— 每次新 trace 跑通就在本 doc 同级目录加一份 `<event>-e2e-trace.md`。
