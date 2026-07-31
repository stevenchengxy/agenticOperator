# Rule-Check 独立化 + RoboHire 直连 — 设计文档

> 作者: Claude (代 Steven)
> 日期: 2026-05-19
> 范围: (1) rules_v0_1_002 数据迁移 (2) 删除 inferSeverity 启发式 (3) rule-check 从 matchResumeAgent 拆出独立 workflow agent (4) 简历解析 / 简历匹配 从 RAAS proxy 切换到直连 RoboHire (5) `/rule-check` UI 适配
> 状态: 待 user review (写完直接走 user gate, 不派 spec-document-reviewer per user preference)

---

## 0. 一句话目标

把 rule-check 从 matchResumeAgent 的 `step.run('rule-check-*')` 内嵌位置抽离成独立 Inngest workflow agent;同时用 `enforcementLevel` + `failurePolicy` 取代 `inferSeverity()` 关键词启发式;把 RoboHire-backed 能力(parse-resume / match-resume)从"经 RAAS 代理"切到"AO 直连 RoboHire";rules_v0_1_002.json 替换 Neo4j + 本地 JSON fallback。

---

## 1. 与现状的对比

### 1.1 chenyang 设计文档 vs AO 现状

| 维度 | chenyang DESIGN_DOC | AO 现状 | 差异 |
|---|---|---|---|
| 入口 | 独立 lib `runRuleCheck` + `/rule-check` UI 评估页 | lib 已存在(基本 fork chenyang),**且嵌进 matchResumeAgent step 4.0**(env gate `RULE_CHECK_ENABLED`) | 多一层耦合,本 spec 要拆掉 |
| 客户过滤 | `applyClientFilter` 直接按 `applicableClient` 字段匹配 | 同上 | **本来就不是 LLM 判断 — 用户对术语的理解需要校准:见 §1.2** |
| 严重态 | `inferSeverity()` 关键词 heuristic (33+ 中文关键词) | 同上 | 新 rule data 已显式化 `enforcementLevel` + `failurePolicy`,删除 heuristic |
| Rule 数据源 | Ontology API live + rules.json fallback | 同上 | OK |
| LLM 输出 | compact `{rule_id, status, reason?}` runner 重算 | 同上 | OK |
| Graph context | 6-slot 一次预拉 + tool dispatcher 复用 cache | 同上 | OK |
| 持久化 | Prisma + Neo4j writers | 同上 | OK |
| Resume parse | 走 RAAS `/api/v1/parse-resume` (RAAS 内部再调 RoboHire) | 同上 | **本 spec 切换为 AO 直连 RoboHire** |
| Resume match | 走 RAAS `/api/v1/match-resume` (同上) | 同上 | **本 spec 切换** |

### 1.2 关于"用 LLM 判断通用 rule"的澄清

用户原话:"我们的rule check算法就不用再用LLM去判断通用的rule是不是真正属于客户的通用的rule"。

