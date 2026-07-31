# RAAS-v1 agents 改造 — 旧仓(server/inngest)落地映射

- **日期**: 2026-07-21
- **源设计**: `/Users/yuhancheng/Desktop/agentic operator_new/docs/raas-v1-agents-optimization-design.md`(v0.7)
- **本文档作用**: 源设计按**新 monorepo**布局(`models/`、`tenants/`、`packages/`)写成;本仓是**旧版 agentic operator**,RAAS-v1 agents 落在 `server/inngest/`。此处把源设计三部分**逐条映射到旧仓真实文件**,并补上源设计没有的**上线安全性分析**(用户红线:"确保上线后也能用我们这版的 agents,能正常运行")。
- **实施铁律**: TDD 先行 → `npm run build` typecheck → 可行处 live 验证。改动只碰 AO 侧;不动与 RAAS 共享的 partner 库 schema。

## 已核实的旧仓基线(与源设计的差异)

| 关注点 | 旧仓真实状态 | 证据 |
|---|---|---|
| 10-1 rule-check 触发器 | **`RESUME_PROCESSED`**(非 `MATCH_RULE_CHECK`) | `server/inngest/agents/rule-check-agent.ts:891` |
| 10-1 是否已透传 candidate_expectation | **是**(入 `:91`,出 `:771`/bypass `:385`) | 同上 |
| 9-1 resume-parser 产出 | `RESUME_PROCESSED`(payload 含 `candidate_expectation`) | `resume-parser-agent.ts:595` / `:563` |
| `MATCH_RULE_CHECK`(裸事件) | **不存在**(只有 `_PASSED`/`_FAILED`) | `client.ts:346-348` |
| 事件名定义方式 | **每个 agent 内联字符串字面量**,无中心 catalog | Explore 全量核实 |
| 候选人期望来源 | **RAAS 已在 `RESUME_DOWNLOADED.payload.expectation_payload` 直接提供** | RAAS `resume-upload-core.ts` + AO 真实运行日志 |
| 手机号归一化器 | **两套**:`field-normalize.ts:normalizePhone`(rule-check)、`candidates.ts:normalizeMobile`(dedup+落 `mobile_normalized`) | `lib/rule-check/candidate-match/field-normalize.ts:13`、`lib/partner-pg/candidates.ts:108` |
| `libphonenumber-js` | **未安装** | package.json 无 |
| 源设计 §3 提到的 `business_records` / `agent_memory_long` 消费点 | **旧仓不存在** | grep 全空 → Part 3 blast radius 仅 2 消费点 |
| createJD 需求装载 | `getRequirementDetail` 只 JOIN spec,**不 JOIN client** | `lib/partner-pg/requirements.ts:34-43` |
| createJD 当前 companyName | 直传 `sd_org_name`/`client_name` **真名** → 违反本体规则 4-2 | `create-jd-agent.ts:255` |
| 本体规则拉取工具 | **已存在** `fetchActionRules(action, domain)` | `lib/ontology-rules.ts:46` |

## 已批准的决策(2026-07-21,用户拍板)

1. **范围**: 三部分全做。
2. **Part 3 手机号**: **仓内归一化先统一**(把两套 normalizer 合成一个 E.164 规范器,两消费点共用,修国际号假并/假拆)。**不改共享 partner 库 schema**(不加 `mobile_e164` 列、不迁移回填);源设计的共享库列迁移显式**推迟**(其详细子文档尚未成文 + 有 RAAS 线上双形依赖 blocker)。
3. **Part 1 候选人期望**（2026-07-24 最终决策）: **不改事件名、不增加中间事件**。RAAS 在 `RESUME_DOWNLOADED` 已经携带 `expectation_payload`；AO 9-1 在同一持久化事务内写共享 PostgreSQL 的 `candidate_expectation`，随后通过 Allmeta API 写 `Candidate_Expectation` Neo4j 实例，再按原契约发布 `RESUME_PROCESSED`。10-1 仍直接订阅 `RESUME_PROCESSED`。
   - RAAS 原始字段保持单数字符串形态（例如 `expected_position/location/salary_range`），用于 PostgreSQL 与 Allmeta 双写。
   - 发给 matcher 前再转换成 AO 的 `CandidateExpectationNested`（数组 + 月薪上下限）；旧事件没有 `expectation_payload` 时才回退到简历文本抽取。
   - 先前的事件拆分、RAAS 回发硬依赖和旁路开关方案已撤回，对接说明文档一并删除。

