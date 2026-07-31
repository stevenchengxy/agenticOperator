# Rule-Check 合并 + 事件改名 + 重派 — 设计文档

> 作者: Claude(代 Steven)
> 日期: 2026-05-19
> 状态: 待 user review(写完直接走 user gate,不派 reviewer per user preference)
>
> **前置 spec(已并 main)**:
> - [2026-05-19-rule-check-independent-agent-design.md](./2026-05-19-rule-check-independent-agent-design.md) — rule-check 独立化 + RoboHire 直连
> - [2026-05-19-raas-integration-divergence-fixes-design.md](./2026-05-19-raas-integration-divergence-fixes-design.md) — F1-F4 + 方案 B
>
> **本 spec 显式覆盖**:
> - 老 spec §2.3 "方案 A — matchResumeAgent 双段订阅" → 改为 "ruleCheckAgent 吸收 matchResume 第一段"
> - 老 spec §5.3 / §5.4 / §5.6 + raas-divergence spec §4.5 的事件名,全部按 `neo4j_data/actions_v0_1_002.json` 10-1 / 10-2 重命名

---

## 0. 一句话目标

按 partner `actions_v0_1_002.json` 10-1(`ruleCheckForMatchResume`)+ 10-2(`matchResume`)对齐本仓的 Inngest 函数边界:**ruleCheckAgent 直接订阅 `RESUME_PROCESSED` + `CANDIDATE_REASSIGNED`**,把原属 matchResumeAgent 第一段的"thin 回拉 + JR 列表收敛 + 派发"全部并进来;matchResumeAgent 收敛成只订阅 `MATCH_RULE_CHECK_PASSED`,只做 RoboHire match + 落库 + 三档 MATCH_* 分发。

---

## 1. 为什么改

### 1.1 partner action 元数据是 source of truth

[neo4j_data/actions_v0_1_002.json](../../../neo4j_data/actions_v0_1_002.json):

| Action | trigger | triggered_event |
|---|---|---|
| **10-1** `ruleCheckForMatchResume` | `RESUME_PROCESSED` | `MATCH_RULE_CHECK_PASSED` / `MATCH_RULE_CHECK_FAILED` |
| **10-2** `matchResume` | `MATCH_RULE_CHECK_PASSED` | `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED` |

我们现在用的:`RESUME_PROCESSED` → matchResume(1st) → `RULE_CHECK_REQUESTED` → ruleCheckAgent → `RULE_CHECK_PASSED` → matchResume(2nd) → `MATCH_*`。多了一层 `RULE_CHECK_REQUESTED` 中转事件 + 函数边界跟 action 元数据对不上(同一函数订阅两个事件做两件不同的事 = monitor / instance tracking 拆分难)。

### 1.2 候选人后期重派要自动跑

**业务场景**:候选人首轮匹配失败/挂起后,招聘人员把简历从 JR-A 重派到 JR-B,需要自动走一遍 rule-check + match 而不是再让人手点。

**实现路径** — 不需要新事件名,**partner 重发 `RESUME_PROCESSED`** 就够了:
- payload 里 `job_requisition_id` 填新关联的 JR(路径 A)
- 本 spec 改完之后 ruleCheckAgent 已经订阅 `RESUME_PROCESSED`,**零额外订阅**
- audit trace 看 `candidate_id` × `timestamp` × `job_requisition_id` 自然区分"首次 parse"和"重派"

**fallback**:partner divergence doc §F1 提过 `CANDIDATE_REASSIGNED` 也属于 thin 事件家族。只在两种情况下用它:
1. `RESUME_PROCESSED` 在 partner 端不 idempotent(重发会触发 partner 自己的副作用,比如重写 Candidate row)
2. partner 明确想在 audit / instance 分组上把"重派"跟"首次处理"拆开

