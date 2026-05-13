// Prompt composer — Phase 3: matchResume Set-ordered + graph-context prompt.

import type { GraphContext } from './graph-context';
import type { MatchResumeStepGroup, Rule, RuleCheckInput } from './types';

// ─── Phase 3: matchResume prompt composer (Set-ordered + graph context) ───

function buildStrictOrderBlock(stepCount: number): string {
  const refs = Array.from({ length: stepCount }, (_, i) => `§4.${i + 1}`).join(' → ');
  return `> **执行约束（必须遵守，违反即视为输出无效）：**
> 1. Set 之间按 ${refs} 顺序，**不得跳过 Set、不得乱序**。
> 2. 每个 Set 内的 rules 按列出顺序逐条评估，**不得调换、不得合并**。
> 3. 一旦任一 rule 的 status="fail"，**立即停止后续所有 rule 的评估**；后续 rule 全部标 status="not_executed"，reason="前序规则 <rule_id> 已 FAIL，本规则未执行"。
> 4. status="pending" / "insufficient_info" / "pass" 均**不**短路；后续规则继续。
> 5. 你必须在内部完成全部评估后，再统一输出 rule_results[]。`;
}

const OUTPUT_SCHEMA_MATCH_RESUME = `## 6. Output schema

仅输出严格符合下列结构的 JSON，**不允许 markdown 代码块、不允许多余字段**：

\`\`\`json
{
  "rule_results": [
    { "rule_id": "<id>", "status": "<status>", "reason": "<≤40 字>" }
  ]
}
\`\`\`

**关键规则（违反即视为无效输出）：**
- status ∈ {pass, fail, pending, insufficient_info, not_triggered, not_executed}。
- 每条规则都必须有一条对应的 \`rule_results\` 条目，按 Set 顺序、Set 内列出顺序输出。
- \`reason\` 字段 **仅在** status ∈ {fail, pending, insufficient_info, not_executed} 时输出；status='pass' 或 'not_triggered' 时**必须省略 \`reason\` 字段**（不要写空字符串，直接不输出该 key）。
- 输出 \`reason\` 时控制在 40 个中文字符内，只写最关键的判断依据，**不要复述规则名或重复信息**。
- 不要输出 \`rule_name\`、\`step_id\`、\`decision\`、\`stats\`、\`explanations\` 等任何额外字段——runner 会基于 \`rule_results\` 重新计算。`;

const DECISION_FOLD_BLOCK = `## 5. 决策结算

逐 rule 评估完后按下列规则汇总：
- 任一 rule status="fail" → \`decision="FAIL"\`
- 否则任一 rule status="pending" 或 "insufficient_info" → \`decision="REVIEW"\`
- 否则 → \`decision="PASS"\`

不要根据自己的判断重新归类 rule status，必须沿用上面的语义。`;

const SELF_CHECK_MATCH_RESUME = `## 7. 自检
- [ ] 是否按 Set 顺序、Set 内列出顺序评估？
- [ ] 是否在 rule_results 中**为每一条规则**输出了一条条目？（数量必须与本提示中的规则总数完全一致）
- [ ] 是否在出现首个 fail 后将后续全部标 not_executed？
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
    renderGraphSlot('3.2 resume (候选人当前简历, 来自 neo4j Resume 节点)', graph.resume),
    renderGraphSlot('3.3 job_requisition', graph.job_requisition),
    renderGraphSlot('3.4 applications (历史投递, 全量)', graph.applications),
    renderGraphSlot('3.5 blacklist_hits (全量)', graph.blacklist_hits),
    renderGraphSlot('3.6 employment_links (含 Employer 节点解析)', graph.employment_links),
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
    buildStrictOrderBlock(sorted.length),
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
    '### 2.2 job_requisition',
    '```json',
    JSON.stringify(input.job_requisition, null, 2),
    '```',
    '',
    '### 2.3 job_requisition_specification',
    '```json',
    JSON.stringify(input.job_requisition_specification ?? null, null, 2),
    '```',
    '',
    '### 2.4 hsm_feedback',
    '```json',
    JSON.stringify(input.hsm_feedback ?? null, null, 2),
    '```',
    '',
    '（候选人简历 resume 已移入 §3.2 Graph context，由 neo4j Resume 节点提供。）',
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