---

## 第一部分 — 候选人期望直读 + PostgreSQL / Neo4j 双写

### 目标时序
```
RAAS RESUME_DOWNLOADED(expectation_payload)
             │
             ▼
      [9-1 resume-parser]
             ├── 同一事务写 PostgreSQL:
             │     Candidate + CandidateExpectation + Resume
             ├── 经 Allmeta API 写 Neo4j:
             │     Candidate + Candidate_Expectation + Resume
             └── 原事件名发布 RESUME_PROCESSED
                            │
                            ▼
                   [10-1 rule-check]
                            │ 原样透传 candidate_expectation
                            ▼
                   [10-2 match-resume]
                   candidatePreferences → RoboHire
```

### 改动清单
| 文件 | 改动 |
|---|---|
| `lib/raas-v1/candidate-expectation.ts` | 白名单化、trim `expectation_payload`，只允许 CandidateExpectation 的 7 个业务字段 |
| `lib/partner-pg/candidates.ts` | 在 Candidate 已存在后复用首个 expectation id，或生成 UUID 后创建并回链；与 Candidate / Resume 同事务 |
| `lib/allmeta-writers/candidate-expectation.ts` | 严格按 RAAS-v1 `Candidate_Expectation` schema 写 Allmeta / Neo4j |
| `lib/mappers/candidate-preferences.ts` | 将 RAAS 单数字段转换为 matcher 的数组与月薪上下限 |
| `server/inngest/agents/resume-parser-agent.ts` | 从入站事件取 `expectation_payload`，传 PostgreSQL writer、写 Allmeta，并继续发布原 `RESUME_PROCESSED` |
| `server/em/schemas/builtin.ts` | 在 `RESUME_DOWNLOADED` schema 显式登记 `expectation_payload` |

### 上线安全性(关键)
- **事件拓扑零变化**：replay 路由、e2e/ops 脚本、RAAS reassign-republisher 与 10-1 触发器均继续使用 `RESUME_PROCESSED`。
- **PostgreSQL 是主写**：CandidateExpectation 与 Candidate/Resume 同事务；任一失败都会回滚，避免发出“已完成”但期望未落库的事件。
- **并发幂等**：锁住 Candidate 行，复用 `candidate_expectation_id[0]`；没有才生成 UUID，重复消费只更新同一行。
- **Allmeta 软失败**：沿用现有 dual-write 策略，Neo4j 写失败会记录告警但不回滚 PostgreSQL 主数据。
- **向后兼容**：入站没有 expectation 时完全不创建 expectation 行，matcher 继续使用既有简历文本兜底。

### 测试(TDD)
- payload：真实 `expected_position/location/salary_range` shape、空值、未知字段、constraints。
- PostgreSQL：已有 expectation 更新；没有则创建并回链；无 payload 零写入。
- Allmeta：对象名与严格字段白名单。
- matcher：`13000-15000` 转为月薪上下限，职位/地点/行业转数组。
- 事件回归：ResumeParser 仍只发布 `RESUME_PROCESSED`，RuleCheck 仍只订阅它。

---

## 第二部分 — createJD 入参优化(公司上下文 + 规则注入 + 匿名化)

### 改动清单
| 文件 | 改动 |
|---|---|
| `lib/partner-pg/requirements.ts` | `getRequirementDetail` 的 SQL 加 `LEFT JOIN client c ON c.client_id = r.client_id`;返回附 `client_industry`/`technical_stack_preference`/`welfare_policy` + 派生 `company_descriptor="某{industry}行业知名企业"`(缺行业→"某知名企业");**真名 `client_name` 不进 carry**(仅内部 compliance 校验用) |
| `server/inngest/agents/create-jd-agent.ts` | ① 新步骤 `fetch-createjd-rules`:`fetchActionRules('createJD', 'RAAS-v1')`,Allmeta 宕机 fail-closed(warn+空);② `buildPromptFromRequirement` 追加**公司背景块**(行业/技术栈/福利)+**生成约束块**(4-2/4-3/4-4 渲染成指令)+**分区预算**(约束+背景保底~500 字符,需求正文优先截断,总长≤4000);③ `generateJdDirect` 的 `companyName` 改传 `company_descriptor`(匿名),不再传真名;④ 生成后落库前 `verifyJdCompliance` |
| 新 `lib/robohire/verify-jd-compliance.ts` | 零 LLM 确定性后校验:JD 正文含 `client_name` → 替换为 `company_descriptor` 并记 `compliance_fixes[]` |

