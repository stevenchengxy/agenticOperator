# Interview Inviter Agent — Use Cases & Test Recipes

**日期**: 2026-05-25
**Agent**: `interviewInviterAgent` (wsId `11-1`, real, `interview-inviter-agent`)
**Trigger**: `INTERVIEW_INVITATION_REQUESTED` (RaaS → AO)
**Emits**: `INTERVIEW_INVITATION_SENT` / `INTERVIEW_INVITATION_FAILED` (AO → RaaS)
**Files**:
[server/inngest/agents/interview-inviter-agent.ts](../server/inngest/agents/interview-inviter-agent.ts) ·
[lib/robohire-client.ts](../lib/robohire-client.ts) (`inviteCandidateDirect`) ·
[lib/allmeta-writers/{communication-log,interview-record}.ts](../lib/allmeta-writers/) ·
[server/em/schemas/builtin.ts](../server/em/schemas/builtin.ts)

---

## 0. 整体上下文(为什么有这个 agent)

```
matchResumeAgent emit MATCH_PASSED_NEED_INTERVIEW
        │ (shared Inngest)
        ▼
RaaS backend 消费 → HSM 风控 / 招聘者审批 / 客户档案校验
        │
        ▼
RaaS emit INTERVIEW_INVITATION_REQUESTED ──────────► AO interviewInviterAgent
                                                      │
                                                      ├─ (可选) partner-pg backfill resume/jd
                                                      ├─ POST RoboHire /api/v1/invite-candidate
                                                      ├─ allmeta 写 Communication_Log + Interview_Record
                                                      ▼
                                                    emit INTERVIEW_INVITATION_SENT (200)
                                                      或
                                                    emit INTERVIEW_INVITATION_FAILED (error_code)
                                                      │ (shared Inngest)
                                                      ▼
                                                  RaaS UI 显示邀请状态
```

**为什么把"调 RoboHire 发邀请"放在 AO 这边而不是 RaaS 直接调**:
- AO 已封装了 RoboHire 客户端的统一 instrumentation(file logger `apiCall` 自动落 request/response,X-Trace-Id 透传,RobohireApiError 标准化错误码)。
- AO 已封装了 Allmeta dual-write 通路;邀请发出 + Neo4j 写入 + 失败回报必须原子地一起做。
- RoboHire API key 只在 AO env(`ROBOHIRE_API_KEY`)中,RaaS 拿不到。
- RaaS 端 HSM 审批是业务决策(发不发);AO 端的本 agent 是执行动作(怎么发 + 把结果落库 + 报告)。职责分离。

---

## 1. Use Cases — 8 个场景

### UC-1: Happy Path · Fat Event(RaaS 端塞好 resume_text / jd_text)

**前置**
- 候选人 `C-12345` 已通过 matchResume,分数 78,RaaS HSM 审批通过。
- RaaS 端已经在内存里有简历纯文本 + JD 纯文本(刚做完匹配)。

**输入** — `INTERVIEW_INVITATION_REQUESTED` 信封 payload:
```json
{
  "candidate_id": "C-12345",
  "job_requisition_id": "JR-7890",
  "application_id": "APP-001",
  "candidate_match_result_id": "cmr_C-12345_JR-7890",
  "client_id": "CLI-bytedance",
  "operator_id": "EMP-0000199059",
  "resume_text": "张三 / 5 年后端 / Java + Spring + Kafka + Redis ...",
  "jd_text": "职位: 高级后端工程师\n工作城市: 深圳\n必备技能: Java, Kafka",
  "candidate_email": "zhangsan@example.com",
  "recruiter_email": "recruiter@chinasoftinc.com",
  "job_title": "高级后端工程师",
  "company_name": "字节跳动",
  "interview_language": "zh",
  "interview_duration": 30,
  "interview_mode": "ai_video",
  "passing_score": 70,
  "interviewer_requirement": "重点考察 Kafka 实战 + 分布式事务"
}
```

