# E2E Mock Test Plan — Rule Check + Augmentation + Neo4j Instance Write

> 目标:用 mock 数据端到端跑通 rule-check 完整链路,
> **不改任何 workflow agent / 现有 RAAS 接口契约 / 叶洋 prompt 模板**,
> 验证:
>   1. LLM 按我们 ontology 规则正确识别命中 / 不命中
>   2. evidence 字段引用的是简历原文(可被字符串 grep 验证)
>   3. resume_augmentation 正确注入 Robohire 调用入参
>   4. Neo4j 收到完整 RuleCheckAudit + RuleCheckFlag 实例数据

---

## 0. 环境清点

| 资源 | 状态 | 我们怎么用 |
|---|---|---|
| 本地 Neo4j(`:7687`) | ✅ 在线 | neo4j-driver 直连,写 `RuleCheckAudit` / `RuleCheckFlag` 节点 |
| Robohire(`:4607` / `https://api.robohire.io`) | ❌ 本地未起,远程外网被沙箱 block | 用 **deterministic stub** 在 mock RAAS server 里返回固定 shape — 我们的目标是验证"AO 调 RAAS 时传给 Robohire 的 input 正确",不验证 Robohire 内部打分 |
| RAAS API Server(`:3001`) | ❌ partner 自己跑,我们不依赖 | **完全 mock** — Express 模拟所有 endpoint |
| LLM Gateway(`AI_BASE_URL` New-API) | ✅ env 已配 | **真实调用** — rule check 是这次要验证的核心 |
| Ontology API(`:3500`) | ❓ 不一定在线 | rule-check 自动 fallback 到 `rules.json`(已在 Phase 2 落地) |

---

## 1. 测试架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  scripts/e2e-mock-test/run-all.ts (test orchestrator)                │
│                                                                       │
│   ┌─ setup ───────────────────────────────────────────────────────┐  │
│   │ a. 启动 mock RAAS server (Express :3001)                       │  │
│   │ b. 检查 LLM gateway / Neo4j 可达                                │  │
│   │ c. 清理本次测试 run_id 在 Neo4j 留下的旧 audit                  │  │
│   └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│   ┌─ FOR EACH scenario(N 个 candidate × M 个 JD)───────────────┐  │
│   │                                                                │  │
│   │  Step 1: 模拟 RESUME_DOWNLOADED → AO resumeParserAgent 逻辑   │  │
│   │    fixture: candidate parsed_resume + transport metadata      │  │
│   │    →  raas-api-client.saveCandidate(...) mocks return id      │  │
│   │    →  emit 模拟 RESUME_PROCESSED payload                       │  │
│   │                                                                │  │
│   │  Step 2: 模拟 matchResumeAgent 逻辑                           │  │
│   │    →  raas-api-client.getRequirementDetail(jr_id) mocks       │  │
│   │    →  if RULE_CHECK_ENABLED:                                   │  │
│   │       a. buildRuleCheckInput()                                 │  │
│   │       b. runRuleCheck() → 真调 LLM                             │  │
│   │          (走 POC 路径,partial resume projection 自动 ON)      │  │
│   │       c. 拿 verdict:decision / resume_augmentation /          │  │
│   │              rule_flags[].evidence                             │  │
│   │       d. 写 Neo4j:RuleCheckAudit + RuleCheckFlag             │  │
│   │       e. 如果 FAIL → record skipped, 跳过 step 3,go scenario │  │
│   │    →  raas-api-client.matchResume(resume:augmented, jd) mocks │  │
│   │       (mock 内部 deterministic stub Robohire 响应,记下         │  │
│   │       AO 调时实际 request body 供 verifier 用)                 │  │
│   │    →  raas-api-client.saveMatchResults() mocks                │  │
│   │                                                                │  │
│   │  Step 3: 验证 (verifier.ts)                                    │  │
│   │    a. verdict.decision === expected.decision                   │  │
│   │    b. verdict.failure_reasons ⊇ expected.failure_reasons       │  │
│   │    c. 每条 rule_flags[i].evidence 在 parsed_resume 里能 grep   │  │
│   │       到原文片段(不允许编造)                                  │  │
│   │    d. 如果 PASS:matchResume 被调用 + body.resume 含 augment   │  │
│   │       前缀("## Rule Check Annotations")                       │  │
│   │    e. Neo4j 查:RuleCheckAudit 节点存在 + 含正确的 dims        │  │
│   │       + RuleCheckFlag 数 = applicable_rule 数                  │  │
│   │                                                                │  │
│   │  Step 4: 报告 (reporter.ts)                                    │  │
│   │    output/${run_id}/${scenario_id}.md                          │  │
│   │       - scenario inputs                                        │  │
│   │       - LLM full output (raw + parsed)                         │  │
│   │       - augmentation injected to Robohire                      │  │
│   │       - Neo4j writes                                           │  │
│   │       - assertion results (per-check pass/fail)                │  │
│   │       - evidence verification(每条 evidence + grep 命中位置)  │  │
│   └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│   ┌─ teardown ────────────────────────────────────────────────────┐  │
│   │ a. 关 mock RAAS server                                          │  │
│   │ b. 生成 output/${run_id}/_summary.md                            │  │
│   │    (N 个 scenario 通过/失败 + 总体准确率)                       │  │
│   └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. 不动什么(硬约束)

