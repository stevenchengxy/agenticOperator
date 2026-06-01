// Shared prompt assembly for run-AI-summary synthesis.
//
// Extracted from app/api/runs/[id]/summary/route.ts so both the
// route handler (lazy-on-view path) and the Inngest synthesis
// worker (eager-on-fail path) build identical prompts.
//
// SYSTEM_PROMPT is the de-jargon guardrail — DO NOT rewrite without
// reviewing the run-summary spec; hallucinated agent names like
// `JD_Writer` / `Recruiter_Agent` are the failure mode this prompt
// prevents.

import { AGENT_MAP } from "@/lib/agent-mapping";
import { byShortFunction } from "@/lib/agent-functions";

export type AgentBreakdownRow = {
  agentName: string;
  steps: number;
  failed: number;
  totalDurationMs: number;
  lastNarrative: string | null;
};

export const SYSTEM_PROMPT = `你是 Agentic Operator 的运行报告生成器。
你**完全了解整个多 agent 工作流的拓扑**——每个 agent 的职责、订阅哪些事件、emit 哪些事件、谁在它的上下游。所以你的总结必须是**多 agent 视角的**，不是把每个 agent 当孤岛说一遍。

⚠ 硬约束（违反 = 输出失败）：
1. agent 名字、事件名、step 名、数字、时间戳——**只能用用户输入里出现过的**。绝不允许编造（如 \`JD_Writer\`、\`Recruiter_Agent\`、\`Channel_Distributor\`、\`Resume_Sourcing_Agent\` 这种不在 AGENT_MAP 里的虚构名字）。
2. 如果 "Per-agent breakdown" 段落为空 OR 标 "(无活动数据)"，**不要伪造工作流路径**。直接说："这条 run 在 AgentActivity 表中无任何记录，无法做多 agent 路径分析。仅有 WorkflowRun 主表的元信息（trigger、status、suspendedReason）可参考。"
3. 工作流拓扑只能引用 "Workflow topology context" 段落里实际列出的 agent。其他 agent 不存在。

格式（Markdown）：
## 概述
（1~2 句：触发事件 / 总耗时 / 整体结果 / 当前阶段。基于实际数据，不是猜测。）

## 工作流路径
**仅当**有真实 per-agent breakdown 数据时填这段：
- 用 → 串起这条 run 实际激活的 agent（必须来自 breakdown）
- 用 ⊘ 标出 "Workflow topology context" 中标 "expected but not activated" 的 agent
- 解释停滞原因（用 suspendedReason 或失败的 step.error，不要猜）

**否则**：写 "无 AgentActivity 数据，无法重建路径。请先按 README 接通 runtime 的活动日志推送（POST /api/runs/[id]/activity）。"

## 各 Agent 干了什么
**仅当** breakdown 非空时列出。每段 1~2 行：
- agent 角色（用 function summary）
- 这条 run 里具体做了什么（用 narrative）

## 异常 / 关注点
列出 step.failed / error / anomaly，没有就写 "未发现异常"。

## 下一步建议
1~2 条具体建议。如果数据为空，建议是 "接通 AgentActivity 写入" 而不是业务建议。

总长度 250~400 字。简洁优于详细。诚实优于华丽。`;

export type BuildUserPromptOpts = {
  /** When set (eager-on-fail path), prepend a directive hinting the LLM to
   *  lead with the failure root cause. The status string is the terminal
   *  status that triggered the eager synthesis. */
  eagerTriggerStatus?: string;
};