agent 这边的兜底实现:加一个 `{event: 'CANDIDATE_REASSIGNED'}` trigger,共用同一 handler,payload shape 视为 RESUME_PROCESSED 兼容(本 spec 在 §4.3 给出字段契约)。

### 1.3 双段订阅在 Inngest UI 上读不清

`matchResumeAgent` 同函数订阅 `RESUME_PROCESSED` + `RULE_CHECK_PASSED`,monitor 页两条 run 都挂在同一个 function id 下,instance tracking 必须靠 if-event-name 分支,事件分歧后看不出谁触发谁。拆开后 ruleCheckAgent / matchResumeAgent 各一个职责。

---

## 2. After 架构

### 2.1 事件流(取代老 spec §2.1 After 图)

```
1) HR submits requirement
   RAAS publish REQUIREMENT_LOGGED
     ↓
2) createJdAgent (不变 — 已 F4)
   ├─ RAAS GET /requirements/:id
   ├─ ⭐ RoboHire POST /jobs/generate-jd
   ├─ RAAS POST /jd/sync-generated
   └─ emit JD_GENERATED

3) HSM uploads resume
   RAAS publish RESUME_DOWNLOADED
     ↓
4) resumeParserAgent (不变 — 已 PR-3)
   ├─ RAAS GET /resumes/uploads/:id/raw
   ├─ ⭐ RoboHire POST /parse-resume
   ├─ RAAS POST /candidates
   └─ emit RESUME_PROCESSED
     ↓
5) ⭐ ruleCheckAgent — workflow node 10-1
   订阅: RESUME_PROCESSED  (重派场景由 partner 重发该事件触发;
                            如果 partner 走 CANDIDATE_REASSIGNED 路径,
                            再加一个 trigger,见 §4.3)
   ├─ (F1) 拿 parsed.data:
   │    缺失 → RAAS GET /candidates/:id/resumes/:rid/parsed
   │    已有 → 直接用(向后兼容厚事件)
   ├─ JR 列表收敛:
   │    路径 A (event.job_requisition_id 存在)
   │      → RAAS GET /requirements/:id
   │    路径 B
   │      → RAAS GET /requirements/agent-view?claimer=&resume_filename=  (F2)
   ├─ for each JR:
   │    runRuleCheck(Ontology + Neo4j + LLM)
   │    if PASS    → emit MATCH_RULE_CHECK_PASSED  (carries jr + parsed)
   │    if FAIL/REVIEW → emit MATCH_RULE_CHECK_FAILED (F3 平铺 payload)
   └─ side-effects (per actions JSON 10-1): RAAS POST /match-results 写 rule_check_*
     ↓ (PASS 路径)
6) ⭐ matchResumeAgent — workflow node 10-2
   订阅: MATCH_RULE_CHECK_PASSED
   ├─ ⭐ RoboHire POST /match-resume
   ├─ RAAS POST /match-results (更新整体 match 字段)
   ├─ score 阈值分发 (不变 — 已 F3):
   │    > 90 → MATCH_PASSED_NO_INTERVIEW
   │    [50,90] → MATCH_PASSED_NEED_INTERVIEW
   │    < 50 → MATCH_FAILED
   └─ emit MATCH_*  (F3 顶层平铺 candidate_id / matching_score / upload_id / JR_id)
     ↓
7) RAAS auto-invitation dispatcher 消费 MATCH_PASSED_NEED_INTERVIEW
```

### 2.2 边界精确表(取代老 spec §2.2 — 仅函数职责变动行)

