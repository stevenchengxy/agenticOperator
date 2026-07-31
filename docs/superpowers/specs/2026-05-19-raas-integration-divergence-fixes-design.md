# RAAS 集成对齐 — 设计文档(F1-F4 + 方案 B)

> 作者: Claude(代 Steven)
> 日期: 2026-05-19
> 范围: 按 partner `raas-integration-divergence(1).md` 的 4 项 divergence(F1-F4),修正 AO 4 agents 让其符合 RAAS 平台工作流;同时把 JD 创建切到 RoboHire 直连,并废弃 `RULE_CHECK_FAILED` 改用 `MATCH_FAILED` 三事件家族(方案 B)。
> 状态: 待 user review(写完直接走 user gate,不派 reviewer per user preference)
>
> **前置 spec**: [2026-05-19-rule-check-independent-agent-design.md](./2026-05-19-rule-check-independent-agent-design.md)(4-agent 架构 + RoboHire 直连 parse/match-resume 已完成)

---

## 0. 一句话目标

让 AO 4 agents 100% 符合 partner 在 `raas-integration-divergence(1).md` 列的接口契约(F1-F4),同时把 createJdAgent 切到 RoboHire `/api/v1/jobs/generate-jd` 直连,事件家族收敛成 `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED` 三个。

---

## 1. 改动范围 — 4 项 partner divergence + 1 项 AO 重构

| ID | 描述 | 严重度 | 改动文件 |
|---|---|---|---|
| **F1** | thin 事件回拉 parsed 正文 | 🔴 致命 | RAAS client + matchResume 1st seg |
| **F2** | agent-view 加 `resume_filename` + 清 deprecated query | 🟡 | RAAS client + matchResume 1st seg |
| **F3** | MATCH_* 三事件 payload 顶层平铺 + score 阈值分发 | 🟠 | event types + matchResume 2nd seg + ruleCheckAgent |
| **F4** | createJdAgent prompt 重写 + RoboHire `/jobs/generate-jd` 直连 | 🟡 | robohire-client + create-jd-agent |
| **B** | 废弃 `RULE_CHECK_FAILED`,ruleCheckAgent 直接 emit `MATCH_FAILED` | — | event types + ruleCheckAgent + UI |

---

## 2. F1 — thin 事件回拉

### 2.1 现状

`RESUME_PROCESSED` 事件已经被 partner 改成 thin shape(不含 `parsed.data`)。AO `matchResumeAgent` 第一段读 `data.parsed?.data` 直接拿到 `undefined`,导致 `RULE_CHECK_REQUESTED.parsed_resume = null`,第二段 `handleRuleCheckPassed` 早退 "missing-parsed-resume",**整个 match 链路死掉**。

### 2.2 设计

新增 `lib/raas-api-client.ts:getParsedResume(candidateId, resumeId)`:

```ts
GET /api/v1/candidates/:candidateId/resumes/:resumeId/parsed
Authorization: Bearer ${AGENT_API_KEY}
X-Trace-Id: <optional>

200 (顶层直出):
{
  "candidate_id": "string",
  "resume_id":    "string",
  "data": { /* RoboHire-shape: name, email, experience, education, skills, ... */ },
  "candidate_snapshot?": { ... },
  "resume_meta?": { ... }
}
```

错误处理(per partner §0.4):
- 4xx → `NonRetriableError`(参数非法 / 不存在)
- 5xx / 网络 → step.run 重试

### 2.3 matchResumeAgent 1st seg 改造

```
handleResumeProcessed:
  ① 读 data.parsed?.data:
      - 存在 → 直接用(向后兼容厚事件)
      - 缺失 → step.run("fetch-parsed-resume"):
                if (!candidate_id || !resume_id) throw NonRetriable
                parsedData = await getParsedResume(candidate_id, resume_id).data
  ② 把 parsedData 注回 data.parsed.data(后续逻辑无感知)
  ③ 后续:拉 JR 列表 + emit RULE_CHECK_REQUESTED(parsedData)
```