实际代码层面,客户级过滤**从来不是 LLM 做的** — 见 [lib/rule-check/ontology.ts:125-130](./lib/rule-check/ontology.ts#L125-L130):

```ts
function matches(r: Rule, q: OntologyDims): boolean {
  if (r.executor !== 'Agent') return false;
  if (r.applicableClient !== '通用' && r.applicableClient !== q.client_id) return false;
  if (!matchesDepartment(r.applicableDepartment, q.business_group)) return false;
  return true;
}
```

LLM 真正承担的"模糊判断"是两块:
1. **`inferSeverity()` 关键词推断**(`lib/rule-check/ontology.ts:31-83`) — 用 33 个关键词从 `standardizedLogicRule` 文本推 `terminal / needs_human / flag_only`。这是隐式的"LLM-style"模糊判断,新数据的 `enforcementLevel + failurePolicy` 字段把这个完全取代。
2. **每条 rule 的逐条评估**(prompt 里 LLM 输出 `status`) — 这是 rule-check 的核心 LLM 调用,**不会被本 spec 改动**。

本 spec 删除 1,保留 2。

---

## 2. 总体架构变更

### 2.1 事件流 — Before / After

**Before** (当前):
```
RESUME_DOWNLOADED → resumeParserAgent
                    ├─ RAAS GET /resumes/uploads/:id/raw     [拉 PDF]
                    ├─ RAAS POST /parse-resume               [RAAS 代理 → RoboHire]
                    ├─ RAAS POST /candidates                 [持久化]
                    └─ emit RESUME_PROCESSED
                                ↓
                    matchResumeAgent
                    ├─ RAAS GET /requirements/agent-view OR /requirements/:id
                    ├─ for each JR:
                    │    ├─ [if RULE_CHECK_ENABLED] runRuleCheck() in-process
                    │    │   ├─ if PASS → emit RULE_CHECK_PASSED
                    │    │   └─ if FAIL/REVIEW → emit RULE_CHECK_FAILED, continue
                    │    ├─ RAAS POST /match-resume          [RAAS 代理 → RoboHire]
                    │    ├─ RAAS POST /match-results         [持久化]
                    │    └─ emit MATCH_PASSED_NEED_INTERVIEW
```

**After** (本 spec):
```
RESUME_DOWNLOADED → resumeParserAgent
                    ├─ RAAS GET /resumes/uploads/:id/raw     [拉 PDF — 仍走 RAAS]
                    ├─ ⭐ RoboHire POST /parse-resume         [DIRECT — 不再经 RAAS]
                    ├─ RAAS POST /candidates                 [持久化 — 仍走 RAAS]
                    └─ emit RESUME_PROCESSED
                                ↓
                    matchResumeAgent (减重)
                    ├─ RAAS GET /requirements/... (不变)
                    ├─ for each JR:
                    │    └─ emit RULE_CHECK_REQUESTED { upload_id, candidate_id, jr, parsed, ... }
                                ↓
                    ⭐ ruleCheckAgent (NEW)
                    ├─ runRuleCheck(input)
                    └─ if PASS    → emit RULE_CHECK_PASSED   (carries jr + parsed)
                       else       → emit RULE_CHECK_FAILED
                                ↓
                    ⭐ matchResumeAgent — 第二段订阅 RULE_CHECK_PASSED
                       (or 拆成 matchResumeContinueAgent — 见 §2.3 选项)
                    ├─ ⭐ RoboHire POST /match-resume         [DIRECT]
                    ├─ RAAS POST /match-results              [持久化 — 仍走 RAAS]
                    └─ emit MATCH_PASSED_NEED_INTERVIEW
```

### 2.2 RAAS / RoboHire 边界 — 精确定义

| 操作 | 调用方 | Before | After | 备注 |
|---|---|---|---|---|
| 下载 PDF 原始字节 | resumeParserAgent | `RAAS GET /resumes/uploads/:id/raw` | **不变** | RAAS 内部 MinIO 存储,不是 RoboHire 能力 |
| 解析简历 | resumeParserAgent | `RAAS POST /parse-resume` → RAAS 代理 → RoboHire | **`RoboHire POST /api/v1/parse-resume` 直连** | 见 §3 |
| 持久化 candidate | resumeParserAgent | `RAAS POST /candidates` | **不变** | RAAS 内部 DB(Prisma + Neo4j 锚定),不是 RoboHire 能力 |
| 列在招需求 | matchResumeAgent | `RAAS GET /requirements/agent-view` 或 `/requirements/:id` | **不变** | RAAS 内部 DB |
| 简历匹配 | matchResumeAgent(后段) | `RAAS POST /match-resume` → RAAS 代理 → RoboHire | **`RoboHire POST /api/v1/match-resume` 直连** | 见 §3 |
| 持久化 match result | matchResumeAgent(后段) | `RAAS POST /match-results` | **不变** | RAAS 内部 DB |
| 生成 JD | createJdAgent | `RAAS POST /generate-jd` → RAAS 代理 → RoboHire | **保留 RAAS 现状**(见 §3.4) | RoboHire 端点存在但本 spec 我们提供的文档不覆盖,留 Phase 2 |
| 持久化 JD | createJdAgent | `RAAS POST /jd/sync-generated` | **不变** | RAAS 内部 DB |
| 拉 JR 详情 | createJdAgent | `RAAS GET /requirements/:id` | **不变** | RAAS 内部 DB |

**原则**:RoboHire 是"AI 模型加工能力";RAAS 是"业务状态存储 + 上游需求源"。能力归 RoboHire 的直连;状态归 RAAS 的留 RAAS。

### 2.3 工作流拆法 — 推荐方案

**方案 A (推荐) — matchResumeAgent 双段订阅**

matchResumeAgent **依然只有一个 Inngest function**,但触发器从只订阅 `RESUME_PROCESSED` 改为订阅 `RESUME_PROCESSED` **+** `RULE_CHECK_PASSED`,函数体根据事件名分支:

```ts
inngest.createFunction(
  { id: 'match-resume-agent', triggers: [
      { event: 'RESUME_PROCESSED' },
      { event: 'RULE_CHECK_PASSED' },
    ] },
  async ({ event, step }) => {
    if (event.name === 'RESUME_PROCESSED') {
      // 第一段: 拉 JR 列表,逐 JR emit RULE_CHECK_REQUESTED
    } else if (event.name === 'RULE_CHECK_PASSED') {
      // 第二段: 调 RoboHire match-resume, 落库, emit MATCH_PASSED_NEED_INTERVIEW
    }
  }
);
```

**优点**:符合用户原话"独立 ruleCheckAgent + MatchResumeAgent"(只有 2 个 function,不是 3 个);matchResumeAgent 名字保持,不需要新建 continueAgent。

**缺点**:一个 function 两段逻辑分支 — 但 Inngest 习惯;在 monitor UI 里仍然是两次独立 run,可观测性好。

> **替代 (方案 B)**:拆成 `matchResumeAgent`(只订阅 `RESUME_PROCESSED`)+ `matchResumeContinueAgent`(订阅 `RULE_CHECK_PASSED`)— 函数职责更纯但 function 数量 +1。
>
> **本 spec 采用 A**,因为用户明确说"独立 ruleCheckAgent + MatchResumeAgent"(2 个,不是 3 个)。

---

## 3. RoboHire 直连客户端 — `lib/robohire-client.ts`

新建 `lib/robohire-client.ts`,提供 `parseResume()` 和 `matchResume()` 两个函数,封装直连 RoboHire 的 HTTP 调用。

### 3.1 配置

新增环境变量:
| 变量 | 值 | 用途 |
|---|---|---|
| `ROBOHIRE_API_BASE_URL` | `https://api.robohire.io` | RoboHire base URL |
| `ROBOHIRE_API_KEY` | `rh_ed0264681b5587cfbd0e4ef556a3b1323e43444603828a0b` | API key(用户已提供,`write` scope) |
| `ROBOHIRE_TIMEOUT_MS` | `120000` | per RoboHire 文档建议 120s |

### 3.2 函数签名

```ts
// lib/robohire-client.ts
export type RobohireParseResumeData = {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  experience?: Array<{
    title?: string; company?: string; location?: string;
    startDate?: string; endDate?: string;
    description?: string; highlights?: string[];
  }>;
  education?: Array<{
    degree?: string; field?: string; institution?: string; graduationYear?: string;
  }>;
  skills?: string[];
  certifications?: string[];
  languages?: Array<{ language?: string; proficiency?: string }>;
  [k: string]: unknown;
};

export type RobohireParseResumeResponse = {
  data: RobohireParseResumeData;
  cached: boolean;
  documentId?: string;
  savedAs?: string;
  requestId: string;
};

export async function parseResumeDirect(
  pdf: Buffer,
  filename: string,
  opts?: { traceId?: string; timeoutMs?: number },
): Promise<RobohireParseResumeResponse>;

export type RobohireMatchResumeInput = {
  resume: string;
  jd: string;
  candidatePreferences?: string;
  jobMetadata?: string;
};

export type RobohireMatchResumeData = {
  matchScore: number;
  recommendation: 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH';
  summary: string;
  matchAnalysis?: Record<string, unknown>;
  mustHaveAnalysis?: Record<string, unknown>;
  niceToHaveAnalysis?: Record<string, unknown>;
  [k: string]: unknown;
};

export type RobohireMatchResumeResponse = {
  data: RobohireMatchResumeData;
  requestId: string;
  savedAs?: string;
};

export async function matchResumeDirect(
  input: RobohireMatchResumeInput,
  opts?: { traceId?: string; timeoutMs?: number },
): Promise<RobohireMatchResumeResponse>;
```

### 3.3 错误处理

复用 `RaasApiError` 的设计模式,新增 `RobohireApiError`:

```ts
export class RobohireApiError extends Error {
  constructor(
    public httpStatus: number,
    public code: 'CLIENT' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'SERVER' | 'NETWORK',
    message: string,
    public requestId?: string,
  ) { super(message); }
  get isClientError(): boolean { return this.httpStatus >= 400 && this.httpStatus < 500 && this.httpStatus !== 429; }
}
```

HTTP 状态 → code 映射(per RoboHire 文档 §2/§3 表):
- 400 / 401 / 403 / 413 / 415 → `CLIENT` (NonRetriableError)
- 402 → `QUOTA_EXHAUSTED` (NonRetriableError, 单独告警)
- 429 → `RATE_LIMITED` (可重试)
- 5xx / 网络超时 → `SERVER` / `NETWORK` (可重试)

### 3.4 不在本 spec 范围内的 RoboHire 端点

用户提到"解析JD、创建JD"也要走直连。但用户提供的 RoboHire 文档 `api-external-resume-parsing-and-matching.md` 只覆盖 parse-resume + match-resume。

**处理**:
- `createJdAgent` 当前调 RAAS `/api/v1/generate-jd`,RAAS 内部转发到 RoboHire — **本 spec 不动 createJdAgent**。
- 留 Phase 2 follow-up: 获取 RoboHire `/generate-jd`(以及可能的 `/parse-jd`)的完整 API 文档后再切换。
- 创建跟踪 issue:`docs/followups/2026-05-19-robohire-direct-jd-generation.md`(本 spec 不创建,实现时再起)。

---

## 4. Rule 数据迁移 — rules_v0_1_002.json → Neo4j + JSON

### 4.1 现状盘点

| 项 | 位置 | 现状 | 目标 |
|---|---|---|---|
| 本地 fallback JSON | `lib/rule-check/rules.json` | v0.1(248 rules)·缺 `enforcementLevel + failurePolicy` | 替换为 v0.1.002 内容(原文件备份到 `lib/rule-check/rules.json.bak`) |
| Neo4j `:Rule` 节点 | local container(bolt://localhost:7688) | **已有 248 节点**(经查),缺 2 个新字段 | 删除全部旧 :Rule 节点,从新 JSON 全量重导 |
| Neo4j 相关关系 | `(:Rule)-[:GOVERNS]->(:ActionStep)` | 由 `scripts/export-action-ontology.ts` 写入,Rule 是 stub(只 id) | 重导后会**断开 GOVERNS 关系** — 见 §4.3 安全策略 |

### 4.2 迁移脚本 — `scripts/migrate-rules-v0-1-002.ts`

**步骤**:
1. Pre-flight 检查
   - 读 `neo4j_data/rules_v0_1_002.json`,断言 `metadata.version === "0.2"`、`rules.length === 248`、每条 rule 含 `id / executor / enforcementLevel / failurePolicy / applicableClient`。
   - 备份现有 `lib/rule-check/rules.json` 到 `lib/rule-check/rules.json.bak.<ISO-timestamp>`。
2. Neo4j 操作(单 transaction)
   ```cypher
   // a) 先记录现存关系数(用于 post-check)
   MATCH (r:Rule)-[g:GOVERNS]->(s:ActionStep)
   RETURN count(g) AS pre_governs_count;

   // b) 全量删除 :Rule 节点(连同关系)
   MATCH (r:Rule) DETACH DELETE r;

   // c) UNWIND 写入新 rules
   UNWIND $rules AS row
   CREATE (r:Rule)
   SET r = row,
       r.imported_at = datetime();

   // d) 重建 GOVERNS 关系(如果 ActionStep 节点知道每条 step 包含哪些 rule_id):
   //    本步骤依赖 ActionStep 节点上是否存了 rule_ids[] 属性 — 见 §4.3
   ```
3. Post-flight 校验
   - `MATCH (n:Rule) RETURN count(n)` 必须 = 248
   - 必须 100% 的节点都有 `enforcementLevel` 和 `failurePolicy` 字段
   - 抽查 3 条已知 rule(`10-25`, `2-4`, `1-1-1`)字段完整
4. 覆盖本地 JSON
   - `cp neo4j_data/rules_v0_1_002.json lib/rule-check/rules.json`
5. Print summary
   - `total: 248 / before-delete: 248 / after-insert: 248 / governs-rebuilt: N`

### 4.3 GOVERNS 关系处理

`(:Rule)-[:GOVERNS]->(:ActionStep)` 关系在当前架构里由 ontology export 产出,**不是 rule-check 运行时所必需**(rule-check 的 step 分组通过 Ontology API live 拿,不读 GOVERNS)。

**策略**:
- DETACH DELETE 后,GOVERNS 关系会一并丢失 — **这是可接受的**。
- 提供 `scripts/restore-governs-relationships.ts` 作为可选恢复:从 Ontology API 拉 ActionStep,按 step 内 rule_ids 重建 GOVERNS。
- 在迁移脚本 print summary 提示用户:"GOVERNS relationships were dropped. Run `npm run rules:restore-governs` if downstream consumers (e.g., monitor UI) depend on them."

### 4.4 代码层适配

| 文件 | 改动 |
|---|---|
| `lib/rule-check/types.ts` | Rule type 加 `enforcementLevel: 'mandatory' \| 'optional'` + `failurePolicy: 'block' \| 'warn'` 字段;**保留旧 `severity` 字段一个 release** 防 UI 编译失败,标记 `@deprecated` |
| `lib/rule-check/ontology.ts` | 删除 `inferSeverity()` 及其 33 关键词常量;`normalizeRaw()` 读新字段,`severity` 改用 `enforcementLevel + failurePolicy` 派生(临时 derive 函数,见下方),`classifyRules()` 内的 `by_severity` 也用 derive |
| `lib/rule-check/prompt.ts` | `renderRuleBlock()` 把 `severity=${r.severity}` 换成 `enforcement=${r.enforcementLevel}, onFail=${r.failurePolicy}` |
| `lib/rule-check/runner.ts` | 不变 — runner 不读 severity |
| `components/rule-check/*` (UI) | 若 UI 渲染 severity badge,改成读新字段 |

**Severity 派生(临时,直到 UI 改完)**:
```ts
function deriveLegacySeverity(r: { enforcementLevel: string; failurePolicy: string }): Severity {
  if (r.enforcementLevel === 'mandatory' && r.failurePolicy === 'block') return 'terminal';
  if (r.failurePolicy === 'warn' && r.enforcementLevel === 'optional') return 'flag_only';
  return 'needs_human'; // 兜底
}
```

---

## 5. rule-check 抽出独立 Inngest function

### 5.1 新增 / 修改文件清单

| 文件 | 状态 | 职责 |
|---|---|---|
| `server/inngest/agents/rule-check-agent.ts` | **NEW** | 订阅 `RULE_CHECK_REQUESTED`,调 `runRuleCheck`,emit `RULE_CHECK_PASSED` / `RULE_CHECK_FAILED` |
| `server/inngest/agents/match-resume-agent.ts` | **MOD** | (a) 删除 step 4.0 rule-check 段 + `RULE_CHECK_ENABLED` 分支 (b) 第一段(`RESUME_PROCESSED` 触发)只 emit `RULE_CHECK_REQUESTED` (c) 第二段(`RULE_CHECK_PASSED` 触发)做 RoboHire match + persist + emit `MATCH_PASSED_NEED_INTERVIEW` |
| `server/inngest/agents/resume-parser-agent.ts` | **MOD** | step `download-and-parse-*` 内 `parseResume(...)` 调用替换为 `parseResumeDirect(...)`(RoboHire 直连) |
| `server/inngest/client.ts` | **MOD** | 新增 `RULE_CHECK_REQUESTED` event + 类型;扩展 `RULE_CHECK_PASSED` payload 加 `job_requisition: Record<string, unknown>` + `parsed_resume: Record<string, unknown>`(供第二段使用,避免回拉) |
| `server/inngest/functions.ts`(或 register 入口) | **MOD** | 注册新增的 `ruleCheckAgent` |
| `lib/robohire-client.ts` | **NEW** | 见 §3 |
| `.env.local` / `.env.example` | **MOD** | 新增 ROBOHIRE_API_BASE_URL / ROBOHIRE_API_KEY / ROBOHIRE_TIMEOUT_MS |

### 5.2 ruleCheckAgent 完整签名(草案)

```ts
// server/inngest/agents/rule-check-agent.ts
import { buildRuleCheckInput, runRuleCheck } from '@/lib/rule-check';
import { extractDims } from '@/lib/rule-check/ontology';
import { inngest, type RuleCheckRequestedData, type RuleCheckPassedData, type RuleCheckFailedData, type RuleCheckAuditMeta } from '@/server/inngest/client';

export const ruleCheckAgent = inngest.createFunction(
  {
    id: 'rule-check-agent',
    name: 'Rule Check Agent (workflow node 10.5)',
    retries: 1,
    triggers: [{ event: 'RULE_CHECK_REQUESTED' }],
  },
  async ({ event, step, logger }) => {
    const data = event.data as RuleCheckRequestedData;
    const stepKey = sanitize(data.job_requisition_id);

    const result = await step.run(`rule-check-${stepKey}`, async () => {
      const input = buildRuleCheckInput({
        runtime_context: data.runtime_context,
        parsed_resume: data.parsed_resume,
        job_requisition: data.job_requisition,
      });
      return await runRuleCheck(input);
    });

    const dims = extractDims(data.job_requisition);
    const audit: RuleCheckAuditMeta = { /* same as before */ };

    if (result.decision === 'PASS') {
      const payload: RuleCheckPassedData = {
        ...data,                              // 透传 jr + parsed_resume + ids
        decision: 'PASS',
        audit,
      };
      await step.sendEvent(`emit-passed-${stepKey}`, { name: 'RULE_CHECK_PASSED', data: payload });
      return { ok: true, decision: 'PASS' };
    } else {
      const payload: RuleCheckFailedData = {
        upload_id: data.upload_id,
        candidate_id: data.candidate_id,
        resume_id: data.resume_id,
        job_requisition_id: data.job_requisition_id,
        client_id: data.client_id ?? '',
        decision: result.decision,
        failed_rules: result.explanations.map((e) => ({ rule_id: e.rule_id, rule_name: e.rule_name, step_id: e.step_id, status: e.status, reason: e.reason })),
        audit,
      };
      await step.sendEvent(`emit-failed-${stepKey}`, { name: 'RULE_CHECK_FAILED', data: payload });
      return { ok: true, decision: result.decision };
    }
  }
);
```

### 5.3 事件 schema 变化

**新增** `RULE_CHECK_REQUESTED`:
```ts
type RuleCheckRequestedData = {
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  employee_id: string;
  job_requisition_id: string;
  client_id?: string;
  // 完整 JR 对象 + parsed resume — 给 ruleCheckAgent 用,避免再去拉 RAAS
  job_requisition: Record<string, unknown>;
  parsed_resume: Record<string, unknown> | null;
  runtime_context: {
    upload_id: string;
    candidate_id: string;
    resume_id: string;
    employee_id: string;
    filename?: string;
    received_at?: string;
    trace_id?: string | null;
  };
  trace_id?: string | null;
};
```

**扩展** `RULE_CHECK_PASSED` payload(原有字段保持,新增 jr + parsed):
```ts
type RuleCheckPassedData = {
  upload_id: string;
  candidate_id?: string;
  resume_id?: string;
  job_requisition_id: string;
  client_id: string;
  audit: RuleCheckAuditMeta;
  // ── NEW: 透传给 matchResumeAgent 第二段 ──
  job_requisition: Record<string, unknown>;
  parsed_resume: Record<string, unknown> | null;
  runtime_context: RuntimeContextShape;
  employee_id: string;
  decision: 'PASS';
};
```

`RULE_CHECK_FAILED` 不变。

### 5.4 matchResumeAgent 改造细节

**第一段**(订阅 `RESUME_PROCESSED`,基本保持原 §1-3 拉 JR 列表的逻辑):
- 删除 step 4.0 整段(行 224-332 in 当前 `match-resume-agent.ts`)
- 把原来的 `for (const req of requirements)` 循环简化为:**对每条 JR emit `RULE_CHECK_REQUESTED`**
- 不再有 `RULE_CHECK_ENABLED` env gate(rule-check 永远跑;真要 bypass 见 §5.6)
- 返回 `{ ok, matched_count, requested_count }`

**第二段**(订阅 `RULE_CHECK_PASSED`,处理单条 JR):
- 不需要再拉 JR(payload 里有)
- step `match-${jrid}`:调 **`matchResumeDirect`**(直连 RoboHire)替代 `matchResume`(RAAS)
- step `save-match-${jrid}`:仍调 `saveMatchResults` (RAAS) 持久化
- 最后 emit `MATCH_PASSED_NEED_INTERVIEW`(payload 不变)

### 5.5 retry / fail policy

- `ruleCheckAgent`:`retries: 1`(runRuleCheck 内部已经 fail-safe in-band 不抛异常,所以 retry 主要为 Inngest 自己的 step.run 异常)
- `matchResumeAgent` 第二段:`retries: 2`(与原 matchResumeAgent 一致 — RoboHire 5xx/429 会重试)
- 全链路 traceId 透传:`event.data.trace_id` → step `traceId` → RoboHire `X-Trace-Id` header(本 spec 跟随用户已有 RAAS 模式)

### 5.6 bypass 机制(可选,默认关)

当前 `RULE_CHECK_ENABLED=false` 等于"绕过 rule-check 直接 match"。本 spec 把它替换成更明确的环境变量 `RULE_CHECK_BYPASS=true`(默认空 / false):

- bypass 时:matchResumeAgent 第一段对每条 JR **直接 emit `RULE_CHECK_PASSED`**(空 audit + `bypass: true`),跳过 ruleCheckAgent。
- 默认(`RULE_CHECK_BYPASS` 不设):走完整 rule-check。

这样:
- 链路保持单一(只有 `RULE_CHECK_PASSED` 一个分发点),matchResumeAgent 第二段不需要知道有没有跑过 rule check。
- bypass 是显式开关,不再依赖一个嵌进 if 分支里的 env gate。

---

## 6. UI 适配 — `/rule-check` 评估页

### 6.1 受影响组件

| 组件 | 改动 |
|---|---|
| [components/rule-check/ScenarioMatrix.tsx](./components/rule-check/ScenarioMatrix.tsx) | 把 severity badge 改用 enforcementLevel + failurePolicy 显示 |
| [components/rule-check/RuleConfusionStrip.tsx](./components/rule-check/RuleConfusionStrip.tsx) | 同上(如有 severity 列) |
| [components/rule-check/CaseDrawer.tsx](./components/rule-check/CaseDrawer.tsx) | rule detail 视图展示新字段 |
| `lib/i18n.tsx` | 新增 i18n key:`rc_enforcement_mandatory` / `rc_enforcement_optional` / `rc_on_fail_block` / `rc_on_fail_warn`(中英) |

### 6.2 显示约定(草案)

每条 rule 在 UI 上的 metadata badge 改为两段:

```
[mandatory · block]   ← 旧 terminal
[optional  · warn]    ← 旧 flag_only
[optional  · block]   ← 中间态(少数 rule)
```

颜色映射:
- `block` → 红色边框
- `warn` → 黄色边框
- `mandatory` → 实心
- `optional` → 描边

### 6.3 API / 数据契约

`/api/rule-check/scenarios` 和 `/api/rule-check/runs/[id]` 返回的 `rule_results[]` shape **不变**。新增字段 `rule_enforcement_level` / `rule_failure_policy` 由 UI 端查 `rules.json` 派生(或在 API 端 join 一下;选 join 更简单,本 spec 推荐 join)。

### 6.4 评估页跟生产 rule-check 的耦合

`/rule-check` 评估页用的是 `lib/rule-check/runner.ts` 同一份 lib — 本 spec 拆 workflow agent 不影响它。评估页的 fixture / `RuleCheckScenarioResult` 表也不受影响。

---

## 7. 持久化变更

无新增 / 修改的 Prisma model。`RuleCheckRun / RuleCheckScenarioResult` 保持原状(评估页用)。

ruleCheckAgent 跑生产时是否要落 Prisma?**本 spec 决定不落** — 原因:
1. RuleCheckScenarioResult 的设计目标是评估页 scenario-level upsert(`@@unique([runId, scenarioId])`)。
2. 生产链路的每次调用没有 scenario_id,不适合复用同表。
3. 生产链路本身的可观测性已经在 `lib/rule-check/logs/YYYY-MM-DD.log` JSON-lines + Inngest UI run history 里。
4. 如果将来要把生产 run 也呈现到评估页,做一个 `RuleCheckProductionRun` 表 + 单独 view — 留 Phase 2。

---

## 8. 测试策略

| 层 | 测试 | 改动 |
|---|---|---|
| `lib/robohire-client.ts` | NEW unit tests:成功响应解析、各 HTTP 错误码 → 正确 RobohireApiError、超时、`X-Trace-Id` 透传 | NEW |
| `lib/rule-check/ontology.test.ts` | 不存在,要补 — 验证 `enforcementLevel + failurePolicy` 读取正确,severity derive 兜底 | NEW |
| `lib/rule-check/runner.test.ts` | 调整 mock fixture 加 `enforcementLevel + failurePolicy` 字段 | MOD |
| `server/inngest/agents/rule-check-agent.test.ts` | NEW unit test:mock runRuleCheck → 验证 emit 的 event payload 字段 | NEW |
| `server/inngest/agents/match-resume-agent.test.ts` | 拆成两个独立测试:(a) 第一段 `RESUME_PROCESSED` 触发 → emit N 个 `RULE_CHECK_REQUESTED` (b) 第二段 `RULE_CHECK_PASSED` 触发 → 调 robohireClient.matchResumeDirect → emit `MATCH_PASSED_NEED_INTERVIEW` | MOD |
| `__tests__/prisma/rule-check.test.ts` | 不变 | — |
| `components/rule-check/*.test.ts` | 适配 severity → enforcement+failurePolicy 显示 | MOD |
| E2E smoke | `scripts/seed-rule-check-fixtures.ts` + `scripts/run-rule-check-test-suite.ts` 仍工作(rules.json schema 加字段,旧测试不读这俩字段所以不破) | 不破即可 |

### 8.1 RoboHire 集成测试约束

RoboHire 是付费 API(消耗 match quota),CI 不能跑真实调用。
- 默认 unit test mock fetch
- 提供 `npm run test:robohire-live` 跑一次真实端到端(用户手动触发,验证 key + 网络通)
- 真实测试用一份固定 `tests/fixtures/sample-resume.pdf` 跑 parse-resume,assert `cached: true`(idempotent — 第二次跑不重复扣费)

---

## 9. 迁移顺序 — 推荐的实施 PR 拆分

| PR | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **PR-1** | rule data 迁移 + types 加新字段 + 删除 inferSeverity + UI severity badge 改造 | 无 | 低 — 数据层独立,可单独跑 |
| **PR-2** | `lib/robohire-client.ts` + unit tests + env vars 文档 | 无 | 低 — 纯加法 |
| **PR-3** | resumeParserAgent 切换 `parseResume → parseResumeDirect` + 实测一份 PDF 走通 | PR-2 | 中 — 上线后才能验证真实调用 |
| **PR-4** | ruleCheckAgent NEW + matchResumeAgent 双段重构 + event schema 加 `RULE_CHECK_REQUESTED` + matchResume 调用切换 `matchResumeDirect` | PR-1, PR-2 | 高 — 链路改造,需要在 Inngest dev 跑 fixture 完整链路 |
| **PR-5** | (可选) `RULE_CHECK_BYPASS` 替换 `RULE_CHECK_ENABLED` 的 env 改名 + 文档 | PR-4 | 低 |

**最小可上线集**:PR-1 + PR-2 + PR-3(不动 rule-check 架构) — 用户可以先验证 RoboHire 直连工作正常,再上 PR-4(架构改造)。

---

## 10. 已知风险 + 兜底

| 风险 | 严重度 | 兜底 |
|---|---|---|
| RoboHire 直连后,RAAS 那边失去 audit trace(它本来代理调用时会落自己的 log) | 中 | AO 这边把 RoboHire `requestId` 完整透传到 `saveMatchResults` 的 `robohire_request_id`,RAAS 仍能反向 join。Inngest UI + `lib/rule-check/logs/` 也都记录 |
| RoboHire quota 耗尽(402) | 中 | NonRetriableError;ruleCheckAgent 仍会跑完 rule-check(因为它只跑 LLM gateway,跟 RoboHire 解耦),只有 matchResumeAgent 第二段会 fail。emit 一条 `MATCH_QUOTA_EXHAUSTED` 事件给监控 alert |
| Neo4j DETACH DELETE 后 GOVERNS 关系全丢 | 中 | 见 §4.3 — 提供恢复脚本;在迁移脚本里 print 警告 |
| 现有 `RULE_CHECK_ENABLED=false` 部署 → 切到新架构后行为变化 | 中 | 部署 README 加一行:"如果之前用 `RULE_CHECK_ENABLED=false`,现在改成 `RULE_CHECK_BYPASS=true`" |
| matchResumeAgent 双段订阅在 Inngest UI 上看起来像两个 run(原是一个) | 低 | UI 上确实是两个 run id;在 audit/log 里把 `upload_id + job_requisition_id` 当成关联 key — 现状已经有这个习惯 |
| 旧 rules.json schema 编译失败(types 加了必填字段) | 低 | 实施时把 `enforcementLevel + failurePolicy` 标 optional 在 TypeScript 层,runtime 在 normalizeRaw 里读不到时报错或填默认值(`optional + warn`) |
| 已经在跑的 Inngest run 里有 `RESUME_PROCESSED` 但 matchResumeAgent 旧版还在内嵌 rule-check — 部署期间双版本会冲突 | 低 | 部署窗口设短;用 Inngest 的 deploy strategy 把旧 function 优雅关掉 |

---

## 11. 实施清单(给执行者)

```
[ ] PR-1: rule data + types
    [ ] Pre-flight: 备份 lib/rule-check/rules.json → .bak.<ts>
    [ ] 写 scripts/migrate-rules-v0-1-002.ts
    [ ] 跑迁移 → Neo4j count=248, 所有节点有 enforcementLevel + failurePolicy
    [ ] cp neo4j_data/rules_v0_1_002.json lib/rule-check/rules.json
    [ ] lib/rule-check/types.ts: Rule 加 2 字段 (optional)
    [ ] lib/rule-check/ontology.ts: 删 inferSeverity, normalizeRaw 读新字段, severity 改 derive
    [ ] lib/rule-check/prompt.ts: renderRuleBlock 改字段
    [ ] components/rule-check/*.tsx: severity badge 改用新字段
    [ ] lib/i18n.tsx: 加 4 个 i18n key
    [ ] 跑测试套件,确保 evaluation page 还工作

[ ] PR-2: RoboHire client
    [ ] 写 lib/robohire-client.ts (parseResumeDirect + matchResumeDirect + RobohireApiError)
    [ ] 写 unit tests (mock fetch)
    [ ] 加 .env.local / .env.example: ROBOHIRE_API_BASE_URL / ROBOHIRE_API_KEY / ROBOHIRE_TIMEOUT_MS
    [ ] 写 npm run test:robohire-live smoke 脚本 (用户验证)

[ ] PR-3: resumeParserAgent 切换 parse-resume
    [ ] server/inngest/agents/resume-parser-agent.ts: 把 parseResume(pdfBuffer, …) 换成 parseResumeDirect(…)
    [ ] 测试:Inngest dev 触发一条 RESUME_DOWNLOADED → 验证 saveCandidate 拿到的 parsed.data 跟 RAAS 路径一致

[ ] PR-4: ruleCheckAgent + matchResumeAgent 重构 + matchResume 直连
    [ ] server/inngest/client.ts: 新增 RULE_CHECK_REQUESTED event + types, 扩展 RULE_CHECK_PASSED
    [ ] server/inngest/agents/rule-check-agent.ts: NEW
    [ ] server/inngest/agents/match-resume-agent.ts: 拆双段 + 删 RULE_CHECK_ENABLED + 改调 matchResumeDirect
    [ ] server/inngest/functions.ts: 注册 ruleCheckAgent
    [ ] 测试:Inngest dev 跑 14 个 fixture scenario → 验证 PASS/FAIL/REVIEW 各 emit 正确事件 → 验证 MATCH_PASSED_NEED_INTERVIEW 仍能发出
    [ ] 更新 docs/rule-check-end-to-end-workflow.md

[ ] PR-5 (可选): bypass env 改名
    [ ] RULE_CHECK_ENABLED → RULE_CHECK_BYPASS (逻辑反转)
    [ ] README 更新
```

---

## 12. 一句话总结

把 rule-check 从 matchResumeAgent 内嵌段抽出独立 Inngest function;新 rule 数据用 `enforcementLevel + failurePolicy` 显式表达严重态,删掉关键词启发式;parse-resume + match-resume 从 RAAS 代理切到 AO → RoboHire 直连。链路从 `RESUME_PROCESSED → matchResumeAgent(干所有事)` 变成 `RESUME_PROCESSED → matchResumeAgent(第一段) → RULE_CHECK_REQUESTED → ruleCheckAgent → RULE_CHECK_PASSED → matchResumeAgent(第二段) → MATCH_PASSED_NEED_INTERVIEW`。
