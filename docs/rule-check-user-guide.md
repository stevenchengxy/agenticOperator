# Rule Check 用户指南

> 范围:AO main 的 `matchResumeAgent` 在调 RAAS `/match-resume` 之前的 **LLM 预筛 gate**
> 状态:**默认关闭**(`RULE_CHECK_ENABLED=false`)。需要时通过环境变量开
> 最后更新:2026-05-11(p4 合并 — `resume-parser-agent` 子项目已并入主仓)

---

## 0. TL;DR

```
RESUME_PROCESSED                  ← upstream(RAAS 或我们)
   │
   ▼
matchResumeAgent (Inngest)
   │
   for each JD:
   │
   ├─ [gate 关] ─────────────────────────── (默认)
   │  → 直接调 RAAS /match-resume
   │
   └─ [gate 开] (RULE_CHECK_ENABLED=true)
      │
      ├─ buildRuleCheckInput()
      │    runtime_context + parsed_resume + job_requisition
      │
      ├─ 选 prompt 来源(env: RULE_CHECK_PROMPT_SOURCE)
      │    "poc"     → composePrompt()   (本地 rules.json + 三段模板)
      │    "yeyang"  → fillRuntimeInput() (静态 v4 snapshot)
      │
      ├─ runLlm() → openai/gemini (AI_BASE_URL + AI_API_KEY)
      │
      ├─ foldVerdict() — 折叠到 binary { PASS | FAIL }
      │
      ├─ PASS → emit MATCH_RULE_CHECK_PASSED → 调 RAAS /match-resume
      │        (走原链路:saveMatchResults + MATCH_PASSED_NEED_INTERVIEW)
      │
      └─ FAIL → emit RULE_CHECK_FAILED → 跳过这条 JD,不消耗 Robohire 配额
```

3 个开关 env(默认全关、全默认):

| 变量 | 默认 | 取值 | 作用 |
|---|---|---|---|
| `RULE_CHECK_ENABLED` | `false` | `true` / `false` | gate 总开关 |
| `RULE_CHECK_PROMPT_SOURCE` | `poc` | `poc` / `yeyang` | 选 prompt 来源 |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | — | URL / token / model id | LLM 网关(必填,即便 gate 关也别留空,后续打开就靠它) |

---

## 1. 我们想解决什么问题

`matchResumeAgent` 接到 `RESUME_PROCESSED` 后,默认会调 RAAS `/match-resume`(背后是 Robohire 打分)。这一步:

- **贵**:每条 JD 走一次 Robohire,消耗 token/API 配额
- **粗**:Robohire 只做"打分匹配",不识别红线/黑名单/利益冲突/婚育风险/竞业冷冻期这些 ontology 里的硬性规则

业务上有 **51 条**针对 `matchResume` action 的规则(`event_manager/Action_and_Event_Manager/ontology-lab/data/rules_20260330.json` → id 以 `10-` 开头),覆盖:
- 红线/黑名单(腾讯历史从业、华为荣耀竞对、CSI 风险离场编码)
- 硬性要求(学历、年龄、语言、性别、外籍通道限制)
- 利益冲突/婚育风险(腾讯亲属回避、女性婚育风险审视)
- 回流冷冻期(腾娱互动 6 个月、CDG 6 个月、字节友商 6 个月)
- 加分项 / 期望薪资 / 空窗期

这些规则**不应该**让 Robohire 处理(超出它的边界),应该在调 Robohire **之前**用 LLM 判一遍,**FAIL 的直接拦掉,PASS 的才进 Robohire**。这就是 rule check gate。

---

## 2. 数据流(端到端)