**预期行为**
1. 不走 partner-pg backfill(payload 已带 resume_text + jd_text)
2. POST `https://api.robohire.io/api/v1/invite-candidate` Bearer + X-Trace-Id
3. RoboHire 200 + data 含 `login_url` / `qrcode_url` / `user_id`
4. 写 Neo4j:
   - `Communication_Log` PK `comm_invite_C-12345_JR-7890_<ts>`(`interaction_type='面试邀请'`, sender=`EMP-0000199059`, receiver=`zhangsan@example.com`, content 含 login_url + qrcode + 时长)
   - `Interview_Record` PK `ivr_C-12345_JR-7890_inv`(`interview_type='我司面试'`, `interview_round='一面'`, `interview_mode='ai_video'`, `recording_url=login_url` 占位, `interviewer_employee_id='EMP-0000199059'`)
5. emit `INTERVIEW_INVITATION_SENT`,payload 含 interview_record_id / communication_log_id / login_url / qrcode_url / user_id

**断言**(单测 [`interview-inviter-agent.test.ts:happy path`](../server/inngest/agents/interview-inviter-agent.test.ts) 已覆盖)
- `mockInvite` 调用 1 次
- `mockWriteComm` + `mockWriteIvr` 各调用 1 次
- 仅 1 个 emit:`INTERVIEW_INVITATION_SENT`
- `mockGetParsedResume` / `mockGetRequirementDetail` 没被调用

---

### UC-2: Happy Path · Thin Event(payload 只带 anchors,AO 自己回查)

**前置** — RaaS 端不想塞文本,只发 IDs。

**输入**
```json
{
  "candidate_id": "C-12345",
  "job_requisition_id": "JR-7890",
  "application_id": "APP-001",
  "resume_id": "RSM-99",
  "operator_id": "EMP-0000199059",
  "interview_language": "zh"
}
```

**预期行为**
1. payload 缺 resume_text → `step.run('backfill-resume-...')` 调 `getParsedResume('C-12345', 'RSM-99')` → 拿 `parsed_content`
2. payload 缺 jd_text → `step.run('backfill-jd-...')` 调 `getRequirementDetail('JR-7890')` → flatten JR row
3. RoboHire `/invite-candidate` 入参的 `resume` = backfilled `parsed_content`,`jd` = flatten 后的 JD 文本
4. 后续同 UC-1

**断言**(单测 `payload thin → backfill resume_text from partner-pg`)
- `mockGetParsedResume` 被调 1 次,参数 `('C-12345', 'RSM-99')`
- `mockInvite` 入参 `resume` === `'backfilled resume body'`

**Failure 分支** — partner-pg 找不到行:
- emit `INTERVIEW_INVITATION_FAILED` `error_code=BACKFILL_FAILED` + NonRetriableError

---

### UC-3: 复用 GoHire 已存在的 Resume / Job(robohire_resume_id + robohire_job_id)

**场景** — 这个候选人/岗位之前已经在 RoboHire 注册过(parseResume / generateJd 阶段),不需要 AO 再传文本。

**输入**
```json
{
  "candidate_id": "C-12345",
  "job_requisition_id": "JR-7890",
  "robohire_resume_id": "rsm_robohire_internal_abc",
  "robohire_job_id": "job_robohire_internal_xyz",
  "operator_id": "EMP-0000199059"
}
```

**预期行为**
1. 完全不走 backfill(robohire_*_id 都直接转发到 RoboHire,server-side 取数)
2. `inviteCandidateDirect` 入参用 `resume_id` + `job_id`(不带 `resume` / `jd`)
3. 后续同 UC-1

**断言**(单测 `robohire_resume_id 直传 → 不走 partner-pg backfill`)
- 不调用 `mockGetParsedResume` / `mockGetRequirementDetail`
- `mockInvite` 入参 `{ resume_id: 'rsm_x', job_id: 'job_x', ... }`

---

