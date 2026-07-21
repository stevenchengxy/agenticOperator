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
import type { OutcomeSummary } from "@/lib/monitor/run-outcome";
import { classifyStep } from "./step-classify";

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
  /** Terminal failures = infraFailed + businessFailed. */
  failed: number;
  /** Failures caused by infrastructure (gateway/graph/timeout/retry) — NOT a
   *  candidate result. Surfaced separately so the summary never frames these as
   *  "候选人未通过". */
  infraFailed: number;
  /** Failures that reflect a real business decision (e.g. a written 判定=未通过). */
  businessFailed: number;
  /** Steps that failed once but succeeded on retry (transient, recovered). */
  recovered: number;
  totalDurationMs: number;
  lastNarrative: string | null;
};

export const SYSTEM_PROMPT = `你是 Agentic Operator 的运行报告生成器，读者是招聘运营人员（非工程师）。
你了解整个多智能体招聘工作流的拓扑——每个智能体的职责、订阅/产出哪些事件、上下游是谁。总结必须是**多智能体视角的业务叙事**，不是把每个智能体当孤岛说一遍。

⚠ 硬约束（违反 = 输出失败）：
1. 智能体一律用**中文业务名称**（如 规则校验、简历匹配、面试邀约）。**严禁**出现函数 slug（如 \`agentic-operator-main-rule-check-agent\`）、英文代号（如 RuleCheck）、或任何编造的名字（如 \`JD_Writer\`）。只能用输入里出现过的名称、事件名与数字。
2. 输入的「工作流拓扑」段落已给出**真实的下游订阅关系**——必须据此描述路径。**不得声称拓扑未知/不完整**，也不得索取更多拓扑或配置数据。
3. 若「各 Agent 明细」为空，只简述可见的元信息（触发事件 / 状态 / 耗时），不要伪造路径，也不要给任何系统内部建议。
4. **区分两类失败，绝不混淆**：
   - **基础设施故障**（输入标注 \`基础设施故障\`：网关 / 大模型额度 / 图谱不可用 / 超时 / 工具循环 / 重试）——这是系统侧的临时故障，**不是候选人的评估结论**。系统会自动重试或挂起重放。**严禁**把它表述为"候选人规则校验未通过 / 候选人被拒"。应表述为"规则校验因基础设施故障临时挂起，已自动重试/重放，候选人未被拒绝"。
   - **业务失败**（输入标注 \`业务失败\`，或活动里明确写出"判定=未通过 / 不符合规则"）——这才是真实的候选人结论，可以说"候选人规则校验未通过"。
   - 输入标注"重试后成功"的环节属于**已恢复**，**不算失败**。
   - 当输入未出现任何"业务失败"标注时，**不得**断言候选人规则校验未通过。
5. 输入中的「权威双轴判定」来自结构化运行输出，优先级高于 narrative、step 文案和历史摘要。业务未通过时严禁写“匹配达标/推进面试”；业务未产出时严禁写“流程成功完成”，也不得把空结果当作业务成功。
6. 若「技术原因 / 建议处置」要求充值、修复凭证、补齐输入、修复配置、检查响应或修复存储，必须明确写出该动作；不得笼统归因为“临时波动”或声称仅等待自动重试即可恢复。只有建议处置为 \`auto_retry\` 时，才能直接建议等待系统自动重试。

格式（Markdown）：
## 概述
（1~2 句：触发事件 / 总耗时 / 整体结果 / 当前阶段。基于实际数据。整体结果要区分"候选人业务结论"与"基础设施故障"——基础设施故障且已重试/重放的，应说明系统波动已自动恢复、候选人未受影响。）

## 工作流路径
用 → 串起本次实际激活的智能体（中文名）；用 ⊘ 标出拓扑里应触发但本次未激活的下游智能体；若已到流程终点则说明。停滞原因用 suspendedReason 或失败环节，不要猜。

## 各 Agent 干了什么
每个激活的智能体 1~2 行：业务角色 + 本次具体做了什么（用 narrative）。

## 异常 / 关注点
分别列出：**业务失败**（真实候选人结论）与**基础设施故障**（系统侧临时故障，已重试/重放，候选人未被拒绝）。重试后已恢复的环节注明"已恢复"。没有任何异常就写 "未发现异常"。

## 下一步建议
1~2 条**面向业务结果**的建议——围绕候选人 / 职位 / 匹配 / 面试 / 推荐包的下一步动作（例如：确认候选人是否进入面试邀约、补齐推荐包缺失字段；**仅当**存在真实"业务失败"时，才建议人工复核候选人规则校验未通过的原因）。若本次仅为基础设施故障，建议关注依赖健康 / 等待自动重放，**不要**让运营去复核候选人。
**严禁**任何关于本系统内部数据完整性、拓扑配置、事件分发、活动日志 / AgentActivity 接入、AO 系统配置的建议——这些不是用户关心的内容，出现即视为输出失败。

总长度 250~400 字。简洁、诚实、业务导向。`;

