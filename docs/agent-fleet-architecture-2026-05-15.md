# Agent Fleet 架构重设计 — 从硬编码 Pipeline 到可编排 Agent 库

**作者**: Steven · 与领导讨论后整理
**日期**: 2026-05-15
**状态**: 提案,等领导确认方向后开干

---

## 1. 背景:为什么要重新设计

### 1.1 现状

Agentic Operator 当前的"workflow agents"有 3 个:
- `createJdAgent` (workflow node 4) — JD 生成
- `resumeParserAgent` — 简历解析 + 候选人入库
- `matchResumeAgent` (workflow node 10) — 简历与岗位匹配

它们都是 Inngest function,内部用 `step.run('xxx', ...)` 串成固定的步骤序列。
**Fleet UI 上叫它们"agent",但本质上它们是 pipeline,不是 agent。**

### 1.2 领导的反馈

> "我们现在的 workflow agents 写死了,你应该写出独立的 agents。现在这 3 个 workflow agents
> 其实应该是一个个的编排 —— 用户可以选择 agent 组成一个工作流,然后运行。"

翻译:
1. **每个外部能力 = 一个独立 agent**(parse-resume 是 agent / generate-jd 是 agent / match-resume 是 agent / rule-check 是 agent / ...)
2. **工作流是编排出来的**,不是写死的代码 —— 用户选 agent 拼成 workflow,然后跑
3. **当前 3 个"workflow agent"其实是 workflow**(由多个真 agent 组合而成)

### 1.3 这个反馈对在哪

| 真 agent 应有的属性 | 我们现在的 3 个 function 实际有的 |
|---|---|
| 有一个目标(intent)| 一段固定脚本(step1 → step2 → step3) |
| 自己决定调哪个工具 | 硬编码 `step.run('fetch-requirement')` 然后 `step.run('generate')` 然后... |
| 可被其他 agent 调用 / 编排 | 只能被特定事件触发 |
| 单独可观察 / 可暂停 / 可替换 | 一整个 pipeline 是单元,中间 step 不可单独操作 |
| 模型 / 工具配置独立 | 跟 pipeline 代码耦合 |

我们当前的 `createJdAgent` 改名叫 `createJdPipeline` 更准确。Fleet UI 说它是"智能体"是名不副实的。

### 1.4 这个反馈过头在哪 (诚实说)

招聘业务核心路径几乎是确定性的:**简历来了必须先解析再匹配,顺序不能颠倒**。完全 LLM-driven 的 orchestrator(每次决策"现在该做什么"都问 LLM)既贵又危险。

所以核心问题不是"该不该有 orchestrator",而是 **"agent 颗粒度划在哪一层 + 工作流定义放在数据层还是代码层"**。

---

## 2. 概念辨析(必读) — 4 个独立的层

跟领导讨论时最容易卡住的点:**把"Inngest function"、"App Server"、"Agent"、"Workflow"当成同一件事**。它们其实是 4 个独立的概念,**多对多关系**,不是 1:1。下面把它们拆开。

### 2.1 4 个独立的概念

```
┌─ Inngest function  (运行时机制)  ←── 谁监听事件、谁执行 step.run
│                                      技术细节,Inngest SDK 注册的单位
│
├─ App Server        (部署机制)    ←── 哪个 Node 进程在跑、跑在哪个端口
│                                      运维选择,跟业务无关
│
├─ Agent             (业务概念)    ←── 一个"能力单元",做一件具体的事
│                                      解析简历、生成 JD、规则预审 …
│
└─ Workflow          (编排概念)    ←── 把多个 agent 按业务流程串起来
                                       简历入库、JD 生成、简历匹配 …
```

**核心**:这 4 个概念正交,**没有强制的 1:1 关系**。一个 App Server 能 host 多个 Inngest function、多个 agent、多个 workflow。一个 workflow 可以横跨多个 Inngest function,也可以塞在一个 function 里。

### 2.2 现状(命名混乱的根源)