### UC-4: GoHire 端 dedup-hit(同 candidate × job 已经发过邀请)

**场景** — RaaS 重发同一对 (candidate, JR),RoboHire 检测到 (user, JD) 已有 hiring_request → 返 `reused: true`。

**预期行为**
1. RoboHire 200,`data.reused: true` + 复用原 `login_url`/`qrcode_url`/`user_id`
2. Neo4j 同样写两条实例(allmeta upsert by PK;`Interview_Record` PK 是确定的 `ivr_<cand>_<jr>_inv`,覆盖原行)
3. emit `INTERVIEW_INVITATION_SENT`,payload 一致(login_url 跟之前一样)
4. `Communication_Log` 的 `content_summary` 会带"(复用之前的 invite)"标记

**断言** — 业务上等价于 happy path;RaaS UI 看到的就是"已邀请",不会因为重发崩。

---

### UC-5: RoboHire 4xx — GoHire 拒绝(`gohire_invitation_failed`)

**场景** — RoboHire 422,response body `{ code: 'gohire_invitation_failed', error: 'GoHire rejected: invalid email' }`

**预期行为**
1. `inviteCandidateDirect` 抛 `RobohireApiError(422, 'CLIENT', '...', requestId)`
2. agent 内 catch:`isClientError = true` → 不重试,转 emit `_FAILED`(`error_code: 'ROBOHIRE_4XX'`, `http_status: 422`, `robohire_request_id` 透传)
3. **不写** Neo4j Communication_Log / Interview_Record(避免脏数据)
4. handler return `{ ok: false, error: 'ROBOHIRE_4XX' }`(对 Inngest 而言是 success,不会触发 retry)

**断言**(单测 `RoboHire 422 → emit _FAILED ROBOHIRE_4XX,不重试`)
- `mockWriteComm` / `mockWriteIvr` 0 次
- emit `_FAILED` payload `http_status=422`、`robohire_request_id='req_x'`

---

### UC-6: RoboHire 402 — quota 用尽

**场景** — RoboHire 检测到客户的 interview quota 用完,返 402。

**预期行为** — 同 UC-5,但 `error_code: 'ROBOHIRE_QUOTA'`(RaaS 端可以特殊处理:发邮件给 ops 充值 + 暂缓邀请)。

**断言**(单测 `RoboHire 402 quota → emit _FAILED ROBOHIRE_QUOTA`)

---

### UC-7: RoboHire 500 — Inngest retry

**场景** — RoboHire 内部错(`SERVER` code)。

**预期行为**
1. agent 内 catch:**抛**(不 catch SERVER code)→ Inngest 看到 throw,触发 retry(`retries: 2`)
2. 完全不发 `_FAILED`(因为可能下一次就好了)
3. 3 次 attempt 全失败后 Inngest 把这个 run marked failed,agent 不再处理

**断言**(单测 `RoboHire 500 → 抛错走 Inngest retry(不 emit _FAILED)`)
- `calls.events.length === 0`(没 emit 任何事件)
- 函数 throw

**Trade-off** — 我们没在 retry 用尽后 emit `_FAILED`;真要做的话需要在 Inngest function config 里加 `onFailure` hook。Phase 2 再加。

---

### UC-8: 缺关键字段 — `candidate_id` 或 `job_requisition_id`

**场景** — RaaS 端 bug 发了畸形 payload。

**预期行为**
1. 早期 anchors 校验失败 → emit `_FAILED` `error_code: 'MISSING_PAYLOAD'`
2. 抛 `NonRetriableError`(Inngest 不会 retry)
3. 不调 RoboHire,不写 Neo4j

**断言**(单测 `缺 candidate_id → emit _FAILED MISSING_PAYLOAD + NonRetriable`)

---

### UC-9: PersistenceWarning — RoboHire 邀请送出但 RoboHire 自己落库失败

**场景** — RoboHire 200 但响应里带 `persistenceWarning: '...'`(candidate 确实拿到了 login_url,但 RoboHire 的 Interview / HiringRequest 表写失败)。