export type BuildUserPromptOpts = {
  /** When set (eager-on-fail path), prepend a directive hinting the LLM to
   *  lead with the failure root cause. The status string is the terminal
   *  status that triggered the eager synthesis. */
  eagerTriggerStatus?: string;
  /** Deterministic verdict derived from the archived handler output. */
  authoritativeOutcome?: OutcomeSummary;
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
    attempts?: number | null;
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

  if (opts?.authoritativeOutcome) {
    const outcome = opts.authoritativeOutcome;
    const reason = [outcome.code, outcome.reason].filter(Boolean).join(" · ");
    lines.push("权威双轴判定（结构化结果，必须优先采用）：");
    lines.push(`- 技术执行：${outcome.technical}`);
    lines.push(
      `- 业务结果：${outcome.business}${outcome.score != null ? `（分数 ${outcome.score}）` : ""}`,
    );
    if (outcome.emittedEvent) lines.push(`- 产出事件：${outcome.emittedEvent}`);
    if (outcome.technicalCause) {
      lines.push(
        `- 技术原因：${outcome.provider ? `${outcome.provider} / ` : ""}${outcome.technicalCause}`,
      );
    }
    if (outcome.recoveryAction) lines.push(`- 建议处置：${outcome.recoveryAction}`);
    if (reason) lines.push(`- 原因：${reason}`);
    if (outcome.business === "rejected") {
      lines.push("- 强制表述：技术调用可以是成功的，但业务结论是未通过；不得建议自动推进面试。 ");
    } else if (outcome.business === "blocked") {
      lines.push("- 强制表述：技术/数据问题阻断了有效业务结论；不得把空结果、缺字段或未调通 API 写成成功。 ");
    }
    lines.push("");
  }

  // ── Inject the REAL workflow topology (system blueprint), so the LLM knows
  //    each involved agent's downstream subscribers and can describe the path
  //    + mark expected-but-not-activated agents — even with zero AgentActivity.
  //    breakdown[].agentName is already the canonical short (resolved upstream).
  const involved = new Set(breakdown.map((b) => b.agentName));
  lines.push(...buildRealTopology(involved));
  lines.push("");

  // Classify every step once so we can describe failures honestly (infra vs
  // business) and not count retry-recoveries as failures.
  const classified = steps.map((s) => ({ s, c: classifyStep(s) }));
  const infraFails = classified.filter(({ c }) => c.outcome === "infra-failed");
  const bizFails = classified.filter(({ c }) => c.outcome === "business-failed");
  const recovered = classified.filter(({ c }) => c.outcome === "recovered");

  // Run-level directive — the most important framing signal. When the only
  // failures are infrastructure (no business failure anywhere), tell the model
  // explicitly NOT to report a candidate rejection.
  if (infraFails.length > 0 && bizFails.length === 0) {
    lines.push(
      "⚠ 失败性质：本次所有失败均为【基础设施故障】（网关/大模型额度/图谱/超时/工具循环/重试），系统已自动重试或挂起重放，**候选人未被拒绝**。严禁表述为“候选人规则校验未通过”。",
    );
    lines.push("");
  } else if (bizFails.length > 0) {
    lines.push(
      "⚠ 失败性质：存在【业务失败】（真实候选人结论），同时可能伴随基础设施故障——请在总结中分别说明，不要把基础设施故障也算作候选人结论。",
    );
    lines.push("");
  }

  lines.push("各 Agent 明细（本次运行）：");
  for (const r of breakdown) {
    const fn = byShortFunction(r.agentName);
    const desc = fn ? ` — ${fn.summary}` : "";
    const failBits: string[] = [];
    if (r.businessFailed > 0) failBits.push(`业务失败 ${r.businessFailed}`);
    if (r.infraFailed > 0) failBits.push(`基础设施故障 ${r.infraFailed}（已重试/重放）`);
    if (r.recovered > 0) failBits.push(`重试后成功 ${r.recovered}`);
    const failStr = failBits.length > 0 ? `, ${failBits.join("、")}` : ", 0 失败";
    lines.push(
      `- ${zh(r.agentName)}: ${r.steps} 个 step${failStr}, 共 ${r.totalDurationMs}ms${desc}`,
    );
    if (r.lastNarrative) lines.push(`    最近: ${r.lastNarrative}`);
  }
  lines.push("");

  if (bizFails.length > 0) {
    lines.push("业务失败（真实候选人结论）：");
    for (const { s, c } of bizFails) {
      lines.push(`- ${zh(s.nodeId)}: ${c.message ?? "判定未通过"}`);
    }
    lines.push("");
  }
  if (infraFails.length > 0) {
    lines.push("基础设施故障（系统侧临时故障，已自动重试/重放，非候选人结论）：");
    for (const { s, c } of infraFails) {
      const tries = c.attempts != null && c.attempts > 1 ? `（已尝试 ${c.attempts} 次）` : "";
      lines.push(`- ${zh(s.nodeId)}${tries}: ${c.message ?? "基础设施故障"}`);
    }
    lines.push("");
  }
  if (recovered.length > 0) {
    lines.push(
      `已恢复：本次有 ${recovered.length} 个环节在重试后成功（曾短暂失败但已恢复），不应视为失败。`,
    );
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
