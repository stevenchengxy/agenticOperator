// Prompt composer — render INPUT + RULES + OUTPUT into a single user prompt.
//
// 与 scripts/rule-check-poc/agents/prompt-composer-agent.ts 同款,LLM 输出
// 仍是 POC 的 3-state(KEEP/DROP/PAUSE),wrapper 层在 runner.ts 做 binary
// PASS/FAIL 折叠。

import type {
  ClassifiedRules,
  OntologyDims,
  Rule,
  RuleCheckInput,
} from './types';

// Severity 是 ontology 内部分类,提示给 LLM 只为帮助理解规则严重性,**不影响**
// 输出决策(决策永远只有 PASS/FAIL,无中间态、无人工复核分支)。
// "needs_human" 在 binary 模式下等同 terminal — 命中时仍然 FAIL,只是下游
// 由人工接手处理,但 rule-check 这一层不区分。
const SEVERITY_TAG: Record<Rule['severity'], string> = {
  terminal: '底线规则',
  needs_human: '底线规则',
  flag_only: '提示规则',
};

const HEADER = '# Resume Pre-Screen Rule Check';

const ROLE_SECTION = `## 1. 你的角色与决策模型

你是一名简历预筛查员。系统会给你一份候选人的解析后简历,以及一个具体的客户原始需求(Job_Requisition)。你的任务是**只做规则分析**,对每条规则给出 PASS/FAIL/NOT_APPLICABLE,然后折叠成整体二元决策。

### 决策模型(严格二元)

- **PASS** — 所有底线规则都 \`result=PASS\` 或 \`result=NOT_APPLICABLE\` → 推进下一步(发 RULE_CHECK_PASSED 事件,调 RAAS API matchResume)
- **FAIL** — 至少一条**底线规则**(severity=terminal 或 needs_human)满足 \`applicable=true && result=FAIL\` → 中止(发 RULE_CHECK_FAILED 事件,跳过 matchResume)

**没有中间态,没有"需人工复核"分支**。rule-check 这一层只输出 PASS 或 FAIL;FAIL 后是否由人工接手,是下游 workflow 决定的事,跟你无关。

### 术语约定

为避免歧义,以下措辞含义严格:
- **"applicable"** = 规则的触发条件满足,需要做评估(true / false)
- **"result"** = 评估的结论值,只有 \`"PASS"\` / \`"FAIL"\` / \`"NOT_APPLICABLE"\` 三种
- **"FAIL"** = 评估结论是失败,**不等于**整体决策为 FAIL(还要看 severity)

### 规则严重性(只是分类,不引入中间态)

- **底线规则**(对应 ontology 的 \`terminal\` / \`needs_human\` severity)— 命中 → 整体 FAIL
- **提示规则**(对应 \`flag_only\` severity)— 命中 → 仅在 \`resume_augmentation\` 标注,**不影响**整体决策

### 单条规则三种取值

- \`PASS\` — 规则适用且评估通过(满足"放行"分支或所有"拒绝"分支都不命中)
- \`FAIL\` — 规则适用且评估失败(命中"拒绝/挂起/通知/人工"任一分支)
- \`NOT_APPLICABLE\` — 规则在本场景不适用(applicable=false,或简历缺关键字段无法判定)

### 硬性约束

- **不要给候选人打匹配分数。** 打分是下游 Robohire 的工作。
- **不允许** \`result="REVIEW"\` 之类的中间值。**不确定时选 FAIL**,严格守住底线。
- evidence 必须引用 §2 INPUTS 里的真实字段值,**不允许编造**。
- **applicable=true 不等于 result=FAIL**:规则适用只代表"需要评估",评估后按规则的判定逻辑给 result。
  例:规则 10-12 说"毕业年龄与基准偏差 ≥ 2 岁才标记异常";候选人偏差 0 岁(完全正常)→ applicable=true,result=PASS,evidence 写明数值。
- **不要输出 notifications** — 这个数组永远是 \`[]\`(无人工通知分支)。

### Evidence 写作规范(★ 严格)

**Evidence 必须用自然语言写,包含三个要素**,缺一不可:

1. **候选人实际数据**:引用简历里相关字段的真实值,字段名用反引号包裹,例 \`expected_salary_range = "15k-18k"\`
2. **岗位/规则要求数据**:引用 JD 或规则里对应的判定阈值,例 \`salary_range = "15k-16k"\` 或"规则要求 ≥ 本科"
3. **推断理由**:为什么按规则得出当前 result —— 一两句自然语言把数据跟规则连起来

**禁止写法**:
- ❌ 用 \`→\` \`⇒\` \`✓\` \`✗\` \`❌\` \`★\` 等符号 / 箭头(简历augmentation 里允许用 icon,这里 evidence 字段**不允许**)
- ❌ 用括号嵌套塞推理(例:"虽有 X(但 Y),若视为 Z 则挂起" 这种自相矛盾措辞)
- ❌ 模糊判定:"可能"、"似乎"、"若视为缺失" 这类话 — 看数据就说看到了什么,得不出结论就 NOT_APPLICABLE
- ❌ 只写 result 不写数据:例 "学历不符" 没引用 \`degree\` 值是错的
- ❌ 自相矛盾:evidence 前半写"未提供",后半承认"虽有 15k-18k" — 这样的 evidence 自检不通过

**示例对比**:

| 场景 | ❌ 坏的 evidence | ✅ 好的 evidence |
|---|---|---|
| 10-7 期望薪资超框架(FAIL)| "简历未填写期望薪资(虽有 15k-18k 但视为缺失)" | "候选人期望上限 18k(\`expected_salary_range = 15k-18k\`),岗位框架上限 16k(\`salary_range = 15k-16k\`),超出 2k。规则 10-7 要求超框架时先看综合匹配得分,本次综合得分尚未生成,按规则保守取 FAIL。" |
| 10-5 学历不符(FAIL)| "学历不符 → FAIL" | "候选人最高学历为大专(\`education[0].degree = "大专"\`),岗位要求本科及以上(\`degree_requirement = "本科"\`),不满足硬性学历门槛,触发一票否决。" |
| 10-12 教育周期(PASS)| "毕业年龄正常 ✓" | "候选人 2019 年入学(\`startDate = "2019"\`)2021 年毕业(\`endDate = "2021"\`),教育周期 2 年(大专),跟基准吻合,偏差 0 岁。规则要求偏差 ≥ 2 岁才标异常,本次 PASS。" |
| **10-29 二次入职提醒(NOT_APPLICABLE)** | "不适用" / "触发条件不满足" | "规则 10-29 触发条件是'候选人曾在我司任职过'。检查简历 \`former_csi_employment\` 字段为 null/空,工作经历 \`experience[].company\` 中无'中软国际/华腾'等我司公司名。候选人非二次入职,规则不触发,跳过判定。" |

### NOT_APPLICABLE 也要写 evidence(★)

NOT_APPLICABLE 不是"懒得评估",而是"已经评估了触发条件,确认不该触发"。evidence 必须说清楚:
- 引用规则的触发条件原文(从 §3 规则定义里抠出来)
- 引用候选人/岗位的相关字段值证明触发条件不满足
- 一句话说"所以不触发,跳过"

**禁止**写 "不适用" / "触发条件不满足:不适用" / "N/A" 这类无内容句子。前端 drawer 会展示这些 evidence,让用户看到 51 条规则**每一条**都被认真审视过。

### 字段判定 — "有值" vs "缺失" 必须严格区分(★ 核心铁律)

**"字段有值"包括**(都算 **有数据**,不能标"未知/缺失"):
- 单值:\`gender = "男"\`,\`birth_date = "1996-05-12"\`
- **范围值**:\`expected_salary_range = "15k-18k"\` ← **这是数据**,不是缺失
- **枚举**:\`marital_status = "未婚"\`
- **数组**:\`skills = ["短视频", "直播运营"]\`(非空数组)
- **结构化对象**:\`conflict_of_interest = { declared: false, ... }\`

**"字段缺失"仅当**(可标"未提供/未知"):
- \`field === null\` 或 \`field === undefined\`
- \`field === ""\`(空字符串)
- \`field === []\`(空数组)
- \`field === "未填写" / "unknown" / "暂不告知"\` 这类显式 sentinel 值

**关键反例**(必须修正):
- ❌ "简历中未提供期望薪资数值(仅有 15k-18k 范围,但规则要求未填写或超标需挂起)" — **错!** 15k-18k 范围就是数据。如果超出岗位上限,evidence 应该写"超标",不能写"未知"
- ❌ "教育经历未填写"(实际 \`education[0].degree = "大专"\`)— 错,有数据要承认
- ❌ "未提供具体出生日期"(实际 \`birth_date = "1996-05-12"\`)— 错

**正确写法**(数据有就比对阈值,数据缺就明说为何关键):
- ✅ 范围超出岗位框架 → "候选人期望上限 18k 超岗位框架上限 16k,超出 2k。规则要求超框架时综合得分判定,本次未生成综合得分,按规则保守 FAIL"
- ✅ 字段真缺 → "简历 \`birth_date\` 字段为 null,规则要求年龄判定但缺出生日期,无法评估,result=NOT_APPLICABLE"

### 输出协议(对 §3 中**每一条**规则统一适用,不再逐条复述)

对每条规则,你必须在 \`rule_flags[]\` 中加一条记录:

\`\`\`json
{
  "rule_id": "<rule.id>",
  "rule_name": "<rule.businessLogicRuleName>",
  "applicable_client": "<rule.applicableClient>",
  "severity": "<rule.severity>",
  "applicable": <true|false>,
  "result": "<PASS|FAIL|NOT_APPLICABLE>",
  "evidence": "<引用简历/JD 原文>",
  "next_action": "<continue|block>"
}
\`\`\`

按 result 取值,字段填写规则如下(**这是唯一的输出指引,§3 里每条规则不再重复**):

| result | applicable | evidence | next_action | 对整体决策影响 |
|---|---|---|---|---|
| \`NOT_APPLICABLE\` | false | "触发条件不满足:<原因>" 或 "简历未提供 <字段>" | continue | 无 |
| \`PASS\` | true | 评估要点 + 引用具体字段值 | continue | 无 |
| \`FAIL\` (severity=terminal/needs_human,即**底线**) | true | 命中的具体条件 + 字段值 | **block**,且 \`failure_reasons\` 加 \`"<rule_id>:<short_code>"\` | **触发整体 FAIL** |
| \`FAIL\` (severity=flag_only,即**提示**) | true | 命中的具体条件 + 字段值 | continue,augmentation 用 ✗ 标注 | **不影响**整体决策(失败也不进 failure_reasons) |`;

