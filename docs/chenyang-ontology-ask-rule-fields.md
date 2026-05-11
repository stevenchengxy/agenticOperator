# 给陈洋的 ask:Ontology Rule 节点加 gating_severity + requiredResumeFields

> 来自:雨函 / Agentic Operator(2026-05-12)
> 关联:[docs/rule-check-unified-plan.md](./rule-check-unified-plan.md) Phase 3 的第 2 项
> 等级:推迟生产启用 ~2 周(可工作绕过,但绕法长期不可持续)

---

## TL;DR

`Rule` 节点(`:Rule` label)目前没有 2 个我们需要的字段,我们这边暂时:
- **`gating_severity`** — 在 [`lib/rule-check/ontology.ts:inferSeverity()`](../lib/rule-check/ontology.ts) 用文本关键词从 `standardizedLogicRule` 推断(P0 bug 来源,多分支规则误判)
- **`requiredResumeFields[]`** — 在 [`lib/rule-check/resume-projection.ts:RULE_REQUIRED_FIELDS`](../lib/rule-check/resume-projection.ts) 维护一份硬编码 map(51 条规则全列,每次新增规则要手工更新)

希望 ontology Rule 节点直接带这 2 个字段,我们退役文本推断 + 硬编码 map。

---

## 1. 字段:`gating_severity`

### 1.1 当前推断逻辑(我们这边)

[`lib/rule-check/ontology.ts:inferSeverity()`](../lib/rule-check/ontology.ts):

```ts
function inferSeverity(text: string): Severity {
  if (/立即终止|不予录用|...等 14 个关键词/.test(text)) return 'terminal';
  if (/挂起|暂停|待 HSM 确认|...等 23 个关键词/.test(text)) return 'needs_human';
  return 'flag_only';
}
```

只看 `standardizedLogicRule` 文本。

### 1.2 误判场景

很多规则原文是**多分支** —— 同一条规则,不同条件下输出 terminal vs needs_human vs flag_only。文本关键词同时命中多种,被推成单一 severity。

举例 — 规则 10-7(候选人期望薪资校验):

```
若候选人求职期望中无候选人期望的薪资范围,标记为"期望薪资未知"挂起匹配流程。     ← needs_human 信号
若期望薪资高于框架上限,得分低于 90 分则标记为"薪资不匹配"并终止匹配流程;         ← terminal 信号
得分达到 90 分及以上,...标记为"薪资超框架-可协商"并允许继续匹配。                ← flag_only 信号
```

我们的 inferSeverity 第一个匹配 `挂起` → 推 `needs_human`,但 LLM 实际跑时遇到"得分低于 90 + 高于框架"情况会判 FAIL/terminal,跟我们标的 needs_human 矛盾。

**长治方法**:gating_severity 在 ontology Rule 节点直接录,以 rule 的**最严重输出**为准(这条 10-7 应该是 `terminal`,因为最严的分支会终止匹配)。

### 1.3 字段定义请求

在 Neo4j `:Rule` label 上加属性:

```cypher
(:Rule {
  id: "10-7",
  ...,
  gating_severity: "terminal"   // 新加
})
```

值域:
- `terminal` — 任一分支会终止匹配流程(`drop_reasons` 候选)
- `needs_human` — 需要 HSM / 招聘专员人工复核(`pause_reasons` 候选)
- `flag_only` — 只 annotate 不阻塞(出现在 `resume_augmentation` 但不影响 gate)

### 1.4 51 条 matchResume 规则的标注

我们用现有 inferSeverity 跑一份初版,然后建议你/你的团队人工 review 一道:

```
$ npm run rule-check-poc:dump-severity
10-1   ... flag_only       (字节新需求滞留简历优先转推,系统逻辑,不影响候选人 gate)
10-2   ... flag_only       (字节新需求 HC 冻结召回,系统逻辑)
10-3   ... terminal        (IEG 活跃流程改推拦截,自动 block)
...
10-25  ... terminal        (华为荣耀冷冻,< 3 个月直接挂起 — 但"挂起"实际等于 block)
...
```

我们这边可以出一份 csv 给你 review,你录入。预计半天工作量(51 条)。

---

## 2. 字段:`requiredResumeFields[]`

### 2.1 当前 map(我们这边)

[`lib/rule-check/resume-projection.ts:RULE_REQUIRED_FIELDS`](../lib/rule-check/resume-projection.ts):

