# 给 RAAS Partner 的对接文档 — Rule Check Gate 新增事件

> 来自:雨函 / Agentic Operator
> 日期:2026-05-12
> 关联:[docs/rule-check-unified-plan.md](./rule-check-unified-plan.md)
> 状态:**代码已落地,默认关 gate (`RULE_CHECK_ENABLED=false`)**;启用前请 partner 确认本文档

---

## 0. TL;DR

**AO 在 matchResumeAgent 内加了一个 LLM 预筛 gate**(在调 RAAS `/api/v1/match-resume` **之前**),根据 ontology 规则(从 Neo4j 抓)判断候选人是否值得进入 Robohire 深度匹配:

- ✅ **PASS** → AO emit `RULE_CHECK_PASSED` → 调 RAAS `/match-resume`(链路不变)
- ❌ **FAIL** → AO emit `RULE_CHECK_FAILED` → **不调 RAAS `/match-resume`**(直接 skip Robohire)

**Partner 需要做什么?**
1. **可选**:订阅 `RULE_CHECK_PASSED` 事件 — 业务上可以用它给 candidate 状态加"已通过预筛"标记
2. **建议**:订阅 `RULE_CHECK_FAILED` 事件 — partner 端可以把"未通过预筛"的候选人状态机更新 + 给 HSM 出审核界面
3. **不需要改任何已有接口** — 现有 `RESUME_PROCESSED → matchResume → MATCH_PASSED_NEED_INTERVIEW` 链路完全保留;PASS 路径行为 100% 兼容

---

## 1. 新事件 schema(2 个)

### 1.1 `RULE_CHECK_PASSED`

```ts
// 触发:AO matchResumeAgent rule-check 通过,即将调 /api/v1/match-resume
// 频率:1 次 / (candidate × JD) — 当 `job_requisition_id` 不在 RESUME_PROCESSED 时,
//      candidate 名下每条招聘中的 JD 都会发一条
{
  upload_id: string,           // RESUME_PROCESSED 透传的 upload_id
  candidate_id?: string,       // RAAS saveCandidate 返回的 candidate_id
  resume_id?: string,
  job_requisition_id: string,  // 本次匹配的 JD
  client_id?: string,          // JD 关联的 client(腾讯 / 字节 / ...)
  audit: {
    rules_evaluated: number,           // 这次评估了多少条规则(过滤后)
    rules_total_in_ontology: number,   // ontology 总规则数(参考)
    client_id: string,                 // 评估时使用的 client dim
    business_group: string | null,     // BG dim
    studio: string | null,             // studio dim
    llm_decision: "PASS",              // LLM 原始决策(此处必为 PASS)
    llm_model: string,                 // 用的模型,如 "google/gemini-3-flash-preview"
    llm_duration_ms: number,           // LLM 调用耗时
    llm_prompt_tokens?: number,
    llm_completion_tokens?: number
  }
}
```

### 1.2 `RULE_CHECK_FAILED`

```ts
// 触发:AO matchResumeAgent rule-check 不通过,**不调** /api/v1/match-resume
// 候选人不进 Robohire 深度匹配,需要 partner 端处理后续流程(通常是给 HSM 复核)
{
  upload_id: string,
  candidate_id?: string,
  resume_id?: string,
  job_requisition_id: string,
  client_id?: string,
  failure_reasons: string[],   // ["10-25:huawei_cooldown_<3m", "10-21:age_overflow"]
                               // 格式:<rule_id>:<short_code>
  hit_rules: Array<{
    rule_id: string,
    rule_name: string,         // 例:"华为荣耀竞对与客户互不挖角红线"
    severity: "terminal" | "needs_human" | "flag_only",
    result: "FAIL" | "NOT_APPLICABLE",
    evidence?: string          // LLM 引用简历原文的证据,如:
                               // "experience[0]: 华为, 离职 2026-03, 距今 < 阈值"
  }>,
  audit: {
    // ... 同 RULE_CHECK_PASSED.audit
    llm_decision: "FAIL"
  }
}
```

---

## 2. 时序图

### 2.1 之前(gate 关时,完全等价于现有链路)

```
raas_v4 → AO matchResumeAgent (RESUME_PROCESSED)
             → POST /api/v1/match-resume   (RAAS → Robohire)
             → POST /api/v1/match-results  (RAAS DB)
             → emit MATCH_PASSED_NEED_INTERVIEW → raas
```

### 2.2 启用 gate 后:PASS 路径

