// Prompt composer — Phase 3: matchResume Set-ordered + graph-context prompt.
//
// 2026-05-20 prompt tightening — addresses "rules drift / wrongly fail" issue
// where the LLM was returning fail for rules whose required fields were
// actually missing (should be insufficient_info) or didn't apply to the
// candidate (should be not_triggered). The fix is a strict status-decision
// tree at the top of the evaluation criteria, plus an evidence-citation
// requirement for any fail.

import type { GraphContext } from './graph-context';
import type { MatchResumeStepGroup, Rule, RuleCheckInput } from './types';

// ─── Phase 3: matchResume prompt composer (Set-ordered + graph context) ───

function buildStrictOrderBlock(stepCount: number): string {
  const refs = Array.from({ length: stepCount }, (_, i) => `§4.${i + 1}`).join(' → ');
  return `> **执行约束（必须遵守，违反即视为输出无效）：**
> 1. Set 之间按 ${refs} 顺序，**不得跳过 Set、不得乱序**。
> 2. 每个 Set 内的 rules 按列出顺序逐条评估，**不得调换、不得合并**。
> 3. **不要因为前面有规则 fail 就把后续标 not_executed**。所有 rule 都必须独立评估并给出最终 status。\`not_executed\` 仅当显式上游依赖断链时使用（极少见，本批通常用不到）。
> 4. 你必须在内部完成全部评估后，再统一输出 rule_results[]。`;
}

const STATUS_DECISION_TREE = `## 5. 单条 rule 的 status 决策树（**严格按下列顺序判断**，命中即止）

针对**每一条** rule，按下列步骤依次判断，**第一个命中的分支决定 status**：

1. **rule 描述的触发条件在本场景下不成立** → \`not_triggered\`
   - 例：rule 是"外籍候选需补充工作签证有效期"，候选人 nationality="中国"。
   - 例：rule 是"高管岗位需 HR 主管审批"，本岗位 level="L4"，不属高管。
   - server 端已按 applicableClient + applicableDepartment 过滤过一轮，但你**仍须**按 rule 文案(submissionCriteria / logic)里"针对 X 客户/X 事业群/X 类候选/X 类岗位"的限定再校验一次：若本场景明显不落在该限定内(例如 rule 限定"腾讯CDG事业群"、而本岗位部门是互娱IEG)，标 \`not_triggered\`，reason 写明不匹配维度。

2. **rule 要评估某字段，但 GRAPH_CONTEXT 中该字段为 null / 缺失 / 空数组** → \`insufficient_info\`
   - 例：rule 是"工作年限 ≥ 2 年"，但 \`candidate.work_years\` 为 null → \`insufficient_info\`，reason="简历未提供 work_years"。
   - 例：rule 是"必须有 Java 经验"，但 \`resume.skills\` 为 [] → \`insufficient_info\`。
   - **重要：缺字段 ≠ 不满足**。GRAPH_CONTEXT 由 server 预拉取，slot 为 null/[] 一律视为"信息不全"，**绝对不要**判 fail。

3. **rule 要评估的字段存在且明确不满足要求** → \`fail\`
   - 例：rule 要求"工作 ≥ 2 年"，\`candidate.work_years\`=1 → fail，reason="work_years=1 < 2"。
   - 例：rule 要求"无黑名单命中"，\`blacklist_hits\` 非空且 status="active" → fail，reason="命中黑名单 <id>"。
   - **必须在 reason 中引用 GRAPH_CONTEXT 中的具体值**（字段名+数值）。没有具体数值支撑的判断不得标 fail。

4. **字段存在且满足要求** → \`pass\`
   - reason 写 ≤40 字简要依据，比如"work_years=3 ≥ 2，满足"。

5. **规则要求 HSM 主观判断，无法从 GRAPH_CONTEXT 自动结算** → \`pending\`
   - 例：rule 是"形象气质需 HSM 复核"。
   - reason 写"需 HSM 复核 <具体维度>"。

⚠ **极性陷阱 —— 排除类/冷冻期/竞对/黑名单规则**：这类规则是"命中坏条件 → 阻断(fail)；未命中 → 放行(pass)"，极性跟"达标类"相反，最易判反：
   - 例：rule "腾讯离职**不足**6个月则阻断"。候选人离职已**满**6个月 → 未命中阻断条件 → 满足放行 → \`pass\`，reason="离职满6个月，放行"。**绝不能因为 reason 里出现"满足"二字就打 fail**——这里"满足"指满足放行条件。
   - 只有候选人**确实命中**阻断条件(如离职仅3个月)才 \`fail\`，reason="离职仅3个月<6，命中冷冻期"。
   - 先判清这条 rule 是"达标类"(满足要求→pass)还是"排除类"(命中坏条件→fail)，再定 status，别让 reason 文字误导。

⚠ **最常见的错误是把 \`insufficient_info\` 误判为 \`fail\`**。在判断为 fail 之前，再问自己：
> 我引用的字段在 GRAPH_CONTEXT 里真的非 null 吗？真的有具体数值吗？

如果回答否，**必须**改为 \`insufficient_info\`。`;