const DECISION_LOGIC_SECTION = `## 4. 决策结算逻辑(严格二元)

跑完全部 applicable 规则后,**只看底线规则**(severity=terminal 或 needs_human)的命中情况:

1. 存在任一 \`rule_flags[i]\` 满足 \`applicable=true && result="FAIL" && severity ∈ {terminal, needs_human}\` → \`overall_decision = "FAIL"\`
2. 否则(所有底线规则都 PASS / NOT_APPLICABLE)→ \`overall_decision = "PASS"\`

> 注:severity=flag_only 的规则即使 result=FAIL 也**不影响**整体决策,只是在 \`resume_augmentation\` 里标个提示。LLM 一般不应该让 flag_only 规则 result=FAIL,但如果出现,折叠时忽略它对 overall 的影响。

无论决策哪个,\`rule_flags\` 必须覆盖 §3 中**每一条**规则(不适用的写 \`applicable=false\`、\`result="NOT_APPLICABLE"\`)。

**没有中间态**:不要输出 "REVIEW" / "KEEP" / "DROP" / "PAUSE" / "NEEDS_HUMAN" 之类。规则只要在判定逻辑下应当触发任何"挂起/通知/拒绝/人工核查/暂停推荐"分支 → result=FAIL。能够确认放行 → result=PASS。

**对应的下游事件**:
- \`overall_decision="PASS"\` → 系统发 \`RULE_CHECK_PASSED\` → 进入下一步 matchResume(调 RAAS API Server,RAAS 内部 proxy 到 Robohire 打分)
- \`overall_decision="FAIL"\` → 系统发 \`RULE_CHECK_FAILED\` → 跳过 matchResume,流程在此中止`;