```
raas_v4 → AO matchResumeAgent (RESUME_PROCESSED)
             │
             │ (per JD)
             ├── LLM rule check → PASS
             │     emit RULE_CHECK_PASSED  ─────────→ raas (可选订阅,业务标记)
             │
             ├── POST /api/v1/match-resume (RAAS → Robohire)
             │     ★ resume 字段顶部带 "## Rule Check Annotations" markdown 段
             │     ★ Robohire 看到 LLM 的规则预判(增强 prompt context)
             ├── POST /api/v1/match-results
             └── emit MATCH_PASSED_NEED_INTERVIEW   ─→ raas (原链路)
```

### 2.3 启用 gate 后:FAIL 路径

```
raas_v4 → AO matchResumeAgent (RESUME_PROCESSED)
             │
             │ (per JD)
             ├── LLM rule check → FAIL
             │     emit RULE_CHECK_FAILED  ─────────→ raas (建议订阅)
             │     带 failure_reasons + hit_rules + evidence
             │
             └── ★ **不调** /api/v1/match-resume      ← 节省 Robohire 配额
                  ★ 候选人不进 Robohire 深度打分
                  ★ raas 端业务:候选人状态可以打"预筛未通过",HSM 复核界面接管
```

---

## 3. Partner 集成 checklist

### 3.1 不订阅事件(最小改动)

如果 partner 暂时不接 RULE_CHECK_*:
- AO 启用 gate 时,候选人 × JD 命中规则的不会出现在 `MATCH_PASSED_NEED_INTERVIEW` 流里
- partner 端表现为"这个候选人这个 JD 没结果"
- 候选人状态不更新

**风险**:用户在 partner UI 上看不到"为什么这个候选人没被推荐",HSM 也不知道该不该复核

### 3.2 推荐方案:订阅 `RULE_CHECK_FAILED`(中等改动)

partner 在 Inngest dev server 注册一个新 function:

```ts
inngest.createFunction(
  { id: 'rule-check-failed-handler', triggers: [{ event: 'RULE_CHECK_FAILED' }] },
  async ({ event, step }) => {
    const { upload_id, candidate_id, job_requisition_id, failure_reasons, hit_rules } = event.data;

    // 1. 更新候选人 × JD 状态:"预筛未通过" + 记录原因
    await step.run('update-candidate-status', async () => {
      await prisma.candidateMatch.upsert({
        where: { upload_id_job_requisition_id: { upload_id, job_requisition_id } },
        create: {
          upload_id, job_requisition_id, candidate_id,
          status: 'rule_check_failed',
          rule_check_failure_reasons: failure_reasons,
          rule_check_hit_rules: hit_rules,
        },
        update: {
          status: 'rule_check_failed',
          rule_check_failure_reasons: failure_reasons,
          rule_check_hit_rules: hit_rules,
        },
      });
    });

    // 2.(可选)如果 hit_rules 含 severity=needs_human,生成 HSM 待办任务
    const needsHsm = hit_rules.some(r => r.severity === 'needs_human');
    if (needsHsm) {
      await step.run('create-hsm-task', async () => {
        await partnerApi.createTask({
          type: 'rule_check_review',
          candidate_id, job_requisition_id,
          reasons: failure_reasons,
          context: hit_rules,
        });
      });
    }
  }
);
```

### 3.3 完整方案:订阅 PASSED + FAILED(完整审计)

- `RULE_CHECK_PASSED` → 候选人状态 = "已通过预筛,进入 Robohire 匹配中"
- `RULE_CHECK_FAILED` → 候选人状态 = "预筛未通过"
- 两个事件都把 `audit` 字段存到 partner 自己的 audit log 表,便于追溯

---

## 4. 启用切换

AO 这边通过 Inngest cloud 环境变量启用:

```
RULE_CHECK_ENABLED=true              # 总开关
RULE_CHECK_PROMPT_SOURCE=poc          # 默认 poc(已 e2e 验过)
RULE_CHECK_AUGMENT_RESUME=true        # 默认开,augmentation 注入 Robohire 的 resume
```

**启用顺序建议**:
1. partner 这边先实现 `RULE_CHECK_FAILED` handler(灰度环境)
2. AO 在 Inngest cloud 设 `RULE_CHECK_ENABLED=true`,**单 client 灰度**(例如先字节客户)
3. 观察 24-48 小时:`RULE_CHECK_FAILED` 命中率 + HSM 审核负担
4. 准确率 ≥ 4/6 场景测试通过率,逐步扩客户

**回滚预案**:
- AO 端 `RULE_CHECK_ENABLED=false` 一键关 — Inngest worker 下次 invocation 立即生效,无需 redeploy
- partner 端不需要任何动作(handlers 仍存在,不再被触发)