| 操作 | Before(当前 main) | After(本 spec) |
|---|---|---|
| F1 thin 回拉 | matchResumeAgent 1st seg | **ruleCheckAgent** |
| 路径 A `GET /requirements/:id` | matchResumeAgent 1st seg | **ruleCheckAgent** |
| 路径 B `GET /requirements/agent-view` | matchResumeAgent 1st seg | **ruleCheckAgent** |
| `for each JR` runRuleCheck | ruleCheckAgent(从 `RULE_CHECK_REQUESTED` 串行触发) | **ruleCheckAgent**(自己 fan-out 自己 for-loop / step.run 并行) |
| RoboHire `POST /match-resume` | matchResumeAgent 2nd seg | **matchResumeAgent**(唯一职责) |
| `POST /match-results` 落 rule_check_* | ruleCheckAgent 当前不落 | **ruleCheckAgent** 落(actions JSON 10-1 side-effect) |
| `POST /match-results` 落 overall_match_* | matchResumeAgent 2nd seg | **matchResumeAgent**(不变) |

---

## 3. 事件改名 + 删除

### 3.1 删除

| 事件名 | 原用途 | 删除原因 |
|---|---|---|
| `RULE_CHECK_REQUESTED` | matchResume 1st → ruleCheckAgent 中转 | ruleCheckAgent 直接订阅 `RESUME_PROCESSED` 后没人发它 |
| `RULE_CHECK_PASSED` | ruleCheckAgent → matchResume 2nd 中转 | 改名 `MATCH_RULE_CHECK_PASSED`(see 3.2) |
| `RULE_CHECK_FAILED` | (老老 spec 设计;raas-divergence §4.5 已经废弃,改 emit `MATCH_FAILED`) | 改名 `MATCH_RULE_CHECK_FAILED`(see 3.3) |

### 3.2 新增 / 改名 — `MATCH_RULE_CHECK_PASSED`

Payload 完全沿用现在 `RuleCheckPassedData` 形状(jr + parsed + runtime_context 透传),只改事件名:

```ts
// server/inngest/client.ts
export type MatchRuleCheckPassedData = {
  upload_id: string;
  candidate_id: string | null;       // 改 string|null 统一(原 string + optional)
  resume_id: string | null;
  job_requisition_id: string;
  client_id: string;
  audit: RuleCheckAuditMeta;
  // 透传给 matchResumeAgent (10-2):
  job_requisition: Record<string, unknown>;
  parsed_resume: Record<string, unknown> | null;
  runtime_context: RuleCheckRequestedData['runtime_context']; // 沿用,后面会改名
  employee_id: string;
};
```

事件名常量:`'MATCH_RULE_CHECK_PASSED'`(全大写下划线,跟 raas 风格一致)。

### 3.3 新增 — `MATCH_RULE_CHECK_FAILED`

raas-divergence spec §4.5 当时(方案 B)让 ruleCheck FAIL → `MATCH_FAILED`,意图是让 partner auto-invitation dispatcher 在 rule-check 阶段失败时也能消费。但 actions JSON 10-1 显式把 rule-check 失败列成独立事件名 `MATCH_RULE_CHECK_FAILED` — 跟最终 match 失败的语义分开。本 spec 改回去:

```ts
export type MatchRuleCheckFailedData = MatchEventData & {
  // MatchEventData 已经平铺 candidate_id / matching_score / upload_id / job_requisition_id
  // matching_score 在 rule-check 阶段必然 null(还没跑过 RoboHire match)
  // data 字段塞 { rule_check_decision: 'FAIL'|'REVIEW', failed_rules, audit }
};
```

**partner dispatcher 影响**:partner 的 auto-invitation dispatcher 不消费 `MATCH_RULE_CHECK_FAILED` — 这是设计;rule-check 失败 ≠ match 失败,前者不该触发"通知 HR 走人工 review"以外的下游路径。如果 partner 那边想看 rule-check 失败的事件,他们订阅这个事件名即可(payload 平铺过,信息量足够)。

> ⚠️ **删除 raas-divergence §4.5 plan B**:rule-check FAIL/REVIEW 不再 emit `MATCH_FAILED`,改 emit `MATCH_RULE_CHECK_FAILED`。这个事件名 partner action 表里有,他们订或不订都不影响主链路。

### 3.4 事件名总表(改后)

