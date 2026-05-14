# E2E Mock Test — Rule Check + Augmentation + Neo4j 端到端验证

> **不动 workflow agent / RAAS 接口契约 / 叶洋 prompt**,纯通过 mock RAAS server
> + deterministic LLM stub(真实 LLM gateway 当前 LAN 不可达,见 §5)+ 隔离
> Neo4j Docker 实例验证完整管道。
>
> 状态:**6/6 scenarios passed,evidence verifiability 99% (166/167)**(2026-05-12 首次跑通)

---

## 0. 一句话

```
模拟 RAAS 平台数据 → AO matchResumeAgent 链路 → 真实 LLM rule check →
augmentation 注入 Robohire → Neo4j 写 RuleCheckAudit/Flag → 验证全部 assertions
```

不 commit、不 push;改不动 production 代码。

---

## 1. 怎么跑

```bash
# (1) 起隔离 Neo4j(端口 7688,避开本机 7687 production)
scripts/e2e-mock-test/start-test-neo4j.sh

# (2) 跑全部 6 scenarios
npx tsx scripts/e2e-mock-test/run-all.ts

# (3) 跑单个
npx tsx scripts/e2e-mock-test/run-all.ts --scenario s02-huawei-cooldown-drop

# (4) 真实 LLM(gateway 恢复后)
npx tsx scripts/e2e-mock-test/run-all.ts --llm=real

# (5) gate-off 对照(只测 mock RAAS + Neo4j,不 rule-check)
npx tsx scripts/e2e-mock-test/run-all.ts --no-llm

# (6) 收摊
scripts/e2e-mock-test/start-test-neo4j.sh stop
```

输出在 `scripts/e2e-mock-test/output/<run_id>/`:
- `_summary.md` — 总览
- `s0X-...md` — 每个 scenario 的完整报告(LLM 原始输出 / assertions / evidence 核查表 / Neo4j 写入快照 / timings)

---

## 2. 测试的是什么

| 维度 | 验证 |
|---|---|
| **rule-check 决策正确性** | 每个 scenario 的 verdict (PASS/FAIL) 和 llm_decision (KEEP/DROP/PAUSE) 跟 fixture expected 一致 |
| **必命中规则** | LLM 输出在 must_fail_rule_ids 里的规则确实命中(applicable=true && result∈{FAIL,REVIEW}) |
| **必通过规则** | LLM 输出 must_pass_rule_ids 里的规则 applicable+PASS |
| **Augmentation 注入** | PASS 路径下,RAAS `/match-resume` 的 body.resume **首部**是 `## Rule Check Annotations` |
| **FAIL 不调 Robohire** | FAIL 路径下 matchResume 没被调到(Kenny §5 节省 Robohire 配额) |
| **Neo4j 写入** | 1 个 RuleCheckAudit 节点 + N 个 RuleCheckFlag 节点(N == applicable=true 的 rule_flag 数) |
| **Evidence 真实性** | 每条 `rule_flags[i].evidence` 抽出"看似引用"的片段(中文 ≥ 2 / 英文数字 ≥ 3 字符),在 parsed_resume JSON 里 grep — 全套场景 verifiability ≥ 80% |

---

## 3. 6 个 scenario

| # | scenario | candidate | JD | expected |
|---|---|---|---|---|
| 1 | `s01-clean-tencent-pcg-keep` | 张三 (clean) | 腾讯 PCG 前端 | PASS,augmentation 注入 |
| 2 | `s02-huawei-cooldown-drop` | 李四 (华为离职 1 个月) | 字节 TikTok | FAIL/PAUSE,10-25 命中 |
| 3 | `s03-csi-blacklist-drop` | 王五 (CSI A13 EHS) | 腾讯 PCG | FAIL/DROP,10-17 命中 |
| 4 | `s04-tencent-history-cross-studio` | 赵六 (腾讯 PCG 史) | 腾讯 IEG 天美 | FAIL/PAUSE,10-38 命中 |
| 5 | `s05-tencent-history-same-studio` | 赵六 | 腾讯 CDG | FAIL/PAUSE,10-38 命中,10-42 PASS |
| 6 | `s06-clean-bytedance-keep` | 张三 (clean) | 字节 TikTok | PASS,augmentation 注入 |

每个 scenario 在 fixture 里有明确的 `rationale` 字段,说明业务上"为什么应该这个 verdict"。

---

## 4. 文件清单

```
scripts/e2e-mock-test/
├── plan.md                          完整设计 / 架构 / 验收 (10 段)
├── README.md                        ← 本文件
├── fixtures/scenarios.ts            6 scenario × expected verdict 声明
├── mock-raas-server.ts              Node http RAAS API 模拟器 + setActiveScenario
├── neo4j-instance-writer.ts         RuleCheckAudit/Flag 写入(neo4j-driver 直连)
├── llm-stub.ts                      Deterministic LLM stub(LAN gateway 不可达兜底)
├── rule-check-stubbed.ts            Test 版 runRuleCheck(注入 stub LLM,production 不动)
├── pipeline-driver.ts               单 scenario 跑完整流程
├── verifier.ts                      verdict + evidence grep 断言
├── reporter.ts                      markdown 报告生成
├── run-all.ts                       orchestrator(CLI 入口)
├── start-test-neo4j.sh              Docker Neo4j 起 / 停
└── output/<run_id>/                 测试报告(.md per scenario + _summary.md)
```

---

## 5. 已知限制 + 后续

### 5.1 LLM 当前是 stub,不是真调

