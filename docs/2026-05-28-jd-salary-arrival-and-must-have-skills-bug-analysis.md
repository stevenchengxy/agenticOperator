# JD 薪资/到岗日期丢失 & must-have-skills 匹配 —— 问题定位文档

> 日期:2026-05-28  
> 范围:只做分析与验证,**未改动任何代码**  
> 证据来源:源码 + `logs/robohire-*.log` / `logs/ruleCheck-*.log` / `logs/partner-pg-*.log`

---

## TL;DR

| 问题 | 一句话根因 | 性质 |
|---|---|---|
| **① 到岗日期没解析出来** | 整条 JD 生成链路**没有任何结构化字段/数据库列承接到岗日期**;它只作为自由文本进了 RoboHire prompt,而 RoboHire generate-jd 从不回吐日期 | 结构性缺失(必然丢) |
| **① 薪资没解析出来** | 薪资在 job_posting 里**唯一来源**是 RoboHire 回吐的 `salaryMin/Max/Text`;createJdAgent **没有把 requirement 自带的 `salary_range` 传进 sync**,导致兜底逻辑是死代码,RoboHire 一旦不回薪资就彻底丢 | 单点依赖 + 兜底失效 |
| **② must-have-skills 怎么匹配** | 结构化 `must_have_skills` 确实是空的(RoboHire 不产出、requirement 没填),对应的 rule-check rule 10-5 基本休眠;**真正的技能匹配发生在 RoboHire `/match-resume`**,它从 JD 散文 + 简历文本里**重新推断** must-have 再比对,不依赖结构化字段 | 两套机制,真正干活的不是结构化那套 |
| **③ 期望到岗日期取值错误(RAAS 复核)** | **字段没取错**(canonical Job_Requisition 的到岗字段就是 `required_arrival_date`,type=`Date`)。根因是 `formatDate` 把 `Date` 纯日历日当 UTC 时刻 `toISOString().slice(0,10)`:东八区零点值(`…T16:00:00.000Z`)的 UTC 日历日永远早一天 → 到岗日期提前一天 | 时区(Date 当 UTC 处理,早一天)→ ✅ **已修复** |
| **③ 遗漏需求澄清内容(RAAS 复核)** | createJD 2026-05-20 从 RAAS HTTP 切到直连 SQL 后,新的 `getRequirementDetail` **只 JOIN job_requisition + specification**,不再拉 `clarification_rounds` / `requirement_clarification_record`,prompt builder 根本拿不到澄清内容 | 迁移回归(数据没取)→ ✅ **已修复** |

---

## 问题 ① —— JD 创建:薪资 & 到岗日期没解析出来

### 1.1 完整链路(7 步)

```
REQUIREMENT_LOGGED 事件
   │  entity_id = job_requisition_id
   ▼
[Step 2] getRequirementDetail(jrid)            ← 直读 partner Postgres
   │  返回 JobRequisition + JobRequisitionSpecification(已含 salary_range / required_arrival_date)
   ▼
[Step 3] buildPromptFromRequirement(r, s)       ← 把字段拼成一段自由文本 prompt
   │  output: string(4-4000 chars)
   ▼
[Step 4] generateJdDirect({prompt, ...})        ← RoboHire POST /api/v1/jobs/generate-jd
   │  output: RobohireGenerateJdData
   ▼
[Step 5] syncJdToPartnerPg(input)               ← 写 partner Postgres
   │  ① UPDATE job_requisition(回填 17 个匹配字段)
   │  ② UPSERT  job_posting(13 列)
   │  ③ UPDATE  spec.status → pending_publish
   ▼
[Step 5b] writeJobPostingInstance / writeJobRequisitionInstance  ← 镜像到 Neo4j
   ▼
[Step 6] emit JD_GENERATED { job_posting_id, jd_content }
```

源码:[create-jd-agent.ts](../server/inngest/agents/create-jd-agent.ts) · [job-posting.ts](../lib/partner-pg/job-posting.ts) · [robohire-client.ts](../lib/robohire-client.ts)

### 1.2 入参:源头数据里其实**有**薪资和到岗日期