---

## 5. 数据存储约定

AO 端**已经实现**(默认 best-effort,失败不阻断主流程):
- 每次 rule check 写入本地 Neo4j 一个 `:RuleCheckAudit` 节点 + N 个 `:RuleCheckFlag` 节点
- 节点上的 `audit_id` = `rca_<run_id>_<upload_id_hash>_<jr_id_hash>`,reruns idempotent

partner 端**不需要**写 Neo4j。partner 收到 `RULE_CHECK_FAILED` 事件后:
- 把 `failure_reasons` 和 `hit_rules` 存进 partner 自己的 PostgreSQL(`candidate_match` 表的扩展字段)
- 用于 partner UI 展示 + HSM 审核

两边数据 **不重复存**:Neo4j 是 AO 的 agent 决策审计(包含完整 LLM raw output),partner 的 Postgres 是业务可见状态。

---

## 6. evidence 字段的语义(给 partner UI 展示用)

`hit_rules[i].evidence` 是 LLM 给出的"为什么这条规则命中"的自然语言推理片段,**引用候选人简历原文**。例如:

```
"experience[0]: 华为, 离职 2026-03, 距今 1.5 个月 < 3 个月阈值"
```

partner 可以在审核界面直接显示这段 evidence 给 HSM 看,**不需要 partner 自己重做规则计算**。

⚠️ **注意**:evidence 是 LLM 输出,**不是 100% 准确**。当前我们在 6 个 e2e 场景中实测:
- 全部 evidence 引用的简历字段值在原始 parsed_resume 里可 grep 命中
- ~90% 的命中规则推理符合规则原文 — 4/6 fully match,2/6 LLM 在多分支规则上有解读偏差
- 长期解决方案:ontology Rule 节点上加 `gating_severity` 字段(陈洋负责),避免 LLM 对多分支规则的歧义解读

---

## 7. AO 现在不向 partner 发的字段(将来可能加)

| 字段 | 现在 | 未来 |
|---|---|---|
| `resume_augmentation`(LLM 输出的 markdown 标注段) | 在 audit 内部记录 + 注入到 Robohire resume 字段顶部,**不在事件 payload 里发** | 如 partner 端也想看到 raw augmentation,后续可加到 event.data 顶层 |
| `llm_raw_output`(完整 LLM JSON 输出) | 存 Neo4j(`RuleCheckAudit.llm_raw_text`)+ AO 内部 audit | partner 不需要,如果需要审计粒度可加 |
| `partial_resume_fields`(实际发给 LLM 的简历字段子集) | audit 内记录 | 同上 |
| `rule_source`("neo4j-direct" / "ontology-api" / "json-fallback") | audit 内记录 | 同上 |

---

## 8. 联系 + 故障排查

- AO 这边:雨函(本仓 maintainer)
- 叶洋(ontology adapter / prompt 模板):见 [docs/yeyang-v5-ask-rule-flags-schema.md](./yeyang-v5-ask-rule-flags-schema.md)
- 陈洋(ontology Rule 节点字段):见 [docs/chenyang-ontology-ask-rule-fields.md](./chenyang-ontology-ask-rule-fields.md)

### 常见问题

**Q: AO 启用 gate 后,我们之前的 `MATCH_PASSED_NEED_INTERVIEW` handler 还会被触发吗?**
A: 会,**只是数量会减少**(被 gate 挡掉的不再走 matchResume 链路)。handler 代码不需要改。

**Q: gate 误杀了一个真实合适的候选人怎么办?**
A: 短期人工流程:HSM 收到 `RULE_CHECK_FAILED` 待办后,可以在 partner UI 上手动 "override"(标记"已审核,允许进入 Robohire"),触发 partner 端再发 `RESUME_PROCESSED` 一次(带 `bypass_rule_check: true` 字段?待 partner 提议)。长期:
ontology 改良规则文本 + Phase 3 gating_severity 字段降低误杀率。

**Q: LLM 调用挂了怎么办?**
A: AO 端 FAIL-safe — emit `RULE_CHECK_FAILED` 带 `failure_reasons: ["llm-call-error:..."]`。**不会**让候选人偷溜进 Robohire。

**Q: Partner 想看到完整 LLM 推理过程怎么办?**
A: 查 AO 端 Neo4j 的 `RuleCheckAudit` 节点,`llm_raw_text` 字段有完整 LLM 输出 JSON。或后续我们可以把 audit 信息也通过事件 payload 传给 partner。