```
┌──────────────────────────────────────────────────────────────────────┐
│ 上游: raas_v4 backend (Hono) 通过 Inngest 发                          │
│   RESUME_PROCESSED { upload_id, candidate_id, resume_id,             │
│                     employee_id, parsed.data,                        │
│                     job_requisition_id (可选,raas 前端"关联岗位"下拉) }│
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ AO main / server/inngest/agents/match-resume-agent.ts                 │
│                                                                       │
│ Step 1: buildResumeText      ← parsed.data → string (给 RAAS 用)      │
│ Step 2: list-requirements    ← RAAS getRequirementDetail / agent-view │
│                                  (单 JD 精准 or claimer 名下全 JD)   │
│ Step 3: for each requirement:                                         │
│         ┌────────────────────────────────────────────────────────┐    │
│         │ 4.0  RULE_CHECK gate  (if isRuleCheckEnabled())        │    │
│         │      ↓                                                  │    │
│         │      runRuleCheck(input) →  { decision: PASS | FAIL }  │    │
│         │      ↓                                                  │    │
│         │      PASS  → emit MATCH_RULE_CHECK_PASSED                    │    │
│         │      FAIL  → emit RULE_CHECK_FAILED, continue          │    │
│         └────────────────────────────────────────────────────────┘    │
│         4a.   调 RAAS /match-resume (Robohire 打分)                    │
│         4b.   调 RAAS /match-results (持久化 source=need_interview)   │
│         4c.   emit MATCH_PASSED_NEED_INTERVIEW                        │
└──────────────────────────────────────────────────────────────────────┘
```

代码入口:[`server/inngest/agents/match-resume-agent.ts`](../server/inngest/agents/match-resume-agent.ts:212)。
gate 的 `if (isRuleCheckEnabled())` 是 line ~217 那块。

---

## 3. 三个 env 怎么用

### 3.1 `RULE_CHECK_ENABLED`(总开关)

```bash
# .env.local 或 Inngest cloud env
RULE_CHECK_ENABLED=false   # default,gate 完全 bypass
RULE_CHECK_ENABLED=true    # 启用 gate
```

- **每次 invocation 实时读** `process.env`,不在 worker 启动时 cache。Inngest cloud 上 toggle 后,下一次 function 调用立即生效,**不需要 redeploy / restart worker**。
- 关 = 所有 JD 直接进 Robohire(等于完全没接 rule-check)。
- 开 = 每条 JD 先跑 LLM 判,不通过的不进 Robohire。

### 3.2 `RULE_CHECK_PROMPT_SOURCE`(prompt 来源,仅 ENABLED=true 时生效)

```bash
RULE_CHECK_PROMPT_SOURCE=poc      # default
RULE_CHECK_PROMPT_SOURCE=yeyang
```

| 选项 | prompt 怎么来 | LLM 输出 schema | 状态 |
|---|---|---|---|
| `poc` | 读 `lib/rule-check/rules.json`(51 条规则)→ 按 (client_id × business_group) 过滤 → 渲染成 INPUT + RULES + OUTPUT 三段 | `{ overall_decision: KEEP\|DROP\|PAUSE, drop_reasons, pause_reasons, rule_flags, ... }` | ✓ POC 阶段已用 6 个真实场景跑通 |
| `yeyang` | 用叶洋 v4 静态 snapshot([`generated/v4/match-resume.action-object.ts`](../generated/v4/match-resume.action-object.ts)) + [`fillRuntimeInput`](../lib/ontology-gen/v4/fill-runtime-input.ts) 替换 `{{CLIENT}} / {{JOB}} / {{RESUME}}` 三个 placeholder | `{ match_results, overall_status, terminal, step_results: { step_1..4: { status, fired_rule_ids, blocking_rule_ids, ... } }, notifications }` | ⚠ adapter 集成已完成,**生产用前还需要交叉验证** |

**怎么选**:
- 默认 `poc`:5 月 11 日前 POC 阶段已用 6 个真实场景(腾讯 IEG、字节、CSI 黑名单、华为冷冻、外籍婚育、字节友商)交叉验过,4/6 准确率
- `yeyang` 是叶洋 v4 adapter 集成后的备选,prompt 写法更结构化(4 个 Step + step_results),但**还没在我们这边交叉验证过命中率**。生产打开前需要在真实数据上跑一轮对比

### 3.3 `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL`(LLM 网关)

```bash
# 走 New-API 网关(默认)
AI_BASE_URL=https://your-newapi.example/v1
AI_API_KEY=sk-...
AI_MODEL=google/gemini-3-flash-preview   # default

# 或 fallback 到 OpenAI 官方
OPENAI_API_KEY=sk-...
# 此时 baseURL = https://api.openai.com/v1,model = gpt-4o-mini
```

逻辑在 [`lib/rule-check/llm.ts`](../lib/rule-check/llm.ts):优先 New-API,fallback OpenAI。两个都没配 → 抛错。

---