### 2.4 验收

- thin 事件(无 `parsed.data`)→ 触发回拉 → ruleCheckAgent 收到非空 parsed_resume
- 厚事件(有 `parsed.data`)→ 不触发回拉(走兼容路径)
- 回拉返回空 data → 视为有效空简历,继续后续逻辑
- 5xx 重试耗尽 → 整条按可重试失败上报

---

## 3. F2 — agent-view 文件名收敛 + deprecated cleanup

### 3.1 现状

- 现在调 `getRequirementsAgentView({ claimer_employee_id })` 不传 filename → 走全量
- `GetRequirementsQuery` type 里有 5 个 `@deprecated` 字段(`scope` / `status` / `client_id` / `page` / `page_size`),partner 说"不再接受"

### 3.2 设计

**`lib/raas-api-client.ts:GetRequirementsQuery` 重写**:

```ts
// Before
export type GetRequirementsQuery = {
  claimer_employee_id?: string;
  /** @deprecated */ scope?: 'claimed' | 'watched' | 'mine';
  /** @deprecated */ status?: string;
  /** @deprecated */ client_id?: string;
  /** @deprecated */ page?: number;
  /** @deprecated */ page_size?: number;
};

// After
export type GetRequirementsQuery = {
  /** ★ 必传 — 招聘人员 employee_id */
  claimer_employee_id: string;
  /** 原始简历文件名(可选)— RAAS 端用文件名内 `【岗位】` 模糊收敛岗位列表。
   *  不传或解析失败 → RAAS 退回返回该 claimer 的全量在招岗位(零回归)。 */
  resume_filename?: string;
};
```

### 3.3 matchResumeAgent 1st seg 改造

路径 B 拼 query 时,从 `event.data.filename`(或 `event.data.payload.filename`)取文件名透传:

```ts
const r = await getRequirementsAgentView(
  { claimer_employee_id: employeeId, resume_filename: filenameRaw },
  { traceId },
);
```

AO 端**不解析文件名**,原样透传。RAAS 解析失败/0 命中由 RAAS 退回全量。

### 3.4 验收

- 文件名含 `【某岗位】` 且 claimer 有该岗位 → items 只含该岗位
- 文件名乱码 / 不含 `【】` → items 为该 claimer 全部在招岗位(零回归)
- 路径 A 简历(已带 `job_requisition_id`)→ 不调本接口

---

## 4. F3 — MATCH_* 三事件平铺 + score 阈值分发(含方案 B)

### 4.1 现状

- `MatchPassedNeedInterviewData` type 只有 `upload_id` / `job_requisition_id` / `success` / `data` / `requestId` / `savedAs` / `error` 7 个字段
- 缺 `candidate_id` / `matching_score` / `job_posting_id` 顶层字段
- `upload_id` 缺失时落空串 `''` 不是 `null`
- 只 emit `MATCH_PASSED_NEED_INTERVIEW` 一个事件,从不发 `MATCH_PASSED_NO_INTERVIEW` / `MATCH_FAILED`
- `ruleCheckAgent` FAIL/REVIEW 时 emit `RULE_CHECK_FAILED`,但 partner 没订阅这个事件,失败信号没传出去

### 4.2 设计 — Type 改造

**`server/inngest/client.ts` 统一 MatchEventData**:

```ts
/** 三个 MATCH_* 事件 payload 统一契约(per partner F3)。
 *  关键字段都在顶层,缺失统一用 null(禁止空串)。 */
export type MatchEventData = {
  /** ★ 路径 A/B 收敛后的具体岗位 ID(必填) */
  job_requisition_id: string;
  /** ★ 候选人 ID;无显式 null */
  candidate_id: string | null;
  /** ★ 匹配分;取不到显式 null,不要省略字段 */
  matching_score: number | null;
  /** ★ upload_id;缺失统一 null,禁止空串 */
  upload_id: string | null;
  /** 关联 posting,有则带 */
  job_posting_id?: string | null;

  // ── envelope 保留字段(RoboHire 风格,供 consumer cherry-pick)──
  success?: boolean;
  /** 原始 RoboHire match 分析数据;FAIL 时塞 { failed_rules: [...] } 等结构化错误 */
  data?: Record<string, unknown>;
  requestId?: string;
  savedAs?: string;
  error?: string;
};

export type MatchPassedNeedInterviewData = MatchEventData;
export type MatchPassedNoInterviewData = MatchEventData;
export type MatchFailedData = MatchEventData;
```