```
App Server: 1 个 (AO 的 Next.js 在 3002)
                ↓ 注册了
Inngest Functions: 3 个
                ↓ 我们叫它们 "agent"(createJdAgent / resumeParserAgent / matchResumeAgent)
                ↓ 但每个内部塞了 5~10 件不同的事
step.run 块: 调 RAAS / 调 RoboHire / 写 Allmeta / emit 事件 …
```

我们**只有 Inngest function 和 App Server 这两层**,**没有真正的 Agent 和 Workflow 这两层**。命名上拿 "Inngest function = Agent" 在用,所以 Fleet UI 上写"3 个智能体"是名不副实的。

### 2.3 目标(领导想要的)

```
App Server: 1 个(或者拆几个,跟业务无关,纯运维选择)
                ↓ 注册了
Inngest Functions: ~14 个
                ↓ 1:1 实现
Agent: ~14 个独立能力单元
       (parse-resume / generate-jd / match-resume / rule-check /
        raas-save-candidate / raas-sync-jd / allmeta-write-instance / 
        emit-event / …)
                ↓ 被编排成
Workflow: 3 个(后续可加)
          - "简历入库":  parse → save-candidate → allmeta×3 → emit
          - "JD 生成":   fetch-jr → generate-jd → sync-jd → allmeta → emit
          - "简历匹配":  list-jrs → for each: rule-check → match → save → allmeta → emit
```

**几个关键点**:
- **Agent 和 Inngest function 在这个方案里是 1:1**,但**这是实现选择,不是必然**(见下表)
- **App Server 跟 Workflow 完全没关系**。一个 App Server 能 host 任意多 workflow 和 agent
- **Workflow 不是一个进程、不是一段代码** —— 是**一行数据库记录**(DSL JSON),描述"哪些 agent 按什么顺序跑";被 Workflow Runtime 解释执行

### 2.4 直接回答两个常见问题

#### Q1: "我们的 Inngest function 应该作为一个 agent 吗?"

✅ **对,但要拆**。

当前 3 个 function 太粗,每个里面塞了 5~10 件不同的事。**拆成 ~14 个细粒度 function,每个 function 严格干一件事** —— 这时候 "1 个 Inngest function = 1 个 agent" 就对得上了。

#### Q2: "或者一个 App Server 为一个 workflow?"

❌ **不对**。

App Server 是部署单元,跟业务 workflow 无关。我们一个 AO server 进程要同时 host 14 个 agent + 3 个 workflow + 1 个 Workflow Runtime。**Workflow 不是服务、不是进程,是数据**(数据库一行 JSON DSL),由 Workflow Runtime 解释执行。

### 2.5 为什么选 "Inngest function = agent"

| 选项 | Agent 用什么实现 | 优 | 劣 |
|---|---|---|---|
| **A. Agent = Inngest function** | 每个 capability 单独注册成 Inngest function,workflow 是事件链或者 step.invoke 链 | ✅ 自带 evidence / retry / pause / replay / 监控<br>✅ partner 协议不变<br>✅ Fleet UI 改造小,每个 function 自然是一张卡 | ⚠️ 事件 dispatch 多一层延迟(~10-50ms,可忽略) |
| **B. Agent = TypeScript class** | Agent 是普通对象,workflow 是 Inngest function 内部循环调它们 | ✅ 调用快 | ❌ 没有 Inngest 的可观察性<br>❌ 不能单独 pause / replay<br>❌ Fleet UI 没法跟 Inngest 直接对齐 |
| **C. Agent = 独立微服务进程** | 每个 agent 是个 HTTP service,跑在不同端口/容器 | ✅ 真正解耦,独立部署、独立扩缩 | ❌ 14 个进程运维代价大<br>❌ 现阶段过度工程<br>❌ 客户自带 agent 需求出现后再考虑 |

**推荐 A**。Inngest 已经提供了 agent 需要的所有运行时能力(事件订阅、重试、暂停、监控、replay、step.run 持久化、evidence trail)。我们借这套基础设施,**用最小工程量做出"agent 化"的体感**。

### 2.6 具体例子:Create JD 在两种状态下长什么样