export function buildUserPrompt(
  run: {
    id: string;
    triggerEvent: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    suspendedReason: string | null;
    triggerData: string;
  },
  breakdown: AgentBreakdownRow[],
  steps: Array<{
    nodeId: string;
    status: string;
    error: string | null;
    durationMs: number | null;
  }>,
  activities: Array<{ agentName: string; type: string; narrative: string }>,
  opts?: BuildUserPromptOpts,
): string {
  const lines: string[] = [];
  if (opts?.eagerTriggerStatus) {
    lines.push(
      `This summary was auto-triggered because the run reached terminal status: ${opts.eagerTriggerStatus}. Lead with the failure root cause.`,
    );
    lines.push("");
  }
  lines.push(`Run id: ${run.id}`);
  lines.push(`Trigger: ${run.triggerEvent}`);
  lines.push(`Trigger data: ${run.triggerData}`);
  lines.push(
    `Status: ${run.status}${run.suspendedReason ? ` (suspended: ${run.suspendedReason})` : ""}`,
  );
  lines.push(`Started: ${run.startedAt.toISOString()}`);
  lines.push(`Completed: ${run.completedAt?.toISOString() ?? "(running)"}`);
  lines.push("");

  // ── Inject the workflow topology so the LLM can reason about
  //    "expected vs actual" path. Without this it can't know which
  //    downstream agents WERE expected when this run halted.
  const involved = new Set(breakdown.map((b) => b.agentName));
  const expected = computeExpectedDownstream(involved, activities);
  lines.push("Workflow topology context (subset relevant to this run):");
  for (const a of AGENT_MAP) {
    if (!involved.has(a.short) && !expected.has(a.short)) continue;
    const fn = byShortFunction(a.short);
    const tag = involved.has(a.short)
      ? "✓ activated"
      : expected.has(a.short)
        ? "⊘ expected but not activated"
        : "—";
    lines.push(
      `- ${a.short} [${tag}] (stage=${a.stage}, kind=${a.kind})${fn ? ` — ${fn.summary}` : ""}`,
    );
    lines.push(`    triggers: ${a.triggersEvents.join(", ") || "(none)"}`);
    lines.push(`    emits: ${a.emitsEvents.join(", ") || "(terminal)"}`);
  }
  lines.push("");

  lines.push("Per-agent breakdown for this run:");
  for (const r of breakdown) {
    const fn = byShortFunction(r.agentName);
    const desc = fn ? ` — ${fn.summary}` : "";
    lines.push(
      `- ${r.agentName}: ${r.steps} step(s), ${r.failed} failed, ${r.totalDurationMs}ms total${desc}`,
    );
    if (r.lastNarrative) lines.push(`    最近: ${r.lastNarrative}`);
  }
  lines.push("");
  if (steps.some((s) => s.error)) {
    lines.push("Errors:");
    for (const s of steps.filter((s) => s.error)) {
      lines.push(`- ${s.nodeId} (${s.status}): ${s.error}`);
    }
    lines.push("");
  }
  // Cap activity log so the prompt stays bounded — last 20 entries are
  // usually most informative for "what just happened".
  const recent = activities.slice(-20);
  if (recent.length > 0) {
    lines.push("Recent activity (last 20):");
    for (const a of recent) {
      lines.push(`- [${a.agentName}/${a.type}] ${a.narrative}`);
    }
  }
  return lines.join("\n");
}

// Given the agents that ACTIVATED in this run, plus the events seen in
// activity narratives, compute which downstream agents WERE EXPECTED but
// didn't activate. This is the "should have run but didn't" set the LLM
// uses for its 工作流路径 section.
//
// Algorithm:
//   1. Collect events emitted (from activity narratives like "Published X").
//   2. Cross-reference AGENT_MAP — any agent whose triggersEvents intersects
//      with our emitted set, but isn't in the activated set, is "expected".
//   3. Cap at one hop downstream — going further is speculative without
//      knowing branch decisions.
function computeExpectedDownstream(
  activated: Set<string>,
  activities: Array<{ narrative: string; type: string }>,
): Set<string> {
  // Pull emitted-event names out of "Published EVENT_NAME · ..." narratives.
  const emitted = new Set<string>();
  for (const a of activities) {
    if (a.type !== "event_emitted" && !a.narrative.startsWith("Published")) continue;
    const m = a.narrative.match(/Published\s+([A-Z_]+)/);
    if (m) emitted.add(m[1]);
  }
  // Also consider the trigger event itself as "input" — agents subscribed
  // to it that didn't activate are notable.
  const expected = new Set<string>();
  for (const agent of AGENT_MAP) {
    if (activated.has(agent.short)) continue;
    const matches = agent.triggersEvents.some((t) => emitted.has(t));
    if (matches) expected.add(agent.short);
  }
  return expected;
}