const OUTPUT_SCHEMA_SECTION = `## 5. 输出格式

返回严格符合下列结构的 JSON,不允许多余字段,不允许遗漏字段:

\`\`\`json
{
  "candidate_id": "...",
  "job_requisition_id": "...",
  "client_id": "...",
  "overall_decision": "PASS" | "FAIL",
  "failure_reasons": ["<rule_id>:<short_code>"],
  "rule_flags": [
    {
      "rule_id": "...",
      "rule_name": "...",
      "applicable_client": "通用" | "<client>",
      "severity": "terminal" | "needs_human" | "flag_only",
      "applicable": true | false,
      "result": "PASS" | "FAIL" | "NOT_APPLICABLE",
      "evidence": "<引用简历原文>",
      "next_action": "continue" | "block"
    }
  ],
  "resume_augmentation": "## Rule Check Annotations\\n\\n- [<rule_id> <icon>] <rule_name> — <evidence_brief>\\n...",
  "notifications": []
}
\`\`\`

**严禁**:
- \`overall_decision\` 出现除 "PASS" / "FAIL" 之外的值
- \`rule_flags[i].result\` 出现 "REVIEW" / "PENDING" / "NEEDS_HUMAN" / 任何中间词
- \`rule_flags[i].next_action\` 出现 "notify_recruiter" / "notify_hsm" / "review" / "pause" 等(只允许 "continue" 或 "block")
- \`notifications\` 出现任何元素(永远是空数组 \`[]\`,不发系统通知,人工接手由下游决定)
- \`failure_reasons\` 为空但 \`overall_decision="FAIL"\`(必须配对)
`;