**预期行为**
1. **正常写 AO Neo4j**(候选人确实拿到 login_url,AO 这边的 Interview_Record 是有意义的)
2. emit `INTERVIEW_INVITATION_FAILED` `error_code: 'PERSISTENCE_WARNING'`(让 RaaS 知道 RoboHire 那边数据可能不一致,后续可对账)
3. **同时 emit** `INTERVIEW_INVITATION_SENT`(候选人收到邀请这件事是事实)

**断言**(单测 `persistenceWarning → 仍写 Neo4j + emit _FAILED PERSISTENCE_WARNING + emit _SENT`)
- 双 emit
- `mockWriteComm` + `mockWriteIvr` 各 1 次

**RaaS 端处理建议** — 看到 `_FAILED PERSISTENCE_WARNING` 不要触发"重发邀请",而是触发"对账任务"。

---

### UC-10: RoboHire 200 但 GoHire 没签发 login_url(罕见)

**场景** — RoboHire 200 + `success: true`,但 `data.login_url` 缺失且 `data.reused !== true`(理论上不应发生,但兜底)。

**预期行为** — emit `_FAILED` `error_code: 'GOHIRE_REJECTED'`,不写 Neo4j(没 login_url 写一条 Interview_Record 没意义)。

**断言**(单测 `RoboHire 200 但无 login_url 且非 reused → emit _FAILED GOHIRE_REJECTED`)

---

## 2. 测试矩阵

| 用例 | 单测 | 手动 e2e(本地) | 联调 e2e(连 RoboHire 真 API) |
|---|---|---|---|
| UC-1 Happy Fat | ✅ pass | ✅ via `/api/test/trigger-interview-invite` | 需要 ROBOHIRE_API_KEY |
| UC-2 Thin + backfill | ✅ pass | 部分 — 需要 partner-pg 真有这条行 | ✅ |
| UC-3 robohire_*_id | ✅ pass | ✅ | ✅ |
| UC-4 dedup-hit | mock | ⚠️ 只能 mock,真 e2e 必须先成功过一次 | ✅ |
| UC-5 4xx | ✅ pass | ✅ via mock-raas 或 invalid email | ⚠️ 难触发(要构造 GoHire 拒绝场景) |
| UC-6 quota | ✅ pass | mock | ⚠️ 要 quota 真用完 |
| UC-7 5xx retry | ✅ pass | mock | ⚠️ |
| UC-8 missing payload | ✅ pass | ✅ 直接发畸形 payload | ✅ |
| UC-9 persistenceWarning | ✅ pass | mock | ⚠️ |
| UC-10 no login_url | ✅ pass | mock | ⚠️ |

总:**9 个单测全 pass,29/29 testsuite green**。

---

## 3. 手动 e2e 测试 recipe

### 3.1 通过 `/api/test/trigger-interview-invite`(无 RaaS 也能跑)

#### Recipe A: UC-1 happy fat event

```bash
curl -s -X POST http://localhost:3002/api/test/trigger-interview-invite \
  -H 'Content-Type: application/json' \
  -d '{
    "candidate_id": "C-test-001",
    "job_requisition_id": "JR-test-001",
    "application_id": "APP-test-001",
    "candidate_match_result_id": "cmr_C-test-001_JR-test-001",
    "client_id": "CLI-test",
    "operator_id": "0000199059",
    "resume_text": "测试候选人 / 5 年 Java 后端经验",
    "jd_text": "高级后端工程师 / 深圳 / Java + Kafka",
    "candidate_email": "test-candidate@example.com",
    "job_title": "高级后端工程师",
    "company_name": "测试客户",
    "interview_language": "zh",
    "interview_duration": 30,
    "interview_mode": "ai_video"
  }' | jq .
```