## 4. POC 路径(`RULE_CHECK_PROMPT_SOURCE=poc`)

### Prompt 三段

输出格式 LLM 看到的 user prompt:

```markdown
## 1. 你的角色
你是一名简历预筛查员 ...

## 2. Inputs
### 2.1 runtime_context — 来自 RESUME_PROCESSED
{ upload_id, candidate_id, resume_id, employee_id, _derived_dimensions: { client_id, business_group, studio } }

### 2.2 resume — 来自 RESUME_PROCESSED.parsed.data
{ name, experience: [...], education: [...], skills: [...], ... }

### 2.3 job_requisition — 来自 RAAS getRequirementDetail.requirement
{ job_requisition_id, client_id, job_responsibility, must_have_skills, ... }

### 2.4 job_requisition_specification
{ priority, deadline, hsm_employee_id, ... } or null

### 2.5 hsm_feedback
{ kin_relation_result, ... } or null

## 3. Rules to check
### 3.1 通用规则 (X 条)
#### 规则 10-25: 华为荣耀竞对与客户互不挖角红线 [终止级]
**触发条件**: 候选人简历已完成解析
**判定逻辑**: 系统在简历匹配环节,自动检索 ...
**命中时的输出动作**: ...

#### 规则 10-38: 腾讯历史从业经历识别 ...
...

### 3.2 客户级规则 (本次 client_id="腾讯" — Y 条)
...

### 3.3 部门级规则 (本次 business_group="IEG", studio="天美" — Z 条)
...

## 4. 决策结算逻辑
1. 任一 rule_flags[i].result == "FAIL" → overall_decision = "DROP"
2. 否则任一 result == "REVIEW" → overall_decision = "PAUSE"
3. 否则 → overall_decision = "KEEP"

## 5. 输出格式
```json
{
  "overall_decision": "KEEP" | "DROP" | "PAUSE",
  "drop_reasons": ["<rule_id>:<short_code>"],
  "pause_reasons": [...],
  "rule_flags": [{...}],
  "resume_augmentation": "...",
  "notifications": [{...}]
}
```

### Binary 折叠

```ts
LLM 输出 overall_decision === "KEEP"  → PASS
LLM 输出 overall_decision === "DROP"  → FAIL
LLM 输出 overall_decision === "PAUSE" → FAIL  (需 HSM 复核;我们的 gate 只有二态)
LLM 解析失败                          → FAIL-safe
```

代码:[`lib/rule-check/runner.ts`](../lib/rule-check/runner.ts)。

---

## 5. 叶洋路径(`RULE_CHECK_PROMPT_SOURCE=yeyang`)

### Prompt 静态 snapshot

[`generated/v4/match-resume.action-object.ts`](../generated/v4/match-resume.action-object.ts) 是叶洋 v4 `assembleActionObjectV4_4` 离线生成的(npm script `gen:v4-snapshot`)。

p4 合并后 `lib/rule-check/yeyang-runner.ts` 直接 import:
- `matchResumeActionObject` from `@/generated/v4/match-resume.action-object`
- `fillRuntimeInput`, `MatchResumeRuntimeInput` from `@/lib/ontology-gen/v4`

不再有 vendor 拷贝步骤。主仓 snapshot 重新生成后(`npm run gen:v4-snapshot`),rule-check 自动用到最新版本。

### Prompt 形状

叶洋 snapshot 的 prompt 包含 3 个 placeholder:

```markdown
## 角色
你是 matchResume action 的执行智能体。...

## 任务
当前需要执行的 action 是 matchResume。...

## 运行时输入

### client

{{CLIENT}}                ← fillRuntimeInput 替换为 "client_name: 腾讯\ndepartment: 互动娱乐事业群"

### 招聘岗位 (Job_Requisition)

{{JOB}}                   ← 替换为 ```json ... ``` 块

### 候选人简历 (Resume)

{{RESUME}}                ← 替换为 ```json ... ``` 块

## 最终输出 JSON 结构
{
  "match_results": [...],
  "overall_status": "存在匹配岗位" | "全部不匹配",
  "notifications": [...],
  "terminal": false,
  "step_results": {
    "step_1": { status, fired_rule_ids, blocking_rule_ids, ... },
    "step_2": { ... },
    "step_3": { ... },
    "step_4": { ... }
  }
}