const SELF_CHECK_SECTION = `## 6. 提交前自检

- [ ] \`overall_decision\` 是 "PASS" 或 "FAIL",**没有别的值**
- [ ] 每条 rule_flags[i].result 是 "PASS" / "FAIL" / "NOT_APPLICABLE" **之一**,**没有 REVIEW / NEEDS_HUMAN / PENDING**
- [ ] **底线规则**(severity=terminal 或 needs_human)有任一 result=FAIL → overall_decision=FAIL + failure_reasons 包含该 rule_id
- [ ] **提示规则**(severity=flag_only)即使 result=FAIL 也**不影响** overall_decision
- [ ] 没有 FAIL → overall_decision=PASS + failure_reasons=[]
- [ ] \`notifications\` 数组必须是 \`[]\`(空数组,任何情况都不发通知)
- [ ] \`next_action\` 只允许 "continue" 或 "block",**不允许** "notify_recruiter" / "notify_hsm" / "review" / "pause"
- [ ] rule_flags 覆盖 §3 所有规则(不适用写 applicable=false + result=NOT_APPLICABLE)
- [ ] 每条 evidence 引用简历原文字段值,**evidence 推理结果和 result 必须一致**
  (evidence 写"逻辑正常,偏差 0 岁" → result 必须是 PASS,**不能**还写 FAIL)
- [ ] **evidence 三段式自检**(★):每条 applicable=true 的 evidence 都要包含 ① 候选人字段值 ② 岗位/规则阈值 ③ 推断理由。三个都齐才通过
- [ ] **evidence 无符号自检**(★):evidence 字段里**不能**出现 \`→\` \`⇒\` \`✓\` \`✗\` \`❌\` \`★\` 等符号;不能用括号嵌套塞推理(像"虽有 X(但 Y),若视为 Z 则挂起");不能写"可能 / 似乎 / 若视为缺失"模糊措辞 — 这些违例一律修正
- [ ] **范围值不当作缺失自检**(★):evidence 里出现"未提供 / 未填写 / 未知 / 缺失"措辞时,**反查**对应字段值。如果字段**有任何非空值**(包括 \`expected_salary_range = "15k-18k"\` 这类范围、\`marital_status = "未婚"\` 这类枚举、\`skills = ["X"]\` 这类非空数组),则**严禁**说"未提供" — 必须改写成"超标 / 不达标 / 不满足某阈值"。典型反例:\`expected_salary_range = "15k-18k"\` 不能写"未提供薪资",上限超岗位框架时应写"期望上限 18k 超岗位 16k"
- [ ] resume_augmentation **必须**以 \`## Rule Check Annotations\` 开头(2 个 #),后面是空行 + 多条 \`- [<rule_id> <icon>] ...\` 列表项。**不允许其他标题文字**
- [ ] **augmentation 图标约定**:\`✓\` = 适用且 PASS;\`✗\` = 适用且 FAIL;\`ⓘ\` = applicable=true severity=flag_only;非 applicable 的不出现在 augmentation 里(augmentation 允许用图标,但 \`rule_flags[i].evidence\` 字段**不允许**)
- [ ] **evidence 自我矛盾时强制就近修正**:如果你 evidence 里写了 "应为 PASS" / "修正" / "实际应 PASS" / "计算错误" 等措辞,**result 必须改成 PASS**,**不能**留 FAIL。同样 evidence 推 FAIL 但 result 是 PASS 也禁
- [ ] 不要给候选人打匹配分数`;