**现在(混乱状态)** —— 一个 Inngest function 干 7 件事:

```typescript
// resume-parser-agent/lib/inngest/agents/create-jd-agent.ts
// (一个 Inngest function)
inngest.createFunction({ id: 'create-jd-agent', triggers: [...] }, async ({step}) => {
  await step.run('check-pause', ...)
  const detail   = await step.run('fetch-requirement', ...)  // ← 调 RAAS
  const generated = await step.run('generate-jd',      ...)  // ← 调 RoboHire
  await step.run('sync-jd',         ...)                      // ← 调 RAAS
  await step.run('write-allmeta',   ...)                      // ← 调 Allmeta
  await step.run('emit-event',      ...)                      // ← emit
})
```

→ Fleet UI 上是 **1 张卡**(叫"Create JD Agent"),里面塞了 5 种异构能力,没法单独暂停 / 替换 / 监控某一种。

**目标(分层后)** —— 5 个独立 agent + 1 行数据库:

```typescript
// 5 个独立 agent function(每个就一件事,~30-50 行)
inngest.createFunction({ id: 'agent.raas-fetch-requirement',  ... })
inngest.createFunction({ id: 'agent.generate-jd',             ... })
inngest.createFunction({ id: 'agent.raas-sync-jd',            ... })
inngest.createFunction({ id: 'agent.allmeta-write-instance',  ... })
inngest.createFunction({ id: 'agent.emit-event',              ... })

// Workflow 是一行数据库记录,不是代码 !
// WorkflowDefinition table:
{
  id: "create-jd",
  trigger: "REQUIREMENT_LOGGED",
  steps: [
    { id: 1, agent: "raas-fetch-requirement",  inputs: { jr_id: "$event.entity_id" } },
    { id: 2, agent: "generate-jd",             inputs: { prompt: "$mapper.buildPrompt($ref.1)" },          needs: [1] },
    { id: 3, agent: "raas-sync-jd",            inputs: { ...$ref.2.data },                                 needs: [2] },
    { id: 4, agent: "allmeta-write-instance",  inputs: { label: "Job_Requisition", payload: "..." },       needs: [1] },
    { id: 5, agent: "emit-event",              inputs: { name: "JD_GENERATED", data: "..." },              needs: [3, 4] }
  ]
}

// Workflow Runtime(一个新的 Inngest function)读 DB 行,按 DSL 调用 agent
inngest.createFunction({ id: 'workflow-runtime', triggers: ['*'] }, async ({event, step}) => {
  const wf = await loadWorkflowForEvent(event.name)  // 从 DB 拉
  // 按 DAG 顺序逐个调用,处理 $event / $ref / $mapper / 分支 / 循环 / 错误
  await runWorkflow(wf, event, step)
})
```

→ Fleet UI 上是 **5 张 agent 卡 + 1 个 "Create JD" workflow 卡**;
- 想换个 generate-jd 实现?改一个 agent 的代码,不动 workflow
- 想加一个"生成完先做合规检查"的步骤?改一行 DB,不发版
- 哪个 agent 慢?监控直接看到该 agent 的 P95
- partner 那边**完全无感**:还是 `REQUIREMENT_LOGGED` 进来、`JD_GENERATED` 出去

### 2.7 一句话总结

> **Agent 是业务能力单元**(我们 1:1 实现成 Inngest function)
> **Workflow 是业务流程编排**(数据库里的一行 JSON,被 Workflow Runtime 解释执行)
> **App Server 是部署进程**(跟 agent / workflow 都正交,运维选择)
> **Inngest function 是运行时机制**(agent 和 Workflow Runtime 都借用它)

不混淆这 4 层,架构讨论就不会卡。后面所有章节都基于这个分层假设。

---

## 3. 目标架构 — 三层

