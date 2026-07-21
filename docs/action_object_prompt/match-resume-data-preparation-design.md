# matchResume Rule Check 测试数据准备设计

> 本文档是 `match-result-rule-check-test-user-guide.md` 的"数据准备"部分的详细设计。配套的脚本是：
>
> - `scripts/seed-rule-check-fixtures.ts` — 一次性 seed 全部 14 个测试场景的实例数据 + 关系数据
> - `scripts/run-rule-check-test-suite.ts` — 跑这 14 个场景 + 出 markdown 报告
>
> 目标：让 `runRuleCheck()` 的回归测试可重放，每次结果可对照同一份预期。

---

## 1. 设计原则

1. **属性名以 Ontology API 的 schema 为准**。每个 label（`Candidate` / `Resume` / `Job_Requisition` / `Application` / `Blacklist` 等）的合法属性名来自 `GET /api/v1/ontology/objects/{label}?domain=RAAS-v1` 返回的 `properties[]` 数组，**不能拍脑袋**。POST 一个未声明的属性 → `400 validation-failed`。
2. **link schema 里定义的关系必须建**。`runRuleCheck` 的图上下文预取（`graph-context.ts`）通过 `listInstances("Resume", { candidate_id })` 等 **property filter** 拿数据，所以 Resume / Application / Blacklist 必须有 `candidate_id` 属性；同时如果 schema 定义了 `Candidate-[:CANDIDATE_HAS_APPLICATIONS]->Application` 等 link，**也要建上**，避免 graph 端 schema 不一致。
3. **场景之间数据隔离**。每个 scenario 用独立的 `candidate_id` / `resume_id` / `blacklist_id` / `application_id`（命名加场景前缀，例如 `C-S01-100023`）。重跑 seed 是幂等的（POST 走 MERGE）。
4. **共享基础数据复用**。两条 JD `JR-TENCENT-001` / `JR-GENERIC-001` 跨多个场景复用；不会按场景重复建。
5. **链路而非关系的依赖**。`runRuleCheck` 内部读 graph 主要靠 property filter（不依赖 link 遍历）；只有 `employment_links` 这个 slot 走 `listLinks({ from: candidate_id, type: "EMPLOYED_BY" })`，是真实关系。除此之外 link 的存在/不存在不影响 rule check 结果，但建议都建以保持图的一致性。

---

## 2. Schema 发现流程（seed script 启动时执行）

### 2.1 Object schemas

```
GET /api/v1/ontology/objects?domain=RAAS-v1
  → { items: [{ id: "Candidate", primary_key: "candidate_id", properties: [...] }, ...] }
```

或者按需逐个：

```
GET /api/v1/ontology/objects/Candidate?domain=RAAS-v1
  → { id: "Candidate", primary_key: "candidate_id", properties: [
      { name: "candidate_id", type: "string", is_required: true },
      { name: "name",         type: "string" },
      { name: "gender",       type: "string" },
      ...
    ] }
```

seed script 启动后会拉以下 6 个 labels 的 schema：

| Label | 用途 |
|---|---|
| `Candidate` | 候选人主信息（性别、出生日期、状态、最高学历等） |
| `Resume` | 简历结构化数据（技能、工作经历、利益冲突声明等） |
| `Job_Requisition` | JD（学历/技能/年龄/经验要求等） |
| `Application` | 投递记录（候选人 × JD × 状态） |
| `Blacklist` | 黑名单命中（reason_code、reason_text） |
| `Employer` | 雇主节点（用于 EMPLOYED_BY link） |

每个 label 拉到后打印 `properties[].name`，**所有 seed 出去的字段都从这个列表里挑**，并在 seed 脚本顶部以 `// SCHEMA: Candidate { ... }` 注释固化下来。如果实际部署的 schema 不一样，运行 seed 会失败、错误信息会告诉你哪个字段不对，改一处即可。