- **不改 workflow agent 文件**(`server/inngest/agents/*.ts`)
- **不改 raas-api-client.ts 的导出契约**
- **不改 rule-check engine 的导出契约**
- **不改叶洋 `lib/ontology-gen/`**
- **不改 `lib/rule-check/prompt.ts` 模板**
- 所有改动**只**在 `scripts/e2e-mock-test/` 下

测试通过的核心是**调用 library**(`runRuleCheck` / `matchResume` 等),而不是真去 spawn Inngest 走 agent。这样:
- 业务逻辑被 100% 覆盖
- 不用搭 Inngest dev server / mock step
- 不用 spin up 整个 Next.js dev runtime

---

## 3. Mock 数据

### 3.1 4 个 candidate scenarios(来源:`scripts/rule-check-poc/fixtures/candidates.ts` 复用)

| ID | 描述 | 关键字段 | 期望规则命中 |
|---|---|---|---|
| `c01-zhangsan-clean` | 干净基线:5y 前端,阿里→字节 | experience: 阿里(2021-2024)+ 字节(2018-2021),无 CSI/华为/腾讯 | 10-6 加分项(技能) — flag_only;其余全 PASS;**decision=KEEP** |
| `c02-huawei-recent` | 华为离职 1 个月 | experience: 华为(2024-04~2026-04),距今 1 个月 | **10-25**(华为冷冻 < 3 个月)terminal — needs_human;**decision=PAUSE** |
| `c03-csi-blacklist` | 中软国际 EHS 离职 | former_csi_employment: { company:"中软国际", leave_code:"A13(1)" } | **10-18**(EHS 风险回流)terminal — needs_human;**decision=PAUSE** |
| `c04-tencent-ieg-history` | 腾讯 IEG 天美历史员工 | former_tencent_employment: { business_group:"IEG", studio:"天美", leave_type:"主动离场" } | **10-38**(腾讯历史从业)needs_human;**10-43**(IEG 工作室互斥) needs_human(取决于 JD);**decision=PAUSE** |

### 3.2 3 个 JD scenarios(`scripts/rule-check-poc/fixtures/job-requisitions.ts` 复用)

| ID | client_id | business_group | studio | 用来跑 |
|---|---|---|---|---|
| `jr-tencent-ieg-tianmei` | "腾讯" | "IEG" | "天美" | c01 / c04 |
| `jr-tencent-ieg-guangzi` | "腾讯" | "IEG" | "光子" | c04(跨室禁止) |
| `jr-bytedance-tiktok` | "字节" | "TikTok" | null | c01 |
| `jr-csi-saas` | "通用" | "CSI" | null | c02 / c03 |

### 3.3 6 个测试场景(candidate × JD)

| # | scenario_id | candidate × JD | expected.decision | expected.failure_reasons | 验证什么 |
|---|---|---|---|---|---|
| 1 | `s01-clean-tencent-ieg-keep` | c01 × jr-tencent-ieg-tianmei | KEEP | [] | clean baseline pass,augmentation 注入 Robohire,Neo4j 有 audit 但无 fail flag |
| 2 | `s02-huawei-cooldown-pause` | c02 × jr-csi-saas | FAIL (PAUSE) | ["10-25:huawei_cooldown_<3m"] | terminal-class 命中,evidence 引用华为离职日期,augmentation 标 ✗ 10-25 |
| 3 | `s03-csi-ehs-drop` | c03 × jr-csi-saas | FAIL (PAUSE) | ["10-18:csi_ehs_a13"] | A13(1) 离场编码识别,evidence 引用 former_csi_employment.leave_code |
| 4 | `s04-tencent-history-cross-studio-pause` | c04 × jr-tencent-ieg-guangzi | FAIL (PAUSE) | ["10-38:tencent_history", "10-43:ieg_studio_cross"] | 双规则命中,evidence 分别引用 |
| 5 | `s05-tencent-history-same-studio-pause` | c04 × jr-tencent-ieg-tianmei | FAIL (PAUSE) | ["10-38:tencent_history"] | 同工作室不触发 10-43,但 10-38 仍需 HSM |
| 6 | `s06-clean-bytedance-keep` | c01 × jr-bytedance-tiktok | KEEP | [] | 字节路径全 PASS(验证 client_id 切换后规则集变化) |