```
┌────────────── ① Agent 库 (capability layer) ──────────────┐
│                                                             │
│  原子能力单元。每个 agent 包一个外部调用 / 一种本地推理。     │
│  独立部署、独立暂停、独立监控、独立 evidence。              │
│                                                             │
│  ┌─────────────────────────┬───────────────────────────┐   │
│  │  RoboHire-backed (LLM)   │  RAAS-backed (DB write)  │   │
│  │  · parse-resume          │  · raas-save-candidate    │   │
│  │  · generate-jd           │  · raas-sync-jd-generated │   │
│  │  · match-resume          │  · raas-save-match-results│   │
│  │  · rule-check (本地 LLM) │  · raas-fetch-requirement │   │
│  │                          │  · raas-list-requirements │   │
│  ├─────────────────────────┼───────────────────────────┤   │
│  │  Allmeta-backed (Neo4j)  │  Infrastructure          │   │
│  │  · allmeta-write-instance│  · emit-event             │   │
│  │    (parameterized: label)│  · download-pdf           │   │
│  │  · allmeta-write-link    │  · audit-event            │   │
│  │                          │  · transform / map (?)    │   │
│  └─────────────────────────┴───────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                          ↓ 被编排
┌────────────── ② Workflow 定义 (composition layer) ─────────┐
│                                                             │
│  数据,不是代码。存数据库。版本化。可被用户改 / 新建。       │
│                                                             │
│  📋 Workflow "简历入库"                                     │
│     trigger:      RESUME_DOWNLOADED                         │
│     steps:                                                  │
│       1. parse-resume         (in: event)                   │
│       2. raas-save-candidate  (in: step1.parsed)            │
│       3. allmeta-write × 3    (in: step2.candidate_id, ...) │
│       4. emit RESUME_PROCESSED(in: step1+step2+event)       │
│                                                             │
│  📋 Workflow "JD 生成"                                      │
│     trigger:      REQUIREMENT_LOGGED                        │
│     steps:        fetch-jr → generate-jd → sync → allmeta   │
│                                                             │
│  📋 Workflow "简历匹配"  (含分支 + 循环)                    │
│     trigger:      RESUME_PROCESSED                          │
│     steps:        list-jrs → for each jr:                   │
│                     rule-check                              │
│                     branch on result:                       │
│                       PASS → match-resume → save → allmeta  │
│                       FAIL → emit MATCH_FAILED              │
└─────────────────────────────────────────────────────────────┘
                          ↓ 被执行
┌────────────── ③ Workflow Runtime (interpreter) ────────────┐
│                                                             │
│  读 Workflow DSL,翻译成 Inngest step.run 调用。            │
│  · 处理 input mapping ($event.x, $steps[0].outputs.y)       │
│  · 处理分支 / 循环                                          │
│  · 处理重试 / NonRetriableError                             │
│  · 把每个 agent 调用包成 captureStepEvidence                │
└─────────────────────────────────────────────────────────────┘
```

**核心区别在第 ②层**:工作流是**数据**(JSON / DB 行),不是代码。这才是领导说的"用户可以选 agent 组成工作流然后运行"。

---

## 4. Agent 拆分清单

下表把现有 3 个 pipeline 拆解成的具体 agent。**事件协议跟 partner 完全不变** —— partner 看到的还是 `RESUME_DOWNLOADED` 进来、`MATCH_PASSED_NEED_INTERVIEW` 出去,中间的实现是什么对它透明。

### 3.1 RoboHire-backed agents (内部跑 LLM)

| Agent ID | 做什么 | 当前在哪个 pipeline | Input | Output |
|---|---|---|---|---|
| `parse-resume` | POST RAAS `/api/v1/parse-resume`(透传 RoboHire LLM 解析 PDF)| RPA | `{pdf_buffer, filename, traceId?}` | `{parsed: {name,email,phone,summary,experience[],education[],skills,certifications,languages,...}, robohire_request_id, cached}` |
| `generate-jd` | POST RAAS `/api/v1/generate-jd`(透传 RoboHire LLM 生成 JD)| createJD | `{prompt, language, companyName?, department?, traceId?}` | `{data: {title, description, qualifications, hardRequirements, niceToHave, salaryMin, salaryMax, ... 21 字段}, requestId, meta}` |
| `match-resume` | POST RAAS `/api/v1/match-resume`(透传 RoboHire LLM 做匹配)| MRA | `{resume_text, jd_text, traceId?}` | `{data: {overallMatchScore, overallFit, mustHaveAnalysis, skillMatchScore, workHistoryStability, ... 20+ 字段}, requestId, savedAs}` |
| `rule-check` | 本地 5-block pipeline:fetch rules → filter by client → project resume → compose prompt → call LLM → reconcile missing-info | MRA | `{runtime_context, parsed_resume, job_requisition, job_requisition_specification?}` | `{decision: PASS/FAIL, llm_decision, counts, failure_reasons, rule_flags[], resume_augmentation, audit:{...}}` |