**注意** — 没有 `ROBOHIRE_API_KEY` 时 agent 会在 `inviteCandidateDirect` 抛 CLIENT err
"ROBOHIRE_API_KEY not set" → emit `_FAILED ROBOHIRE_4XX`,这条链路依然走通(只是 RoboHire 那一跳被短路),Neo4j 不会写。

#### Recipe B: UC-8 missing payload(验 NonRetriable)

```bash
curl -s -X POST http://localhost:3002/api/test/trigger-interview-invite \
  -H 'Content-Type: application/json' \
  -d '{ "job_requisition_id": "JR-test-001" }' | jq .
```

期望:em.publish 拒收(zod schema 校验失败,`candidate_id` 是 `.min(1)`),HTTP 422。

#### Recipe C: UC-3 robohire_*_id 直透

```bash
curl -s -X POST http://localhost:3002/api/test/trigger-interview-invite \
  -H 'Content-Type: application/json' \
  -d '{
    "candidate_id": "C-test-002",
    "job_requisition_id": "JR-test-002",
    "robohire_resume_id": "rsm_robohire_xxx",
    "robohire_job_id": "job_robohire_yyy",
    "candidate_email": "test2@example.com"
  }' | jq .
```

### 3.2 观察邀请处理结果

| 看什么 | 在哪里 |
|---|---|
| 事件已收 | http://localhost:3002/events 列表新增 `INTERVIEW_INVITATION_REQUESTED` 行 |
| Run 启动 | http://localhost:8288/runs · `agentic-operator-main-interview-inviter-agent` |
| Step 序列 | Inngest dashboard 里看到 `backfill-resume-*`(可选) / `backfill-jd-*`(可选) / `invite-<key>` / `write-comm-log-<key>` / `write-interview-record-<key>` / `emit-invitation-sent-<key>` |
| File log | `~/.claude_logs/agents/interviewInviter/<runId>.log`(`createAgentLogger` 落地) |
| Neo4j 实例 | Allmeta studio (`:3500`) `Interview_Record` / `Communication_Log` 列表里看到 `ivr_C-test-001_JR-test-001_inv` / `comm_invite_C-test-001_JR-test-001_<ts>` |
| 出向事件 | http://localhost:3002/events 看到 `INTERVIEW_INVITATION_SENT` 或 `_FAILED`(payload 含 error_code) |

### 3.3 跑单测

```bash
npx vitest run lib/robohire-client.test.ts server/inngest/agents/interview-inviter-agent.test.ts
# 29 passed (29)  — 见 §2 测试矩阵
```

---

## 4. 联调 e2e checklist(连真 RoboHire + RaaS)

进入联调环境之前确认:

- [ ] `ROBOHIRE_API_BASE_URL=https://api.robohire.io` + `ROBOHIRE_API_KEY=rh_<live>` 在 AO `.env.local`
- [ ] `ALLMETA_BASE_URL=http://localhost:3500` + `ALLMETA_API_KEY=...` 可达
- [ ] partner-pg 有候选人 + JR 行(thin event 路径才需要;fat event 跳过)
- [ ] `INNGEST_BASE_URL=http://localhost:8288` 跟 RaaS 端是同一台 shared Inngest
- [ ] RaaS 端实现了 `INTERVIEW_INVITATION_REQUESTED` 的发送(见 §5 RaaS-side 实现备忘)
- [ ] 候选人邮箱真实可收(GoHire 真会发邮件 + AI 视频面试链接)

联调验证步骤:
1. RaaS Web Console 给一个候选人 + JR 触发 "发起邀请"(或 HSM 审批通过)
2. AO `/events` 出现一行 `INTERVIEW_INVITATION_REQUESTED`,5-15 秒内
3. Inngest dashboard `interview-inviter-agent` runs 列表新增 1 条 run
4. Step `invite-<key>` 耗时 2-10s(RoboHire → GoHire 链路),完成后 status 200
5. 候选人邮箱收到 GoHire AI 视频面试邀请 + login_url 可点开
6. Neo4j(Allmeta `:3500/instances/Interview_Record/ivr_*`) 有新行
7. AO `/events` 出现 `INTERVIEW_INVITATION_SENT`(或 `_FAILED` + error_code)
8. RaaS UI 显示候选人状态 "已发邀请"(取决于 RaaS 端订阅了 `_SENT`)