### 3.4 expected output 写在 `fixtures/expected-results.ts`

```ts
export const EXPECTED: Record<ScenarioId, ExpectedVerdict> = {
  's01-clean-tencent-ieg-keep': { decision: 'KEEP', must_fail_reasons: [], must_pass_rules: ['10-25', '10-38'], must_have_augmentation: true },
  ...
};
```

---

## 4. Mock RAAS Server 端点契约

每个 endpoint 实现"接收 → 验证 schema → 返回 mock"。所有调用记录在 `__seenCalls` 数组,供 verifier 查证。

```
GET  /api/v1/resumes/uploads/:upload_id/raw     → 返回 dummy PDF Buffer + content-type
POST /api/v1/parse-resume                       → 返回 fixture candidate 的 parsed.data
POST /api/v1/candidates                         → 返回 { candidate_id: "C_${uuid}", resume_id: "R_${uuid}", is_new_candidate: true }
GET  /api/v1/requirements/:id                   → 返回 fixture JD requirement + spec
GET  /api/v1/requirements/agent-view?...        → 返回 [fixture JDs]
POST /api/v1/match-resume                       → 调 deterministic stub:
                                                  matchScore = (resumeText.length % 31) + 60
                                                  recommendation = matchScore > 75 ? "推荐" : "待定"
                                                  记下 req.body.resume(检查 augmentation)
POST /api/v1/match-results                      → { ok: true, id: "MR_${uuid}" } + 记下 body
POST /api/v1/generate-jd                        → deterministic stub
POST /api/v1/jd/sync-generated                  → { ok: true }
```

---

## 5. Neo4j 实例写入 schema

Neo4j 节点设计(跟 `docs/neo4j-instance-storage-plan.md` 一致,但**直接用 neo4j-driver 写**,不走 Ontology API — 用户明确说"用本地的 neo4j"):

```cypher
// 每次 rule check 一条
(:RuleCheckAudit {
  audit_id: "rca_${run_id}_${scenario_id}",
  run_id: "run_2026-05-12_xxx",
  scenario_id: "s02-huawei-cooldown-pause",
  candidate_id: "c02-huawei-recent",
  job_requisition_id: "jr-csi-saas",
  upload_id: "upl_test_xxx",
  resume_id: "R_xxx",
  client_name: "通用",           // snapshot,decision-time 上下文
  business_group: null,
  studio: null,
  llm_decision: "PAUSE",
  decision: "FAIL",
  llm_model: "google/gemini-3-flash-preview",
  llm_duration_ms: 2150,
  llm_prompt_tokens: 12350,
  llm_completion_tokens: 1820,
  rules_evaluated: 12,
  rules_total_in_ontology: 51,
  rule_source: "json-fallback",   // Phase 2 audit
  partial_resume_fields: ["name", "experience", "former_csi_employment"],
  failure_reasons: ["10-25:huawei_cooldown_<3m"],
  resume_augmentation: "## Rule Check Annotations ...",
  created_at: datetime()
})

// 每条命中规则一条
(:RuleCheckFlag {
  flag_id: "rcf_${run_id}_${scenario_id}_${rule_id}",
  audit_id: "rca_...",       // 索引回父 audit
  rule_id: "10-25",
  rule_name_snapshot: "华为荣耀竞对与客户互不挖角红线",
  severity: "terminal",
  applicable: true,
  result: "FAIL",
  evidence: "experience[0]: 华为(2024-04~2026-04),距今 1 个月 < 3 个月阈值",
  next_action: "block",
  created_at: datetime()
})

// 链
(:RuleCheckAudit)-[:HAS_FLAG]->(:RuleCheckFlag)
(:RuleCheckAudit)-[:FOR_CANDIDATE {candidate_id: "..."}]->()  // 跨节点引用 candidate_id
(:RuleCheckAudit)-[:FOR_JOB {job_requisition_id: "..."}]->()
```