### 3.2 RAAS-backed agents (写 / 读 partner 的 PostgreSQL)

| Agent ID | 做什么 | 当前在哪个 pipeline | Input | Output |
|---|---|---|---|---|
| `raas-fetch-requirement` | GET RAAS `/api/v1/requirements/{id}` 拉单条需求详情 | createJD, MRA(路径A) | `{job_requisition_id, traceId?}` | `{requirement: {64 字段}, specification}` |
| `raas-list-requirements` | GET RAAS `/api/v1/requirements/agents/view?claimer_employee_id=...` 列出招聘人员名下所有在招 JR | MRA(路径B)| `{claimer_employee_id, traceId?}` | `{items: RequirementsAgentViewItem[]}` |
| `raas-save-candidate` | POST RAAS `/api/v1/candidates` 入库候选人 + 简历(partner 端会分配 candidate_id / resume_id)| RPA | `{upload_id, bucket, object_key, etag, parsed, ...}` | `{candidate_id, resume_id, is_new_candidate, is_new_resume, file_path}` |
| `raas-sync-jd-generated` | POST RAAS `/api/v1/jd/sync-generated` 把生成的 JD 入库 + 推进 JR status | createJD | `{job_requisition_id, client_id, ...jdData, must_have_skills, city, ...}` | `{synced, jd_id, job_posting_id}` |
| `raas-save-match-results` | POST RAAS `/api/v1/match-results` 入库匹配结果(自带去重)| MRA | `{...matchResult.data, source, candidate_id, upload_id, job_requisition_id, client_id, ...}` | `{upserted, candidate_match_result_id, source}` 或 `{skipped, reason}` |
| `raas-download-pdf` | GET RAAS `/api/v1/resumes/uploads/{id}/raw` 拉 PDF 字节 | RPA | `{upload_id, traceId?}` | `{pdf: Buffer, filename, contentType}` |

### 3.3 Allmeta-backed agents (写 Neo4j)

| Agent ID | 做什么 | 当前在哪个 pipeline | Input | Output |
|---|---|---|---|---|
| `allmeta-write-instance` | POST Allmeta `/api/v1/ontology/instances/{label}?domain=RAAS-v1` 写一个 DataObject 节点 | 三个 pipeline 都用 | `{label: 'Candidate' \| 'Resume' \| 'Job_Requisition' \| 'Candidate_Expectation' \| 'Candidate_Match_Result', payload}` | `{upserted: [pk], count, neo4j_cypher_hint}` |
| `allmeta-write-link` | POST Allmeta `/api/v1/ontology/links` 写关系边(目前没用,但 v0_1_010 +可能要)| —— | `{source_label, source_id, target_label, target_id, relationship}` | `{created}` |

### 3.4 Infrastructure agents

| Agent ID | 做什么 | 当前在哪个 pipeline | Input | Output |
|---|---|---|---|---|
| `emit-event` | 经 `em.publish` emit 进 Inngest + 写 `EventInstance` 审计 | 三个 pipeline 都用 | `{name, data, source?, causedBy?, traceId?}` | `{event_id}` |

**总计:14 个 agent**(从 3 个 pipeline 拆出来的)。

---

## 5. Workflow DSL — 关键设计决策

工作流定义存 DB 一行,长这样(草案):