`getRequirementDetail` 返回的 `JobRequisition`([types.ts:38-106](../lib/partner-pg/types.ts#L38-L106))和 `Specification`([types.ts:13-32](../lib/partner-pg/types.ts#L13-L32)):

```ts
// JobRequisition
salary_range:          string | null   // 第 62 行 —— 薪资在这
required_arrival_date: Date|string|null // 第 79 行 —— 到岗日期在这
// JobRequisitionSpecification
start_date:            Date|string|null // 第 17 行 —— 服务开始日期
deadline:              Date|string|null // 第 18 行 —— 到岗日期 fallback
```

**结论:数据在源头是存在的,问题出在「解析/搬运」环节,不是数据本身缺。**

### 1.3 Step 3 出参:两个字段都进了 prompt(自由文本)

[create-jd-agent.ts:480, 521-529](../server/inngest/agents/create-jd-agent.ts#L520-L530):

```ts
push('薪资范围', r.salary_range);                                        // ✅ 第 480 行
push('期望到岗日期',
  formatDate(r.required_arrival_date) ?? formatDate((s as any).deadline)); // ✅ 第 526-528 行
push('服务开始日期', formatDate((s as any).start_date));                  // ✅ 第 529 行
```

⚠️ 注意:这里只是把它们拼成 `"薪资范围: 30-50K\n期望到岗日期: 2026-06-01"` 这样的**纯文本**,丢给 RoboHire。RoboHire 是否把它们**结构化抽回来**完全是另一回事。

### 1.4 Step 4 出参:RoboHire generate-jd 的响应 schema

[robohire-client.ts:291-314](../lib/robohire-client.ts#L291-L314) `RobohireGenerateJdData`:

```ts
type RobohireGenerateJdData = {
  title?, companyName?, department?, location?, workType?, employmentType?,
  experienceLevel?, education?, headcount?,
  qualifications?, hardRequirements?, niceToHave?, description?, benefits?,
  interviewRequirements?, evaluationRules?,
  salaryMin?, salaryMax?, salaryCurrency?, salaryPeriod?, salaryText?,   // ← 薪资有
  [k: string]: unknown;
  // ❌ 没有 requiredArrivalDate / startDate / onboardDate / 任何日期字段
};
```

**日志验证(99 次 generate-jd 调用,`logs/robohire-*.log`):**

```
status 200  resp_keys = ['title','description','qualifications','hardRequirements','salaryMin','salaryMax','salaryText']
            date-ish keys: []        ← 每一次都没有日期字段
status 200  resp_keys = []           ← 还有「200 但 data 为空」的情况,此时薪资也一并丢
```

➡️ **到岗日期:RoboHire 从不回吐。薪资:RoboHire 会回 `salaryMin/Max/Text`,但不稳定(有时 data 为空)。**

### 1.5 Step 5 入参:createJdAgent 实际传给 sync 的字段

[create-jd-agent.ts:242-259](../server/inngest/agents/create-jd-agent.ts#L242-L259):

```ts
const input: SyncJdInput = {
  job_requisition_id, client_id,
  ...(jdData as Record<string, unknown>),     // ← RoboHire 响应整段 spread(含 salaryMin/Max/Text)
  must_have_skills:      arrayOrUndefined(requirement.must_have_skills),
  nice_to_have_skills:   arrayOrUndefined(requirement.nice_to_have_skills),
  negative_requirement:  stringOrUndefined(requirement.negative_requirement),
  language_requirements: stringOrUndefined(requirement.language_requirements),
  expected_level:        stringOrUndefined(requirement.expected_level),
  degree_requirement:    stringOrUndefined(requirement.degree_requirement),
  education_requirement: stringOrUndefined(requirement.education_requirement),
  work_years:            ...,
  interview_mode:        ...,
  recruitment_type:      ...,
  city:                  pickCityFromBoth(requirement, jdData),
  // ❌ 没有 salary_range:requirement.salary_range
  // ❌ 没有 required_arrival_date / start_date 任何日期
};
```

**关键缺口**:agent 把 `must_have_skills / work_years / degree_requirement` 等一堆 requirement 字段**显式透传**了,**唯独漏了 `salary_range` 和所有日期字段**。薪资只能靠 `...jdData`(RoboHire 回的)带进来。

### 1.6 Step 5 内部:薪资解析逻辑 & 死掉的兜底

[job-posting.ts:227-241](../lib/partner-pg/job-posting.ts#L227-L241):

```ts
const salaryText   = pickField(body, 'salary_text', 'salaryText');     // 来自 RoboHire
const salaryMinRaw = pickField(body, 'salary_min',  'salaryMin');      // 来自 RoboHire
const salaryMaxRaw = pickField(body, 'salary_max',  'salaryMax');      // 来自 RoboHire

const fallbackSalaryRange = salary_range ?? jd_content?.salaryBenefits ?? null;
//                          └─ undefined(没传)  └─ undefined(没传)  => 永远 null
const { min, max } = parseSalaryRange(fallbackSalaryRange);            // parse(null) => {null,null}
const salaryMin = explicitSalaryMin ?? min;   // = RoboHire值 ?? null
const salaryMax = explicitSalaryMax ?? max;
const resolvedSalaryRangeText = salaryText ?? salary_range ?? ... ;    // = RoboHire值 ?? null
```

➡️ 因为 1.5 里 agent 既没传 `salary_range` 也没传 `jd_content`,**这段「从 requirement 自带薪资兜底」的逻辑永远拿不到值 = 死代码**。RoboHire 不回薪资时,本来唾手可得的 `requirement.salary_range` 救不回来。

### 1.7 Step 5 出参:job_posting 实际写入的列

[job-posting.ts:294-308](../lib/partner-pg/job-posting.ts#L294-L308):

```ts
const sharedCols = [
  'posting_title', 'posting_description', 'city',
  'salary_range', 'salary_currency', 'salary_period',
  'salary_range_monthly_min', 'salary_range_monthly_max',   // ✅ 薪资有列
  'degree_requirement', 'headcount', 'interview_mode',
  'search_keywords', 'publish_status',
  // ❌ 没有任何到岗/开始日期列
];
```

job_requisition 的回填列([job-posting.ts:247-269](../lib/partner-pg/job-posting.ts#L247-L269))同样**不含** `salary_range`、**不含**任何日期。

### 1.8 各步骤「入→出」汇总表

| 步骤 | 薪资 | 到岗日期 |
|---|:--:|:--:|
| 源 JobRequisition(入参) | ✅ `salary_range` | ✅ `required_arrival_date` |
| Step3 prompt(自由文本) | ✅ 第480行 | ✅ 第526行 |
| Step4 RoboHire 响应类型 | ✅ `salaryMin/Max/Text` | ❌ **类型里无日期** |
| Step4 实测(日志99次) | ⚠️ 有时回有时空 | ❌ **从不回** |
| Step5 agent 传入 sync | ❌ **没传 `salary_range`** | ❌ 没传任何日期 |
| Step5 sync 兜底 | ❌ **死代码(null)** | — |
| Step5 写 job_posting 列 | ✅ 有列 | ❌ **无列** |
| 最终 job_posting 值 | ⚠️ 仅当 RoboHire 回才有 | ❌ **必然为空** |

### 1.9 根因定论

- **到岗日期** = 结构性缺失。`RobohireGenerateJdData` 无日期字段、`SyncJdInput` 无日期字段、job_posting 无日期列、`assembleJdContent`([create-jd-agent.ts:356-383](../server/inngest/agents/create-jd-agent.ts#L356-L383))也不含日期。它**全程只以 prompt 自由文本存在**,RoboHire 又不抽取,所以生成出来的 JD **必然**没有到岗日期。源 requisition 行上的 `required_arrival_date` 自始至终没被读出来用于 JD 产物。

- **薪资** = 单点依赖 + 兜底失效。job_posting 的薪资**只**来自 RoboHire 回吐的结构化薪资;agent 没把 requirement 自带的 `salary_range` 传进 sync,使得本应救场的 fallback 永远是 null。RoboHire 一旦返回空 data(实测存在),薪资就丢。
  - 附带数据 bug:RoboHire 回 `salaryMin='30', salaryMax='50', salaryText='30-50K'` 时,`salary_range_monthly_min/max` 被存成 `30/50`,而文本是 `30-50K`(应为 30000/50000),量级差 1000(`toInt('30')=30`,见 [job-posting.ts:85-95](../lib/partner-pg/job-posting.ts#L85-L95))。

---

## 问题 ② —— must-have-skills 怎么匹配的

系统里有**两套**技能匹配机制。你观察到的「RoboHire 没解析出 must-have skills」对应的是 A 套(结构化),它基本休眠;真正干活的是 B 套(RoboHire 文本推断)。

### 2.1 机制 A:结构化 rule-check(rule 10-5)—— 基本休眠

#### A.1 JD 侧 `must_have_skills` 的来源链(**不来自 RoboHire**)

```
源 requirement.must_have_skills
   │  create-jd-agent.ts:247  arrayOrUndefined(requirement.must_have_skills)
   ▼
syncJdToPartnerPg → UPDATE job_requisition.must_have_skills   (job-posting.ts:248)
   │
   ▼
writeJobRequisitionInstance → Neo4j JR 节点.must_have_skills   (job-requisition.ts:91)
```

➡️ JD 的必备技能是**从源 requirement 透传**的,RoboHire generate-jd 根本不产出这个数组。**源 requirement 没填 → 全程为空。**

#### A.2 候选人技能的来源链

```
RoboHire /parse-resume  → data.skills
   │  (实测 shape 不一致:有时 string[],有时 { technical, soft, languages } 对象)
   ▼
neo4j-instance-writer.parsedResumeToResumeFields  → 拍平成 Resume 节点的技能字段
   │  (neo4j-instance-writer.ts:283-291 + flattenSkills 729-746,两种 shape 都兜)
   ▼
rule-check 读 Neo4j Resume 节点
```

#### A.3 匹配怎么做:LLM 读整段节点 JSON

[runner.ts:380-385](../lib/rule-check/runner.ts#L380-L385) + [prompt.ts:105-121](../lib/rule-check/prompt.ts#L105-L121):runner **不再用** `projectResume`,而是把**整个 Neo4j Resume 节点 + Job_Requisition 节点当 JSON** 丢进 prompt 的 §3.2 / §3.3。rule 10-5 文本([rules.json](../lib/rule-check/rules.json))让 LLM 判断「候选人技能列表是否包含 JD 全部必备技能」。

rule 10-5 入参(标准化逻辑节选):
> (2) 逐项比对:b)**必备技能**:候选人技能列表是否包含 JD 要求的全部必备技能项

#### A.4 为什么它休眠 —— 三重失效(全部有日志佐证)

**11 次真实 rule-check 运行(`logs/ruleCheck-*.log`)统计:**

```
JR must_have_skills across prompts: {'empty': 11}        ← 11/11 全是 []
resume skills:                       已填充(实测 20 项扁平数组)
rule 10-5 在响应中:                  缺席(某次只跑了 10-25/26/45/43/46/56 六条)
```

1. **must_have_skills 全是 `[]`** → prompt 决策树([prompt.ts:33-36](../lib/rule-check/prompt.ts#L33-L36))明令「字段为空数组 → `insufficient_info`,**绝不判 fail**」→ `insufficient_info` 折成 PASS([runner.ts:266-276](../lib/rule-check/runner.ts#L266-L276))。**即使 10-5 跑了,空必备技能也只会 PASS。**
2. **rule 10-5 常不在过滤后的规则集里** —— 规则按 client/department 动态拉([runner.ts:306](../lib/rule-check/runner.ts#L306)),样本那次根本没拉到 10-5。
3. **rule 10-5 元数据是 `enforcementLevel=optional, failurePolicy=warn`** —— 名字叫「一票否决」,机制上否决不了(`foldDecision` 只在 `stats.fail>0` 时 FAIL)。

#### A.5 候选人技能节点实测(证明候选人侧是有数据的)

某次真实运行,Resume 节点的 `skills` 字段:
```json
["普通话一级乙等","英语 CET-6（589 分）","PMP 持证","商务接待","沟通能力","保密意识",
 "行政数据分析","党政机关公文规范","项目管理","MS Office 全套","Excel BI 工具",
 "钉钉","华为 WeLink","飞书","Confluence","Jira","SAP HR 模块", ...]   // 20 项
```
➡️ 候选人技能**有**(RoboHire 的 `{technical, soft, languages}` 对象被拍平进了扁平 `skills`)。空的只有 JD 侧的 `must_have_skills`。

### 2.2 机制 B:RoboHire `/match-resume` —— 真正在匹配 must-have skills

#### B.1 入参(纯文本,不是结构化字段)

[match-resume-agent.ts:122](../server/inngest/agents/match-resume-agent.ts#L122) → `matchResumeDirect`([robohire-client.ts:245-275](../lib/robohire-client.ts#L245-L275)):

```ts
type RobohireMatchResumeInput = {
  resume: string;   // 简历纯文本
  jd:     string;   // JD 纯文本(散文)
  candidatePreferences?: string;
  jobMetadata?: string;
};
```

#### B.2 出参 & 实测:RoboHire 自己从 JD 散文里**推断** must-have

真实调用(`logs/robohire-*.log`,jd 805 字、resume 1736 字):

- **JD 文本里根本没有「必备技能」甚至「技能」字样**(实测 `jd mentions 必备技能: False | 技能: False`)
- RoboHire 仍返回:
```json
"mustHaveAnalysis": {
  "extractedMustHaves": {
    "skills": [
      {"skill":"公文写作","reason":"JD明确要求各类公文、纪要、简报撰写","explicitlyStated":true},
      {"skill":"商务接待","reason":"负责商务接待与公关，维护合作关系","explicitlyStated":true},
      {"skill":"会议组织","reason":"全流程组织与保障单位各项会议","explicitlyStated":true}
    ],
    "experiences":[{"experience":"2年以上相关工作经验","minimumYears":"2"}, ...],
    "qualifications":[{"qualification":"本科及以上学历"}]
  },
  "candidateEvaluation": { "meetsAllMustHaves": true, "matchedSkills":[{"skill":"公文写作", ...}] }
}
```

➡️ RoboHire 的 LLM **从 JD 散文里推断出 must-have skills**(公文写作/商务接待/会议组织),再去简历文本里匹配。**完全不依赖结构化 `must_have_skills` 字段。** 结果落到 partner Postgres `candidate_match_result_runtime_state`(`matched_skills / missing_skills / must_have_analysis / skills_score`,见 `logs/partner-pg-*.log`)。

### 2.3 根因定论

- 你看到的「结构化 must-have skills 没解析出来」是**真的**:RoboHire generate-jd 不产出它,源 requirement 没填它,所以 JR 节点上是空 `[]`,对应的 rule-check rule 10-5 这道门是关着的(空数组 → insufficient_info → PASS,且常常根本不在规则集里)。
- 但匹配**照样发生**:RoboHire `/match-resume` 拿 JD 散文 + 简历文本,**自己重新推断** must-have skills 再比对。这才是真正决定技能匹配的地方。
- 即:**must-have-skills 的匹配压根不走那个结构化字段**,走的是 RoboHire 的文本理解。

### 2.4 顺带发现(建议单独排查)

最近几次真实 `/match-resume` 返回 **`matchScore=null` / `recommendation=null`**(只回了 `mustHaveAnalysis`),而 match-resume-agent 是靠 `matchScore` 判 `MATCH_PASSED` / `MATCH_FAILED` 的——RoboHire 响应 shape 发生漂移,可能影响最终录用判定。

---

## 问题 ③ —— RAAS partner 复核发现的 prompt 层问题

> 这两条是 partner(RAAS)复核 `buildPromptFromRequirement` 时提出的,属于「拼 prompt」这一步(Step 3),与问题①的「下游没承接」是不同环节。

### 3.1 期望到岗日期取值错误 —— 复查定论(按 canonical schema):**字段没取错,根因是「Date 纯日期被当 UTC 时刻 → 早一天」**

> 两次更正记录(保留以示推理过程):
> - 第一版:只归「时区 off-by-one」——方向对,但没说清为什么。
> - 第二版:怀疑「取错字段(应为 `expected_arrival_date`)」——**这条经 canonical schema 核对后撤回**(见下)。
> - 本版(以 `docs/data/objects_v0_1_010.json` 权威 schema 为准):**字段 `required_arrival_date` 是对的;唯一根因是把 `Date` 类型(纯日历日)当成 UTC 时刻去 `slice`,导致东八区日期早一天。**

#### 权威依据:canonical ontology 怎么定义这个字段

[objects_v0_1_010.json:276-279](../docs/data/objects_v0_1_010.json#L276-L279) —— Job_Requisition 对象:
```json
{ "name": "required_arrival_date", "type": "Date", "description": "招聘岗位要求候选人到岗的日期" }
```
两点关键:
1. **它就是「到岗日期」字段**(描述=「要求候选人到岗的日期」),createJD 读 `r.required_arrival_date` **取对了字段**。canonical Job_Requisition 里**根本没有 `expected_arrival_date`**(grep 全文只有 `open_date` / `required_arrival_date`)。
2. **类型是 `Date`(纯日历日)**,不是 DateTime——它语义上只有「年月日」,没有时刻、没有时区含义。

> 撤回第二版的「取错字段」:`expected_arrival_date` 只出现在另一套**只读列表 API** 的文档([raas-internal-api-spec.md:60](../docs/raas-internal-api-spec.md#L60))里,那是 match-resume 用的 agent-view 接口的展示字段,**不是 canonical Job_Requisition 对象的字段**,也不在 createJD 直连的 `job_requisition` 表里。所以「应该改用 expected_arrival_date」不成立。

#### 根因:`Date`(纯日历日)被当 UTC 时刻处理 → 东八区早一天

`formatDate` [create-jd-agent.ts:445-449](../server/inngest/agents/create-jd-agent.ts#L445-L449):
```ts
const d = new Date(String(value));
return d.toISOString().slice(0, 10);   // ← 把值当 UTC 时刻,取 UTC 日历日
```
调用 [create-jd-agent.ts:525-528](../server/inngest/agents/create-jd-agent.ts#L525-L528):`push('期望到岗日期', formatDate(r.required_arrival_date) ?? formatDate((s).deadline))`。

**入参(实测真实数据,`logs/` 全量统计):** `required_arrival_date` 基本非空,**全部形如 `…T16:00:00.000Z`**:
```
22×  "required_arrival_date":"2026-05-30T16:00:00.000Z"     (纯日历日=北京 2026-05-31)
20×  "required_arrival_date":"2026-07-19T16:00:00.000Z"     (纯日历日=北京 2026-07-20)
13×  "required_arrival_date":"2026-05-10T16:00:00.000Z"     (纯日历日=北京 2026-05-11)
 6×  "required_arrival_date":null
```
一个 `Date` 纯日历日(比如「2026-05-31」)以东八区零点入库,序列化成 UTC 就成了**前一天 16:00Z**(00:00 CST = 前一日 16:00 UTC)。这正是 `…T16:00:00.000Z` 的来历。

**出参(Node 复算,证明早一天):**
```
2026-05-30T16:00:00.000Z | formatDate→ 2026-05-30 | 实际(北京)日历日 2026-05-31  ← 早一天
2026-07-19T16:00:00.000Z | formatDate→ 2026-07-19 | 实际(北京)日历日 2026-07-20  ← 早一天
2026-05-10T16:00:00.000Z | formatDate→ 2026-05-10 | 实际(北京)日历日 2026-05-11  ← 早一天
```

➡️ **根因一句话:`required_arrival_date` 是 `Date` 纯日历日,但 `formatDate` 用 `new Date(v).toISOString().slice(0,10)` 把它当 UTC 时刻、取 UTC 日历日;东八区零点值的 UTC 日历日永远比真实日期早一天 → 「期望到岗日期」整体提前一天写进 prompt。** 这与「字段选择」无关,纯粹是 `Date` 类型的时区处理错误。

**波及面:** 同一个 `formatDate` 也用于 `发布日期`(`open_date`/`client_published_at`)、`服务开始日期`(`start_date`)——这些在 canonical schema 里同样是 `Date` 类型,**三个日期一并早一天**,partner 这次只点了到岗日期。
另外 allmeta 写 Neo4j 的 [`asIsoDateOrNull`](../lib/allmeta-writers/_helpers.ts#L61-L69) 也是 `new Date(v).toISOString()`(UTC),同一反模式**在代码库里重复出现**。

#### 次要隐患(顺带):fallback `?? s.deadline`

primary 为空时 fallback 到 `s.deadline`;`deadline` 在 schema 里是另一语义(截止/期限),与「到岗日期」不是一回事。F4(2026-05-19)注释把 `deadline` 当「到岗 fallback」是一次主观重映射,建议与 partner 对齐后大概率去掉(不属于这次「取值早一天」的主因,只是会在 `required_arrival_date` 为空那 6/56 条上引入第二种错值)。

#### 3.1 小结

| 项 | 结论 |
|---|---|
| 字段取对了吗 | ✅ 对。canonical Job_Requisition 的到岗字段就是 `required_arrival_date`(type=`Date`),无 `expected_arrival_date` |
| 根因 | `Date` 纯日历日被 `formatDate` 当 UTC 时刻 `slice`,东八区早一天(`toISOString` 取 UTC 日) |
| 正确做法 | 按东八区取日历日(或当 `Date` 直接取其年月日,不经 UTC),`formatDate` 与 `asIsoDateOrNull` 同改 |
| 次要 | 去掉/对齐 `?? s.deadline` fallback |

#### 3.1 修复状态(2026-05-28)

- ✅ **已修复主因(时区早一天)**:[create-jd-agent.ts:445-451](../server/inngest/agents/create-jd-agent.ts#L445-L451) 的 `formatDate` 改为
  `new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d)`,按北京时区取日历日。
  一处改动同时修好 prompt 里的 `期望到岗日期 / 发布日期 / 服务开始日期`(三者共用 `formatDate`)。
  验证:`2026-05-30T16:00:00.000Z` → 旧 `2026-05-30` → 新 `2026-05-31`(`2026-07-19…`→`07-20`、`2026-05-10…`→`05-11`);`tsc --noEmit` 该文件无类型错误。
- ⏸ **未改(刻意留下)**:
  - `asIsoDateOrNull`([_helpers.ts:61-69](../lib/allmeta-writers/_helpers.ts#L61-L69))同一反模式,但属 Neo4j 写入路径(非本次 JD prompt 问题),改动会影响已写入值,留作单独一项。
  - `?? s.deadline` fallback 需 partner 确认语义后再动(只在 `required_arrival_date` 为空的 6/56 条触发)。

### 3.2 遗漏需求澄清内容 —— `requirement_clarification_record` 既没取也没拼

**澄清内容当前完全进不了 prompt,分两层验证:**

**① 取数层:新版 `getRequirementDetail` 根本不拉澄清记录**

[requirements.ts:34-43](../lib/partner-pg/requirements.ts#L34-L43) —— 2026-05-20 从 RAAS HTTP 切到直连 SQL 后,只有:
```sql
SELECT row_to_json(r.*), row_to_json(s.*)
FROM job_requisition r
LEFT JOIN job_requisition_specification s ON ...
WHERE r.job_requisition_id = $1
```
**没有 JOIN / 查询 `requirement_clarification_record`(或澄清轮次表)。** 对比旧的 HTTP 版 [raas-api-client.ts:663-720](../lib/raas-api-client.ts#L663-L720) 是会返回 `clarification_rounds: Array<…>` 的——切直连 SQL 时这块数据被丢了,属**迁移回归**。

**② 拼装层:`buildPromptFromRequirement` 也没有任何澄清字段**

[create-jd-agent.ts:469-549](../server/inngest/agents/create-jd-agent.ts#L469-L549) 推入 prompt 的字段里**既没有澄清答复内容、也没有 `clarify_questions`**。即使 requirement 上带了 `clarify_questions`(问题清单,[types.ts:82](../lib/partner-pg/types.ts#L82)),也没被拼进去;而 partner 要的是**已录入的澄清「答复内容」**(`requirement_clarification_record`),那个连取都没取。

**业务背景(为何必须拼进去):** 按 [workflow-canonical.json](../lib/workflow-canonical.json) 的澄清流程,澄清结果里包含「模糊要求的确认、硬性条件 And/Or 逻辑关系、隐性要求」等——其中一部分会被折进 `must_have_skills/nice_to_have_skills/negative_requirement` 等结构化字段,但**澄清记录里的自由文本细节(逻辑关系、上下文)不会全部落到那几个数组**。所以生成 JD 时漏掉澄清记录,等于丢失了客户真正确认过的需求语义。

➡️ **根因:JD 生成在「取数」和「拼 prompt」两层都漏了澄清记录——直连 SQL 不查 `requirement_clarification_record`,prompt builder 也没有对应拼装分支。需要在 partner-pg 侧补一次对 `requirement_clarification_record` 的查询(按 job_requisition_id 取已录入的澄清内容),再在 `buildPromptFromRequirement` 里新增一段「需求澄清记录」拼进 prompt。**

#### 3.2 修复状态(2026-05-28)—— ✅ 已修复

**先连库拿到真实表结构**(host 实测是 `192.168.1.103`、库名是 `raas`,非 `…104` / `raas_db`):
```
requirement_clarification_record(
  id text PK, job_requisition_id text FK, clarified_at timestamp,
  content text,                       ← 澄清正文
  clarifier_name text, client_clarifier_name text,
  clarification_type text, attachments jsonb, created_at timestamp)
```
(当前线上该表 0 行,但 schema 已确认,SQL 已对真实库验证可执行。)

**改动:**
1. **取数** — 新增 [requirements.ts `getClarificationRecords(jrid)`](../lib/partner-pg/requirements.ts):按 `job_requisition_id` 查、`clarified_at` 正序、过滤空 `content`。
2. **接线** — [create-jd-agent.ts](../server/inngest/agents/create-jd-agent.ts) 新增 `fetch-clarifications-*` step(取数失败只 warn + 回退 `[]`,**不阻断** JD 生成),结果传入 `buildPromptFromRequirement`。
3. **拼装** — `buildPromptFromRequirement` 新增 `clarifications` 入参 + 一段「需求澄清记录(已与客户确认,JD 须据此调整)」,**放在原始长文本之前**,避免被尾部 4000 字截断。日期复用已修正的北京时区 `formatDate`。

**产物示例(prompt 里长这样):**
```
需求澄清记录(已与客户确认,JD 须据此调整):
  - [2026-05-20 · 技能澄清 · 张三] 必备技能中 Java 与 Go 为 Or 关系,满足其一即可
  - [2026-05-21 · 李四(客户)] 该岗位不涉及海外出差;可接受应届硕士
  - [职责澄清] 汇报对象为技术总监
```

**验证:** `getClarificationRecords` 的 SQL 已对线上 `raas` 库执行成功(列名/语法正确,空表返回 0 行);拼装格式如上;`tsc --noEmit` 两个改动文件无类型错误。

### 3.3 问题③「入→出」汇总

| 子问题 | 入参(实际有什么) | 处理 | 出参(prompt 里成了什么) | 错在哪 |
|---|---|---|---|---|
| 到岗日期 | `required_arrival_date="2026-05-30T16:00:00.000Z"`(type=`Date`,纯日历日=北京 2026-05-31) | `formatDate` 当 UTC 时刻取 UTC 日 | `期望到岗日期: 2026-05-30` | `Date` 被当 UTC 处理 → 早一天(字段没错) |
| 澄清内容 | partner `requirement_clarification_record.content` 已录入答复 | 直连 SQL 不查 + builder 不拼(**已修复**:新增 `getClarificationRecords` + 拼装段) | 修复前 prompt 里**完全没有** | 取数+拼装双缺 → ✅ 已补齐 |

## 验证清单(可复现)

```bash
# Q1-到岗日期:99 次 generate-jd 没有任何一次回吐日期字段
grep -h generateJd logs/robohire-*.log | python3 -c "import sys,json; \
 [print([k for k in (json.loads(l).get('response',{}).get('data',{}) or {}) if 'date' in k.lower()]) for l in sys.stdin]"
#   → 全部输出 []

# Q1-薪资:generate-jd 存在「200 但 data 为空」的情况
#   见 1.4 日志:resp_keys = []

# Q1-代码:agent 没把 salary_range 传进 sync
grep -n "salary_range" server/inngest/agents/create-jd-agent.ts   # → 只有 prompt(480行),无 sync 传参

# Q2-must_have_skills 全空 + 候选人 skills 已填
#   见 2.1 A.4 / A.5 的 ruleCheck 日志统计

# Q2-RoboHire 从无「技能」字样的 JD 推断出 must-have
#   见 2.2 B.2

# Q3-到岗日期时区 off-by-one:真实值全是 …T16:00:00.000Z(北京零点)
grep -rhoE '"required_arrival_date":[^,}]+' logs/ | sort | uniq -c
node -e 'console.log(new Date("2026-05-30T16:00:00.000Z").toISOString().slice(0,10))'  # → 2026-05-30(应为北京 05-31)

# Q3-澄清内容:直连 SQL 没查澄清表
grep -n "clarif" lib/partner-pg/requirements.ts        # → 无任何匹配
grep -n "澄清\|clarif" server/inngest/agents/create-jd-agent.ts   # → buildPrompt 里无澄清拼装
```

## 涉及文件索引

| 关注点 | 文件 |
|---|---|
| JD 生成 agent | [server/inngest/agents/create-jd-agent.ts](../server/inngest/agents/create-jd-agent.ts) |
| RoboHire client(generate-jd / parse / match 类型) | [lib/robohire-client.ts](../lib/robohire-client.ts) |
| partner-pg sync(薪资解析 + job_posting 写列) | [lib/partner-pg/job-posting.ts](../lib/partner-pg/job-posting.ts) |
| partner schema 类型(salary_range / required_arrival_date) | [lib/partner-pg/types.ts](../lib/partner-pg/types.ts) |
| JR → Neo4j 镜像(must_have_skills) | [lib/allmeta-writers/job-requisition.ts](../lib/allmeta-writers/job-requisition.ts) |
| rule-check 编排 / 折叠决策 | [lib/rule-check/runner.ts](../lib/rule-check/runner.ts) |
| rule-check prompt(graph context + 决策树) | [lib/rule-check/prompt.ts](../lib/rule-check/prompt.ts) |
| rule 10-5 定义 | [lib/rule-check/rules.json](../lib/rule-check/rules.json) |
| 候选人技能拍平进 Neo4j | [lib/rule-check/neo4j-instance-writer.ts](../lib/rule-check/neo4j-instance-writer.ts) |
| match-resume agent | [server/inngest/agents/match-resume-agent.ts](../server/inngest/agents/match-resume-agent.ts) |
