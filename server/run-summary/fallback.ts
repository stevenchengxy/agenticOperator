// Deterministic fallback renderers for run summaries.
//
// Used when:
//   - LLM gateway not configured (deterministicSummary)
//   - run has 0 AgentActivity AND 0 WorkflowStep rows (emptyRunNotice) —
//     skips the LLM entirely so it can't hallucinate agent names like
//     `JD_Writer` that don't exist in AGENT_MAP
//
// Extracted from app/api/runs/[id]/summary/route.ts.

import { byShortFunction } from "@/lib/agent-functions";
import { displayNameFor } from "@/lib/agent-display-names";
import type { OutcomeSummary } from "@/lib/monitor/run-outcome";
import type { AgentBreakdownRow } from "./prompt";
import { classifyStep } from "./step-classify";

// Localize any agent identifier to its Chinese business name — the deterministic
// (gateway-down) path must never leak a raw Inngest slug or English code either.
const zh = (idOrShort: string) => displayNameFor(idOrShort, "zh");

export function deterministicSummary(
  run: { triggerEvent: string; status: string; suspendedReason: string | null },
  breakdown: AgentBreakdownRow[],
  steps: Array<{
    nodeId: string;
    status: string;
    error: string | null;
    attempts?: number | null;
  }>,
  activities: Array<{ agentName: string; narrative: string }>,
  outcome?: OutcomeSummary,
): string {
  const lines: string[] = [];
  lines.push("## 概述");
  lines.push(
    `由 \`${run.triggerEvent}\` 触发，当前状态 \`${run.status}\`${run.suspendedReason ? `（${run.suspendedReason}）` : ""}。${outcome ? `权威双轴结果为“${outcomeLabel(outcome)}”。` : ""}共涉及 ${breakdown.length} 个 agent，记录 ${steps.length} 个 step、${activities.length} 条 narrative。`,
  );
  lines.push("");
  lines.push("## 各 Agent 做了什么");
  if (breakdown.length === 0) {
    lines.push("- 暂无 agent 活动记录。");
  } else {
    for (const r of breakdown) {
      const fn = byShortFunction(r.agentName);
      const lastBit = r.lastNarrative ? `；最近一次：${truncate(r.lastNarrative, 80)}` : "";
      const fnBit = fn ? `（${fn.summary}）` : "";
      const failBits: string[] = [];
      if (r.businessFailed > 0) failBits.push(`**业务失败 ${r.businessFailed}**`);
      if (r.infraFailed > 0) failBits.push(`基础设施故障 ${r.infraFailed}（已重试/重放）`);
      if (r.recovered > 0) failBits.push(`重试后成功 ${r.recovered}`);
      const failBit = failBits.length > 0 ? `，${failBits.join("、")}` : "";
      lines.push(
        `- **${zh(r.agentName)}** ${fnBit}：执行 ${r.steps} 个环节，累计 ${r.totalDurationMs} ms${failBit}${lastBit}`,
      );
    }
  }
  lines.push("");
  lines.push("## 异常 / 关注点");
  // Split infra-vs-business so a gateway blip never reads as a candidate
  // rejection; retry-recoveries are not listed as failures.
  const classified = steps.map((s) => ({ s, c: classifyStep(s) }));
  const bizFails = classified.filter(({ c }) => c.outcome === "business-failed");
  const infraFails = classified.filter(({ c }) => c.outcome === "infra-failed");
  const recovered = classified.filter(({ c }) => c.outcome === "recovered");
  if (outcome?.business === "rejected" && bizFails.length === 0) {
    lines.push(`- **业务未通过**${outcome.score != null ? `：匹配分 ${outcome.score}` : ""}；这是业务结论，不是技术故障。`);
  } else if (outcome?.business === "blocked" && infraFails.length === 0) {
    lines.push(`- **业务未产出**：${outcome.reason ?? outcome.code ?? "技术或数据问题阻断了有效业务结论"}。`);
  } else if (bizFails.length === 0 && infraFails.length === 0) {
    lines.push("- 未发现失败环节。");
  } else {
    for (const { s, c } of bizFails) {
      lines.push(`- **${zh(s.nodeId)}（业务失败）**：${c.message ?? "判定未通过"}`);
    }
    for (const { s, c } of infraFails) {
      lines.push(
        `- **${zh(s.nodeId)}（基础设施故障·已重试/重放，候选人未被拒绝）**：${c.message ?? "基础设施故障"}`,
      );
    }
  }
  if (recovered.length > 0) {
    lines.push(`- 另有 ${recovered.length} 个环节在重试后成功，已恢复，不计为失败。`);
  }
  lines.push("");
  lines.push("## 下一步建议");
  if (outcome?.business === "rejected") {
    lines.push("- 本次业务判定未通过，不应自动推进面试；可按匹配分和原因决定是否人工复核。");
  } else if (outcome?.business === "blocked") {
    lines.push("- 先恢复依赖或补齐数据，再重试 / 重放；不得上传空结果或将其标记为业务成功。");
  } else if (bizFails.length > 0) {
    lines.push("- 建议人工复核业务失败环节涉及的候选人 / 职位数据，确认是数据缺失还是匹配规则需要调整。");
  } else if (infraFails.length > 0) {
    lines.push("- 本次失败均为基础设施故障，候选人未被拒绝；请关注依赖健康，系统会在依赖恢复后自动重放，无需人工复核候选人。");
  } else if (run.status === "suspended" || run.status === "paused") {
    lines.push("- 该流程已暂停，请确认暂停原因并决定是否继续推进该候选人。");
  } else if (run.status === "running") {
    lines.push("- 流程进行中，可稍后刷新查看该候选人的处理进度。");
  } else {
    lines.push("- 该流程已正常完成，候选人已推进到下一阶段。");
  }
  lines.push("");
  lines.push("> 当前由统计字段直接渲染（未启用 AI 解读）。");
  return lines.join("\n");
}

