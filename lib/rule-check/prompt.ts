// Prompt composer — render INPUT + RULES + OUTPUT into a single user prompt.
//
// 与 scripts/rule-check-poc/agents/prompt-composer-agent.ts 同款,LLM 输出
// 仍是 POC 的 3-state(KEEP/DROP/PAUSE),wrapper 层在 runner.ts 做 binary
// PASS/FAIL 折叠。

import type { GraphContext } from './graph-context';
import type {
  ClassifiedRules,
  MatchResumeStepGroup,
  OntologyDims,
  Rule,
  RuleCheckInput,
} from './types';

const SEVERITY_TAG: Record<Rule['severity'], string> = {
  terminal: '终止级',
  needs_human: '需人工复核',
  flag_only: '仅记录',
};

const HEADER = '# Resume Pre-Screen Rule Check';

const ROLE_SECTION = `## 1. 你的角色

你是一名简历预筛查员。系统会给你一份候选人的解析后简历,以及一个具体的客户原始需求(Job_Requisition)。你的任务是逐条检查下列所有规则,找出哪些规则在这份简历上命中,并把结果整理成结构化标签输出。

请特别注意:
- **不要给候选人打匹配分数。** 打分是下游 Robohire 的工作。
- 你的输出会驱动三种处理:DROP / PAUSE / KEEP。
- 简历缺少某个字段时,该字段相关的规则应标 \`result="NOT_APPLICABLE"\`,不要编造证据。`;

const DECISION_LOGIC_SECTION = `## 4. 决策结算逻辑

跑完全部 applicable 规则后:
1. 任一 \`rule_flags[i].result == "FAIL"\` → \`overall_decision = "DROP"\`
2. 否则任一 \`result == "REVIEW"\` → \`overall_decision = "PAUSE"\`
3. 否则 → \`overall_decision = "KEEP"\`

无论决策哪个,\`rule_flags\` 必须覆盖 §3 中**每一条**规则(不适用的写 NOT_APPLICABLE)。`;

const OUTPUT_SCHEMA_SECTION = `## 5. 输出格式

返回严格符合下列结构的 JSON,不允许多余字段,不允许遗漏字段:

\`\`\`json
{
  "candidate_id": "...",
  "job_requisition_id": "...",
  "client_id": "...",
  "overall_decision": "KEEP" | "DROP" | "PAUSE",
  "drop_reasons": ["<rule_id>:<short_code>"],
  "pause_reasons": ["<rule_id>:<short_code>"],
  "rule_flags": [
    {
      "rule_id": "...",
      "rule_name": "...",
      "applicable_client": "通用" | "<client>",
      "severity": "terminal" | "needs_human" | "flag_only",
      "applicable": true | false,
      "result": "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE",
      "evidence": "<引用简历原文>",
      "next_action": "continue" | "block" | "pause" | "notify_recruiter" | "notify_hsm"
    }
  ],
  "resume_augmentation": "<给 Robohire 的 markdown 标记段>",
  "notifications": [
    {
      "recipient": "招聘专员" | "HSM",
      "channel": "InApp" | "Email",
      "rule_id": "...",
      "message": "..."
    }
  ]
}
\`\`\``;

const SELF_CHECK_SECTION = `## 6. 提交前自检

- [ ] rule_flags 覆盖 §3 所有规则(不适用写 NOT_APPLICABLE)
- [ ] overall_decision 跟 drop_reasons / pause_reasons 一致
- [ ] 每条 evidence 引用了简历原文,简历未提供时写"简历未提供 <字段>,标 NOT_APPLICABLE"
- [ ] resume_augmentation 是给 Robohire 看的可读 markdown
- [ ] 不要给候选人打匹配分数`;

function severityToResult(s: Rule['severity']): string {
  switch (s) {
    case 'terminal':
      return 'FAIL';
    case 'needs_human':
      return 'REVIEW';
    case 'flag_only':
      return 'PASS';
  }
}

function severityToActionHint(r: Rule): string {
  switch (r.severity) {
    case 'terminal':
      return `\`drop_reasons\` 加 \`"${r.id}:<short_code>"\`,\`next_action\`="block"`;
    case 'needs_human':
      return `\`pause_reasons\` 加 \`"${r.id}:<short_code>"\`,\`notifications\` 加对应招聘专员/HSM 的通知,\`next_action\`="pause"`;
    case 'flag_only':
      return `仅在 \`resume_augmentation\` 文本里追加一行 flag,不写 drop/pause reasons,\`next_action\`="continue"`;
  }
}

