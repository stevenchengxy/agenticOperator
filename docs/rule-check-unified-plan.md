# Rule Check 统一方案 — 综合 POC + 叶洋 v4 + Kenny 5 点

> 目标:把 POC 路径(reasoning + evidence + 完整覆盖)和叶洋 v4 路径
> (ontology codegen + actionSteps 对齐)的优点合到一条新路径上,落地 Kenny 的 5 步设想。
>
> 最后更新:2026-05-11

---

## 0. Kenny 5 点 + 我们的对应方案

| Kenny 原话 | 我们要做的 |
|---|---|
| **1. Get rules for matching resume from ontology and output as a user prompt in markdown format, specifying CSI rules and client rules.** | 用叶洋 `generatePrompt` live 调 Ontology API 拿 rule 列表,**输出 prompt 时显式按"CSI 通用 / 客户级 / 部门级"分组**(POC 的 `RuleClassifierAgent` 逻辑)。模板 source-of-truth 走 ontology codegen,改了一键重生。 |
| **2. Then we can try to use partial parsed resume data to run a rules check again (1).** | LLM 评估时只发**评估这批规则需要的最小字段**(per rule_id → required resume fields 映射)。减少 token + 减少注意力分散。 |
| **3. Augment the resume with rule check flags.** | LLM 输出强制带 `resume_augmentation` markdown 段(POC schema 已有),里面列 rule_id + evidence + severity。这段在调 Robohire 时**注入到 resume 字段顶部**。 |
| **4. Calls RoboHire match-resume api to do core resume matching.** | 仅当 `overall_decision=KEEP` 时调 Robohire。`/match-resume.body.resume = augmentation + parsed_resume`。 |
| **5. This way, we don't have to send all the unqualified resumes to do a deep matching to RoboHire.** | gate:`DROP/PAUSE` → 跳过 Robohire,emit `RULE_CHECK_FAILED`。配额省下来 + 业务规则在 LLM 层就拦掉。 |

---

## 1. 总体架构

