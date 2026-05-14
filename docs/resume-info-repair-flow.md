# 简历缺字段补全闭环 — 最终流程

> 简历 rule-check 发现关键字段缺失时,如何让 recruiter 补全并自动重判的完整闭环。

- **状态**:已实现,AO 端零中间 handler · partner 端 3 处改动
- **新事件数**:**0**(全部用已有事件)
- **AO 代码**:`matchResumeAgent` 处理一切;`infoFilledHandler` 已删除
- **partner 文档**:[raas-partner-integration-spec-for-claude-code.md](raas-partner-integration-spec-for-claude-code.md)

---

## 1. 设计原则

| 原则 | 体现 |
|---|---|
| **数据所有权** | `parsed_resume` 由 RAAS 调 RoboHire 拿到,RAAS 持有;补全也由 RAAS merge,无重复存储 |
| **无新事件** | `RESUME_INFO_MISSING` 已在白名单;补全后重发 `RESUME_PROCESSED`(已是常规事件) |
| **统一代码路径** | 补全重判走的就是新简历入系统的标准 `matchResumeAgent` 链路 |
| **谱系串联** | `enrichment_applied.parent_audit_id` 把"补全前 audit"→"补全后 audit"串起来 |
| **自然收敛** | 补全后还缺 → 自然再发 `RESUME_INFO_MISSING`(下一轮),无需 retry 计数器 |

---

## 2. 完整事件链(简化版)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ RAAS partner                       Shared Inngest                  AO          │
│ (10.100.0.70)                      (event bus :8288)               (port 3002) │
└────────────────────────────────────────────────────────────────────────────────┘

RAAS 上传简历 ─► parse(RoboHire) ─► emit RESUME_PROCESSED ─►
                                                                     ▼
                                                       Shared Inngest server
                                                                     │
                                                                     ▼
                                  ┌─────────────────────────────────────────┐
                                  │  AO  matchResumeAgent                   │
                                  │  Step 1-3) fetch JR + 准备数据           │
                                  │  Step 4.0) rule-check LLM 预筛           │
                                  │  Step 4b) 写 Prisma audit + Neo4j 实体  │
                                  │           + Candidate_Match_Result       │
                                  └──────────────────┬──────────────────────┘
                                                     │
                          ┌──────────────────────────┼─────────────────────────────┐
                          │ rule-check PASS          │ rule-check FAIL              │
                          │                          │                              │
                          ▼                          ▼ (互斥分流,看有无 missing)    │
                  Step 4a:                  ┌─────────────────┐                   │
                  调 RAAS API Server         │ 有 missing 字段? │                   │
                  /api/v1/match-resume       └────────┬────────┘                   │
                  (RAAS 内部 proxy            ┌────────┴────────┐                   │
                   到 Robohire)              │ 是              │ 否                │
                          │                  ▼                  ▼                   │
                  emit MATCH_RESUME_*  ① emit RESUME_INFO   emit RULE_CHECK_FAILED  │
                  (happy path 结束)     _MISSING(乐观:补全  (硬性失败,partner       │
                                       后能 PASS)         关任务,终止)             │
                                              │                                      │
                                              ▼                                      │
                                       (走下面 partner 补全循环)─────────────────────┘
                                                                          │
                                                                          ▼
                                                       RAAS event_outbox → dispatcher
                                                                          │
                                                                          ▼
                                                       hitl-event.consumer 匹配
                                                       HITL mapping(R1 要补)
                                                                          │
                                                                          ▼
                                                       INSERT hitl_task(recruiter)
                                                                          │
                                                                          ▼
                                                       recruiter 工作台看到任务
                                                       打开表单页(R3)
                                                                          │
                                                                          ▼
                                                       提交时(R3.2 submit handler):
                                                       a) 中→英 key 翻译
                                                       b) merge 进本地 parsed_resume 副本
                                                       c) appendOntologyEvent({
                                                            event_name: RESUME_PROCESSED,
                                                            payload: {
                                                              parsed: { data: merged },
                                                              enrichment_applied: {
                                                                parent_audit_id: ←
                                                                  原 RESUME_INFO_MISSING.
                                                                  payload.audit_id
                                                              },
                                                              source_channel:
                                                                'raas_recruiter_repair_replay'
                                                            }
                                                          })
                                                                          │
                                                                          │ outbox → Inngest
                                                                          ▼
                                                       Shared Inngest server
                                                                          │
                                                                          ▼ ② RESUME_PROCESSED 重发
                                  ┌─────────────────────────────────────────┐
                                  │  AO  matchResumeAgent(同一函数,重跑)   │
                                  │  - 读 event.data.enrichment_applied.    │
                                  │    parent_audit_id                      │
                                  │  - 新 audit 写 Prisma 时带 parent       │
                                  │  - rule-check 重跑                      │
                                  │     · PASS  → MATCH_RESUME_*           │
                                  │     · 还缺  → 再次 ① 进下一轮          │
                                  └─────────────────────────────────────────┘