**删除** `RuleCheckFailedData` type(方案 B)。

### 4.3 score 阈值分发函数

`server/inngest/agents/match-resume-agent.ts` 新 helper:

```ts
function extractMatchingScore(robohireData: unknown): number | null {
  // RoboHire response shape: data.matchScore (0-100 number)
  if (!robohireData || typeof robohireData !== 'object') return null;
  const d = robohireData as Record<string, unknown>;
  // 优先 matchScore;兜底位置 overallMatchScore;都不在 → null
  if (typeof d.matchScore === 'number') return d.matchScore;
  if (typeof d.overallMatchScore === 'number') return d.overallMatchScore;
  return null;
}

function decideMatchEvent(score: number | null): 'MATCH_PASSED_NO_INTERVIEW' | 'MATCH_PASSED_NEED_INTERVIEW' | 'MATCH_FAILED' {
  if (score === null) return 'MATCH_PASSED_NEED_INTERVIEW';   // 取不到分 → 保守路径
  if (score > 90)     return 'MATCH_PASSED_NO_INTERVIEW';     // 自信直送
  if (score >= 50)    return 'MATCH_PASSED_NEED_INTERVIEW';   // 标准面试路径
  return 'MATCH_FAILED';                                       // <50 业务 fail
}
```

阈值边界:
- `> 90`(严格大于)→ NO_INTERVIEW
- `[50, 90]`(两端闭)→ NEED_INTERVIEW
- `< 50`(严格小于)→ FAILED

### 4.4 matchResumeAgent 2nd seg emit 改造

```ts
// handleRuleCheckPassed 末尾,从原来固定 emit NEED_INTERVIEW 改成:
const matching_score = extractMatchingScore(matchResult.data);
const eventName = decideMatchEvent(matching_score);

const payload: MatchEventData = {
  job_requisition_id: data.job_requisition_id,
  candidate_id: candidateId || null,                       // 空串 → null
  matching_score,
  upload_id: uploadId || null,                              // 空串 → null
  job_posting_id: (req as any).job_posting_id ?? null,
  success: true,
  data: matchResult.data,
  requestId: matchResult.requestId,
  savedAs: matchResult.savedAs,
};
await step.sendEvent(`emit-match-${stepKey}`, { name: eventName, data: payload });
```

如果 RoboHire 调用失败(`matchResult.ok === false`)→ emit `MATCH_FAILED`(`matching_score: null`,`data: { error_kind: 'robohire-call-failed' }`)。

### 4.5 ruleCheckAgent 改 emit MATCH_FAILED(方案 B)

```ts
// 之前:result.decision !== 'PASS' → emit RULE_CHECK_FAILED
// 现在:result.decision !== 'PASS' → emit MATCH_FAILED(平铺契约)

const failedPayload: MatchEventData = {
  job_requisition_id: data.job_requisition_id,
  candidate_id: data.candidate_id ?? null,
  matching_score: null,                                     // rule check 阶段无 score
  upload_id: data.upload_id ?? null,
  success: false,
  data: {
    rule_check_decision: result.decision,                   // FAIL / REVIEW
    failed_rules: result.explanations.map(...),             // 详细原因
    audit: ruleCheckAudit,
  },
  error: `rule-check-${result.decision.toLowerCase()}`,
};
await step.sendEvent(`emit-match-failed-${stepKey}`, {
  name: 'MATCH_FAILED',
  data: failedPayload,
});
```

