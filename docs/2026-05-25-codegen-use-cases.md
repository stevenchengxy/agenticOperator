# Codegen Use Cases — 5 Production Agents as Ground Truth

> 2026-05-25 · 配套 Phase 1c 提交（registries + few-shot + UI polish）
> 适用页面：[`/behavior/codegen`](../app/behavior/codegen/page.tsx)
> 适用 LLM 模型：`AI_CODEGEN_MODEL` 环境变量（默认 `gpt-4o-mini`）

---

## 0. 概览

AO Codegen 当前以 **5 个真实生产 agent** 为 ground truth：

| Agent (short) | slug | Stage | Trigger | Emits |
|---|---|---|---|---|
| `JDGenerator` | `create-jd-agent` | jd | `REQUIREMENT_LOGGED` / `CLARIFICATION_READY` / `JD_REJECTED` | `JD_GENERATED` |
| `ResumeParser` | `resume-parser-agent` | resume | `RESUME_DOWNLOADED` | `RESUME_PROCESSED`, `RESUME_PARSE_ERROR` |
| `Matcher` | `match-resume-agent` | match | `MATCH_RULE_CHECK_PASSED` | `MATCH_PASSED_NEED_INTERVIEW`, `MATCH_PASSED_NO_INTERVIEW`, `MATCH_FAILED` |
| `RuleCheck` | `rule-check-agent` | match | `RESUME_PROCESSED` | `MATCH_RULE_CHECK_PASSED`, `MATCH_RULE_CHECK_FAILED` |
| `InterviewInviter` | `interview-inviter-agent` | interview | `INTERVIEW_INVITATION_REQUESTED` | `INTERVIEW_INVITATION_SENT`, `INTERVIEW_INVITATION_FAILED` |

注册表喂给 LLM 的上下文：
- **Tool registry** ([`tool-registry.raas.ts`](../lib/agent-codegen/registries/tool-registry.raas.ts)) — 23 条，覆盖以上 5 agents 调用的全部 `@/lib/*` wrappers
- **Event registry** ([`event-registry.raas.ts`](../lib/agent-codegen/registries/event-registry.raas.ts)) — 30+ 条，含整条 RAAS workflow 上的事件名
- **Few-shot index** ([`few-shot-index.ts`](../lib/agent-codegen/few-shot-index.ts)) — 10 段真实 `step.run` body，按 stage + tool overlap 检索