```
RESUME_PROCESSED
       │
       ▼
matchResumeAgent (per JD loop)
       │
       │  step A: get rules from ontology
       ▼
┌───────────────────────────────────────────────────────────────────┐
│  A. Ontology rules fetch                                           │
│     [primary]  叶洋 generatePrompt({actionRef:'matchResume',       │
│                  domain:'RAAS-v1', client:<client_id>})            │
│                → 返回 ActionObjectV4 { prompt, meta }              │
│     [fallback] 读 lib/rule-check/rules.json + 客户端过滤          │
│                (POC 路径,Ontology API 挂了用)                     │
└───────────────────────────────────────────────────────────────────┘
       │
       │  step B: 组 prompt
       ▼
┌───────────────────────────────────────────────────────────────────┐
│  B. Compose user prompt (markdown)                                 │
│                                                                    │
│   §1 角色 + 重要约束                                                │
│   §2 Inputs (5-block, POC style)                                   │
│       2.1 runtime_context                                          │
│       2.2 resume — partial(per rule_id 字段过滤后的简历)           │
│       2.3 job_requisition                                          │
│       2.4 job_requisition_specification                            │
│       2.5 hsm_feedback                                             │
│   §3 Rules to check (3 类分组)                                      │
│       3.1 CSI 通用规则(applicableClient="通用")                    │
│       3.2 客户级规则(applicableClient=<client>,部门 N/A)          │
│       3.3 部门级规则(applicableClient=<client> + 特定 BG / Studio)│
│   §4 决策结算逻辑                                                  │
│   §5 输出格式 (POC schema 强 evidence)                              │
│   §6 提交前自检                                                    │
└───────────────────────────────────────────────────────────────────┘
       │
       │  step C: LLM 评估
       ▼
┌───────────────────────────────────────────────────────────────────┐
│  C. LLM call                                                        │
│     POST <AI_BASE_URL>/chat/completions                            │
│     temperature=0.1, response_format=json_object                   │
│     model=google/gemini-3-flash-preview (or fallback)              │
│                                                                    │
│  Output schema (强制):                                              │
│    {                                                                │
│      "overall_decision": "KEEP" | "DROP" | "PAUSE",                │
│      "drop_reasons": ["10-25:huawei_cooldown", ...],               │
│      "pause_reasons": ["10-12:age_logic_anomaly", ...],            │
│      "rule_flags": [                                                │
│        {                                                            │
│          "rule_id": "10-25",                                       │
│          "rule_name": "华为荣耀竞对与客户互不挖角红线",            │
│          "applicable_client": "通用",                              │
│          "severity": "terminal",                                   │
│          "applicable": true | false,            ← Kenny user story │
│          "result": "PASS|FAIL|REVIEW|NOT_APPLICABLE",              │
│          "evidence": "简历 work_history[0]: 华为, 离职 2025-11,    │
│                       距今 5 个月 < 3 个月阈值不命中,result=PASS",│
│                                              ← Kenny user story    │
│          "next_action": "continue|block|pause|notify_recruiter|   │
│                          notify_hsm"                                │
│        },                                                           │
│        ... 51 条规则全列(applicable=false 也要写,evidence 说"不适用原因")│
│      ],                                                             │
│      "resume_augmentation": "## Rule Check Annotations\\n         │
│         - [10-25 ✓] 华为冷冻期已过(距今 5 个月)\\n               │
│         - [10-43 ⚠] IEG 工作室回流标记: 候选人原为天美             │
│         - [10-6 ⓘ] 加分项命中: vite 主导经验\\n",                  │
│                                              ← Kenny augmentation  │
│      "notifications": [{recipient,channel,rule_id,message}]        │
│    }                                                                │
└───────────────────────────────────────────────────────────────────┘
       │
       │  step D: gate decision
       ▼
┌───────────────────────────────────────────────────────────────────┐
│  D. Gate                                                            │
│     KEEP → emit MATCH_RULE_CHECK_PASSED → continue                       │
│     DROP → emit RULE_CHECK_FAILED → skip Robohire (Kenny §5)       │
│     PAUSE → emit RULE_CHECK_FAILED with reason=needs_hsm           │
└───────────────────────────────────────────────────────────────────┘
       │
       │ (KEEP only)
       ▼
┌───────────────────────────────────────────────────────────────────┐
│  E. Augment resume                                                  │
│     augmented_resume_text =                                         │
│       output.resume_augmentation + "\\n\\n" + flatten(parsed_resume)│
└───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────────────────┐
│  F. Robohire deep match                                             │
│     POST /api/v1/match-resume                                       │
│       body: { resume: augmented_resume_text, jd: jd_text }         │
└───────────────────────────────────────────────────────────────────┘
       │
       ▼
   persist + emit MATCH_PASSED_NEED_INTERVIEW
```

---

## 2. 关键决策(各 component 选哪个版本)

| Component | 选用 | 理由 |
|---|---|---|
| **Rule fetch** | 叶洋 v4 `generatePrompt()` live API call(primary) + POC `rules.json` (fallback) | 主路径走 ontology canonical source,改规则 = 改 ontology;但 Ontology API 不可用时 fallback 不阻塞生产 |
| **Prompt 结构 — Inputs 段** | POC 5-block | 5 个数据块对应 5 个数据来源,LLM 可清楚溯源(runtime_context / resume / jr / spec / hsm_feedback) |
| **Prompt 结构 — Rules 段分组** | POC 3-class(通用 / 客户级 / 部门级) | 这正是 Kenny 第 1 点说的 "specifying CSI rules and client rules"。叶洋的 4-step 拆分(redline/hard_req/bonus/match_result)是垂直 workflow 视角,跟"CSI vs 客户"的水平视角不冲突,但 Kenny 明确要求按 client/CSI 分。两者可叠加(主分组 CSI/客户,子分组 step) |
| **Output schema** | POC 风格:`rule_flags[]` + `evidence` + `applicable` + `result` + `next_action` | 满足 Kenny "user story 验证"必需 — 51 条规则全 cover、每条带 evidence(简历原文摘录)。叶洋当前 schema 只列 fired_rule_ids,没 evidence,user story 复盘看不到 LLM 在想什么 |
| **Augmentation** | POC 已有 `resume_augmentation` 字段(markdown 段) | Kenny 第 3 点要求 augment resume。POC 的 schema 已经强制 LLM 输出这段。注入到 Robohire `/match-resume` 的 resume 字段顶部 |
| **Severity 来源** | 短期:POC `inferSeverity` 文本推断<br>长期:Ontology Rule 节点加 `gating_severity` 字段 | 文本推断是 P0 bug 来源(多分支规则误判)。中期推 Ontology 团队加字段,POC 这层退役 |
| **Partial resume filter** | 新增 `lib/rule-check/resume-projection.ts`(per rule_id → required fields map) | Kenny 第 2 点的核心。当前 POC / 叶洋都发整简历,token 浪费 + 注意力分散 |
| **Gate 三态 → binary** | LLM 输出 3-state(KEEP/DROP/PAUSE),wrapper 在 [runner.ts](../lib/rule-check/runner.ts) 折叠 | 保留 PAUSE 语义(needs_human),emit `RULE_CHECK_FAILED` 时 `failure_reasons[0]` 区分 "DROP" vs "PAUSE+reason=needs_hsm" |