## 执行步骤总览
Step 1: validateRedlineAndBlacklist
Step 2: matchHardRequirements
Step 3: evaluateBonusAndCheckReflux
Step 4: generateMatchResult

(每个 Step 下面列规则原文 + 适用条件 + 判定逻辑)
```

### Runtime input 怎么拼

[`yeyang-runner.ts:buildRuntimeInput()`](../lib/rule-check/yeyang-runner.ts) 把我们的 `RuleCheckInput` 转成叶洋的 `MatchResumeRuntimeInput`:

```ts
{
  kind: "matchResume",
  client: {
    name: "腾讯",                              // normalizeClientName(jr.client_id)
    department: "互动娱乐事业群",                // BG_DISPLAY[dims.business_group] (IEG → 互动娱乐事业群)
    studio: "天美"                              // dims.studio (可选)
  },
  job: { ...jr, job_requisition_id: "..." },   // RaasRequirement 原样 + 强制 job_requisition_id
  resume: { ...parsed_resume, candidate_id }
}
```

### Binary 折叠(跟 POC 路径不同)

```ts
terminal === true                               → FAIL
overall_status === "全部不匹配"                  → FAIL
step_results.*.status === "blocked"             → FAIL
step_results.*.status === "pending_human"       → FAIL  (需人工复核,等同 POC 的 PAUSE)
LLM 解析失败                                     → FAIL-safe
其他                                             → PASS
```

`failure_reasons` 从 step_results 各 step 的 `blocking_rule_ids` + `notifications.trigger_rule_id` 汇总。

---

## 6. 输出事件 schema

定义在 [`server/inngest/client.ts`](../server/inngest/client.ts):

### `MATCH_RULE_CHECK_PASSED`

```ts
{
  upload_id: string,
  candidate_id?: string,
  resume_id?: string,
  job_requisition_id: string,
  client_id?: string,
  audit: {
    rules_evaluated: number,          // 过滤后规则数
    rules_total_in_ontology: number,  // 51
    client_id: string, business_group: string|null, studio: string|null,
    llm_decision: "KEEP" | "DROP" | "PAUSE" | "UNKNOWN",
    llm_model: string, llm_duration_ms: number,
    llm_prompt_tokens?, llm_completion_tokens?, parse_error?
  }
}
```

### `RULE_CHECK_FAILED`

```ts
{
  ...同上 + 
  failure_reasons: string[],          // ["10-25:terminal", "10-38:notify_HSM", ...]
  hit_rules: Array<{
    rule_id, rule_name, severity,
    result: "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE",
    evidence?
  }>
}
```

下游谁可以消费这两个事件?目前**没人订阅**。Operator 面板可以拉来做 dashboard / 操作员手工复审。后续也可以让 raas backend 订阅 `RULE_CHECK_FAILED` 做候选人前端可见的 explanation。

---

## 7. 开发态怎么跑

### 一键启动整套

```bash
# Terminal 1 — AO main(端口 3002)
npm install
npm run dev
# dev-bootstrap.mjs 会自动:
#  - 拷 .env.example → .env.local
#  - prisma db push (创 SQLite)
#  - 启 Inngest dev server(Docker)
# 如果 Docker 不在:warning 提示用 npm run inngest:dev

# Terminal 2 — Inngest dev server (如果 Docker 不可用)
npm run inngest:dev
# 用本地 node_modules/.bin/inngest-cli(devDep),无 @latest fetch
# 没起 inngest-cli 用本地、又没开 Docker 的话,跑一次 `npm run register`
# 把 3 个 function 推到 dev server
```

p4 合并后只有一个 Next.js app(AO main / 端口 3002),3 个 agent 一起注册。
**之前** `resume-parser-agent / 端口 3020` 的那个 terminal 不再需要。

### 触发一次 rule-check

最简单的方式:让 raas backend 发一个真实 `RESUME_DOWNLOADED` 事件(会 cascade 到 `RESUME_PROCESSED`),或者直接发 `RESUME_PROCESSED`。

```ts
// 例如从 raas v4 backend
await inngest.send({
  name: "RESUME_PROCESSED",
  data: {
    upload_id: "test-001",
    candidate_id: "C_xxx",
    resume_id: "R_xxx",
    employee_id: "E_xxx",
    job_requisition_id: "JR_xxx",       // 关联岗位
    parsed: { data: { name, experience, ... } },
    // ... transport metadata
  }
});
```

启用 gate 后,在 `http://localhost:8288`(Inngest dev UI)能看到:
1. `RESUME_PROCESSED` 进站
2. `match-resume-agent` 起步
3. **新增** `rule-check-{jr_id}` step(耗时 = LLM 延迟,通常 2-5s)
4. PASS → emit `MATCH_RULE_CHECK_PASSED` + 继续 `match-{jr_id}` step
   FAIL → emit `RULE_CHECK_FAILED`,跳过这条 JD