下面 5 个 use case 都假设：
1. 你的浏览器打开 [`http://localhost:3002/behavior/codegen`](http://localhost:3002/behavior/codegen)
2. AppBar 右上的 domain 切换器是 **RAAS**
3. 后端 `AI_BASE_URL+AI_API_KEY` 或 `OPENAI_API_KEY` 已配
4. AO dev server 已起（`npm run dev`）

---

## Use Case 1 · 重生成 `JDGenerator`

> **场景**：现在跑生产的 `create-jd-agent` 调 RoboHire `generate-jd` 时偶尔 502。你想试一版"多一步:在调 RoboHire 前先 ping 一下健康检查端点,失败就 NonRetriableError 跳过"。

### 输入

1. 左栏 Prompt（覆盖默认的 starter 文字）：

```
新建 create JD agent v2。要做的事:
1. 收到 REQUIREMENT_LOGGED, 从 partner Postgres 拉 requirement 详情
2. 把 requirement 镜像写到 Allmeta Neo4j (Job_Requisition 节点)
3. 调 RoboHire /generate-jd 生成 JD 文本 (RobohireApiError 4xx 走 NonRetriableError)
4. 把生成的 JD 写回 partner Postgres job_posting 表
5. 把 job_posting 镜像写到 Allmeta Neo4j
6. emit JD_GENERATED
```

2. 点 **生成 Agent →**

### 期望流程

- 顶部 Pipeline stepper 从 ① Prompt → ② Spec → ③ Render → ④ Bodies → ⑤ Compile 一路点亮
- 总耗时 ~30-60s（取决于 LLM gateway 速度）
- 右栏 CompilerPanel 顶部出现 **✓ OK · 0 diag**

### 期望结果

**Spec tab** 大致是：

```json
{
  "slug": "create-jd-agent",
  "displayName": "Create JD Agent",
  "stage": "jd",
  "ownerTeam": "HSM·交付",
  "triggerEvent": "REQUIREMENT_LOGGED",
  "emitEvents": ["JD_GENERATED"],
  "retries": 2,
  "steps": [
    { "id": "fetch-requirement", "callsLib": "partner-pg.getRequirement", ... },
    { "id": "write-jr-neo4j",    "callsLib": "allmeta.writeJobRequisition", ... },
    { "id": "generate-jd",       "callsLib": "robohire.generateJd", ... },
    { "id": "sync-jd",           "callsLib": "partner-pg.syncJd", ... },
    { "id": "write-jp-neo4j",    "callsLib": "allmeta.writeJobPosting", ... }
  ]
}
```

**Code tab** 包含真实的 imports + step.run 调用 + emit。Step bodies 由 few-shot index 的 `create-jd-agent.ts:generate` 引导，应该带 try/catch + `NonRetriableError` + `logger.info`。

### Save as version

CompilerPanel 底部按钮 **保存为版本 → JDGenerator** 可点。点了之后：
- POST `/api/agents/JDGenerator/versions` with `{ codegen: { codeBlob, specJson, promptText, modelUsed } }`
- 写入 `AgentVersion` 行,`capturedFrom='codegen'`, `status='draft'`
- 右栏出现 **✓ 已保存版本 · 2026-05-25-1830**
- 之后到 [`/fleet/JDGenerator?tab=versions`](http://localhost:3002/fleet/JDGenerator?tab=versions) 能看到这一行

### Diff tab

切到 **Diff** tab。
- 如果 `JDGenerator` 之前已有 active codegen 版本 → 左侧是上次保存的代码,右侧是这次刚生成的
- 如果是第一次 → 左侧显示 "No saved version yet" 提示

---

## Use Case 2 · 重生成 `ResumeParser`

> **场景**：当前 `resume-parser-agent` 只支持 PDF。你想生成一版"先 stat 一下文件大小,>10MB 直接 NonRetriableError 拒掉"。

### 输入

```
ResumeParser v2。流程:
1. 收到 RESUME_DOWNLOADED 事件 (含 minio_object_key)
2. minio stat 一下文件,大小超过 10MB 直接 NonRetriableError "resume too large"
3. minio 拉 buffer
4. 调 RoboHire parse-resume,RobohireApiError 4xx → NonRetriableError
5. 把 parsed_resume_json 写进 partner Postgres candidates 表
6. 把 candidate + resume 都镜像写 Allmeta Neo4j
7. 成功 emit RESUME_PROCESSED,parse 失败 emit RESUME_PARSE_ERROR
```

### 期望 Spec

```json
{
  "slug": "resume-parser-agent",
  "displayName": "Resume Parser Agent",
  "stage": "resume",
  "triggerEvent": "RESUME_DOWNLOADED",
  "emitEvents": ["RESUME_PROCESSED", "RESUME_PARSE_ERROR"],
  "steps": [
    { "id": "stat-resume",        "callsLib": "minio.statResume", ... },
    { "id": "download-and-parse", "callsLib": "minio.getResumeBuffer", ... },  // 或 robohire.parseResume
    { "id": "save-candidate",     "callsLib": "partner-pg.saveCandidate", ... },
    { "id": "write-candidate-neo4j", "callsLib": "allmeta.writeCandidate", ... },
    { "id": "write-resume-neo4j",    "callsLib": "allmeta.writeResume", ... }
  ]
}
```

### 期望 Code

`download-and-parse` 步骤的 body 应该被 few-shot 牵引成接近真实 agent 的：

```ts
const pdf = await getResumeBuffer(objectKey);
try {
  const r = await parseResumeDirect(pdf, { traceId });
  logger.info(`[${AGENT_NAME}] parsed resume ${objectKey} chars=${r.data.text?.length ?? 0}`);
  return r;
} catch (e) {
  if (e instanceof RobohireApiError && e.isClientError) {
    throw new NonRetriableError(`RoboHire parse-resume 4xx: ${e.httpStatus} ${e.code}`);
  }
  throw e;
}
```

新增的 `stat-resume` 步骤是模型自己根据 prompt 加的；body 应该包含 `>10MB` 判断 + `NonRetriableError`。

### Compile 预期

- ✓ OK 如果 LLM 没乱写
- 常见失败：把 `getResumeBuffer` 的 import 路径写错，或忘了 import `RobohireApiError` —— Compiler 会精确报 TS2307 import 错误，操作员可以手改 Code tab 然后右栏 **Compile** 再校验

---

## Use Case 3 · 重生成 `Matcher`

> **场景**：把 RoboHire match-resume 的失败处理改成"不抛错,直接 emit MATCH_FAILED 终结"。

### 输入

```
Match resume agent。流程:
1. 收到 MATCH_RULE_CHECK_PASSED (data 含 candidate_id, job_requisition_id, parsed_resume_json)
2. 从 partner Postgres 拉 requirement 详情 (拼成 jdText)
3. 调 RoboHire /match-resume 算分
   - 4xx 错误不抛,捕获后 emit MATCH_FAILED 终结
4. 把 match 结果落 partner Postgres match_results 表
5. 把 Candidate_Match_Result 镜像写 Allmeta Neo4j (overall_*)
6. 按分数决定 emit:
   - 高分需要面试 → MATCH_PASSED_NEED_INTERVIEW
   - 高分不需要面试 → MATCH_PASSED_NO_INTERVIEW
   - 低分 → MATCH_FAILED
```

### 期望 Spec

模型应该选 `MATCH_RULE_CHECK_PASSED` 作为 triggerEvent，emitEvents 三个 MATCH_* 全部带上。Steps 是经典 5 步：fetch → match → save → mirror → decide-emit。

### 期望 Code 的关键片段

Few-shot 的 `match-resume-agent.ts:match` 直接命中 → 生成的 match 步骤几乎是真实代码：

```ts
try {
  const r = await matchResumeDirect(
    { resume: resumeText, jd: jdText },
    { traceId: traceId ?? undefined },
  );
  logger.info(`[${AGENT_NAME}] match OK · score=${r.data.matchScore}`);
  return { ok: true as const, data: r.data, requestId: r.requestId };
} catch (e) {
  if (e instanceof RobohireApiError && e.isClientError) {
    return { ok: false as const, error: `${e.code}: ${e.message}` };
  }
  throw e;
}
```

### Save 后

到 [`/fleet/Matcher?tab=versions`](http://localhost:3002/fleet/Matcher?tab=versions) → 看到 codegen-source 的 draft 行。

---

## Use Case 4 · 重生成 `RuleCheck`

> **场景**：生产 `rule-check-agent` 是 649 行 ——最复杂的一个。重生成的目标:验证 codegen 在大 agent 上的 spec/code 完整度。

### 输入

```
Rule Check Agent。
触发: RESUME_PROCESSED (data 至少含 candidate_id, parsed_resume_json, upload_id)
流程:
1. 列出当前所有 open recruiting jobs (作为本次 fan-out 的 JR 列表)
2. 对每个 JR (但 spec 内只描述单 JR 路径就够了,fan-out 当成隐式):
   a. 拉 partner-pg parsed_resume (按 candidate_id)
   b. 把 JR 镜像写到 Allmeta Neo4j
   c. 跑 rule check (输入: requirement + candidate + parsedResume)
   d. 把 audit 写回 partner-pg (rule_check_audit 表)
   e. 把 Candidate_Match_Result 的 rule_check_* 字段写 Allmeta
3. 全部跑完后,对每个 JR 单独 emit:
   - verdict pass → MATCH_RULE_CHECK_PASSED
   - verdict fail → MATCH_RULE_CHECK_FAILED
```

### 期望

- Spec 大概率 5-6 步（codegen 不会 1:1 复刻 649 行，但骨架 step 命中）
- `rule-check` 这一步会被 few-shot 引导成调 `runRuleCheck()` + `buildRuleCheckInput()`
- Compile 大概率有 1-2 个错（LLM 容易把 `buildRuleCheckInput` 的 input 形状猜错，因为 tool-registry 没把 RuleCheckInput 全展开）
- 你在 Compile diagnostics 里看到 TS2353 "Object literal may only specify known properties" → 手改 Code tab → 再 Compile → ✓
- 这是 codegen 的**真实使用场景**：MVP 出第一稿，operator 修编译错误，落版本

### Save 后效果

`/fleet/RuleCheck?tab=versions` → 出现 codegen draft。点 "部署" 不可用（codegen-source 版本目前只支持 draft）。这是 Phase 0 留的口，等代码层热加载（Phase 5）再启用。

---

## Use Case 5 · 重生成 `InterviewInviter`

> **场景**：刚 ship 的 `interview-inviter-agent` 是 5 个里最新的。验证 codegen 能否复现"GoHire 2xx + success=false 当失败处理"这个 corner case。

### 输入

```
Interview Inviter Agent。
触发: INTERVIEW_INVITATION_REQUESTED (data 含 candidate_id, job_requisition_id, optional resume_text, jd_text)
流程:
1. 如果 event 里没 resume_text,从 partner-pg parsed_resume backfill
2. 如果 event 里没 jd_text,从 partner-pg requirement backfill
3. 调 RoboHire /invite-candidate
   - HTTP 2xx + body.success=false 也算失败 (GoHire 拒绝),抛 NonRetriableError
   - 4xx 抛 NonRetriableError
4. 成功后把 communication_log 镜像写 Allmeta
5. 把 interview_record (status=invited) 镜像写 Allmeta
6. emit INTERVIEW_INVITATION_SENT,失败 path emit INTERVIEW_INVITATION_FAILED
```

### 期望

- Spec triggerEvent = `INTERVIEW_INVITATION_REQUESTED`（event registry 里有，模型不会自创）
- `invite` 步骤被 few-shot 引导 →（这是 few-shot index 第 9 条，直接对齐：

```ts
try {
  const r = await inviteCandidateDirect(input, { traceId });
  if (!r.data.success) {
    throw new NonRetriableError(`GoHire rejected invite: ${JSON.stringify(r.data)}`);
  }
  logger.info(`[${AGENT_NAME}] invite sent · candidate=${candidateId} url=${r.data.invite_url}`);
  return r;
} catch (e) { ... }
```

- backfill 两步是 spec extractor 根据 prompt 自创的（few-shot 里没有），可能 body 不够完整 — operator 手补即可
- write-comm-log 步骤命中 few-shot 第 10 条

### Save 后

`/fleet/InterviewInviter?tab=versions` → 与你刚 ship 的真实 v1.0.0 并列，作为 codegen 的对比基线。可以切换 Diff tab 看一行行差异 — 这是验证"AI 生成 vs 人写"质量差距的最直接方法。

---

## 通用：你能从 Codegen 拿到什么

| 阶段 | 你看到的 | 持久化 |
|---|---|---|
| **Spec extract** | 中栏 Spec tab 出现结构化 JSON | 否（在 spec tab 文本里） |
| **Template render** | 中栏 Code tab 出现 .ts 文件 | 否 |
| **Compile** | 右栏 ✓ OK 或 ❌ 错误列表 | 否 |
| **Save as version** | 右栏 ✓ 已保存版本 · `<label>` | ✅ `AgentVersion` 表,`capturedFrom='codegen'` |
| **Diff tab** | 与该 agent 上次 codegen-saved 版本的并排 diff | 否（只读视图） |

每次 codegen pipeline 跑完后,你都可以：
- 自己改 Code tab → 点 Compile → 验证你的修改不破编译
- 不满意 → 改 Prompt → 再点 "生成 Agent →" 重跑
- 满意 → "保存为版本" 落库
- 落库后,后续生成默认 Diff tab 跟它对比,你能看到每一版的改动

## 限制

- 一次 codegen 需要 ~30-90s。慢主要因为：① LLM Call A + Call B 各一次往返；② 对真实项目跑 tsc overlay 编译 ~5-15s
- 生成的 step body **质量取决于 few-shot 命中**。和现有 5 agents 同 stage / 同 lib 的场景下质量较高；偏离这 5 agents 的场景（如纯 R7 类、纯 system stage）质量明显下降
- **代码落盘后,Inngest 不会热加载**。Save as version 只是把 codeBlob 存进数据库 draft；真要让生成的 agent 跑起来,还要：（a）手动把 codeBlob 写到 `server/inngest/agents/<slug>.ts`，（b）重启 Next.js 进程
- 这条限制在研究文档 §10 #2 已写明,Phase 5 才解