---

## 3. 数据流 + Schema 详解

### 3.1 Step A — Ontology rules fetch

**新代码**:`lib/rule-check/ontology-source.ts`(替代当前 [`ontology.ts`](../lib/rule-check/ontology.ts) + 叶洋 vendor 路径)

```ts
export async function fetchRulesForMatchResume(opts: {
  client_id: string;          // "腾讯" / "字节"
  business_group?: string;    // "IEG" / "PCG" / etc.
  studio?: string;
}): Promise<ClassifiedRules> {
  try {
    // Primary: 叶洋 generatePrompt 拿 ontology 实时数据
    const action = await fetchAction({
      actionRef: 'matchResume',
      domain: 'RAAS-v1',
      apiBase: process.env.ONTOLOGY_API_BASE,
      apiToken: process.env.ONTOLOGY_API_TOKEN,
    });
    return classifyByClient(action.actionSteps, opts);
  } catch (err) {
    if (err instanceof OntologyGenError && err.isRetriable === false) {
      // 4xx → 立刻 fallback
    } else {
      // 5xx/timeout/network → fallback + log
    }
    // Fallback: POC rules.json
    return filterRulesFromJson(opts);
  }
}
```

**分类逻辑**(从 POC 的 `RuleClassifierAgent` 抽出):
- `general`: `applicableClient === '通用'` → CSI 级
- `client_level`: `applicableClient === client_id` 且 `applicableDepartment ∈ {N/A, 通用}` → 客户专属
- `department_level`: `applicableClient === client_id` 且 `applicableDepartment` 包含具体 BG/Studio → 部门专属

### 3.2 Step B — Compose prompt

**新代码**:`lib/rule-check/prompt-v3.ts`(替代当前 [`prompt.ts`](../lib/rule-check/prompt.ts) + [`yeyang-runner.ts`](../lib/rule-check/yeyang-runner.ts) 的 prompt 部分)

Prompt 模板组成 6 段(继承 POC):

```markdown
# Resume Pre-Screen Rule Check

## 1. 你的角色
你是简历预筛查员 ... [POC §1 原文]

## 2. Inputs
### 2.1 runtime_context (来自 RESUME_PROCESSED)
### 2.2 resume (来自 RESUME_PROCESSED.parsed.data)
    ⚠️ 注意:这里只发 **partial resume** —— 按本批次规则需要的字段过滤后
### 2.3 job_requisition (来自 RAAS getRequirementDetail.requirement)
### 2.4 job_requisition_specification (可能为 null)
### 2.5 hsm_feedback (可能为 null)

## 3. Rules to check
### 3.1 CSI 通用规则 (X 条) — 所有客户必查
    #### 规则 10-5: ... [触发条件 / 判定逻辑 / 命中时输出动作]
    #### ...
### 3.2 客户级规则 (本次 client_id="腾讯", Y 条)
### 3.3 部门级规则 (本次 BG="IEG", studio="天美", Z 条)

## 4. 决策结算逻辑
[POC 三态决策,KEEP/DROP/PAUSE]

## 5. 输出格式
```json
{
  "overall_decision": "...",
  "rule_flags": [
    { "rule_id":"10-5", "applicable": true, "result":"PASS",
      "evidence":"...", "next_action":"continue" },
    ...  // 全部 X+Y+Z 条规则
  ],
  "resume_augmentation": "## Rule Check Annotations\n  - [10-25 ✓] ...",
  ...
}
```

## 6. 提交前自检
- [ ] rule_flags 覆盖 §3 所有规则
- [ ] 每条 evidence 引用简历原文
- [ ] resume_augmentation 是可读 markdown
- ...
```

### 3.3 Step B' — Partial resume projection(Kenny §2 关键)