### 2.2 Link schemas / link types in use

Ontology API 没有专门的 "link schema definition" 端点，但可以通过：

```
GET /api/v1/ontology/links?domain=RAAS-v1&limit=200
  → { items: [{ type, fromLabel, toLabel, ... }, ...] }
```

枚举现存所有 links 的 `type`、`fromLabel`、`toLabel` 三元组，从而推断 schema 允许哪些类型在哪些 label 之间。seed script 启动时也会拉一遍，打印出来：

```
Existing link types (RAAS-v1):
  HAS_FIELD                  (DataObject → DataObject)   [schema-level, ignore]
  CANDIDATE_HAS_RESUME       (Candidate → Resume)
  CANDIDATE_HAS_APPLICATIONS (Candidate → Application)
  CANDIDATE_HAS_BLACKLIST    (Candidate → Blacklist)
  APPLICATION_FOR_JD         (Application → Job_Requisition)
  EMPLOYED_BY                (Candidate → Employer)
  ...
```

我们要建的 link 类型（**待 seed 脚本启动时根据 schema 现实情况确认/修正**）：

| 类型 | from | to | 用途 |
|---|---|---|---|
| `CANDIDATE_HAS_RESUME` | Candidate | Resume | 候选人 ↔ 简历 |
| `CANDIDATE_HAS_APPLICATIONS` | Candidate | Application | 候选人 ↔ 投递（多） |
| `CANDIDATE_HAS_BLACKLIST` | Candidate | Blacklist | 候选人 ↔ 黑名单命中 |
| `APPLICATION_FOR_JD` | Application | Job_Requisition | 投递 ↔ JD |
| `EMPLOYED_BY` | Candidate | Employer | 候选人 ↔ 雇主（rule-check 显式使用） |

如果服务器返回 `400 invalid-link-type`，seed script 会跳过那条 link、记录到错误日志、继续往下走（property-only data 仍然可让大多数规则正常评估，只有 EMPLOYED_BY 缺失会让"回流/竞对"类规则信息不全）。

### 2.3 Property name 兼容性

考虑到不同部署的 schema 可能差异（field 命名风格、是否驼峰 vs snake_case），seed script 采用**白名单写入**：

```ts
// 在每次 POST 前过滤掉 schema 未声明的字段
function filterToSchema(label: string, payload: Record<string, unknown>): Record<string, unknown> {
  const declared = schemaProperties[label]; // Set<string>，启动时从 API 拉
  return Object.fromEntries(
    Object.entries(payload).filter(([k]) => declared.has(k) || k === 'domainId'),
  );
}
```

这样即使我们的"理想 payload"含有 schema 里没有的字段，只会被静默过滤、不会被 API 报 400 拒绝。**唯一需要绝对正确的字段是 primary key（如 `candidate_id`）和 `candidate_id` 这种用于 listInstances filter 的字段**；这两个 seed script 会显式检查。

---

## 3. 测试场景矩阵（更新自 user-guide §3）