| 事件 | producer | consumer(本仓) | 备注 |
|---|---|---|---|
| `REQUIREMENT_LOGGED` | raas | createJdAgent | 不变 |
| `JD_GENERATED` | createJdAgent | raas | 不变 |
| `RESUME_DOWNLOADED` | raas | resumeParserAgent | 不变 |
| `RESUME_PROCESSED` | resumeParserAgent / raas(重派时重发) | **ruleCheckAgent** | trigger 从 matchResume 换到 ruleCheck;同事件支撑首发 + 重派 |
| `CANDIDATE_REASSIGNED` | raas(可选)| ruleCheckAgent(可选 trigger) | 仅在 RESUME_PROCESSED 不 idempotent 时启用 |
| `MATCH_RULE_CHECK_PASSED` | **ruleCheckAgent** | matchResumeAgent | 改名(原 RULE_CHECK_PASSED) |
| `MATCH_RULE_CHECK_FAILED` | **ruleCheckAgent** | (partner 可订)| 改名(原 RULE_CHECK_FAILED / 短暂的 MATCH_FAILED) |
| `MATCH_PASSED_NO_INTERVIEW` | matchResumeAgent | raas dispatcher | 不变(已 F3) |
| `MATCH_PASSED_NEED_INTERVIEW` | matchResumeAgent | raas dispatcher | 不变(已 F3) |
| `MATCH_FAILED` | matchResumeAgent | raas dispatcher | 只在 RoboHire match 阶段 < 50 / 调用失败 时发 — rule-check 失败不再用这个 |

---

## 4. 函数改造细节

### 4.1 `ruleCheckAgent`(吸收 matchResume 1st)

**新签名**:

```ts
inngest.createFunction(
  {
    id: 'rule-check-agent',
    name: 'Rule Check Agent (workflow node 10-1)',
    retries: 1,
    triggers: [
      { event: 'RESUME_PROCESSED' },
      // 重派场景 fallback — 只在 partner 不 idempotent / 想拆 audit 时启用
      // { event: 'CANDIDATE_REASSIGNED' },
    ],
  },
  async (ctx) => ruleCheckAgentHandler(ctx),
);
```

**handler 逻辑**(伪代码):

```ts
async function ruleCheckAgentHandler({ event, step, logger }) {
  // 1. unwrap envelope + 提取 anchor 字段
  const data = unwrapEvent(event.data);
  const { upload_id, candidate_id, resume_id, employee_id, filename, linkedJrId } = pickAnchors(data);
  const traceId = getTraceId(event.data);

  // 2. (F1) parsed.data: 先看事件,缺则回拉
  let parsedData = pickParsedFromEvent(data);
  if (!parsedData) {
    parsedData = await step.run('fetch-parsed-resume', () =>
      getParsedResume(candidate_id, resume_id, { traceId }).then(r => r.data ?? {})
    );
  }

  // 3. JR 列表收敛
  const requirements = await step.run('list-requirements', async () => {
    if (linkedJrId) {
      // 路径 A
      const detail = await getRequirementDetail(linkedJrId, { traceId });
      return [mergeReqSpec(detail)];
    } else {
      // 路径 B — agent-view + filename (F2)
      const r = await getRequirementsAgentView(
        { claimer_employee_id: employee_id, resume_filename: filename },
        { traceId },
      );
      return (r.items ?? []).filter(isRecruiting).filter(hasMatchableContent);
    }
  });

  if (requirements.length === 0) return { ok: true, requested_count: 0, reason: 'no-matchable-requirements' };

  // 4. for each JR: runRuleCheck → emit
  const bypass = process.env.RULE_CHECK_BYPASS === 'true';
  let passed = 0, failed = 0;

  for (const req of requirements) {
    const jrid = pickRequisitionId(req);
    if (!jrid) continue;
    const stepKey = sanitize(jrid);

    if (bypass) {
      // bypass: 直接 emit MATCH_RULE_CHECK_PASSED
      await emitPassed(step, { ...buildPassedPayload(req, parsedData, /*audit=bypass*/) });
      passed++;
      continue;
    }

    // 跑 rule-check
    const result = await step.run(`rule-check-${stepKey}`, () =>
      runRuleCheck(buildRuleCheckInput({ runtime_context, parsed_resume: parsedData, job_requisition: req })),
    );

    // side-effect: raas POST /match-results 写 rule_check_*
    await step.run(`persist-rule-check-${stepKey}`, () =>
      saveMatchResults({ ...ruleCheckResultPayload(result, req, candidate_id, upload_id) }, { traceId })
    );

    if (result.decision === 'PASS') {
      await step.sendEvent(`emit-passed-${stepKey}`, {
        name: 'MATCH_RULE_CHECK_PASSED',
        data: buildPassedPayload(req, parsedData, result.audit, /*employee_id, runtime_context*/),
      });
      passed++;
    } else {
      await step.sendEvent(`emit-failed-${stepKey}`, {
        name: 'MATCH_RULE_CHECK_FAILED',
        data: buildFailedPayload(result, req, candidate_id, upload_id),
      });
      failed++;
    }
  }

  return { ok: true, requested_count: requirements.length, passed, failed };
}
```