```ts
export const RULE_REQUIRED_FIELDS: Record<string, readonly ResumeField[]> = {
  '10-25': ['experience'],
  '10-21': ['birth_date'],
  '10-47': ['gender', 'birth_date', 'marital_status'],
  '10-5':  ['education', 'skills', 'languages', 'gender', 'birth_date'],
  ...51 条
};
```

[Kenny §2](./rule-check-unified-plan.md) "partial parsed resume data" 的支撑:LLM 评估每条规则时只看它需要的简历字段(`projectResume` 投影)。

### 2.2 为什么 ontology 化好

- **维护成本**:新加 / 改 ontology 规则后,我们这边要同步更新 map。漏更新 → partial 投影缺字段 → LLM 误判
- **跨项目复用**:RAAS / Robohire 团队可能也想知道"评估这条规则需要简历哪几个字段",ontology 化后他们也能读
- **声明式 vs 硬编码**:rule.standardizedLogicRule 里描述了字段需求(自然语言),ontology 化等于把它结构化

### 2.3 字段定义请求

```cypher
(:Rule {
  id: "10-47",
  ...,
  required_resume_fields: ["gender", "birth_date", "marital_status"]  // 新加
})
```

字段名值域(取自我们 `RaasParseResumeData` 字段):
```
name, email, phone, location, summary,
experience, education, skills, certifications, languages,
birth_date, gender, nationality, marital_status,
conflict_of_interest, expected_salary_range,
outsourcing_acceptance, labor_form_preference,
former_csi_employment, gap_periods, former_tencent_employment
```

无字段需求的规则(系统逻辑 / HSM 反馈触发)给空数组 `[]`。

### 2.4 51 条规则的字段标注

已经在我们这边维护了一份(见 [`lib/rule-check/resume-projection.ts`](../lib/rule-check/resume-projection.ts) 第 50-130 行),你直接拷贝过去录入即可。

---

## 3. 落地节奏

| 时间 | 你 | 我 |
|---|---|---|
| Day 1-2 | review 我们给的 severity csv,调整可疑的 | 出 csv + spec |
| Day 3-4 | 把 gating_severity + required_resume_fields 字段加到 Neo4j Rule 节点 + cypher migration | 等 |
| Day 5 | Ontology API 暴露这两个字段(在 `ActionRule` type / response 里加) — 配合叶洋 v5 PR | 验证 API 返回字段 |
| Week 2 | (无) | `lib/rule-check/ontology.ts:inferSeverity()` 退役;`resume-projection.ts:RULE_REQUIRED_FIELDS` 退役;改成读 ontology |

---

## 4. 验收

- `:Rule` 节点上 51 条 matchResume 规则全部带 `gating_severity` + `required_resume_fields` 属性
- Ontology API `GET /api/v1/ontology/actions/matchResume/rules` 返回字段含这两个
- 我们这边 `inferSeverity()` 删掉,所有 verdict 用 ontology canonical severity → POC 6 场景重跑准确率打平或更好
- `RULE_REQUIRED_FIELDS` 硬编码 map 删掉,`projectResume()` 改读 rule.required_resume_fields

---

## 5. 跟叶洋 v5 ask 的关系

叶洋的 v5 PR(见 [yeyang-v5-ask-rule-flags-schema.md](./yeyang-v5-ask-rule-flags-schema.md))主要改 prompt 模板的 **output schema**(让 LLM 输出 rule_flags + evidence),跟你这边的 **input metadata**(规则节点字段)正交,但**最好同步上线** — 这样 `ActionRule` type 里同时多出:
- `gating_severity`(你出)
- `required_resume_fields`(你出)
- (顺便)输出 schema 改造(叶洋出)

我们这边只需要切换一次代码,不用分两次。

---

## 6. 备注

- 如果 ontology rule 不止 matchResume 一个 action(还有 createJD / parseResume 等),`required_resume_fields` 字段对它们也有意义。建议字段命名 ontology 通用一些,不要绑死 "resume"。例如 `required_input_fields: string[]`(值域可以是 `resume.experience` 这种带 namespace 的)。看你判断
- `gating_severity` 字段是必填还是可选?建议必填,留空就走 `inferSeverity` fallback(我们这边代码保留 inferSeverity 兜底,直到 51 条全标完)
