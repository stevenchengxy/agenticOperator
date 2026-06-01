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
import { displayNameFor } from "@/lib/agent-display-names";

// Localize any agent identifier (short / inngest id / app-prefixed slug) to its
// Chinese business name. The LLM only ever SEES business names, so it can only
// ECHO business names — never a raw Inngest slug.
const zh = (idOrShort: string) => displayNameFor(idOrShort, "zh");

// Real, deterministic workflow topology for the involved agents — derived from
// the system blueprint (AGENT_MAP: each agent's emitsEvents → the agents whose
// triggersEvents subscribe to them). Works even with zero AgentActivity, so the
// model always has the true downstream wiring and never claims "topology unknown".
function buildRealTopology(involved: Set<string>): string[] {
  const out: string[] = ["工作流拓扑（真实路径，来自系统蓝图）："];
  if (involved.size === 0) {
    out.push("- （本次运行无已激活的智能体）");
    return out;
  }
  for (const short of involved) {
    const a = AGENT_MAP.find((x) => x.short === short);
    if (!a) {
      out.push(`- ${zh(short)}（本次激活）`);
      continue;
    }
    out.push(
      `- ${zh(a.short)}（本次激活，阶段=${a.stage}${a.terminal ? "，流程终点" : ""}）`,
    );
    if (a.emitsEvents.length === 0) {
      out.push("    无产出事件");
      continue;
    }
    for (const ev of a.emitsEvents) {
      const subs = AGENT_MAP.filter((b) => b.triggersEvents.includes(ev)).map((b) => b.short);
      if (subs.length === 0) {
        out.push(`    产出「${ev}」→ 流程终点（无下游订阅者）`);
        continue;
      }
      const subStr = subs
        .map((s) => `${zh(s)}${involved.has(s) ? "（✓ 已激活）" : "（⊘ 未激活）"}`)
        .join("、");
      out.push(`    产出「${ev}」→ 下游：${subStr}`);
    }
  }
  return out;
}

export type AgentBreakdownRow = {
  agentName: string;
  steps: number;
  failed: number;
  totalDurationMs: number;
  lastNarrative: string | null;
};

export const SYSTEM_PROMPT = `你是 Agentic Operator 的运行报告生成器，读者是招聘运营人员（非工程师）。
你了解整个多智能体招聘工作流的拓扑——每个智能体的职责、订阅/产出哪些事件、上下游是谁。总结必须是**多智能体视角的业务叙事**，不是把每个智能体当孤岛说一遍。

⚠ 硬约束（违反 = 输出失败）：
1. 智能体一律用**中文业务名称**（如 规则校验、简历匹配、面试邀约）。**严禁**出现函数 slug（如 \`agentic-operator-main-rule-check-agent\`）、英文代号（如 RuleCheck）、或任何编造的名字（如 \`JD_Writer\`）。只能用输入里出现过的名称、事件名与数字。
2. 输入的「工作流拓扑」段落已给出**真实的下游订阅关系**——必须据此描述路径。**不得声称拓扑未知/不完整**，也不得索取更多拓扑或配置数据。
3. 若「各 Agent 明细」为空，只简述可见的元信息（触发事件 / 状态 / 耗时），不要伪造路径，也不要给任何系统内部建议。

格式（Markdown）：
## 概述
（1~2 句：触发事件 / 总耗时 / 整体结果 / 当前阶段。基于实际数据。）

## 工作流路径
用 → 串起本次实际激活的智能体（中文名）；用 ⊘ 标出拓扑里应触发但本次未激活的下游智能体；若已到流程终点则说明。停滞原因用 suspendedReason 或失败环节，不要猜。

## 各 Agent 干了什么
每个激活的智能体 1~2 行：业务角色 + 本次具体做了什么（用 narrative）。

## 异常 / 关注点
列出失败 / 错误 / 异常，没有就写 "未发现异常"。

## 下一步建议
1~2 条**面向业务结果**的建议——围绕候选人 / 职位 / 匹配 / 面试 / 推荐包的下一步动作（例如：建议人工复核该候选人规则校验未通过的原因、确认是否进入面试邀约、补齐推荐包缺失字段）。
**严禁**任何关于本系统内部数据完整性、拓扑配置、事件分发、活动日志 / AgentActivity 接入、AO 系统配置的建议——这些不是用户关心的内容，出现即视为输出失败。

总长度 250~400 字。简洁、诚实、业务导向。`;

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

  // ── Inject the REAL workflow topology (system blueprint), so the LLM knows
  //    each involved agent's downstream subscribers and can describe the path
  //    + mark expected-but-not-activated agents — even with zero AgentActivity.
  //    breakdown[].agentName is already the canonical short (resolved upstream).
  const involved = new Set(breakdown.map((b) => b.agentName));
  lines.push(...buildRealTopology(involved));
  lines.push("");

  lines.push("各 Agent 明细（本次运行）：");
  for (const r of breakdown) {
    const fn = byShortFunction(r.agentName);
    const desc = fn ? ` — ${fn.summary}` : "";
    lines.push(
      `- ${zh(r.agentName)}: ${r.steps} 个 step, ${r.failed} 个失败, 共 ${r.totalDurationMs}ms${desc}`,
    );
    if (r.lastNarrative) lines.push(`    最近: ${r.lastNarrative}`);
  }
  lines.push("");
  if (steps.some((s) => s.error)) {
    lines.push("错误：");
    for (const s of steps.filter((s) => s.error)) {
      lines.push(`- ${zh(s.nodeId)} (${s.status}): ${s.error}`);
    }
    lines.push("");
  }
  // Cap activity log so the prompt stays bounded — last 20 entries are
  // usually most informative for "what just happened".
  const recent = activities.slice(-20);
  if (recent.length > 0) {
    lines.push("最近活动（最后 20 条）：");
    for (const a of recent) {
      lines.push(`- [${zh(a.agentName)}/${a.type}] ${a.narrative}`);
    }
  }
  return lines.join("\n");
}