`match-resume-agent` 日志会打:
```
[matchResume] rule-check · job_req=JR_xxx decision=PASS llm_decision=KEEP hit_flags=0 rules_evaluated=12/51 model=google/gemini-3-flash-preview latency_ms=2150
[matchResume] ✓ MATCH_RULE_CHECK_PASSED · job_req=JR_xxx — proceed to matchResume
```

或:
```
[matchResume] rule-check · job_req=JR_xxx decision=FAIL llm_decision=DROP hit_flags=3 rules_evaluated=12/51 model=... latency_ms=...
[matchResume] ⛔ RULE_CHECK_FAILED · job_req=JR_xxx reasons=10-25:terminal,10-38:notify_HSM — skip matchResume
```

### 切换 prompt source

```bash
# .env.local
RULE_CHECK_ENABLED=true
RULE_CHECK_PROMPT_SOURCE=yeyang   # 或 poc
```

Inngest worker 不需要 restart — 下一次 invocation 立刻生效。

---

## 8. 生产部署 checklist

打开 gate 前要确认:

- [ ] `RULE_CHECK_ENABLED=true` 在 Inngest cloud env(不在 .env.local,**那是本地用**)
- [ ] `AI_BASE_URL` + `AI_API_KEY` 配置成功且有足够 token 配额
- [ ] LLM 模型(`AI_MODEL`)在新 RAAS 客户场景跑过至少 6 个交叉验证场景,准确率 ≥ 5/6
- [ ] `RULE_CHECK_PROMPT_SOURCE` 选定(`poc` 默认安全,`yeyang` 需要自己验)
- [ ] 监控:`RULE_CHECK_FAILED` 事件的命中率是否合理(预期 < 30%,否则 LLM 误杀严重)
- [ ] 回滚预案:`RULE_CHECK_ENABLED=false` 一键关闭,**不需要 redeploy**

打开方式:
1. Inngest cloud → environment → set `RULE_CHECK_ENABLED=true`
2. 等下一次 `RESUME_PROCESSED` 触发即可生效
3. 看 Inngest dashboard 里 `rule-check-*` step 的执行结果

回滚:
1. Inngest cloud → environment → 删掉 `RULE_CHECK_ENABLED` 或设回 `false`
2. 下一次 invocation 不再跑 rule-check

---

## 9. 已知 limitation

1. **POC 路径的 severity 推断不严谨** — 51 条规则里 ontology 没显式 `gating_severity` 字段,severity 是从 `standardizedLogicRule` 文本里关键词推断的(`lib/rule-check/ontology.ts:inferSeverity`)。**P0 修复路径**:让叶洋/陈洋在 Neo4j Rule 节点上加 `gating_severity` 字段,我们改成读字段而非推断。
2. **叶洋路径的 snapshot 静态化** — 跑 `npm run gen:v4-snapshot` 重新生成 `generated/v4/match-resume.action-object.ts` 后,rule-check 自动用到最新版本(p4 合并后已直接 import,无 vendor 拷贝)。如果 ontology 在 Neo4j 改了但忘了重新生成 snapshot,LLM 看到的还是旧 rule。更优解:rule-check 改用 `generatePrompt()` live 调 Ontology API(`:3500`),但有 HTTP 延迟代价
3. **3-state 简并为 binary** — POC 的 PAUSE / 叶洋的 pending_human 都被折叠成 FAIL。后续如果需要"暂停而非拒绝",要扩 `RuleCheckVerdict.decision` 为三态 + 加 `RULE_CHECK_PAUSED` 事件
4. **没有 Neo4j 实例存储** — 现在 rule-check 决策只 emit Inngest 事件,**不落到 Neo4j 做长期审计**。落实例数据的计划见 [neo4j-instance-storage-plan.md](./neo4j-instance-storage-plan.md)(走 Ontology API,不直连 Neo4j)
5. **不做 Robohire 边界外打分** — 严格遵守:rule-check 只判 PASS/FAIL,不出匹配分。打分仍然是 Robohire 的活,PASS 后才进 `/match-resume`