**与现在 ruleCheckAgent 的差异**(明确改动):

| 模块 | Before | After |
|---|---|---|
| trigger | `RULE_CHECK_REQUESTED` | `RESUME_PROCESSED` + `CANDIDATE_REASSIGNED` |
| F1 回拉 | matchResume 第一段做 | **本函数做** |
| JR 列表收敛 | matchResume 第一段做 | **本函数做** |
| for-loop 处理多 JR | 不存在(单 JR 单次触发) | **本函数 step.run 串行处理(N 条 JR)** |
| `POST /match-results` 写 rule_check_* | 不写(老 spec §7 故意不落) | **写**(actions JSON 10-1 side-effect) |
| PASS 路径事件名 | `RULE_CHECK_PASSED` | `MATCH_RULE_CHECK_PASSED` |
| FAIL/REVIEW 路径事件名 | `MATCH_FAILED`(plan B) | `MATCH_RULE_CHECK_FAILED` |

### 4.2 `matchResumeAgent`(收敛成只做 2nd seg)

```ts
inngest.createFunction(
  {
    id: 'match-resume-agent',
    name: 'Match Resume Agent (workflow node 10-2)',
    retries: 2,
    triggers: [{ event: 'MATCH_RULE_CHECK_PASSED' }],
  },
  handleMatchRuleCheckPassed,  // 重命名自 handleRuleCheckPassed
);
```

**handler 逻辑**:跟现在的 `handleRuleCheckPassed` 完全一样,改 input type 为 `MatchRuleCheckPassedData` + 删 `handleResumeProcessed`(整段移到 ruleCheckAgent)+ 删 `if (event.name === ...)` 分支。

### 4.3 重派场景 — 首选方案 + fallback

**首选方案**:partner 在重派时直接**重发 `RESUME_PROCESSED`**(payload 里 `job_requisition_id` 填新 JR)。
- agent 这边无任何额外订阅或代码改动 — 现有 trigger + path-A 逻辑天然支持
- 前置条件:partner 端 `RESUME_PROCESSED` 必须 idempotent(重发不会重复写 Candidate / Resume 行)

**fallback `CANDIDATE_REASSIGNED`** — 启用条件:
1. partner 端 `RESUME_PROCESSED` 不 idempotent
2. 或 partner 想在 audit / instance 分组上明示"重派"跟"首次处理"分开

事件 payload 契约(跟 RESUME_PROCESSED thin 同一族):