**`RULE_CHECK_PASSED` 内部事件保留**(matchResumeAgent 第二段订阅它继续 match 流程)— 这是 AO 内部分段事件,不出 AO 边界,不需要 platform 知道。

### 4.6 验收

- 触发匹配 score=95 → emit `MATCH_PASSED_NO_INTERVIEW`,顶层有 candidate_id / matching_score=95
- 触发匹配 score=70 → emit `MATCH_PASSED_NEED_INTERVIEW`,顶层有完整字段
- 触发匹配 score=30 → emit `MATCH_FAILED`,顶层有完整字段
- rule-check FAIL → emit `MATCH_FAILED`,`data.failed_rules` 含违规规则列表
- 任何分支 `upload_id` 缺失 → 值为 `null` 不是 `""`

---

## 5. F4 — createJdAgent prompt 重写 + RoboHire 直连

### 5.1 现状

- `createJdAgent` 调 RAAS `POST /api/v1/generate-jd`(RAAS 透传 RoboHire `/api/v1/jobs/generate-jd`)
- `buildPromptFromRequirement` 字段缺一半(缺 service_bg / demand_type / work_address / 性别 / 年龄 / 外籍 / 排班 / 紧急度 / 填充难度 / 招聘策略 / 初复试详情 / 面试流程 等 ~15 个)
- **两处日期标错**:
  - `s.deadline` 标 "截止日期" → 应该是 "期望到岗日期"(主取 `r.required_arrival_date`)的 fallback
  - `s.start_date` 标 "期望到岗" → 应该是 "服务开始日期"(HRO 合同字段)
- 缺 "发布日期"(`pick(client_published_at, open_date)`)
- 所属部门只用 `sd_org_name`,应该 `pick(first_level_department, oa_department, sd_org_name)`

### 5.2 设计 — RoboHire 直连

**`lib/robohire-client.ts` 加 `generateJdDirect`**:

```ts
POST https://api.robohire.io/api/v1/jobs/generate-jd
Authorization: Bearer rh_*
Content-Type: application/json

{
  "prompt": "string",            // 4-4000 字符,F4 拼出的 free-text
  "language?": "zh" | "en" | ...,
  "companyName?": "string",
  "department?": "string"
}

200 (envelope):
{
  "success": true,
  "data": {
    "title": "...",
    "companyName": "",
    "department": "",
    "location": "",
    "experienceLevel": "senior",
    "headcount": 1,
    "qualifications": "...",
    "hardRequirements": "...",
    "niceToHave": "...",
    "description": "...",
    "benefits": "...",
    "interviewRequirements": "...",
    "evaluationRules": "...",
    "salaryMin": "...",
    "salaryMax": "...",
    "salaryCurrency": "...",
    "salaryPeriod": "...",
    "salaryText": "..."
    // ... 20+ camelCase 字段
  },
  "meta": { "stages": { "parse": "success", "generate": "success" } },
  "requestId": "req_..."
}
```

错误码同 robohire-client 已有逻辑:4xx (非 429) → CLIENT,402 → QUOTA_EXHAUSTED,429 → RATE_LIMITED,5xx/网络 → SERVER/NETWORK。

```ts
export type RobohireGenerateJdData = {
  title?: string;
  companyName?: string;
  department?: string;
  location?: string;
  workType?: string;
  employmentType?: string;
  experienceLevel?: string;
  education?: string;
  headcount?: number | string;
  qualifications?: string;
  hardRequirements?: string;
  niceToHave?: string;
  description?: string;
  benefits?: string;
  interviewRequirements?: string;
  evaluationRules?: string;
  salaryMin?: string | number;
  salaryMax?: string | number;
  salaryCurrency?: string;
  salaryPeriod?: string;
  salaryText?: string;
  [k: string]: unknown;
};

export type RobohireGenerateJdResponse = {
  data: RobohireGenerateJdData;
  meta?: { stages?: { parse?: string; generate?: string } };
  requestId: string;
};

export async function generateJdDirect(
  input: { prompt: string; language?: string; companyName?: string; department?: string },
  opts?: CommonOpts,
): Promise<RobohireGenerateJdResponse>;
```