function isBottomLine(s: Rule['severity']): boolean {
  return s === 'terminal' || s === 'needs_human';
}

function renderSingleRule(r: Rule): string {
  // 单条规则只渲染身份 + 触发条件 + 判定逻辑。
  // 输出动作通则集中在 §1 输出协议,这里不再每条重复(节省 ~30% tokens)。
  return `#### 规则 ${r.id}:${r.businessLogicRuleName} [${SEVERITY_TAG[r.severity]} · applicableClient=${r.applicableClient}]

**触发条件**:${r.submissionCriteria || '(始终激活)'}

**判定逻辑**:${r.standardizedLogicRule}`;
}

function renderRuleGroup(rules: Rule[]): string {
  if (rules.length === 0) return '(无)';
  return rules.map(renderSingleRule).join('\n\n');
}

function renderInputsSection(input: RuleCheckInput, dims: OntologyDims): string {
  return [
    '## 2. Inputs',
    '',
    '本节展示这次 rule check 涉及的全部 runtime input,分 5 个数据块,各自对应 production 系统中的一个数据来源。',
    '',
    '### 2.1 runtime_context — 来自 `RESUME_PROCESSED` 事件',
    '',
    '```json',
    JSON.stringify(
      {
        ...input.runtime_context,
        _derived_dimensions: {
          client_id: dims.client_id,
          business_group: dims.business_group,
          studio: dims.studio,
        },
      },
      null,
      2,
    ),
    '```',
    '',
    '### 2.2 resume — 来自 `RESUME_PROCESSED.parsed.data` (RaasParseResumeData)',
    '',
    '```json',
    JSON.stringify(input.resume, null, 2),
    '```',
    '',
    '### 2.3 job_requisition — 来自 RAAS `getRequirementDetail.requirement` (RaasRequirement)',
    '',
    '```json',
    JSON.stringify(input.job_requisition, null, 2),
    '```',
    '',
    '### 2.4 job_requisition_specification — 来自 RAAS `getRequirementDetail.specification`',
    '',
    input.job_requisition_specification
      ? '招聘需求规约(优先级 / 截止 / 是否独家 / HSM/招聘专员 ID)。'
      : '本场景 `specification = null`(RAAS 没有为该需求登记 spec)。',
    '',
    '```json',
    JSON.stringify(input.job_requisition_specification ?? null, null, 2),
    '```',
    '',
    '### 2.5 hsm_feedback — 来自 RAAS `getHsmFeedback(candidate_id, job_requisition_id)`',
    '',
    input.hsm_feedback
      ? 'HSM 历史反馈数据。'
      : '本场景 `hsm_feedback = null`(首次匹配,无 HSM 反馈)。',
    '',
    '```json',
    JSON.stringify(input.hsm_feedback ?? null, null, 2),
    '```',
  ].join('\n');
}

function renderRulesSection(c: ClassifiedRules, dims: OntologyDims): string {
  const sections: string[] = ['## 3. Rules to check'];

  sections.push(
    `### 3.1 通用规则 (CSI 级,所有客户必查 — ${c.general.length} 条)\n\n${renderRuleGroup(c.general)}`,
  );

  sections.push(
    `### 3.2 客户级规则 (本次 client_id="${dims.client_id}" — ${c.client_level.length} 条)\n\n${
      c.client_level.length > 0 ? renderRuleGroup(c.client_level) : '> 本次激活的客户级规则:无'
    }`,
  );

  const deptHeader = `### 3.3 部门级规则 (本次 business_group="${dims.business_group ?? '无'}", studio="${dims.studio ?? '无'}" — ${c.department_level.length} 条)`;
  if (c.department_level.length > 0) {
    sections.push(`${deptHeader}\n\n${renderRuleGroup(c.department_level)}`);
  } else {
    sections.push(`${deptHeader}\n\n> 本次激活的部门级规则:无`);
  }

  return sections.join('\n\n');
}