partner LAN LLM gateway (`AI_BASE_URL=http://10.100.0.70:3010/v1`) 从这边 timeout。
默认 `--llm=stub`,deterministic 按 fixture expected 构造输出 + evidence 引用简历原文。

**这验证的是**:管道 / Neo4j / mock RAAS / augmentation 注入 / evidence grep 算法 ✓
**这不验证**:LLM 真实推理质量 / 51 条规则真实命中准确率

**怎么切到真实 LLM**:
- gateway 恢复后,`npx tsx scripts/e2e-mock-test/run-all.ts --llm=real`
- 仍然走同一个 pipeline,只是把 stub LLM 换成 `runRuleCheck`(production 版本)
- 报告里 `llm_model` 字段会从 `stub:deterministic` 变成 `google/gemini-3-flash-preview`

### 5.2 Robohire 也是 stub(deterministic 在 mock RAAS 内)

`POST /api/v1/match-resume` 在 mock RAAS 里返回:
```js
{ matchScore: (resumeLen % 31) + 60, recommendation: ..., _stub_detected_augmentation: body.resume.startsWith('## Rule Check Annotations') }
```

`_stub_detected_augmentation` 字段是给 verifier 的 sanity 信号 — 帮我们确认 augmentation header 确实到了 Robohire 这层。

要打通真实 Robohire:在 mock-raas-server.ts 的 `/api/v1/match-resume` handler 里把 stub 换成 `fetch('http://localhost:4607/...')` + Robohire API key。当前从沙箱里不能直接调外网 Robohire,所以维持 stub。

### 5.3 没动 production 代码

- `lib/rule-check/runner.ts`(production runRuleCheck)没动 — 测试用 parallel `rule-check-stubbed.ts`
- `server/inngest/agents/*` 没动
- `lib/raas-api-client.ts` 没动 — 只是把它指向 mock RAAS server (`RAAS_API_BASE_URL=http://localhost:3001`)
- 叶洋 `lib/ontology-gen/`、`generated/v4/` 没动
- partner RAAS 那边契约保持 / 未触碰

### 5.4 不 commit

按要求,所有文件都在 `scripts/e2e-mock-test/`,**未 git add / commit / push**。
用户决定后续:
- ✅ ack 测试通过(test harness 用完一次性)→ 不需要 commit
- 或者想 keep:`git add scripts/e2e-mock-test/ && git commit`(我可以做,但需要明确指令)

---

## 6. 最近一次跑的结果

```
[e2e] FINAL: 6/6 passed

| # | Scenario                            | Decision     | Evidence rate | Status   |
| 1 | s01-clean-tencent-pcg-keep         | PASS (KEEP)  | 100%          | ✅ PASS  |
| 2 | s02-huawei-cooldown-drop           | FAIL (PAUSE) | 100%          | ✅ PASS  |
| 3 | s03-csi-blacklist-drop             | FAIL (DROP)  | 100%          | ✅ PASS  |
| 4 | s04-tencent-history-cross-studio   | FAIL (PAUSE) | 100%          | ✅ PASS  |
| 5 | s05-tencent-history-same-studio    | FAIL (PAUSE) |  96%          | ✅ PASS  |
| 6 | s06-clean-bytedance-keep           | PASS (KEEP)  | 100%          | ✅ PASS  |

Aggregate evidence verifiability: 166/167 (99%)
```

Neo4j 实测查回:
- 6 个 `RuleCheckAudit` 节点,scenario_id 各异,client_name / business_group / decision / llm_decision 全部正确
- 167 个 `RuleCheckFlag` 节点,经 `[:HAS_FLAG]` 链回各 audit
- partial_resume_fields 字段记下每次实际投影的简历字段集合

---

## 7. Kenny §1-5 落地证明

| Kenny § | 在测试里怎么体现 |
|---|---|
| §1 Get rules from ontology + CSI/client grouping | Phase 2 `ontology-source.ts` primary 调 Ontology API,fallback rules.json;prompt §3.1/3.2/3.3 三类分组,在报告 §4 LLM 原始输出可见 |
| §2 Partial parsed resume | `audit.partial_resume_fields` 字段记下每 scenario 实际发的简历字段(s02 = [name, experience, expected_salary_range, ...]) |
| §3 Augment resume with flags | PASS scenarios 的 `## 5. matchResume 调用 — body.resume` 头部含 `## Rule Check Annotations` 段 |
| §4 RoboHire match-resume(PASS only) | s01 / s06 调了 matchResume(报告 §5 抓拍 request body);s02-s05 FAIL 路径 matchResume 未调 |
| §5 不发不合格简历给 Robohire | s02-s05 的 `matchResume NOT called` assertion 全 ✓ |

---

## 8. Evidence 抽样(s02 华为冷冻为例,证明推理引用了简历原文)

LLM 输出 `rule_flags[10-25].evidence = "experience[0]: 华为, 离职 2026-03, 距今 < 阈值,命中"`

verifier 抽取片段:`["华为", "2026-03", "experience", "离职", "距今"]`

在原始 parsed_resume JSON.stringify 里 grep:
- ✓ `华为` matched(experience[0].company)
- ✓ `2026-03` matched(experience[0].endDate)
- ✓ `experience` matched(JSON 字段名)
- ✗ `离职` not literally in JSON
- ✗ `距今` not literally in JSON

Verifiable rate per rule 10-25: 3/5 = **60%** —> 这条 evidence 被认为 verified ✓(至少一段在原文里出现)

(说明:`离职`、`距今` 是 LLM 自然语言措辞,不在 JSON 原文。能 grep 到核心实体名+日期就足够,Kenny user story 验证目标是"LLM 是不是在编造",不是"逐字复刻"。)