### 5.3 createJdAgent 改 RoboHire 直连

```ts
// Before
const generated = await step.run(`generate-${stepKey}`, async () => {
  return await generateJd({ prompt, language: 'zh', companyName, department }, { traceId });
  //                                              ^^^ RAAS proxy
});

// After
import { generateJdDirect, RobohireApiError } from '@/lib/robohire-client';

const generated = await step.run(`generate-${stepKey}`, async () => {
  try {
    return await generateJdDirect({ prompt, language: 'zh', companyName, department }, { traceId });
  } catch (e) {
    if (e instanceof RobohireApiError && e.isClientError) {
      throw new NonRetriableError(`RoboHire /jobs/generate-jd 4xx: ${e.httpStatus} ${e.code} ${e.message}`);
    }
    throw e;
  }
});
```

### 5.4 prompt 重写 — F4 完整字段表

替换 `buildPromptFromRequirement`,严格按 partner F4 表逐行实现:

```ts
function buildPromptFromRequirement(r: RaasRequirement, s: Partial<RaasRequirementSpecification>): string {
  const lines: string[] = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value && String(value).trim()) lines.push(`${label}: ${value}`);
  };
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = (r as any)[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  const formatDate = (value: unknown): string | null => {
    if (!value) return null;
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);   // YYYY-MM-DD
  };
  const formatWorkAddress = (value: unknown): string | null => {
    if (!value) return null;
    if (typeof value === 'string') return value.trim() || null;
    if (Array.isArray(value)) {
      const parts = value.filter(Boolean).map(String).join(' / ');
      return parts || null;
    }
    if (typeof value === 'object') {
      const v = value as Record<string, unknown>;
      const parts = [v.city, v.district, v.address].filter(Boolean).map(String);
      return parts.join(' ') || null;
    }
    return null;
  };

  // 基础信息
  push('岗位', r.client_job_title);
  push('岗位类型', r.client_job_type);
  push('所属部门', pick('first_level_department', 'oa_department', 'sd_org_name'));
  push('服务BG', (r as any).service_bg);
  push('需求类型', (r as any).demand_type);
  push('招聘类型', r.recruitment_type);
  push('期望级别', r.expected_level);
  if (typeof r.headcount === 'number') push('招聘人数', String(r.headcount));
  push('工作城市', r.city);
  push('工作地点', formatWorkAddress((r as any).work_address));
  push('薪资范围', r.salary_range);
  if (typeof r.work_years === 'number') push('工作年限', `${r.work_years} 年以上`);
  push('学历要求', r.degree_requirement);
  push('专业要求', r.education_requirement);
  push('语言要求', r.language_requirements);

  // 候选人偏好
  const gender = (r as any).gender;
  if (typeof gender === 'string' && gender.trim() && gender.trim() !== '不限') push('性别要求', gender);
  push('年龄要求', (r as any).age_range);
  if ((r as any).require_foreigner === true) push('接收外籍', '是');
  push('排班类型', (r as any).work_schedule_type);

  // 面试
  push('面试形式', r.interview_mode);
  const firstFmt = (r as any).first_interview_format;
  const finalFmt = (r as any).final_interview_format;
  if ((firstFmt && String(firstFmt).trim()) || (finalFmt && String(finalFmt).trim())) {
    push('初/复试形式', `${firstFmt ?? '—'} / ${finalFmt ?? '—'}`);
  }
  const firstInt = (r as any).first_interviewer_name;
  const finalInt = (r as any).final_interviewer_name;
  if ((firstInt && String(firstInt).trim()) || (finalInt && String(finalInt).trim())) {
    push('初/复试官', `${firstInt ?? '—'} / ${finalInt ?? '—'}`);
  }
  push('面试流程', (r as any).interview_process);

  // 优先级 / 紧急度 / 难度
  push('优先级', s.priority);
  push('紧急度', (r as any).urgency_level);
  push('填充难度', (r as any).fill_difficulty);

  // 三个日期(关键校正点)
  push('发布日期', formatDate((r as any).client_published_at) ?? formatDate((r as any).open_date));
  push('期望到岗日期', formatDate((r as any).required_arrival_date) ?? formatDate(s.deadline));
  push('服务开始日期', formatDate(s.start_date));

  if (s.is_exclusive) push('独家委托', '是');
  push('招聘策略', (r as any).recruitment_strategies);

  // 技能 / 排除 / 原始文本
  if (Array.isArray(r.must_have_skills) && r.must_have_skills.length) {
    lines.push(`\n必备技能:\n  - ${r.must_have_skills.join('\n  - ')}`);
  }
  if (Array.isArray(r.nice_to_have_skills) && r.nice_to_have_skills.length) {
    lines.push(`\n加分技能:\n  - ${r.nice_to_have_skills.join('\n  - ')}`);
  }
  if (typeof r.negative_requirement === 'string' && r.negative_requirement.trim()) {
    lines.push(`\n排除条件: ${r.negative_requirement}`);
  }
  if (typeof r.job_responsibility === 'string' && r.job_responsibility.trim()) {
    lines.push(`\n岗位职责(原始):\n${r.job_responsibility}`);
  }
  if (typeof r.job_requirement === 'string' && r.job_requirement.trim()) {
    lines.push(`\n任职要求(原始):\n${r.job_requirement}`);
  }

  return lines.join('\n').slice(0, 4000);
}
```