```jsonc
{
  "candidate_id": "string",          // ★ 必有
  "resume_id":    "string",          // ★ 必有
  "upload_id":    "string | undefined",
  "employee_id":  "string",          // ★ 必有(claimer)
  "filename":     "string | undefined",
  "job_requisition_id": "string | null | undefined",
  //   - 有值  → 路径 A(精准匹配新关联 JR)
  //   - 缺/null → 路径 B(走 agent-view 找 JR)
  "parsed": { "data": { ... } }       // 通常缺失,触发 F1 回拉
}
```

启用 fallback 后 agent 这边的改动 = 一行 trigger:`{ event: 'CANDIDATE_REASSIGNED' }`,共用同一 handler。

> **决策待 partner 确认**:发邮件/IM 问 zyj — RESUME_PROCESSED 是否 idempotent?如是 → 首选方案;如否 → fallback。本 spec 默认按首选方案落码,fallback trigger 注释保留方便后续启用。

### 4.4 bypass 机制

`RULE_CHECK_BYPASS=true` 改成在 ruleCheckAgent 内 short-circuit:跳过 `runRuleCheck`,跳过 rule-check side-effect 写库,直接 emit `MATCH_RULE_CHECK_PASSED`(audit 字段 `rule_source='bypass'` + `fail_reason='bypassed'`)。

---

## 5. type / schema 变更

### 5.1 `server/inngest/client.ts`

```diff
- export type RuleCheckRequestedData = { ... };   // 删
- export type RuleCheckPassedData    = { ... };   // 改名
- // (RuleCheckFailedData 已经在 raas-divergence 时删过了)
+ export type MatchRuleCheckPassedData = { ... }; // 上面 §3.2 形状
+ export type MatchRuleCheckFailedData = MatchEventData;  // §3.3
```

注:`MatchRuleCheckPassedData.runtime_context` 内嵌的形状不变;给它单独起 type:

```ts
export type RuleCheckRuntimeContext = {
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  employee_id: string;
  filename?: string;
  received_at?: string;
  trace_id?: string | null;
};
```

### 5.2 `server/em/schemas/builtin.ts`

如果该文件里有 `RULE_CHECK_PASSED` / `RULE_CHECK_REQUESTED` / `RULE_CHECK_FAILED` 的 zod schema,改名 / 删除对应条目;`MATCH_FAILED` schema 不变(只是产生它的函数边界变了)。

### 5.3 `lib/events-catalog.ts`(`/events` 页 chrome 用)

老 spec / raas-divergence 里都没改这个 catalog。这次必须同步 — `/events` 是 demo 用的事件目录,事件名得跟实际 emit 的对齐。把 `RULE_CHECK_*` 三条改成 `MATCH_RULE_CHECK_PASSED` / `MATCH_RULE_CHECK_FAILED`(删 `_REQUESTED`),`CANDIDATE_REASSIGNED` 加一条。

---

## 6. UI 影响

| 组件 | 改动 |
|---|---|
| `/monitor` Run / `/live` 时间线 | event-name 列直接显示新名字 — 无代码改动,只是 demo data / fixture 要刷一遍 |
| `/events` 目录 | 见 §5.3 |
| `/rule-check` 评估页 | 不影响 — 评估页用 `lib/rule-check/runner.ts`,不依赖事件名 |
| `/workflow` 节点图 | `WorkflowContent.tsx` 把 10-1 / 10-2 节点的事件标签更新;边的指向不变 |

---

## 7. 测试改造

| 文件 | 改动 |
|---|---|
| `server/inngest/agents/rule-check-agent.test.ts` | 大改:input event 改 `RESUME_PROCESSED`;mock RAAS API client 的 `getParsedResume` / `getRequirementsAgentView` / `getRequirementDetail` / `saveMatchResults`;assert emit `MATCH_RULE_CHECK_PASSED` / `MATCH_RULE_CHECK_FAILED` |
| `server/inngest/agents/match-resume-agent.test.ts`(若存在)| 删第一段测试;只留 `MATCH_RULE_CHECK_PASSED` 触发 → RoboHire match → emit MATCH_* 三档 |
| `lib/rule-check/runner.test.ts` | 不动 — runner 不读事件 |
| 新加 `server/inngest/agents/rule-check-agent.reassign.test.ts` | 仅测 `CANDIDATE_REASSIGNED` 触发的 path-A / path-B |