| # | 场景名 | 触发数据 | 期望 decision | 主要命中规则 |
|---|---|---|---|---|
| **S1** | 控制组 PASS | 干净候选人，全部硬性达标 | PASS | 全部 pass |
| **S2** | 华为冷冻期 FAIL | work_exp.华为 2024-01 → 2026-04（< 3 月） | FAIL | 10-25 fail，下游 not_executed |
| **S3** | OPPO 已过冷冻 PASS | work_exp.OPPO 2024-01 → 2025-09（> 6 月） | PASS | 10-26 pass |
| **S4** | 小米未过冷冻 REVIEW | work_exp.小米 2024-01 → 2026-01（< 6 月） | REVIEW | 10-26 pending |
| **S5** | 腾讯历史 REVIEW | work_exp.腾讯 2018-2022（客户=腾讯） | REVIEW | 10-38 pending |
| **S6** | 黑名单高风险 FAIL | Blacklist {reason_code: A15} 前华腾 | FAIL | 10-17 fail |
| **S7** | EHS 挂起 | Blacklist {reason_code: A13(1)} 前华腾 | REVIEW | 10-18 pending |
| **S8** | 学历不符 FAIL | Resume 最高学历=大专（JD 要求本科） | FAIL | 10-5 fail |
| **S9** | 年龄超限 FAIL | Candidate dob=1980-01-01（JD age_max=40） | FAIL | 10-21 fail |
| **S10** | 必备技能缺失 FAIL | Resume.skills=[Python, Go]（JD 必备 Java） | FAIL | 10-5 fail |
| **S11** | 亲属回避 REVIEW | Resume.conflict_of_interest_declaration 提腾讯亲属 | REVIEW | 10-27 pending |
| **S12** | 岗位冷冻期 REVIEW | Application {status: 筛选淘汰, 近 3 月} | REVIEW | 10-32 pending |
| **S13** | 年龄信息不全 | Candidate dob=null（JD 有 age_max） | REVIEW | 10-21 insufficient_info |
| **S14** | 短路验证 | 华为冷冻期 + 大专学历同时存在 | FAIL | 10-25 fail；Step 2 全 not_executed |

每个场景独立的 ID：
- `C-S01-100023` ~ `C-S14-100036`（Candidate）
- `R-S01-100023` ~ `R-S14-100036`（Resume）
- `BL-S06-100028`、`BL-S07-100029`（仅 S6/S7 有黑名单）
- `A-S12-100034`（仅 S12 有投递历史）
- 雇主节点：`E-HUAWEI`、`E-OPPO`、`E-XIAOMI`、`E-TENCENT`、`E-HUATENG`、`E-BYTEDANCE` 等

---

## 4. 数据准备流程

### 4.1 准备的写入顺序（依赖顺序）

```
1. Object schemas 拉取 + 校验            (no writes)
2. Existing link types 探测              (no writes)
3. 共享 Employer 节点 × 6                MERGE
4. 共享 JD × 2 (JR-TENCENT-001, JR-GENERIC-001)   MERGE
5. 14 个 Candidate                       MERGE
6. 14 个 Resume                          MERGE
7. CANDIDATE_HAS_RESUME × 14             POST link
8. S6/S7 的 Blacklist × 2                MERGE
9. CANDIDATE_HAS_BLACKLIST × 2           POST link
10. S12 的 Application × 1               MERGE
11. CANDIDATE_HAS_APPLICATIONS × 1       POST link
12. APPLICATION_FOR_JD × 1               POST link
13. EMPLOYED_BY links (按场景 work_exp)  POST link
```

任何一步失败：log + 继续。最后打印汇总：`14 candidates · 14 resumes · 2 blacklists · 1 application · X links written, Y failed`。

### 4.2 单个场景的"完整数据视图"（以 S2 为例）

```
Candidate (C-S02-100024) {
  candidate_id: "C-S02-100024",
  name: "S02 — 华为近期离职",
  gender: "男",
  date_of_birth: "1990-01-01",
  candidate_status: "active",
  ...(其他 schema 声明的字段)
}

Resume (R-S02-100024) {
  resume_id: "R-S02-100024",
  candidate_id: "C-S02-100024",            ← 必须；用于 listInstances filter
  skills: ["Java", "Spring Boot", "MySQL"],
  work_experience: [
    {
      company: "华为",
      title: "软件工程师",
      start_date: "2024-01",
      end_date: "2026-04"                  ← 触发 10-25 (距 2026-05-13 < 3 月)
    },
    {
      company: "字节跳动",
      title: "高级工程师",
      start_date: "2017-07",
      end_date: "2023-12"
    }
  ],
  conflict_of_interest_declaration: "无",
  ...
}

Links:
  C-S02-100024  -[CANDIDATE_HAS_RESUME]->     R-S02-100024
  C-S02-100024  -[EMPLOYED_BY]->              E-HUAWEI       (start: 2024-01, end: 2026-04)
  C-S02-100024  -[EMPLOYED_BY]->              E-BYTEDANCE    (start: 2017-07, end: 2023-12)
```