```yaml
id: resume-onboarding
name: 简历入库
version: 1
trigger:
  event: RESUME_DOWNLOADED
  filter: ~  # optional event payload filter

steps:
  - id: parse
    agent: parse-resume
    inputs:
      pdf_buffer: $ref.download.pdf
      filename: $event.data.filename
      traceId: $event.trace.trace_id
    needs: [download]                          # 依赖 download step 先跑完

  - id: download
    agent: raas-download-pdf
    inputs:
      upload_id: $event.data.upload_id
      traceId: $event.trace.trace_id

  - id: save
    agent: raas-save-candidate
    inputs:
      upload_id: $event.data.upload_id
      bucket: $event.data.bucket
      object_key: $event.data.objectKey
      parsed: $ref.parse.parsed
      etag: $event.data.etag
    needs: [parse]

  - id: write-candidate
    agent: allmeta-write-instance
    inputs:
      label: Candidate
      payload: |
        $mapper.toAllmetaCandidate(
          $ref.parse.parsed,
          $ref.save.candidate_id,
          { employee_id: $event.data.employeeId }
        )
    needs: [save]

  - id: write-expectation
    agent: allmeta-write-instance
    inputs:
      label: Candidate_Expectation
      payload: $mapper.toAllmetaCandidateExpectation($ref.parse.parsed, $ref.save.candidate_id)
    needs: [save]

  - id: write-resume
    agent: allmeta-write-instance
    inputs:
      label: Resume
      payload: $mapper.toAllmetaResume($ref.parse.parsed, { ... })
    needs: [save]

  - id: emit
    agent: emit-event
    inputs:
      name: RESUME_PROCESSED
      data:
        upload_id: $event.data.upload_id
        candidate_id: $ref.save.candidate_id
        resume_id: $ref.save.resume_id
        parsed: $ref.parse.parsed
        # ...
      causedBy: { eventId: $event.id, name: $event.name }
    needs: [save]

emits: [RESUME_PROCESSED]
```

### 4.1 DSL 表达力需要支持

| 特性 | 必须? | 备注 |
|---|---|---|
| **顺序 / 并发** | 必须 | 用 `needs: [stepId]` 声明依赖,interpreter 算 DAG |
| **Input mapping** | 必须 | `$event.x` / `$ref.{stepId}.{field}` / `$mapper.fnName(...)` |
| **条件分支** | 必须 | `when: $ref.rule-check.decision === 'PASS'` |
| **循环** | 必须 | `forEach: $ref.list-jrs.items as jr` —— MRA 每个 JR 跑一遍是核心场景 |
| **错误处理** | 必须 | per-step `retries`、`onError: {agent: ..., inputs: ...}`、是否 NonRetriable |
| **早期 return** | 应该 | "rule-check FAIL → emit MATCH_FAILED → 不进 match-resume" |
| **子 workflow 调用** | 看情况 | workflow A 里调 workflow B —— 强大但增加复杂度,Phase 2 再说 |
| **状态机 / 长流程** | 不必 | 复杂流程留给代码,DSL 只做有限表达力 |

### 4.2 Mapper 怎么办?

我们现有的 `toAllmetaCandidate / toAllmetaResume / mapRobohireToRaas / flattenRequirementForMatch / buildResumeText / ...` 这些函数把数据从一种 shape 转成另一种 shape。

两种处理方案:
- **(a) Mapper 也是 agent** —— 一种特殊类型 agent,纯函数,无 IO。优点:DSL 全靠 agent 组合,简洁;缺点:为了几行代码搞个 agent 注册有点重
- **(b) DSL 内置 mapper 函数表** —— 在 DSL 里直接写 `$mapper.toAllmetaCandidate(...)`,mapper 函数在 runtime 注册,不暴露成 agent。优点:不污染 agent 库;缺点:DSL 要支持表达式

倾向 **(b)**。Mapper 是技术细节,不是业务能力;agent 库应该装"业务能力"而不是"shape 转换"。

---

## 6. UI — 怎么暴露给用户

### 5.1 Fleet 视图(已有,但要重做)

