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
): string {
  const lines: string[] = [];
  lines.push("## 概述");
  lines.push(
    `由 \`${run.triggerEvent}\` 触发，当前状态 \`${run.status}\`${run.suspendedReason ? `（${run.suspendedReason}）` : ""}。共涉及 ${breakdown.length} 个 agent，记录 ${steps.length} 个 step、${activities.length} 条 narrative。`,
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
  if (bizFails.length === 0 && infraFails.length === 0) {
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
  if (bizFails.length > 0) {
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
}): string {
  const ageMs = Date.now() - run.startedAt.getTime();
  const ageMin = Math.round(ageMs / 60_000);
  return `## 概述
由 \`${run.triggerEvent}\` 触发，当前状态 \`${run.status}\`${
    run.suspendedReason ? `（${run.suspendedReason}）` : ""
  }，开始于 **${ageMin} 分钟前**。

## 数据状态
这条运行暂时没有可供分析的活动记录，因此无法生成多智能体路径与行为总结，仅有触发事件与状态等基础信息可参考。

## 下一步建议
- 稍后刷新本页，或在该运行产生活动后点击「重新生成」查看完整分析。`;
}