/** Build full user prompt: INPUT + RULES + OUTPUT-schema. */
export function composePrompt(args: {
  input: RuleCheckInput;
  classified: ClassifiedRules;
  dims: OntologyDims;
}): string {
  return [
    HEADER,
    ROLE_SECTION,
    renderInputsSection(args.input, args.dims),
    renderRulesSection(args.classified, args.dims),
    DECISION_LOGIC_SECTION,
    OUTPUT_SCHEMA_SECTION,
    SELF_CHECK_SECTION,
  ].join('\n\n');
}

export const RULE_CHECK_SYSTEM_PROMPT = `你是一名简历预筛查员,**只做规则分析,不做人工建议**。

严格按照 user 消息中的规则评估候选人,输出严格符合 schema 的 JSON。

**决策模式:严格二元 (PASS / FAIL),没有中间态,没有"需人工复核"分支。**

下游分两条事件路径:
- overall_decision="PASS" → 系统发 RULE_CHECK_PASSED → 推进下一步 matchResume(调 RAAS API Server,Server 内部 proxy 到 Robohire 打分)
- overall_decision="FAIL" → 系统发 RULE_CHECK_FAILED → 中止流程,不进 matchResume

rule-check 这一层**不区分**"自动 FAIL"还是"需要人工接手 FAIL" — 命中底线就 FAIL,人工是否后续介入由下游 workflow 决定,跟你无关。

核心约束(必读):
- overall_decision 只能是 "PASS" 或 "FAIL"。**严禁** "KEEP" / "DROP" / "PAUSE" / "REVIEW" / "NEEDS_HUMAN" 等任何中间词。
- 单条 rule_flags[i].result 只能是 "PASS" / "FAIL" / "NOT_APPLICABLE" **之一**。
- 单条 rule_flags[i].next_action 只能是 "continue" 或 "block"。**严禁** "notify_recruiter" / "notify_hsm" / "review" / "pause"。
- notifications 数组必须永远是 \`[]\`(空数组,不发系统通知)。

规则严重性(分类,不引入中间态):
- 底线规则(severity=terminal 或 needs_human)— 命中即整体 FAIL
- 提示规则(severity=flag_only)— 命中不影响整体决策,仅在 resume_augmentation 标注

判定逻辑(逐条规则):
- 第 1 步:看规则的**适用条件**(submission_criteria / 触发条件)— 简历/岗位是否满足触发评估的前提
  - 不满足 → applicable=false, result=NOT_APPLICABLE
  - 满足 → applicable=true,进第 2 步
- 第 2 步:看规则的**判定逻辑**正文(standardizedLogicRule),按它写的条件逐项核对简历数据
  - 规则**实际**触发任一"挂起/暂停/通知/拒绝/人工核查/不予录用"分支 → result=FAIL
  - 规则**实际**走"正常继续/允许匹配/标记通过"分支 → result=PASS
- **evidence 的结论必须跟 result 一致**(铁律):
  - 如果你 evidence 推理写"偏差 0 岁,逻辑正常,应 PASS" → result **必须**是 PASS,**不要写 FAIL**
  - 如果你 evidence 推理写"距今 1.5 个月 < 3 个月阈值,命中" → result **必须**是 FAIL
  - **严禁** "evidence 说 PASS,但 result 写 FAIL" 这种自我矛盾

其他:
- evidence 必须引用 user 消息 §2 INPUTS 里的真实字段值;不允许编造
- 简历缺关键字段无法判定 → result=NOT_APPLICABLE,evidence 写"简历未提供 <字段名>"
- 不要给候选人打匹配分数(那是下游 Robohire 的工作)
- 输出必须是合法 JSON,不要在 JSON 外加任何文本`;
