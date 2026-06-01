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

// Localize any agent identifier to its Chinese business name — the deterministic
// (gateway-down) path must never leak a raw Inngest slug or English code either.
const zh = (idOrShort: string) => displayNameFor(idOrShort, "zh");

export function deterministicSummary(
  run: { triggerEvent: string; status: string; suspendedReason: string | null },
  breakdown: AgentBreakdownRow[],
  steps: Array<{ nodeId: string; status: string; error: string | null }>,
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
      lines.push(
        `- **${zh(r.agentName)}** ${fnBit}：执行 ${r.steps} 个环节，累计 ${r.totalDurationMs} ms${r.failed > 0 ? `，**${r.failed} 个失败**` : ""}${lastBit}`,
      );
    }
  }
  lines.push("");
  lines.push("## 异常 / 关注点");
  const failed = steps.filter((s) => s.status === "failed" || s.error);
  if (failed.length === 0) {
    lines.push("- 未发现失败环节。");
  } else {
    for (const s of failed) {
      lines.push(`- **${zh(s.nodeId)}**：${s.error ?? "该环节执行失败"}`);
    }
  }
  lines.push("");
  lines.push("## 下一步建议");
  if (failed.length > 0) {
    lines.push("- 建议人工复核失败环节涉及的候选人 / 职位数据，确认是数据缺失还是匹配规则需要调整。");
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