const DECISION_FOLD_BLOCK = `## 6. 决策结算（仅供你参考，最终由 server 计算）

逐 rule 评估完后 server 端会按下列规则汇总；你**只**输出 rule_results[]，不要输出 decision：
- 任一 rule status="fail" → \`decision="FAIL"\`
- 否则 → 整体 \`PASS\`（\`insufficient_info\` 与 \`pending\` 都**不**阻断，server 会在 audit 中单独显示这两类，但不影响整体推进）

不要根据自己的判断重新归类 rule status；按 §5 决策树独立评估每条规则。`;

const OUTPUT_SCHEMA_MATCH_RESUME = `## 7. Output schema

仅输出严格符合下列结构的 JSON，**不允许 markdown 代码块、不允许多余字段**：

\`\`\`json
{
  "rule_results": [
    { "rule_id": "<id>", "status": "<status>", "reason": "<判定依据>", "next_action": "<action>" }
  ]
}
\`\`\`

**关键规则（违反即视为无效输出）：**
- status ∈ {pass, fail, pending, insufficient_info, not_triggered, not_executed}。
- next_action ∈ {continue, block, supplement, review}，**必填**，按 status 取值：fail→block(阻断)；insufficient_info→supplement(补充材料)；pending→review(人工复核，不阻断)；pass / not_triggered→continue(放行)。
- 每条规则都必须有一条对应的 \`rule_results\` 条目，按 Set 顺序、Set 内列出顺序输出。
- \`reason\` 字段 **必填**（每条 rule 都要写，所有 status 都要写）：
  - status='fail'：写**详细**判定链(≤120 字)——①触发判定:为何本规则适用本候选人 ②引用 GRAPH_CONTEXT 的具体字段+数值 ③套用规则逻辑(注意极性:排除/冷冻类是"命中坏条件→fail"，别被"满足"二字误导)④结论。例:"目标岗位归属CDG适用；employment_links 最近腾讯离职 2024.02 距今约3个月<6；命中冷冻期阻断条件→未通过"
  - status='pending'：写**详细**待复核理由(≤120 字)——为何需 HSM、复核哪个维度、当前已知信息
  - status='insufficient_info'：写详细缺哪个字段+为何无法判定(≤80 字)，例:"candidate.work_years 为 null，规则要求≥2年无法结算"
  - status='pass'：写 ≤40 字简要依据，例:"work_years=3 ≥ 2，满足"
  - status='not_triggered'：写 ≤40 字为何不触发，例:"目标部门=IEG≠规则限定CDG，本规则不适用"
  - status='not_executed'：本批通常用不到；如用了写 ≤40 字上游断链原因
- \`reason\` 限 40 个中文字符内，只写最关键依据，**不要复述规则名或重复信息**。
- 不要输出 \`rule_name\`、\`step_id\`、\`decision\`、\`stats\`、\`explanations\` 等任何额外字段——runner 会基于 \`rule_results\` 重新计算。`;

const SELF_CHECK_MATCH_RESUME = `## 8. 自检
- [ ] 是否按 Set 顺序、Set 内列出顺序评估？
- [ ] 是否在 rule_results 中**为每一条规则**输出了一条条目？（数量必须与本提示中的规则总数完全一致）
- [ ] 每条 fail 是否都在 reason 中引用了 GRAPH_CONTEXT 中的具体字段+数值？
- [ ] 是否把所有"字段为 null / 缺失"的情况标成了 \`insufficient_info\` 而不是 \`fail\`？
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

export function renderRuleBlock(r: Rule): string {
  const enforcement = r.enforcementLevel ?? 'optional';
  const onFail = r.failurePolicy ?? 'warn';
  return [
    `#### Rule ${r.id}: ${r.businessLogicRuleName}  [applicableClient=${r.applicableClient}, enforcement=${enforcement}, onFail=${onFail}]`,
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
    STATUS_DECISION_TREE,
    DECISION_FOLD_BLOCK,
    OUTPUT_SCHEMA_MATCH_RESUME,
    SELF_CHECK_MATCH_RESUME,
  ].join('\n\n');
}

export const MATCH_RESUME_SYSTEM_PROMPT = `你是一名 matchResume 规则评估员。

严格按照 user 消息中的 INPUT / GRAPH_CONTEXT / RULES 评估，输出严格符合 schema 的 JSON。

边界约束：
- 必须按 Set 顺序、Set 内列出顺序评估，**每条 rule 都独立评估并输出 status**（不要因为前面有 fail 就把后面标 not_executed）
- 严格按 user 消息中第 5 节的"单条 rule status 决策树"判断 status
- 任何 fail 必须在 reason 中引用 GRAPH_CONTEXT 里的具体字段+数值；做不到的标 insufficient_info
- 字段为 null / 缺失 / 空数组 → insufficient_info，**绝对不要**判 fail
- 必须输出合法 JSON，不要在 JSON 外加任何文本（包括 markdown code fence）`;