**新代码**:`lib/rule-check/resume-projection.ts`

每个 rule_id 声明需要 resume 的哪些字段:

```ts
// 示例(完整版要给 51 条规则建表)
export const RULE_REQUIRED_FIELDS: Record<string, ResumeField[]> = {
  // 红线/黑名单类规则
  '10-25': ['experience'],                        // 华为荣耀冷冻期 → 工作经历
  '10-38': ['experience'],                        // 腾讯历史从业经历 → 工作经历
  '10-26': ['experience'],                        // OPPO 小米冷冻期
  '10-18': ['experience'],                        // CSI 风险离场编码 → 历史任职
  '10-21': ['birth_date'],                        // 年龄红线 → 出生日期
  '10-5':  ['education', 'skills', 'languages',   // 硬性要求一票否决 → 全部硬条件
            'gender', 'birth_date'],
  // 加分项 / 期望薪资
  '10-7':  ['expected_salary_range'],             // 期望薪资
  '10-47': ['gender', 'birth_date',               // 腾讯婚育风险
            'marital_status'],
  '10-43': ['experience'],                        // IEG 工作室回流互斥
  '10-27': ['conflict_of_interest'],              // 腾讯亲属回避
  // ... 共 51 条
};

export function projectResume(
  parsedResume: ParsedResume,
  applicableRules: Rule[],
): Partial<ParsedResume> {
  const fieldsNeeded = new Set<string>(['name']); // name 始终保留(给 LLM 上下文)
  for (const rule of applicableRules) {
    for (const f of RULE_REQUIRED_FIELDS[rule.id] ?? []) {
      fieldsNeeded.add(f);
    }
  }
  return pickFields(parsedResume, [...fieldsNeeded]);
}
```

**收益**:
- 当前 prompt 含 resume 整段 (~3000 token),partial 后预计 ~600 token
- 减 80% prompt token,加 LLM 注意力
- LLM 不会因为看到无关字段(教育背景对腾讯历史从业规则没用)而干扰判断

**风险**:Field map 维护成本。新加规则要同步更新 map。Mitigation:用 TS 类型 + 单测保证 `applicableRules[i].id` 都有 map entry。

### 3.4 Step C — LLM output schema

**沿用 POC,但加 3 点 user story 验证强化**:

```ts
interface RuleCheckOutput {
  overall_decision: 'KEEP' | 'DROP' | 'PAUSE';
  drop_reasons: string[];     // e.g. ["10-25:huawei_cooldown_under_3m"]
  pause_reasons: string[];

  rule_flags: Array<{
    rule_id: string;          // "10-25"
    rule_name: string;
    applicable_client: '通用' | string;
    severity: 'terminal' | 'needs_human' | 'flag_only';

    applicable: boolean;      // ★ user story 验证:这条在本场景适用吗
    result: 'PASS' | 'FAIL' | 'REVIEW' | 'NOT_APPLICABLE';

    evidence: string;         // ★ user story 验证:LLM 必须引用简历原文
                              //   或写"简历未提供 <字段>,标 NOT_APPLICABLE"

    next_action: 'continue' | 'block' | 'pause' | 'notify_recruiter' | 'notify_hsm';
  }>;

  resume_augmentation: string; // ★ Kenny §3:markdown,注入到 Robohire resume 顶部

  notifications: Array<{
    recipient: '招聘专员' | 'HSM';
    channel: 'InApp' | 'Email';
    rule_id: string;
    message: string;
  }>;
}
```

**与叶洋 v4 现状的差异**:
- 叶洋:`step_results.step_N.fired_rule_ids[]` — 只列触发的
- POC:`rule_flags[]` 全列(51 条都要 `applicable` + `result` + `evidence`)
- 这个差异是 Kenny "user story 验证" 的必要条件

### 3.5 Step E — Augmentation injection

**新代码**:[match-resume-agent.ts](../server/inngest/agents/match-resume-agent.ts) 在 step 4a 之前

```ts
// 当前:
const resumeText = data.parsed?.data;  // 直接发整段 parsed

// v3 (KEEP path only):
const resumeText = ruleCheck.llm_output.resume_augmentation
  + '\n\n---\n\n'
  + flattenResumeForMatch(data.parsed?.data);

// 然后正常调 Robohire:
await matchResume({ resume: resumeText, jd: jdText });
```

Robohire 看到的 resume 形如:

```
## Rule Check Annotations

- [10-25 ✓] 华为冷冻期已过(work_history[2]: 华为, 离职 2025-11, 距今 5 个月 ≥ 3 个月阈值)
- [10-43 ⚠] IEG 工作室回流标记:work_history[1] 显示曾在腾讯天美;本岗位是 IEG 光子,跨室推荐合规(>6 个月)
- [10-6 ⓘ] 加分项命中:experience.highlights 显示主导 webpack→vite 迁移

---

[原始 parsed resume 内容]
```

**收益**(Kenny §3 直击):
- Robohire 不仅看到候选人简历,还看到我们 ontology 规则的预判
- Robohire 的打分逻辑可以参考这些 flag(下游应用层逻辑无需改,只是 input 富了)
- 审计场景:Robohire 给低分但 rule check 全 PASS → 知道分歧来源

---

## 4. 分阶段实施

> **进度(2026-05-12)**:Phase 1 + Phase 2 已落地推到 Steven 分支。Phase 3 的 spec PR 已写给叶洋([yeyang-v5-ask-rule-flags-schema.md](./yeyang-v5-ask-rule-flags-schema.md))和陈洋([chenyang-ontology-ask-rule-fields.md](./chenyang-ontology-ask-rule-fields.md))。

### Phase 1 ✅ DONE(commit 128f7e1)— 当前 POC 路径上加 augmentation 注入

**改动**:
1. [`lib/rule-check/runner.ts`](../lib/rule-check/runner.ts):在返回 `RuleCheckVerdict` 时把 `resume_augmentation` 字段透传出来(目前 POC 输出有这字段,但 `RuleCheckVerdict` 没接出来)
2. [`server/inngest/agents/match-resume-agent.ts`](../server/inngest/agents/match-resume-agent.ts) step 4a:当 `verdict.decision === 'PASS'`,把 `verdict.llm_output.resume_augmentation` 拼到 `resumeText` 头部再调 `matchResume()`
3. 新建 [`lib/rule-check/resume-projection.ts`](../lib/rule-check/resume-projection.ts):51 条规则 × 字段 map + `projectResume()` 函数。先覆盖**红线/硬性要求/婚育/亲属回避**这 ~15 条高频规则,其他暂时发全字段
4. [`lib/rule-check/runner.ts`](../lib/rule-check/runner.ts) 调用 `projectResume()` 替代直接发整段 parsed
5. POC `rules.json` 的 3 类分组在 prompt 中显式标记 §3.1 / §3.2 / §3.3 (现已实现,无需改)
6. 加单测:6 个 POC 场景重跑一遍,验证 augmentation 注入后 LLM 行为不变

**验收**:
- LLM 输出含 `resume_augmentation` 字段且非空
- Robohire `/match-resume` 调用的 `body.resume` 包含 augmentation header
- partial resume(15 条规则覆盖)的 prompt token 比当前少 ≥ 50%

### Phase 2 ✅ DONE(commit 94814c2)— ontology codegen 接入

**前置(给陈洋 / 叶洋的 ask)**:
- Ontology API 暴露 `GET /api/v1/ontology/actions/matchResume/rules?domain=RAAS-v1&client=<id>` 返回按 client 过滤的 rule 列表
- 或者 — 叶洋 `generatePrompt({client})` 已经支持(看现在的实现是)

**改动**:
1. 新建 [`lib/rule-check/ontology-source.ts`](../lib/rule-check/ontology-source.ts):primary 调 `fetchAction` (叶洋 path),fallback 读 `rules.json`
2. [`lib/rule-check/ontology.ts`](../lib/rule-check/ontology.ts) 重命名为 `ontology-fallback.ts`,只保留 JSON 加载
3. [`lib/rule-check/runner.ts`](../lib/rule-check/runner.ts) 改用 `fetchRulesForMatchResume()`
4. 新加 env:`ONTOLOGY_API_BASE` + `ONTOLOGY_API_TOKEN`(已在 .env.example)
5. 监控:Ontology API outage → fallback 触发次数 > N/h 报警

**验收**:
- `RULE_CHECK_PROMPT_SOURCE=poc` 模式下,prompt 中的规则数 = ontology 实时返回的数(不是 rules.json 老快照)
- Ontology API 给的规则被更新 → 下次 rule check 立刻用到