测试结束后,verifier 查:
```cypher
MATCH (a:RuleCheckAudit {run_id: $run_id})-[:HAS_FLAG]->(f:RuleCheckFlag)
WHERE a.scenario_id = $scenario_id
RETURN a, collect(f) AS flags
```

---

## 6. Evidence 验证逻辑

**Kenny 的核心 ask**:LLM 输出的 `evidence` 字段必须**真实引用简历原文**,不能编造。

Verifier 对每条 `rule_flags[i].evidence`:
1. 把 evidence 字符串 tokenize(按中文标点切句)
2. 找最长的"看起来像引用"的段(> 8 字符 + 不含 markdown 控制符)
3. 在原始 parsed_resume(JSON.stringify)里 grep
4. 如果命中 → ✓ verifiable
5. 如果未命中 → ✗ 标记为可疑(可能 LLM 编造或释义)

报告里每条 evidence 标 ✓/✗,统计 verifiable_rate(预期 > 80%)。

---

## 7. 文件结构

```
scripts/e2e-mock-test/
├── plan.md                          # ← 本文档
├── run-all.ts                       # 入口 — orchestrator
├── mock-raas-server.ts              # Express RAAS mock
├── neo4j-instance-writer.ts         # neo4j-driver 写 audit / flag
├── pipeline-driver.ts               # 单 scenario 跑完整流程
├── verifier.ts                      # 断言 + evidence grep
├── reporter.ts                      # markdown 生成
├── fixtures/
│   ├── candidates.ts                # 4 个 candidate(复用 POC)
│   ├── job-requisitions.ts          # 3 个 JD
│   └── expected-results.ts          # 6 个 scenario 预期
└── output/
    └── ${run_id}/
        ├── _summary.md
        ├── s01-...md
        ├── s02-...md
        ├── ...
        └── neo4j-snapshot.json      # 测试后 Neo4j 状态快照
```

---

## 8. 执行步骤

| Step | 动作 | 验证条件 |
|---|---|---|
| 1 | 写 plan.md(本文) | 用户认可 |
| 2 | 实现 mock-raas-server.ts | `curl localhost:3001/health` 返回 200 |
| 3 | 实现 neo4j-instance-writer.ts + 单测 | 单测能 write + read back 一条 audit |
| 4 | 实现 fixtures(c01-c04 + jr-* + expected) | TS typecheck pass |
| 5 | 实现 pipeline-driver.ts(单 scenario)| 跑 s01 输出 verdict |
| 6 | 实现 verifier.ts + reporter.ts | s01 生成 .md 报告 |
| 7 | 实现 run-all.ts orchestrator | 跑全部 6 scenario |
| 8 | 迭代调通 | 6/6 scenario 通过断言 |
| 9 | Evidence 复盘 + summary | verifiable_rate > 80% |
| 10 | **不 commit** — 报告给用户 | — |

---

## 9. 不做的事

- **不真调 Robohire** — 沙箱阻挡 + 本地未启;mock RAAS 内 stub 返回
- **不真发 Inngest event** — 直接 invoke 库函数
- **不写 raas-api-client 的 mock 版本** — 直接让 raas-api-client 调本机 mock server(只需 `RAAS_API_BASE_URL=http://localhost:3001`)
- **不实现 Ontology API write 路径** — Neo4j 直连写;后续 Phase 3 完成后切 Ontology API
- **不动 workflow agent / 现有 schemas / partner / 叶洋的代码**

---

## 10. 验收

成功 = 全部满足:

- [ ] 6 个 scenario 跑完,decision 全部跟 expected 一致
- [ ] 每个 PASS scenario:Robohire 调用入参 body.resume **首部含** "## Rule Check Annotations"
- [ ] 每个 scenario 在 Neo4j 留下:1 个 RuleCheckAudit + 0..N 个 RuleCheckFlag,数量跟 LLM 输出的 rule_flags applicable=true 一致
- [ ] 所有 rule_flags[i].evidence 至少 80% 能在 parsed_resume.json 里 grep 到原文
- [ ] 报告里附 LLM 完整 raw output(便于复盘 + 找 prompt 改进点)
- [ ] **不 commit / push 任何东西**