function renderSingleRule(r: Rule): string {
  return `#### 规则 ${r.id}:${r.businessLogicRuleName} [${SEVERITY_TAG[r.severity]}]

**触发条件**:${r.submissionCriteria || '(始终激活)'}

**判定逻辑**:${r.standardizedLogicRule}

**命中时的输出动作**:
- 在 \`rule_flags\` 中加一条 \`{rule_id: "${r.id}", severity: "${r.severity}", applicable: true, result: "${severityToResult(r.severity)}", evidence: "<引用简历原文>"}\`
- ${severityToActionHint(r)}`;
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

export const RULE_CHECK_SYSTEM_PROMPT = `你是一名简历预筛查员。

严格按照 user 消息中的规则评估候选人,输出严格符合 schema 的 JSON。

边界约束:
- 不要给候选人打匹配分数(那是下游 Robohire 的工作)
- 不要超出 user 消息中规定的规则范围进行评估
- 不要在 evidence 里编造简历未提供的信息;缺字段一律标 NOT_APPLICABLE
- 输出必须是合法 JSON,不要在 JSON 外加任何文本`;

// ─── Phase 3: matchResume prompt composer (Set-ordered + graph context) ───

const STRICT_ORDER_BLOCK = `> **执行约束（必须遵守，违反即视为输出无效）：**
> 1. Set 之间按 §4.1 → §4.2 → §4.3 → §4.4 顺序，**不得跳过 Set、不得乱序**。
> 2. 每个 Set 内的 rules 按列出顺序逐条评估，**不得调换、不得合并**。
> 3. 一旦任一 rule 的 status="fail"，**立即停止后续所有 rule 的评估**；后续 rule 全部标 status="not_executed"，reason="前序规则 <rule_id> 已 FAIL，本规则未执行"。
> 4. status="pending" / "insufficient_info" / "pass" 均**不**短路；后续规则继续。
> 5. 你必须在内部完成全部评估后，再统一输出 explanations[]。`;

const OUTPUT_SCHEMA_MATCH_RESUME = `## 6. Output schema

仅输出严格符合下列结构的 JSON，**不允许 markdown 代码块、不允许多余字段**：

\`\`\`json
{
  "decision": "PASS" | "FAIL" | "REVIEW",
  "stats": {
    "total": <int>,
    "pass": <int>,
    "fail": <int>,
    "pending": <int>,
    "insufficient_info": <int>,
    "not_triggered": <int>,
    "not_executed": <int>
  },
  "explanations": [
    {
      "rule_id": "<id>",
      "rule_name": "<name>",
      "step_id": "<step_id>",
      "status": "fail" | "pending" | "insufficient_info" | "not_executed",
      "reason": "<reasoning, 引用 graph context 或 input 原文>"
    }
  ]
}
\`\`\`

stats 各字段必须与你内部评估的 status 数量一致；总和等于 stats.total。
explanations[] **仅**包含 status ∈ {fail, pending, insufficient_info, not_executed} 的规则；pass / not_triggered 的规则只计入 stats、不出现在 explanations。`;

const DECISION_FOLD_BLOCK = `## 5. 决策结算

逐 rule 评估完后按下列规则汇总：
- 任一 rule status="fail" → \`decision="FAIL"\`
- 否则任一 rule status="pending" 或 "insufficient_info" → \`decision="REVIEW"\`
- 否则 → \`decision="PASS"\`

不要根据自己的判断重新归类 rule status，必须沿用上面的语义。`;

const SELF_CHECK_MATCH_RESUME = `## 7. 自检
- [ ] 是否按 Set 顺序、Set 内列出顺序评估？
- [ ] 是否在出现首个 fail 后将后续全部标 not_executed？
- [ ] stats 的各类计数是否与 explanations[] 一致？
- [ ] 仅输出 JSON 对象本身，无 markdown 包裹？`;

function renderGraphSlot(name: string, value: unknown): string {
  return [`### ${name}`, '```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

function renderGraphSection(graph: GraphContext): string {
  return [
    '## 3. Graph context',
    '',
    '你可以通过下列对象引用 ontology 实例数据。**先用这些字段，不够再调 tool**。',
    '所有数据已经按 candidate_id / job_requisition_id 预拉取；缺的 slot 显示为 null 或 []，对应规则按 "信息不全" 处理。',
    '',
    renderGraphSlot('3.1 candidate', graph.candidate),
    renderGraphSlot('3.2 job_requisition', graph.job_requisition),
    renderGraphSlot('3.3 applications (历史投递, 全量)', graph.applications),
    renderGraphSlot('3.4 blacklist_hits (全量)', graph.blacklist_hits),
    renderGraphSlot('3.5 employment_links (含 Employer 节点解析)', graph.employment_links),
    '',
    '如需上面未列出的实体（亲属关系、合规文档等），通过 tool 调用 `get_instance` / `list_instances` / `list_links`。',
  ].join('\n');
}

function renderRuleBlock(r: Rule): string {
  return [
    `#### Rule ${r.id}: ${r.businessLogicRuleName}  [applicableClient=${r.applicableClient}, severity=${r.severity}]`,
    `- submissionCriteria: ${r.submissionCriteria || 'N/A'}`,
    `- logic: ${r.standardizedLogicRule}`,
  ].join('\n');
}

function renderStepBlock(s: MatchResumeStepGroup, index: number): string {
  const header = `### 4.${index + 1} Set ${s.order} — ${s.name}  [order=${s.order}]`;
  const meta = [
    `**进入条件**：${s.condition || '(无)'}`,
    `**Set 说明**：${s.description || '(无)'}`,
  ].join('\n');
  const ruleBlocks = s.rules.map(renderRuleBlock).join('\n\n');
  return [header, meta, ruleBlocks].join('\n\n');
}

function renderRulesSectionV2(steps: MatchResumeStepGroup[]): string {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  return [
    '## 4. Rules to check — 严格按 Set 顺序、Set 内严格按列出顺序评估',
    '',
    STRICT_ORDER_BLOCK,
    '',
    ...sorted.map((s, i) => renderStepBlock(s, i)),
  ].join('\n\n');
}

function renderInputsSectionV2(input: RuleCheckInput): string {
  return [
    '## 2. Inputs',
    '',
    '### 2.1 runtime_context',
    '```json',
    JSON.stringify(input.runtime_context, null, 2),
    '```',
    '',
    '### 2.2 resume',
    '```json',
    JSON.stringify(input.resume, null, 2),
    '```',
    '',
    '### 2.3 job_requisition',
    '```json',
    JSON.stringify(input.job_requisition, null, 2),
    '```',
    '',
    '### 2.4 job_requisition_specification',
    '```json',
    JSON.stringify(input.job_requisition_specification ?? null, null, 2),
    '```',
    '',
    '### 2.5 hsm_feedback',
    '```json',
    JSON.stringify(input.hsm_feedback ?? null, null, 2),
    '```',
  ].join('\n');
}

export function composeMatchResumePrompt(args: {
  input: RuleCheckInput;
  graph: GraphContext;
  steps: MatchResumeStepGroup[];
}): string {
  const ROLE = `# matchResume Rule Check

## 1. 你的角色

你是一名 matchResume action 的规则评估员。基于给定的 INPUT、GRAPH_CONTEXT 和 RULES，按 Set 顺序逐条评估每条 rule 的 status，并按规则结算出最终 decision。

- **必须**严格按 Set 顺序、Set 内列出顺序评估。
- **不要**给候选人打匹配分数（评分由下游算法负责）。
- **不要**在 reason 中编造 INPUT 或 GRAPH_CONTEXT 中未提供的信息；缺字段一律标 \`insufficient_info\`。`;

  return [
    ROLE,
    renderInputsSectionV2(args.input),
    renderGraphSection(args.graph),
    renderRulesSectionV2(args.steps),
    DECISION_FOLD_BLOCK,
    OUTPUT_SCHEMA_MATCH_RESUME,
    SELF_CHECK_MATCH_RESUME,
  ].join('\n\n');
}

export const MATCH_RESUME_SYSTEM_PROMPT = `你是一名 matchResume 规则评估员。

严格按照 user 消息中的 INPUT / GRAPH_CONTEXT / RULES 评估，输出严格符合 schema 的 JSON。

边界约束：
- 必须按 Set 顺序、Set 内列出顺序评估
- 一旦任一 rule status="fail"，后续全部标 not_executed
- 不要在 reason 里编造 INPUT/GRAPH_CONTEXT 未提供的信息；缺字段标 insufficient_info
- 必须输出合法 JSON，不要在 JSON 外加任何文本（包括 markdown code fence）`;