---

## 10. 文件索引

| 路径 | 作用 |
|---|---|
| [`lib/rule-check/index.ts`](../lib/rule-check/index.ts) | 公开 API:`buildRuleCheckInput`、`runRuleCheck`、types |
| [`lib/rule-check/runner.ts`](../lib/rule-check/runner.ts) | 主入口 + POC 路径(`composePrompt` + KEEP/DROP/PAUSE 折叠) |
| [`lib/rule-check/yeyang-runner.ts`](../lib/rule-check/yeyang-runner.ts) | 叶洋路径(`fillRuntimeInput` + terminal 折叠) |
| [`generated/v4/match-resume.action-object.ts`](../generated/v4/match-resume.action-object.ts) | 叶洋 v4 静态 snapshot(yeyang-runner 直接 import) |
| [`lib/ontology-gen/v4/`](../lib/ontology-gen/v4/) | 叶洋 v4 adapter:`generatePrompt` / `fillRuntimeInput` / `MatchResumeRuntimeInput` 类型 |
| [`lib/rule-check/ontology.ts`](../lib/rule-check/ontology.ts) | rules.json 加载 + 过滤 + classify + severity 推断 + dims 提取 |
| [`lib/rule-check/prompt.ts`](../lib/rule-check/prompt.ts) | POC composer:INPUT + RULES + OUTPUT 三段 |
| [`lib/rule-check/llm.ts`](../lib/rule-check/llm.ts) | LLM gateway picker(新 API / OpenAI) |
| [`lib/rule-check/rules.json`](../lib/rule-check/rules.json) | 51 条 matchResume 规则(来自 ontology-lab) |
| [`lib/rule-check/types.ts`](../lib/rule-check/types.ts) | RuleCheckInput / Verdict / 审计 |
| [`server/inngest/agents/match-resume-agent.ts`](../server/inngest/agents/match-resume-agent.ts) | gate 接入点(`isRuleCheckEnabled()`) |
| [`server/inngest/client.ts`](../server/inngest/client.ts) | `MATCH_RULE_CHECK_PASSED` / `RULE_CHECK_FAILED` 事件 schema |
| [`lib/ontology-gen/v4/generate-prompt.ts`](../lib/ontology-gen/v4/generate-prompt.ts) | 主仓:叶洋 v4 canonical `generatePrompt` async entry |
| [`generated/v4/match-resume.action-object.ts`](../generated/v4/match-resume.action-object.ts) | matchResume 静态 snapshot(p4 合并后 yeyang-runner 直接 import) |
| [`scripts/rule-check-poc/`](../scripts/rule-check-poc/) | POC 历史:6 个场景 + 主仓真实 Neo4j 跑通的脚本 |
| [`docs/yeyang-prompt-adapter-onboarding.md`](./yeyang-prompt-adapter-onboarding.md) | 给叶洋写的 adapter onboarding(他基于此交付了 v4) |

---

## 11. 改这块代码的时候要注意什么

- **Gate 默认 false** — 别在代码里硬编码 `true`。所有切换走 env。
- **每次 invocation 实时读 env** — 不要用模块顶层 `const RULE_CHECK_ENABLED = ...`(Inngest worker 会 cache)。用 `function isRuleCheckEnabled()` 这种 getter
- **PASS 路径必须 emit `MATCH_RULE_CHECK_PASSED`** — 不只是为了审计,Operator 面板要用它做"已通过 gate 但还没匹配到岗位"的状态展示
- **FAIL 路径必须 `continue;`** — 不能直接 `return`,因为外层 for-loop 还有其他 JD 要处理
- **`buildRuleCheckInput()` 不要假设字段一定有** — `resume_id` / `filename` 都可能缺,用兜底
- **LLM 调用 retry** — 不要自己加 retry,让 Inngest `step.run()` 的 retry 机制托管
- **审计字段不能漏** — `audit.dims` / `llm_model` / `llm_duration_ms` 是 Operator 面板必读字段