### 上线安全性
- 所有新入参**可选**,缺失即今日行为 = 零回归(源设计 §6)。
- Allmeta 宕机 → 规则拉取 fail-closed 空数组 → prompt 少一段约束块,不阻断 JD 生成(与今天等价)。
- **回滚**:恢复 companyName 取值 + 删新步骤。

### 测试(TDD)
- `verifyJdCompliance`:正文含真名→替换+标记;不含→原样+空 fixes。
- prompt 预算:约束/背景块在超长时不被 4000 截断;需求正文被优先截。
- `company_descriptor` 派生:有行业/无行业两分支。
- 规则拉取失败 → 空约束块 + JD 仍生成(fail-closed 不 throw)。

---

## 第三部分 — 候选人手机号归一化(仓内统一,不动共享库)

### 改动清单
| 文件 | 改动 |
|---|---|
| `package.json` | 加依赖 `libphonenumber-js` |
| 新 `lib/phone/normalize-e164.ts` | 单一权威:`toE164(raw, {defaultRegion='CN'})→{e164,valid,type}`(用 libphonenumber-js);`canonicalMobile(raw, region?)→string\|null`(有效个人号型返回 E.164,否则 null)。默认区号解析链留 hook(JD 国家/国籍线索/租户默认 CN),本期默认 CN 但**绝不盲目补 +86**(仅当 isValid) |
| `lib/rule-check/candidate-match/field-normalize.ts` | `normalizePhone` 内部改调 `canonicalMobile`;无效退化返回既有"去数字后 11 位"以**保持向后兼容**(不制造新的假拆) |
| `lib/partner-pg/candidates.ts` | `normalizeMobile` 内部改调 `canonicalMobile`;**`mobile_normalized` 列语义/dedup SQL 完全不变**(仍写这一列,值改为更准的 E.164 规范形);保留 `DEDUP_PHONE_PRIMARY` 语义 |

### 上线安全性(用户最担心的一块)
- **不改共享 partner 库 schema**:不加列、不迁移、不回填 → RAAS 侧读写 `mobile_normalized` 不受结构影响。
- **值兼容性**:新规范形对**中国号**结果与旧"后 11 位"**一致**(E.164 `+8613800138000` 的国内可比形仍是 `13800138000` 口径);仅对**国际号**从"错误的后 11 位"变为"正确的 E.164",消除假并/假拆。中国号占绝对多数 → dedup 命中率不回退。
- **fallback 保守**:libphonenumber 判无效时退回旧启发式,不 NULL 化既有可匹配值。
- **回滚**:normalizer 内部改回旧实现(不涉及库/数据)。

### 测试(TDD)
- `toE164`:中国手机 `+86 138…`/`086-138…`/`138…`→ `+8613800138000`;新加坡号 → `+65…` 不与中国号尾数假并;固话/无效 → invalid。
- `canonicalMobile`:有效个人号→E.164;<7 位/无效→null。
- 回归:`normalizePhone` 对既有测试用例(`+86 138 0013 8000`→`13800138000` 等)结果不变(经内部转换后仍稳定)。
- dedup 不回退:两条中国号不同写法仍并到一人;中/新两国尾数相同不再假并。

---

## 明确排除(本次不做)
- 共享 partner 库 `mobile_e164` 双列 + 迁移/回填/双读窗口(源设计 §3 最终形态,推迟,需与 RAAS 协调)。
- 额外的候选人期望补齐事件 / RAAS 回发链路（已取消；RAAS 上传事件已经携带期望）。
- 把 `Candidate_Expectation` 加进 10-1 `objectTypes` 让 4 条期望规则进规则检查(源设计 §1.8 未来增强)。
- createJD 规则 4-1(相似 JD 聚合)/4-5(生成时机审核)——AO 发布生命周期规则,backlog。

## 实施顺序
1. Part 3 手机号(最自包含) → 2. Part 2 createJD(安全、零回归) → 3. Part 1 候选人期望双写(保持 live 事件拓扑不变)。
每部分:失败测试 → 实现 → 绿 → typecheck。三部分全绿后整体 `npm run build` + live 链路验证。