现状:`/monitor?tab=agents` 显示 3 张卡(3 个 pipeline)。
目标:显示 **14 个 agent**,每个独立 pause / 监控 / replay。每张卡上能看到:
- agent 名 + 描述 + 类型(`raas-backend` / `robohire` / `allmeta` / `internal`)
- 触发它的 workflow 名字(可能多个 workflow 都用同一个 agent)
- 调用次数 / 成功率 / 平均耗时
- pause toggle
- 进去能看 input/output schema、最近调用、单独 replay

### 5.2 Workflow 视图(新)

`/workflows`:
- 列出所有 workflow(系统预置 + 用户自建)
- 每个 workflow 显示:trigger event / 步骤数 / agent 列表 / 版本号 / 启用状态
- 点开是**编辑器**

### 5.3 Workflow 编辑器(新)

MVP 不上画布,先做**列表式**:
```
Workflow: 简历入库  v3  [启用]

Trigger:  RESUME_DOWNLOADED
          [+ 条件过滤]

Steps:
  ▸ [1] download         agent: raas-download-pdf       [编辑 input ▸]
  ▸ [2] parse            agent: parse-resume            needs: [1]
  ▸ [3] save             agent: raas-save-candidate     needs: [2]
  ▸ [4] write-candidate  agent: allmeta-write-instance  needs: [3]
  ▸ [5] write-expectation agent: allmeta-write-instance needs: [3]
  ▸ [6] write-resume     agent: allmeta-write-instance  needs: [3]
  ▸ [7] emit             agent: emit-event              needs: [3]

[+ 添加 step]  [保存为新版本]  [测试]  [Diff vs v2]
```

Phase 3 再上 React Flow / xyflow 那种 DAG 拖拽画布。

### 5.4 历史 evidence trail

现有的 EvidenceTrail 设计**天然适配**:每个 agent 调用是一个 evidence row,workflow 跑完一条 evidence trail 就是 workflow 的执行记录。把现有 `function_slug` 字段拆成 `workflow_id` + `agent_id`,UI 渲染顺序按 step 顺序而不是按时间。

---

## 7. 分阶段路线图

### Phase 1 — 拆 Agent(2-3 周,**现在可以动**)

只拆代码,**不上 DSL**。

- 把现在 3 个 `*Agent.ts` 里的 `step.run` 块抽出来,各自做成独立 Inngest function
- 每个新 function 监听一个**内部专用事件**(`AO_INTERNAL.parse-resume.request` → 响应 `AO_INTERNAL.parse-resume.completed`)
- 3 个 pipeline 的 TS 代码改成"发请求事件 + 等响应事件",通过 `step.waitForEvent`
- 不动 partner 协议(对外触发事件和 emit 事件全保持原样)
- Agent registry 写死在 `lib/agents/manifest.ts` 一个文件里,不上 DB
- Fleet UI 适配显示 ~14 张卡

**收益**:agent 真的独立了 / 每个 agent 有独立监控、pause、replay / Fleet UI 名副其实 / **没赌 DSL 设计**

**风险**:每个 agent 调用增加 ~10-50ms Inngest 事件 round-trip 延迟。但相比 RoboHire LLM 20-30 秒,可以忽略。

### Phase 2 — Workflow 数据化(3-4 周,**等 partner 对接稳定再开**)

- 设计 DSL JSON schema
- 写 Workflow Runtime 解释器
- Prisma 表 `WorkflowDefinition`(版本化)
- 把 3 个现有 pipeline 翻写成 3 条 WorkflowDefinition 记录
- 老 pipeline TS 代码降级成"调用 Workflow Runtime"
- UI:列表式编辑器(读写 DSL JSON)

**收益**:workflow 真的可被用户改 / 可 A/B / 可回滚版本 / 可热修复(不发版)

### Phase 3 — 视觉编辑器 + 第三方 Agent(长期)

- DAG 画布编辑器(React Flow / xyflow)
- Agent SDK:客户能用 TS / Python 写自己的 agent,部署后注册到 AO
- 沙箱执行 / 资源限额 / schema 校验
- Marketplace:agent / workflow 模板共享