```

---

## 3. 事件清单

| 事件 | 方向 | 通道 | 状态 |
|---|---|---|---|
| `RESUME_DOWNLOADED` | RAAS → AO | partner Inngest | 现有 |
| `RESUME_PROCESSED` | RAAS → AO | partner Inngest | 现有(补全后**复用**) |
| `RESUME_INFO_MISSING` | AO → RAAS | HTTP `POST /api/v1/events/ingest` | 白名单已有;HITL mapping 要补 |
| `MATCH_RESUME_PASSED` / `MATCH_RESUME_FAILED` | AO → RAAS | partner Inngest | 现有 |

**所有事件都是现有的**。

---

## 2a. 关键设计:FAIL 路径 emit 互斥

| rule-check 结论 | 有 missing 字段? | emit 事件 | 语义 |
|---|---|---|---|
| **PASS** | — | (无 — 走 RAAS API Server → Robohire) | 不发"问题"事件,Robohire 后发 `MATCH_PASSED_*` / `MATCH_FAILED` |
| **FAIL** | **有** | `RESUME_INFO_MISSING` | 可救:partner 触发 recruiter 补全 → 期望补完后 PASS |
| **FAIL** | **无** | `MATCH_FAILED` (payload `match_failed_source='rule_check_terminal'`)| 硬性失败(候选人没通过门槛),partner 关任务 — 跟 Robohire-fail 走同一事件 |

**不会同时发**两个事件 — 避免 partner 收到"既要补全又要关任务"矛盾信号。

**复用 `MATCH_FAILED`**:rule-check 硬性失败本质就是"撮合失败",跟 Robohire 评分失败语义一致,partner 走同一事件处理。AO 不再发额外的 `RULE_CHECK_FAILED`(那是个内部概念)。

**自然收敛**:补完 missing 后还 FAIL(如学历真的不符)→ 自动走 `MATCH_FAILED` 分支终止。无需 retry 计数器。

---

## 2b. 同时发的 Neo4j 写入

每次 matchResumeAgent 跑完,写入按阶段分:

| 阶段 | 写入 | 内容 |
|---|---|---|
| **总是写** | Prisma `RuleCheckAudit` + `RuleCheckFlag` | 完整 LLM prompt / raw response / decisions / 全部 flags(含 applicable=false)|
| **总是写** | Neo4j `Candidate` / `Resume` / `Job_Requisition` 实体节点 + 关系 | 锚定实体身份 |
| **仅 PASS + RAAS match 完成后写** | Neo4j `Candidate_Match_Result` 节点 | rule-check 推理 + match score / recommendation,真正"匹配结果"的实例 |

**为什么 FAIL 时不写 Match_Result**:rule-check 阶段只是推理(audit + flags 已经覆盖),没真正跑过 RAAS matchResume,**没有 match 维度数据**。Match_Result 节点的语义是"匹配结果",rule-check FAIL 时这条候选根本没走完匹配链路,不算"匹配结果"。FAIL 的审计完整保留在 Prisma `RuleCheckAudit`。

`Candidate_Match_Result` 是 AO 给 RAAS partner 的**共享数据契约**(partner 可以从 Neo4j 查任意成功跑完的 candidate-on-jr 决策 + score + 谱系)。

---

## 4. partner ↔ AO 对接契约(就这一条)

partner 在它内部任意时机(recruiter 完成补全后)重发已有的 `RESUME_PROCESSED` 事件,payload 必须含:

```typescript
enrichment_applied: {
  parent_audit_id: <原 RESUME_INFO_MISSING.payload.audit_id 原样回传>,
}
```

**就这一个字段** — `enrichment_applied.parent_audit_id`。其余 `RESUME_PROCESSED` payload 字段跟首次发简历时一样,只是 `parsed.data` 含 recruiter 补的字段。

partner 内部怎么:
- 接收 `RESUME_INFO_MISSING`(HITL 任务 / 独立 Inngest function / 内部 admin 工具 都行)
- 通知 recruiter
- 渲染表单
- 校验输入
- 存任务状态

**AO 完全不关心**。partner 决定。

---

## 5. partner 实现建议(非强制)

partner 看 ingest 文档 §5 现有 8 个 HITL 事件(`resume_fix` / `jd_review` 等),按同模式接入 `RESUME_INFO_MISSING` 是最快路径:

| 步骤 | 工作量 |
|---|---|
| 给 `RESUME_INFO_MISSING` 加 HITL mapping(`task_type` 名 partner 自定) | 5 分钟 |
| 给新 task_type 加 recruiter 工作台 UI + submit handler(参考现有 `resume_fix` 等) | 1-2 小时 |

**总计 1-2 小时**。详细模式见 [raas-partner-integration-spec-for-claude-code.md](raas-partner-integration-spec-for-claude-code.md) §3a。

---

## 5. AO 改动清单(已完成)

| # | 任务 | 文件 | 状态 |
|---|---|---|---|
| A1 | 删 `infoFilledHandler`(原来做 merge,现在 partner 做) | `server/inngest/agents/info-filled-handler.ts` | ✅ 已删 |
| A2 | 从 Inngest function 注册移除 | `server/inngest/functions.ts` | ✅ 已改 |
| A3 | 删 `lookupAudit` 工具函数(没人用了) | `lib/rule-check/prisma-audit-writer.ts` | ✅ 已删 |
| A4 | `matchResumeAgent` 读 `enrichment_applied.parent_audit_id` | `server/inngest/agents/match-resume-agent.ts:357-360` | ✅ 早已支持 |

净代码减少 ~110 行。

---

## 6. 字段映射表

recruiter 在 RAAS 表单看到中文字段名,partner submit handler 翻译为 AO `parsed_resume` 的英文 key:

| 中文(表单输入) | 英文(parsed_resume key) | 例值 |
|---|---|---|
| 性别 | `gender` | "男" |
| 婚育情况 | `marital_status` | "未婚" |
| 国籍 | `nationality` | "中国" |
| 出生年份 | `birth_year` | "1996" |
| 出生日期 | `birth_date` | "1996-05-12" |
| 期望薪资 / 期望薪资范围 | `expected_salary_range` | "15k-18k" |
| 利益冲突声明 / 利益冲突声明数据 | `conflict_of_interest_summary` | "已声明无亲属冲突" |

partner 端 const 表见 [partner spec §4](raas-partner-integration-spec-for-claude-code.md#4-ao-字段映射表给-r3-表单填写参考)。

---

## 7. 谱系串联机制

AO 端怎么知道一条 audit 是"补全后重判"?靠 `parent_audit_id`:

```typescript
// AO 端 matchResumeAgent 写 Prisma audit 时:
parent_audit_id: event.data.enrichment_applied?.parent_audit_id ?? null
```

效果:
- 新 audit `rca_NEW` 的 `parent_audit_id = rca_OLD`
- 前端 drawer 渲染时能展示"补全前 (rca_OLD)" vs "补全后 (rca_NEW)"
- Prisma 查询能拉出完整重判链:`SELECT * FROM RuleCheckAudit WHERE parent_audit_id = ?`

`source_channel: 'raas_recruiter_repair_replay'` 是 partner 标记本次重发的可选字段,前端可据此把 audit 标"补全后重判"图标。

---

## 8. 自然收敛(不需要 retry 计数器)

| 情况 | 行为 |
|---|---|
| recruiter 填齐 → rule-check PASS | matchResumeAgent 走到 Robohire match,流程结束 |
| recruiter 填了但还缺 | rule-check 再次发现 missing,AO 又 emit `RESUME_INFO_MISSING`(audit_id 是新的) → 进入下一轮循环 |
| recruiter 一直不填 | partner 的 `ResumeRepairTask.status = 'pending'`,在 recruiter 工作台一直挂着,partner 自己决定何时升级 HSM(跟 AO 无关) |

AO 端不需要算 retry 次数,也不需要 `HUMAN_REVIEW_REQUIRED` 事件 — partner 工作流自己处理升级。

---

## 9. 验证脚本

[scripts/e2e-raas-mock-loop.ts](../scripts/e2e-raas-mock-loop.ts) 完整模拟 RAAS partner 行为:

```bash
npx tsx scripts/e2e-raas-mock-loop.ts
```

测试矩阵:
- [A] AO + Inngest + Neo4j + 真实 partner API 健康
- [B] 挑现存 audit(江银行 → 腾讯 R20260401429)
- [C] 模拟 recruiter 填表 + partner merge + 重发 RESUME_PROCESSED
- [D] AO matchResumeAgent 重跑(rule-check LLM + Robohire,~40s)
- [E] Prisma 新 child audit + parent_audit_id 谱系 + 补全字段进入
- [F] Neo4j candidate-resume-jr 三角完整

---

## 10. 设计演进史(为什么最后是这样)

| 版本 | 设计 | 问题 |
|---|---|---|
| v1 | 3 个新事件:`RESUME_INFO_MISSING` + `RESUME_INFO_MISSING_FILLED` + `RESUME_INFO_MISSING_VALIDATION_FAIL` + `HUMAN_REVIEW_REQUIRED` | 过度工程,partner 要注册 3 个事件;AO 要维护 retry 计数器 |
| v2 | 2 个事件:砍掉 `VALIDATION_FAIL` 和 `HUMAN_REVIEW_REQUIRED`,保留 `RESUME_INFO_MISSING` + `RESUME_INFO_MISSING_FILLED` | AO 需要 `infoFilledHandler` 中间层做 merge;partner 不持有 parsed_resume 也要发完整 delta |
| **v3(当前)** | **0 个新事件**:`RESUME_INFO_MISSING`(已有) + 补全后 partner 重发 `RESUME_PROCESSED`(已有) | ✅ 最简 · partner own data 做 merge · AO 零中间层 |

关键洞察:**`parsed_resume` 的原始持有者是 RAAS**(它调 RoboHire 拿到的),所以 merge 应该在 RAAS 端做 — AO 不应该复制一份再 merge。