function outcomeLabel(outcome: OutcomeSummary): string {
  const technical = {
    healthy: "执行正常",
    degraded: "技术异常",
    failed: "技术失败",
    running: "运行中",
    cancelled: "已取消",
  }[outcome.technical];
  const business = {
    passed: "业务通过",
    rejected: "业务未通过",
    mixed: "部分通过",
    blocked: "业务未产出",
    pending: "业务处理中",
    not_applicable: "无业务判定",
    unknown: "结果未知",
  }[outcome.business];
  return `${technical} / ${business}${outcome.score != null ? ` / ${outcome.score} 分` : ""}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// Honest "no data" notice rendered when a run has 0 AgentActivity AND
// 0 WorkflowStep rows. Skips the LLM entirely so it can't invent agent names.
// User-facing → business language, no internal engineering details.
export function emptyRunNotice(run: {
  triggerEvent: string;
  status: string;
  startedAt: Date;
  suspendedReason: string | null;
}, outcome?: OutcomeSummary): string {
  const ageMs = Date.now() - run.startedAt.getTime();
  const ageMin = Math.round(ageMs / 60_000);
  return `## 概述
由 \`${run.triggerEvent}\` 触发，当前状态 \`${run.status}\`${
    run.suspendedReason ? `（${run.suspendedReason}）` : ""
  }，开始于 **${ageMin} 分钟前**。

${outcome ? `权威双轴结果：**${outcomeLabel(outcome)}**${outcome.reason ? `（${outcome.reason}）` : ""}。` : ""}

## 数据状态
这条运行暂时没有可供分析的活动记录，因此无法生成多智能体路径与行为总结，仅有触发事件与状态等基础信息可参考。

## 下一步建议
- ${outcome?.business === "rejected"
    ? "业务判定未通过，不应自动推进面试；可按匹配分与原因决定是否人工复核。"
    : outcome?.business === "blocked"
      ? "先恢复依赖或补齐数据，再重试 / 重放；不得上传空结果或标记为业务成功。"
      : "稍后刷新本页，或在该运行产生活动后点击「重新生成」查看完整分析。"}`;
}