---

## 8. Trade-offs — 诚实清单

### 7.1 这条路的好

- 名副其实:Fleet 真的是 agent fleet
- 业务可配置:HR/PM 改 workflow 不用发版
- 能力可复用:`allmeta-write-instance` 一个 agent 被 5 个 step 调,改一处影响全局
- 客户可扩展:卖 SDK 让客户接自己的 agent
- 监控粒度细:每个外部调用单独 evidence / pause / replay
- A/B 友好:换个 matcher 试试只要新建一个 workflow 版本指向新 agent

### 7.2 这条路的痛

- **工程量大**:Phase 1+2 总 5-7 周,Phase 3 不限期
- **DSL 设计是地雷**:表达力太弱不够用、太强等于又造一门编程语言
- **可观察性更复杂**:一个事件触发可能跨 5-10 个 agent,trace correlation 必须做好(`flow_id` 那套要扩)
- **错误处理变难**:中间某个 agent 失败,workflow 怎么决定 retry/skip/abort?DSL 要表达,UI 要呈现
- **性能多一层**:event dispatching 开销叠加;LLM 工作流影响小,但纯 IO 工作流会感觉慢一些
- **不利于现在**:partner 对接还没稳,我们一边搭 DSL 一边底层在变,两头扛

### 7.3 不该上的

- ❌ **LLM-driven orchestrator**(每次决策都问 LLM 该调哪个 agent)。我们业务核心路径确定性,不需要。
- ❌ **完全图灵完备的 DSL**。表达力到"DAG + 条件 + 循环 + 早返回"就够 90% 场景,剩下 10% 写代码 agent 包进去。
- ❌ **第一版就上画布编辑器**。MVP 用列表 + JSON,验完概念再做画布。

---

## 9. 跟领导对齐的 3 个问题

开干前必须澄清:

### 8.1 DSL 表达力到哪一层?

- **A.** 只支持线性顺序(简单) → MVP 足够,但 MRA 那种"对每个 JR 跑一遍"做不了
- **B.** 顺序 + DAG + 条件分支 + 循环(够用)→ 推荐
- **C.** 全状态机 / 子流程 / 回调 / 长事务(过度) → 不推荐,这种就该写代码

### 8.2 工作流的实际用户是谁?

- **A.** 工程师改 JSON / YAML 提 PR → Phase 1 后期可以
- **B.** PM / HR 在 UI 拖画布 → Phase 3 才能开
- **C.** 客户自己定制 → 需要 Agent SDK + 沙箱,大项目

### 8.3 客户能自带 agent 吗?

- 如果是 → Agent Registry 必须支持**远程注册 + schema 验证 + 沙箱执行**(完全是另一个产品)
- 如果不是 → Agent 库就是内置目录,简单很多

---

## 10. 我的建议

**短期(本月)**:领导确认方向后,开始 Phase 1。这一步**不破坏任何现有功能**,partner 对接照常,但 Fleet UI 一旦真的列出 14 个 agent,领导对"agent 化"的体感立刻有。

**中期(下季度)**:Phase 2。等 partner 对接稳定 + Allmeta schema 收敛后再做 DSL,不然两头扛。

**长期**:Phase 3 看商业化进展。如果有客户买单需要"我能自带 agent",优先做 Agent SDK;否则视觉编辑器优先级低于稳定性。

---

## 11. 附录:跟 partner 协议保证不变

无论怎么拆,partner 看到的事件都是一样的:

| 入站(partner → AO)| 出站(AO → partner)|
|---|---|
| RESUME_DOWNLOADED | RESUME_PROCESSED |
| REQUIREMENT_LOGGED | JD_GENERATED |
| CLARIFICATION_READY | MATCH_PASSED_NEED_INTERVIEW |
| JD_REJECTED | MATCH_FAILED |

Payload shape 不变(全是 `RaasRequirement` / `ResumeProcessedData` / `MatchPassedNeedInterviewData` 那套)。

Partner 那边**完全不需要任何改动**。重构是我们内部的事。