### 7.1 E2E smoke(用户手工跑)

1. 发一条 `RESUME_PROCESSED`(thin,无 parsed.data,无 job_requisition_id)
   - 期望:ruleCheckAgent 拉 parsed → agent-view 拿 JR 列表 → 每条 JR 跑 rule-check → emit `MATCH_RULE_CHECK_*` → matchResumeAgent 接 `MATCH_RULE_CHECK_PASSED` → emit `MATCH_*`
2. 发一条 `RESUME_PROCESSED`(thin,带 `job_requisition_id`)
   - 期望:ruleCheckAgent 走路径 A,单条 JR 跑 rule-check
3. 发一条 `CANDIDATE_REASSIGNED`(带 `job_requisition_id` = 新 JR)
   - 期望:同 #2 路径 A,跑完进 matchResumeAgent

---

## 8. 迁移顺序 / 部署窗口

| 阶段 | 内容 | 风险 |
|---|---|---|
| **0. 准备** | client.ts 加新 types(`MatchRuleCheckPassedData` / `MatchRuleCheckFailedData`)— 不删老 types | 0 |
| **1. ruleCheckAgent 改造** | 新订阅 RESUME_PROCESSED + CANDIDATE_REASSIGNED;同时**保留**对 `RULE_CHECK_REQUESTED` 的订阅(为部署窗口兼容)| 低 — 双订阅期间老路径 matchResume(1st)→`RULE_CHECK_REQUESTED`→ruleCheck 仍工作 |
| **2. matchResumeAgent 改造** | 删第一段,只订 `MATCH_RULE_CHECK_PASSED`;**保留**老 `RULE_CHECK_PASSED` 订阅一个 release | 中 — 部署窗口内两种事件名都接 |
| **3. ruleCheckAgent 切 emit** | PASS 改 emit `MATCH_RULE_CHECK_PASSED`(不再发 `RULE_CHECK_PASSED`);FAIL 改 emit `MATCH_RULE_CHECK_FAILED` | 中 — ruleCheck 出口换 |
| **4. 清理** | (a) 删 matchResumeAgent 的 `RESUME_PROCESSED` 订阅 + 第一段代码 (b) 删 ruleCheckAgent 的 `RULE_CHECK_REQUESTED` 订阅 (c) 删 `RuleCheckRequestedData` / `RuleCheckPassedData` types | 低 — 流量已切走 |

**单 PR 也可以**(用户当前只有 demo 不要走部署窗口):合并 1-4 一次性走;那就同 PR 改 ruleCheckAgent + matchResumeAgent + client.ts + tests + i18n + events-catalog,**老的 `RULE_CHECK_REQUESTED` / `RULE_CHECK_PASSED` 事件直接删,不留兼容期**。

> **本仓库决策**:走单 PR 一次性切。理由 — agentic-operator 是 frontend demo + 单 Inngest dev runtime,没有线上流量,不需要部署窗口;留兼容期反而留死代码。

---

## 9. 风险表(取代老 spec §10 相关行)

| 风险 | 严重度 | 兜底 |
|---|---|---|
| `CANDIDATE_REASSIGNED` payload 字段跟 partner 改后不一致 | 中 | 在 unwrap 函数里用 fallback 链(`candidate_id ?? candidateId ?? data.payload.candidate_id`)— 跟 `RESUME_PROCESSED` 同套兼容 |
| `runRuleCheck` 对一条 resume × N 条 JR 串行跑太慢 | 中 | step.run 改 parallel(Inngest 4 支持多 step 并发);先串行 ship,有性能问题再切并行 |
| `RAAS POST /match-results` 在 ruleCheckAgent 阶段写空 score 误导 dashboard | 低 | payload 只写 `rule_check_result` / `rule_check_reason`,不写 overall_*;raas 端 schema 允许 partial update |
| Partner 还没准备好订阅 `MATCH_RULE_CHECK_FAILED` | 低 | 它就是 fire-and-forget;partner 那边不订也不影响主链路(matchResume 完全不读它)|
| `/events` catalog / `/workflow` 节点图 fixture data 过时 | 低 | demo 用,改 fixture 即可,无运行时影响 |