### Phase 3 🚧 BLOCKED on partners(spec PR 已交付 2026-05-12)— Severity 字段 + 叶洋 v5 输出 schema 同步

**前置(给陈洋 + 叶洋的 ask)**:
1. **陈洋**:Ontology Rule 节点加 `gating_severity` enum 字段(terminal / needs_human / flag_only)+ `required_resume_fields[]` 字段。spec → [chenyang-ontology-ask-rule-fields.md](./chenyang-ontology-ask-rule-fields.md)。预计陈洋侧 3-5 天
2. **叶洋**:v5 `assembleActionObjectV4_5`:每个 step 的输出 schema 改成 `rule_flags[]` + evidence + applicable + result + next_action 风格,顶层加 `resume_augmentation`。spec → [yeyang-v5-ask-rule-flags-schema.md](./yeyang-v5-ask-rule-flags-schema.md)。预计叶洋侧 1-2 周

**改动**(本仓):
1. [`lib/rule-check/ontology.ts`](../lib/rule-check/ontology.ts):`inferSeverity` 完全去掉,从 ontology 字段读
2. [`lib/rule-check/yeyang-runner.ts`](../lib/rule-check/yeyang-runner.ts) 退役 — 主仓 `generatePrompt` + 新 schema 就是默认路径
3. 删 `RULE_CHECK_PROMPT_SOURCE` env(只剩一条路径)
4. POC composer ([`prompt.ts`](../lib/rule-check/prompt.ts)) 改用主仓 `generatePrompt` 渲染 + 加 evidence section overlay
5. `scripts/rule-check-poc/` 全部存档(`scripts/rule-check-poc/_archived-2026-05/`),保留为历史 spec

**验收**:
- 一个统一路径,LLM 看到 prompt 是 ontology canonical 输出
- LLM 输出仍有 evidence 字段
- POC 6 场景重跑,准确率不降

---

## 5. 测试策略

### 5.1 Phase 1 单测(本仓 vitest)

- `lib/rule-check/resume-projection.test.ts`:覆盖 15 条规则的字段映射 + edge case(rule_id 无 map entry → 应抛或警告)
- `lib/rule-check/runner.test.ts`:mock LLM 返回,验证 `resume_augmentation` 字段正确透传 + augmentation 拼装格式

### 5.2 Phase 1 集成(POC 场景重跑)

```bash
npm run rule-check-poc
# scripts/rule-check-poc/run-demo.ts
# 6 场景:01-clean-baseline-keep / 02-huawei-cooldown-pause /
#         03-csi-blacklist-drop / 04-tencent-ieg-history-pause /
#         05-foreign-marital-pause / 06-bytedance-history-pause
```

每场景产出对比 `_comparison.md`:
- expected vs actual `overall_decision`
- expected vs actual `drop_reasons` + `pause_reasons`(set 相等比较)
- `rule_flags[].evidence` 是否含简历原文片段(grep "work_history" / "experience" / "marital_status" 等关键词)
- `resume_augmentation` 是否非空

目标:6/6 通过(当前 POC 是 4/6,Phase 1 不应降低)

### 5.3 E2E(Phase 1 后立即可做)

- 发一个测试 `RESUME_DOWNLOADED` 经过 `RESUME_PROCESSED → matchResumeAgent` 走完整链路
- Inngest UI 验证:`rule-check-${jr_id}` step 输出含 `verdict.llm_output.resume_augmentation`
- 查 Robohire 的 `/match-resume` request body(可以通过日志或 RAAS-side request logging):`body.resume` 头部含 `## Rule Check Annotations` 段

---

## 6. 风险 + 回滚

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| **LLM 不遵守 51 条全列要求**(只列触发的) | 中 | user story 验证失效 | Output 后置校验:`rule_flags.length === applicableRules.length`,不满足 → fall back 到 PASS 安全侧 + log warning |
| **partial resume 漏字段导致 LLM 误判** | 中 | 错杀 / 误放 | Phase 1 只覆盖 15 条高频规则,其他暂时发全字段;每加一条规则严格审查字段 map |
| **Ontology API outage** | 低 | 走 fallback,prompt 用旧 rules.json | Phase 2 双路径,fallback 自动触发;监控告警 |
| **`resume_augmentation` 内容污染 Robohire 打分** | 低中 | 分数偏差 | augmentation 限定在 markdown header 段,Robohire prompt 应当能区分(Robohire 端 prompt 写"忽略 ## 段之前的 annotations"作为 hedge);先 A/B 跑 |
| **新加规则忘了更新 `RULE_REQUIRED_FIELDS` map** | 高 | partial resume 缺字段 | TS 类型约束 + CI lint:`Rule.id` 在 ontology 出现但 map 缺,build 失败 |
| **token 估算偏差,partial 反而更多** | 低 | 成本不降反升 | Phase 1 验收看 token 数,< 50% reduction 才进 Phase 2 |