---

## 5. RaaS-side 实现备忘(给 RaaS 同事的契约)

### 5.1 触发条件

RaaS 后端在以下时机 emit `INTERVIEW_INVITATION_REQUESTED`:

1. 招聘者在 RaaS UI 点 "发起 AI 面试邀请"(主路径)
2. HSM 审批通过 `Application` 状态 `interview_pending` 后自动触发
3. 客户档案 `client_preferences.auto_invite=true` 且 matchScore ≥ 客户阈值

### 5.2 必填字段

```ts
interface InterviewInvitationRequestedPayload {
  // 必填(zod min(1))
  candidate_id: string;          // RaaS Candidate PK
  job_requisition_id: string;    // RaaS Job_Requisition PK

  // 强烈建议带(避免 Neo4j 孤儿节点)
  application_id?: string;       // RaaS Application PK
  candidate_match_result_id?: string;  // 跨系统 trace
  client_id?: string;
  operator_id?: string;          // 真实工号,落 Communication_Log.message_sender

  // 二选一(给 AO 的简历来源)
  resume_text?: string;          // RaaS 端有就直接传(模式 A)
  resume_id?: string;            // 否则给 RaaS 端的 resume PK,AO 自己回查 partner-pg(模式 B)
  robohire_resume_id?: string;   // 或:已在 RoboHire 注册过的 Resume id(模式 C)

  // 二选一(给 AO 的 JD 来源)
  jd_text?: string;              // RaaS 端有 JD 文本就直接传(模式 A)
  // 或:无 jd_text 时,AO 用 job_requisition_id 查 partner-pg
  robohire_job_id?: string;      // 或:已在 RoboHire 注册过的 Job id

  // 面试参数(RoboHire 入参直透)
  candidate_email?: string;      // 优先用 RaaS 维护的邮箱
  recruiter_email?: string;
  job_title?: string;            // 进 GoHire 邮件标题
  company_name?: string;         // 进 GoHire 邮件 banner
  interview_language?: 'en' | 'zh' | 'ja';  // 默认 en
  interview_duration?: number;   // 分钟,> 0,默认 30
  interview_mode?: string;       // 'ai_video' 等
  passing_score?: number;        // 0-100,RoboHire-side 面试通过门槛
  interviewer_requirement?: string;  // 自由文本评估指引
  linked_assessment_id?: string;
  hiring_request_id?: string;

  // trace
  runtime_context?: { trace_id?: string; request_id?: string; workflow_id?: string };
}
```

### 5.3 RaaS 端订阅 AO 回发的事件

| AO emit | RaaS subscriber | 处理 |
|---|---|---|
| `INTERVIEW_INVITATION_SENT` | `raas-backend.interview-invitation-sync` | 更新 Application 状态为 `interview_invited`;UI 显示 login_url / qrcode_url;落 `interview_record_id` 入 partner-pg `interview` 表 |
| `INTERVIEW_INVITATION_FAILED` | 同上 | 按 `error_code` 路由:`MISSING_PAYLOAD`/`BACKFILL_FAILED` → RaaS bug,告警 dev;`ROBOHIRE_4XX`/`GOHIRE_REJECTED` → 人工介入;`ROBOHIRE_QUOTA` → 告警 ops 充值 + 暂缓邀请;`PERSISTENCE_WARNING` → 触发对账任务,不重发 |

---

## 6. 联调验证记录 — 2026-05-25 实战

### 6.1 真实 RoboHire + GoHire e2e ✓

通过 `/api/test/trigger-interview-invite` 配真实 emails 直接打到 `https://api.robohire.io`:

| 项 | 值 |
|---|---|
| candidate_email | `stevenchengxy19@gmail.com` |
| recruiter_email | `1037806649@qq.com` |
| Inngest run id | `01KSF6G4JRM00DRD2W7C54XN1N` |
| status | COMPLETED ✓ |
| 耗时 | 33s(invite-candidate API 约 30s + Neo4j 双写 < 1s) |
| login_url | `https://worker.gohire.top/sso?ssotoken=ab441a3e-...&lang=zh` |
| interview_record_id | `ivr_C-test-real-001_JR-test-real-001_inv` |
| communication_log_id | `comm_invite_C-test-real-001_JR-test-real-001_1779700373140` |
| GoHire 邮件 | 候选人邮箱实收 ✓(由用户确认) |
| `lang=zh` 透传 | ✓ payload `interview_language='zh'` 进入 URL query |
| AO emit `_SENT` | ✓ |

### 6.2 L1 在 e2e 中暴露并已修复

**第一次 e2e**(stub resume 文本)— RoboHire 返 HTTP 200 + `{success:false, error: 'upload_resume failed after 3 attempts'}`(GoHire 解析 stub PDF 失败)。

**bug** — 我的初版 catch 把这种 2xx-success-false 标 `code='SERVER'` 走 Inngest retry,3 次后 run 静默 FAILED,**RaaS 永远拿不到 `_FAILED`**。

**fix**([server/inngest/agents/interview-inviter-agent.ts:208](../server/inngest/agents/interview-inviter-agent.ts#L208)):

```ts
if (e.code === 'SERVER' && e.httpStatus >= 200 && e.httpStatus < 400) {
  return {
    ok: false as const,
    terminal: true as const,
    error_code: 'GOHIRE_REJECTED',
    error_message: `RoboHire 2xx 但 success=false: ${e.message}`,
    ...
  };
}
```

新增单测 `RoboHire 2xx 但 success=false → emit _FAILED GOHIRE_REJECTED 不重试`。

### 6.3 重要的 Inngest 行为观察

Agent 每次 step.run 完成后 Inngest **重放** function 从头到该步骤(memoized),所以 `handler.start` 在 file log 会出现多次(N 个 step.run = N 次 handler.start)。**这不是 retry,是 Inngest 的 step-replay 执行模型。** 真 retry 的标志是同一 step 多次 attempt + 60s 间隔。

---

## 7. 已知限制 & 未实现

- **L1 — Inngest retry 用尽不 emit `_FAILED`**(部分已修):2026-05-25 在 e2e 暴露后,把 2xx-success-false(GoHire 上游业务拒绝)归到 terminal。但 RoboHire **真的 5xx HTTP** 或 NETWORK 错误抛了走 Inngest retry,3 次用尽后 Inngest 把 run marked failed,**仍然不会发 `_FAILED` 事件**。Phase 2 用 Inngest `onFailure` hook 补。
- **L2 — 没做 idempotency**:同一 (candidate, JR) 反复发 `_REQUESTED` 会反复调 RoboHire;依赖 RoboHire 自己的 dedup(reused: true)。如果 RoboHire dedup 失效,会重复扣 quota。可加 AO 端 partner-pg `interview_invitation_runtime_state` 表防御。
- **L3 — `interview_model_id` 没填**:Interview_Model 是另一个 DataObject(面试策略),目前没有 agent 在写;skeleton 写法里这个字段留空,等 InterviewStrategy agent 出来后回填。
- **L4 — 没记 audit trail**:Communication_Log 已经覆盖,但若要看 RoboHire 端原始 request/response 取证,需要查 `~/.claude_logs/agents/interviewInviter/<runId>.log`(`apiCall` 自动落)。
- **L5 — fleet UI 卡片**:wsId `11-1` 现在 real,但 [components/fleet/AgentDetailContent.tsx](../components/fleet/AgentDetailContent.tsx) 是 git WIP,详情页可能未对齐。