### 5.5 验收

- 触发 JD 生成,prompt 含 F4 表所有字段(有值时输出,空跳过)
- "服务开始日期" 取 `s.start_date`(不是"期望到岗")
- "期望到岗日期" 优先 `r.required_arrival_date`,fallback `s.deadline`
- "发布日期" 优先 `r.client_published_at`,fallback `r.open_date`
- RoboHire `/jobs/generate-jd` 直连成功,RAAS `/jd/sync-generated` 写 Postgres 不变
- RAAS API Server `/generate-jd` 端点本仓库**无任何调用**(`grep -r generateJd lib/raas-api-client.ts server/` 命中应该只有 type definitions,无调用方)

---

## 6. 待清理(完整清单)

| 文件 | 操作 | 备注 |
|---|---|---|
| `lib/raas-api-client.ts` | 删除 `generateJd` 函数 + `GenerateJdInput` / `GenerateJdResponse` / `RaasGenerateJdData` type | RoboHire 直连后没人用 |
| `lib/raas-api-client.ts` | 移除 `GetRequirementsQuery` 里 5 个 `@deprecated` 字段 | F2 cleanup |
| `server/inngest/client.ts` | 删除 `RuleCheckFailedData` type | 方案 B,改用 `MatchFailedData` |
| `server/inngest/client.ts` | 重写 `MatchPassedNeedInterviewData` / `MatchPassedNoInterviewData` / `MatchFailedData` 为统一 `MatchEventData` | F3 平铺 |
| `server/em/schemas/builtin.ts` | 更新 `MATCH_*` zod schema,加新字段 | 与 type 同步 |
| `server/inngest/agents/rule-check-agent.ts` | emit FAIL/REVIEW 改成 `MATCH_FAILED` | 方案 B |
| `server/inngest/agents/match-resume-agent.ts` | (1) 第一段加 thin-event 回拉 + resume_filename(F1+F2)(2) 第二段加 score 阈值分发 + payload 平铺(F3) | |
| `server/inngest/agents/create-jd-agent.ts` | (1) prompt 重写(F4 40+ 字段 + 日期校正)(2) 切 `generateJdDirect`(F4 直连) | |
| `lib/robohire-client.ts` | 加 `generateJdDirect` + types | F4 直连 |
| UI(如有 `RULE_CHECK_FAILED` 渲染) | grep 检查,改用 `MATCH_FAILED.data.rule_check_decision` | 方案 B |