**整链路 kill switch**:
- `RULE_CHECK_ENABLED=false` → 当前已实现,Inngest cloud 切回完全 bypass(< 1 分钟回滚)
- `RULE_CHECK_AUGMENT_RESUME=false`(新加 env) → KEEP 路径不注入 augmentation,Robohire 看原始 resume(可独立回滚 augment 这个增量,保留 gate)

---

## 7. 给 Kenny / 叶洋 / 陈洋的开放问题

### 给 Kenny
1. **partial resume 字段 map 接受**手工维护(我们这边出 spec + table),还是希望 ontology 上每条规则节点带 `requiredResumeFields[]` 字段(陈洋那边出)?手工维护快(2-3 天),ontology 化合规(2-3 周)
2. PAUSE(needs_human) 当前我们折成 FAIL 不走 Robohire,这跟"unqualified resumes 不发 Robohire" 的口径一致吗?还是 PAUSE 也应该走 Robohire 但带 augmentation 标 "needs HSM review"?
3. resume_augmentation 注入后,Robohire 的 prompt 是否需要相应调整提示它"prefix 是预筛标注,不是简历内容"?(走通 Robohire 团队 sign-off)

### 给叶洋
1. v5 `assembleActionObjectV4_5` 输出 schema 改成 `rule_flags[]` + evidence + applicable + result 风格,你这边出 PR 还是要我们出 spec PR 你 review?
2. `generatePrompt({client})` 当前 query 是否支持只返回某 client 适用的 rule 列表(server-side filter)?还是 client-side 拿全集再过滤?

### 给陈洋
1. Ontology Rule 节点加 `gating_severity` 字段(enum:terminal / needs_human / flag_only)— 多久能上线?
2. 51 条 matchResume 规则的 severity 标注由谁出(我们这边用 `inferSeverity` 跑一份 + 人工 review,你这边录入)?
3. 长期把 `requiredResumeFields[]` 也加到 Rule 节点,可行吗?

---

## 8. 时间线(乐观估计)

| Phase | 范围 | 工期 | 依赖 |
|---|---|---|---|
| Phase 1 | augmentation 注入 + partial resume(15 条)+ POC 重跑 | 2-3 天 | 仅本仓 |
| Phase 2 | Ontology API 接入(primary)+ rules.json fallback | 3-5 天 | 叶洋 `generatePrompt` 已能用(已交付)+ Ontology API 鉴权 |
| Phase 3 | Severity 字段 + v5 schema + POC 退役 | 2-3 周 | 陈洋 ontology 改 + 叶洋 v5 snapshot |

**目标**:Phase 1 + Phase 2 末完成时,生产可以 toggle `RULE_CHECK_ENABLED=true` 启用 gate,**符合 Kenny 5 点设想的所有 5 条**。

---

## 9. 备忘 — 与现有文档的关系

| 文档 | 关系 |
|---|---|
| [docs/rule-check-user-guide.md](./rule-check-user-guide.md) | 当前实现的用户手册(POC 路径 + 叶洋 v4 路径并行)。Phase 3 后只剩一条统一路径,需要重写 |
| [docs/workflow-event-chain.md](./workflow-event-chain.md) | 端到端事件链。本 plan 影响"未来增量 A"那节,Phase 1 落地后更新 |
| [docs/neo4j-instance-storage-plan.md](./neo4j-instance-storage-plan.md) | RuleCheckAudit 写 Neo4j 的方案。本 plan 不冲突,正交 |
| [docs/yeyang-prompt-adapter-onboarding.md](./yeyang-prompt-adapter-onboarding.md) | 给叶洋的 v4 onboarding。本 plan 的 Phase 3 是给叶洋的 v5 ask,需要单独写 v5 onboarding |
| [scripts/rule-check-poc/](../scripts/rule-check-poc/) | POC 历史归档。Phase 3 后整体存档到 `_archived-2026-05/` |