### 4.3 Property 名 vs 结构化对象

Schema 通常把"work_experience"声明为 `List<JSON>` 或 `string`。如果是 `List<JSON>`，可直接传上面的数组；如果是 `string`，需要 `JSON.stringify`。seed script 在拉到 schema 后会检查 property 的 `type` 字段，自动 stringify 复合数据。

---

## 5. seed 脚本（`scripts/seed-rule-check-fixtures.ts`）

### 5.1 接口

```bash
# 一次性 seed 全部 14 个场景
npx tsx scripts/seed-rule-check-fixtures.ts

# 选项
#   --dry-run    只打印 schema、不写数据
#   --verbose    打印每次 POST 的请求/响应
```

### 5.2 控制流

```
1. 加载 .env.local（dotenv override:true，参考 export-action-ontology.ts）
2. 验证 ONTOLOGY_API_BASE / ONTOLOGY_API_TOKEN
3. 启动时一次性拉以下 schema：
     - GET /objects/Candidate, Resume, Job_Requisition, Application, Blacklist, Employer
     - GET /links?domain=RAAS-v1&limit=200 → 推断 link types
   打印每个 label 的 properties (name + type) 和现存的 link types。
4. 如果 --dry-run，到这里就结束。
5. 否则进入写入阶段：
     - 写 6 个 Employer
     - 写 2 个 JD
     - 写 14 个 Candidate + 14 个 Resume + 各种 link
     - 写场景特定的 Blacklist / Application + link
6. 失败时记录，最后输出汇总：
     ✓ 14 candidates · 14 resumes · 6 employers · 2 jd · 2 blacklists · 1 application
     ✓ 31 links written, 0 failed
     ✗ 2 link failures (CANDIDATE_HAS_BLACKLIST type rejected — link allowlist needs update)
```

### 5.3 数据来源

场景定义在脚本顶部一个 const 数组里：

```ts
const SCENARIOS: ScenarioFixture[] = [
  { id: "S01", candidate_id: "C-S01-...", name: "控制组 PASS", profile: {...}, expectedDecision: "PASS", ... },
  { id: "S02", candidate_id: "C-S02-...", name: "华为冷冻期 FAIL", profile: {...}, expectedDecision: "FAIL", expectedHits: ["10-25"], ... },
  ...
];
```

每条 fixture 包含：
- 候选人特征（性别、出生日期、最高学历）
- 简历特征（技能、工作经历数组、COI）
- 可选的黑名单记录
- 可选的投递历史
- 雇主映射（哪些 employer 节点是这个候选人 EMPLOYED_BY 的）
- 预期 decision / 主要命中规则（runner script 用这部分校验）

---

## 6. 测试运行脚本（`scripts/run-rule-check-test-suite.ts`）

### 6.1 接口

```bash
# 跑 14 个场景，输出 markdown 报告
npx tsx scripts/run-rule-check-test-suite.ts

# 选项
#   --only S05,S12     只跑指定场景（逗号分隔）
#   --jd JR-GENERIC-001  覆盖默认 JD（每个场景默认绑定 JR-TENCENT-001）
#   --no-report        不写报告文件，只控制台输出
```

### 6.2 控制流

```
1. 加载 .env.local
2. 从 fixture 模块拿 14 个场景的预期定义（与 seed script 共用同一份）
3. 对每个场景：
     - 调 buildRuleCheckInput({ candidate_id, job_requisition_id, ... })
     - 调 runRuleCheck(input)
     - 抓 result.decision, result.stats, result.rule_results
     - 与预期比对：
         - decision 一致？
         - 关键 hit rules 的 status 一致？
         - 短路场景：之后的规则是否真为 not_executed？
4. 输出：
     - 控制台逐场景一行结果（✓ / ✗ / ⚠）
     - data/rule-check-test-report.md（markdown 报告，含每个失败的差异）
```