---

## 7. 测试策略

### 7.1 Unit tests

| 文件 | 改/新 | 测什么 |
|---|---|---|
| `lib/raas-api-client.ts` 单测(若存在) | 改 | `getParsedResume` 200 / 404 / 5xx 路径 |
| `lib/robohire-client.test.ts` | 改 | 加 `generateJdDirect` 4 个 case(200 / 400 / 402 / X-Trace-Id) |
| `server/inngest/agents/rule-check-agent.test.ts` | 改 | 把 `RULE_CHECK_FAILED` 期望改成 `MATCH_FAILED`,验证 payload 平铺 |
| `server/inngest/agents/match-resume-agent.test.ts`(若存在) | 改/新 | (1) thin 事件回拉 (2) resume_filename query (3) score 三档分发 |
| `lib/rule-check/runner.test.ts` | (不动)| insufficient_info → PASS 上轮已验证 |

### 7.2 端到端

- 触发 `RESUME_DOWNLOADED` → 完整链路:resumeParser → matchResume(1st) → ruleCheckAgent → matchResume(2nd,按 score 分发) → MATCH_PASSED_* / MATCH_FAILED
- 触发 `REQUIREMENT_LOGGED` → createJdAgent 调 RoboHire `/jobs/generate-jd` 直连
- 验证 partner dispatcher 能从顶层 `data.candidate_id` / `data.matching_score` 读到字段(预期 RAAS 端验证)

---

## 8. 风险 + 兜底

| 风险 | 严重度 | 兜底 |
|---|---|---|
| RAAS `GET /candidates/:id/resumes/:rid/parsed` 端点 partner 还没部署 | 高 | F1 必须 partner 先上线;AO 加 fallback log 但不静默吞 |
| RoboHire `/jobs/generate-jd` 35 秒延迟(实测) | 中 | createJdAgent retries=1,Inngest step.run 默认 timeout 看 partner config(可能要调高) |
| score 阈值业务上未来要调 | 低 | 抽 `decideMatchEvent` 单函数;参数化阈值留 todo |
| 删除 RULE_CHECK_FAILED 后,内部审计页(`/rule-check`)若依赖该事件 | 低 | grep UI/api routes,改用 `MATCH_FAILED.data.rule_check_decision` |
| RoboHire `/jobs/generate-jd` partner 改 schema | 低 | meta.stages 字段已是契约信号;实测 200 响应保留 |

---

## 9. 实施顺序(给执行者)

4 个 PR,可独立合并:

| PR | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **PR-1** | F1 thin 事件回拉(RAAS client + matchResume 1st seg) | 无 | 中(链路阻断的解药) |
| **PR-2** | F2 resume_filename + 清 deprecated query | 无 | 低 |
| **PR-3** | F3 平铺 + score 阈值 + 方案 B(`RULE_CHECK_FAILED` → `MATCH_FAILED`) | 无 | 中(改 type + 改 emit) |
| **PR-4** | F4 createJdAgent prompt 重写 + RoboHire `/jobs/generate-jd` 直连 | 无 | 中(prompt 大改 + 切端点) |

每个 PR 独立,可并行实施。

---

## 10. 一句话总结

把 RAAS API Server 上**透传 RoboHire 的 3 个端点**(parse-resume / match-resume / generate-jd)全部替换成 AO 直连 RoboHire(parse + match 已完成,本 spec 加 generate);把 matchResume 链路按 partner F1-F3 契约补齐(thin 事件回拉 / 文件名收敛 / 顶层平铺 + score 阈值);事件家族从"`MATCH_PASSED_NEED_INTERVIEW` 一家独大 + `RULE_CHECK_FAILED` 内部审计"收敛成"`MATCH_PASSED_NO_INTERVIEW` / `MATCH_PASSED_NEED_INTERVIEW` / `MATCH_FAILED` 三态家族"。