---

## 10. 实施清单(给执行者)

```
[ ] Step 1: types
    [ ] server/inngest/client.ts: 加 MatchRuleCheckPassedData + MatchRuleCheckFailedData;删 RuleCheckRequestedData + RuleCheckPassedData
    [ ] 检查 zod schema (server/em/schemas/builtin.ts) — 改名 / 加 / 删

[ ] Step 2: ruleCheckAgent 重写
    [ ] triggers 改 [{event:'RESUME_PROCESSED'},{event:'CANDIDATE_REASSIGNED'}]
    [ ] 从 match-resume-agent.ts 移植 handleResumeProcessed 主体(F1 回拉 + JR 列表收敛 + path-A/B 分支)
    [ ] for-loop 包住原本的 runRuleCheck step
    [ ] 加 persist-rule-check step (POST /match-results 写 rule_check_*)
    [ ] emit 名改 MATCH_RULE_CHECK_PASSED / MATCH_RULE_CHECK_FAILED
    [ ] bypass 路径同步改名
    [ ] sanitize / unwrap helper 从 match-resume-agent 拷贝过来

[ ] Step 3: matchResumeAgent 收敛
    [ ] triggers 改 [{event:'MATCH_RULE_CHECK_PASSED'}]
    [ ] 删 handleResumeProcessed + 所有 helper 只在第一段用的
    [ ] 把 handleRuleCheckPassed 改名 handleMatchRuleCheckPassed (event.data 类型换 MatchRuleCheckPassedData)
    [ ] 验证第二段 helper (extractMatchingScore / decideMatchEvent / saveMatchResults) 一行不动

[ ] Step 4: 注册 + catalog
    [ ] server/inngest/functions.ts (或 register 入口) 确认 ruleCheckAgent + matchResumeAgent 都注册
    [ ] lib/events-catalog.ts: RULE_CHECK_* → MATCH_RULE_CHECK_*; 加 CANDIDATE_REASSIGNED
    [ ] components/workflow/WorkflowContent.tsx: 节点 label + edge 标签

[ ] Step 5: 测试
    [ ] rule-check-agent.test.ts 改写 (mock RAAS getParsedResume / getRequirementsAgentView / getRequirementDetail / saveMatchResults)
    [ ] match-resume-agent.test.ts 删第一段 case
    [ ] 加 rule-check-agent.reassign.test.ts (CANDIDATE_REASSIGNED path-A / path-B)
    [ ] npm run build (TypeScript + lint)
    [ ] npx vitest run

[ ] Step 6: 手测
    [ ] Inngest dev: 发 RESUME_PROCESSED (thin) → 全链路通
    [ ] Inngest dev: 发 CANDIDATE_REASSIGNED (path-A) → ruleCheckAgent 跑 + emit
    [ ] /monitor 页面看新事件名渲染正确
```

---

## 11. 一句话总结

把"`matchResumeAgent` 第一段拉 JR + thin 回拉 + emit `RULE_CHECK_REQUESTED`"整段并进 `ruleCheckAgent`;后者改订 `RESUME_PROCESSED` + 新增 `CANDIDATE_REASSIGNED`;事件出口按 actions_v0_1_002 10-1 改名 `MATCH_RULE_CHECK_PASSED` / `MATCH_RULE_CHECK_FAILED`;`matchResumeAgent` 收敛成只订 `MATCH_RULE_CHECK_PASSED`,只做 RoboHire match + 三档 MATCH_* 分发。