### 6.3 报告格式（`data/rule-check-test-report.md`）

```markdown
# Rule Check Test Suite — Report
Generated: 2026-05-13T12:00:00+08:00
Total: 14, Passed: 12, Failed: 2

| # | Scenario | Expected | Got | Result |
|---|---|---|---|---|
| S01 | 控制组 PASS | PASS | PASS | ✓ |
| S02 | 华为冷冻期 FAIL | FAIL (10-25=fail) | FAIL (10-25=fail) | ✓ |
| S05 | 腾讯历史 REVIEW | REVIEW (10-38=pending) | PASS | ✗ |
...

## Failures

### S05 — 腾讯历史 REVIEW

Expected: decision=REVIEW, rule_results.find('10-38').status='pending'
Got:      decision=PASS, rule_results.find('10-38').status='pass'

Reason: LLM didn't trigger 10-38 despite work_experience including 腾讯 2018-2022.
Likely causes:
  - The prompt's STRICT_ORDER_BLOCK isn't being honored
  - The work_experience JSON wasn't injected (check graph.resume.work_experience)
  - The LLM model is weaker than expected
```

### 6.4 数据共享

`fixtures.ts`（新增 `lib/rule-check/__fixtures__/test-suite-scenarios.ts`，或者直接放 `scripts/rule-check-test-suite/fixtures.ts`）是 seed + runner 的单一事实源：
- seed 脚本读它构造 POST payload
- runner 脚本读它构造 input + 预期值

---

## 7. 失败时的诊断

1. **decision 跟预期不一致**：runner 报告会指出具体差异。第一步是看 `rule_results`：哪条规则的 status 跟预期不同？把那条规则的 `reason` 抓出来，理解 LLM 为什么这么判。
2. **关键 rule 没出现在 rule_results**：通常说明 `applyClientFilter` 把它过滤掉了 → 检查 `client_id` / `client_department_id` 与规则的 `applicableClient` / `applicableDepartment` 是否匹配。
3. **graph 数据没读到**：runner 跑完一个失败场景时，可以临时把 `runRuleCheck` 内的 `graph` 对象 console.log 出来，看是不是 `resume: null` / `applications: []`。如果是 null，回去看 seed 时该字段对不对（多半是 property name 没匹配 schema → 检查 `--dry-run` 模式打印的 schema 输出）。
4. **link 没建上**：不影响绝大多数规则。只有 EMPLOYED_BY 缺失会让 graph.employment_links=[]，使得"回流/竞对"类规则信息不全 → 报告里 10-25/10-26 之类的 status 会是 insufficient_info 而不是 fail。

---

## 8. 待办 / 后续优化

- **加分项规则**（10-1, 10-2 等"亮点识别"）目前不在 14 个场景里。可以加 S15-S17 三个"强候选人"场景，验证加分类 rule 的 status='pass' + reason 是否合理。
- **HSM 反馈处理**（10-39）依赖输入参数 `hsm_feedback`，不依赖 graph。可以让 S5（腾讯历史挂起）再跑两次：一次 `hsm_feedback={result:"非淘汰退场"}`，一次 `hsm_feedback={result:"淘汰退场"}`，验证两种走向。
- **客户矩阵扩展**：S15-S16 跑 `CLI_BYTEDANCE` 客户，验证 `applicableClient=腾讯` 的规则被正确过滤为 `not_triggered`。
- **CI 接入**：本测试套件依赖真实 Ontology API + LLM 调用，不能跑在普通 CI 里。设想是做成 nightly 任务，跑完后 commit `data/rule-check-test-report.md` 到 `docs/rule-check-reports/<date>.md` 留作回归基线。
